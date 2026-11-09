/**
 * Live-Synchronisierung im Browser: Ereignis-Stream (EventSource) mit Wiederverbinden ab der letzten bekannten
 * Änderungsnummer, gebündeltes Senden der eigenen Änderungen (je Element nur der letzte Stand, etwa alle 80 ms,
 * eine Anfrage gleichzeitig, Wiederholung bei Netzfehlern) und gedrosselte Anwesenheit (Cursor, Auswahl).
 */
import { SvelteMap } from 'svelte/reactivity';
import { ApiClientError, apiFetch } from '$lib/sdk/client';
import {
	API_BASE,
	type ElementOp,
	type LiveElement,
	type LiveEvent,
	type OpsResult,
	type PresenceUser,
	type ShareLevel
} from '../../schemas';

export type SyncStatus = 'connecting' | 'live' | 'offline' | 'closed';

export interface SyncHandlers {
	/** Änderungen anderer (oder nachgeholte) */
	onElements(elements: LiveElement[]): void;
	/** Bestätigte Versionen eigener Änderungen */
	onAck(applied: OpsResult['applied']): void;
	/** Stand zu alt bzw. Version wiederhergestellt → komplett neu laden */
	onReset(): void;
	onBoard(board: Extract<LiveEvent, { type: 'board' }>['board']): void;
	onAccess(level: ShareLevel): void;
	/** Kein Zugriff mehr bzw. Board gelöscht */
	onGone(reason: 'revoked' | 'deleted'): void;
	/** Änderungen wurden abgelehnt (ungültig, Grenze erreicht) */
	onRejected(message: string): void;
}

const FLUSH_MS = 80;
const PRESENCE_MS = 100;
/** Byte-Budget je Anfrage (Router-Grenze 1 MB) */
const MAX_BATCH_BYTES = 800_000;
const MAX_BATCH_OPS = 400;

function randomClient(): string {
	const bytes = new Uint8Array(12);
	crypto.getRandomValues(bytes);
	return `c${[...bytes].map((b) => b.toString(36).padStart(2, '0')).join('')}`.slice(0, 32);
}

export class BoardSync {
	readonly client = randomClient();
	status = $state<SyncStatus>('connecting');
	/** Ungespeicherte eigene Änderungen vorhanden */
	saving = $state(false);
	/** Andere Verbindungen (je Tab) */
	peers = new SvelteMap<string, PresenceUser>();

	private es: EventSource | null = null;
	private seq = 0;
	private pending = new Map<string, ElementOp>();
	private inflight = new Map<string, ElementOp>();
	private flushTimer: ReturnType<typeof setTimeout> | null = null;
	private retryTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private retryDelay = 1000;
	private reconnectDelay = 1000;
	private closed = false;
	private readonly = false;
	private presenceTimer: ReturnType<typeof setTimeout> | null = null;
	private presenceState: {
		cursor: { x: number; y: number } | null;
		selection: string[];
		editing: string | null;
	} = {
		cursor: null,
		selection: [],
		editing: null
	};
	private presenceDirty = false;
	private lastPresenceAt = 0;

	constructor(
		private readonly boardId: string,
		private readonly handlers: SyncHandlers
	) {}

	/** Element hat ungespeicherte/unbestätigte eigene Änderungen (Fremdänderungen dann nicht übernehmen) */
	isPending(id: string): boolean {
		return this.pending.has(id) || this.inflight.has(id);
	}

	setReadonly(v: boolean): void {
		this.readonly = v;
		if (v) this.pending.clear();
	}

	connect(since: number): void {
		this.closed = false;
		this.seq = Math.max(this.seq, since);
		this.open();
	}

	/** Nach komplettem Neuladen: ab diesem Stand weiterhören */
	resetSeq(seq: number): void {
		this.seq = seq;
	}

	private open(): void {
		if (this.closed) return;
		this.es?.close();
		this.status = this.status === 'live' ? 'live' : 'connecting';
		const url = `${API_BASE}/boards/${encodeURIComponent(this.boardId)}/live?client=${this.client}&since=${this.seq}`;
		const es = new EventSource(url, { withCredentials: true });
		this.es = es;
		es.onmessage = (msg) => {
			let event: LiveEvent;
			try {
				event = JSON.parse(msg.data) as LiveEvent;
			} catch {
				return;
			}
			this.handle(event);
		};
		es.onerror = () => {
			// Browser würde mit alter URL (altes `since`) wiederverbinden → selbst steuern
			es.close();
			if (this.es !== es || this.closed) return;
			this.es = null;
			this.status = 'offline';
			this.peers.clear();
			if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
			this.reconnectTimer = setTimeout(() => this.open(), this.reconnectDelay);
			this.reconnectDelay = Math.min(this.reconnectDelay * 2, 15_000);
		};
	}

	private handle(event: LiveEvent): void {
		switch (event.type) {
			case 'hello':
				this.status = 'live';
				this.reconnectDelay = 1000;
				this.peers.clear();
				for (const p of event.peers) if (p.client !== this.client) this.peers.set(p.client, p);
				if (event.reset) this.handlers.onReset();
				else this.seq = Math.max(this.seq, event.seq);
				if ((event.level === 'read') !== this.readonly) this.handlers.onAccess(event.level);
				this.presenceDirty = true;
				this.schedulePresence();
				// Ausstehendes nach Verbindungsabbruch nachschicken
				if (this.pending.size) this.scheduleFlush(0);
				break;
			case 'ops':
				this.seq = Math.max(this.seq, event.seq);
				this.handlers.onElements(event.elements);
				break;
			case 'join':
			case 'presence':
				if (event.peer.client !== this.client) this.peers.set(event.peer.client, event.peer);
				break;
			case 'leave':
				this.peers.delete(event.client);
				break;
			case 'board':
				this.handlers.onBoard(event.board);
				break;
			case 'access':
				this.handlers.onAccess(event.level);
				break;
			case 'reset':
				this.handlers.onReset();
				break;
			case 'revoked':
			case 'deleted':
				this.close();
				this.handlers.onGone(event.type);
				break;
		}
	}

	/** Änderung vormerken (je Element zählt nur der letzte Stand) */
	queue(op: ElementOp): void {
		if (this.readonly || this.closed) return;
		this.pending.set(op.id, op);
		this.saving = true;
		this.scheduleFlush(FLUSH_MS);
	}

	private scheduleFlush(ms: number): void {
		if (this.flushTimer || this.retryTimer) return;
		this.flushTimer = setTimeout(() => {
			this.flushTimer = null;
			void this.flush();
		}, ms);
	}

	private takeBatch(): ElementOp[] {
		const batch: ElementOp[] = [];
		let bytes = 0;
		for (const [id, op] of this.pending) {
			const size = JSON.stringify(op).length;
			if (batch.length && (bytes + size > MAX_BATCH_BYTES || batch.length >= MAX_BATCH_OPS)) break;
			batch.push(op);
			bytes += size;
			this.pending.delete(id);
			this.inflight.set(id, op);
		}
		return batch;
	}

	async flush(keepalive = false): Promise<void> {
		if (this.inflight.size || !this.pending.size || this.readonly) {
			this.saving = this.pending.size > 0 || this.inflight.size > 0;
			return;
		}
		const batch = this.takeBatch();
		try {
			const res = await apiFetch<OpsResult>(
				`/modules/whiteboard/boards/${encodeURIComponent(this.boardId)}/ops`,
				{ method: 'POST', body: JSON.stringify({ client: this.client, ops: batch }), keepalive }
			);
			this.inflight.clear();
			this.retryDelay = 1000;
			this.handlers.onAck(res.applied);
		} catch (e) {
			const failed = [...this.inflight.entries()];
			this.inflight.clear();
			if (e instanceof ApiClientError && [400, 403, 404, 409, 413, 422].includes(e.status)) {
				// endgültig abgelehnt: nicht wiederholen, Zustand vom Server holen
				if (e.status === 403) this.handlers.onAccess('read');
				this.handlers.onRejected(e.message || 'Änderung konnte nicht gespeichert werden');
			} else {
				// Netz/Server kurz weg: zurücklegen (neuere Änderungen desselben Elements haben Vorrang)
				for (const [id, op] of failed) if (!this.pending.has(id)) this.pending.set(id, op);
				this.status = this.status === 'live' ? 'offline' : this.status;
				this.retryTimer = setTimeout(() => {
					this.retryTimer = null;
					void this.flush();
				}, this.retryDelay);
				this.retryDelay = Math.min(this.retryDelay * 2, 15_000);
			}
		}
		this.saving = this.pending.size > 0 || this.inflight.size > 0;
		if (this.pending.size && !this.retryTimer) this.scheduleFlush(FLUSH_MS);
	}

	/** Anwesenheit melden (gedrosselt) */
	presence(patch: Partial<typeof this.presenceState>): void {
		this.presenceState = { ...this.presenceState, ...patch };
		this.presenceDirty = true;
		this.schedulePresence();
	}

	private schedulePresence(): void {
		if (this.presenceTimer || this.status !== 'live') return;
		const wait = Math.max(0, PRESENCE_MS - (Date.now() - this.lastPresenceAt));
		this.presenceTimer = setTimeout(() => {
			this.presenceTimer = null;
			if (!this.presenceDirty || this.status !== 'live') return;
			this.presenceDirty = false;
			this.lastPresenceAt = Date.now();
			void apiFetch(`/modules/whiteboard/boards/${encodeURIComponent(this.boardId)}/presence`, {
				method: 'POST',
				body: JSON.stringify({ client: this.client, ...this.presenceState })
			}).catch(() => undefined);
		}, wait);
	}

	close(): void {
		this.closed = true;
		this.es?.close();
		this.es = null;
		this.status = 'closed';
		for (const t of [this.reconnectTimer, this.presenceTimer]) if (t) clearTimeout(t);
		this.peers.clear();
	}

	/** Beim Verlassen: Ausstehendes noch senden */
	dispose(): void {
		if (this.flushTimer) clearTimeout(this.flushTimer);
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.flushTimer = null;
		this.retryTimer = null;
		if (this.pending.size && !this.readonly) void this.flush(true);
		this.close();
	}

	hasUnsaved(): boolean {
		return this.pending.size > 0 || this.inflight.size > 0;
	}
}
