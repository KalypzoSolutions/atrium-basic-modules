/**
 * Live-Verteilung (Server-Sent Events) im Prozess: je Board die offenen Verbindungen (`Subscriber`, eine je
 * Browser-Tab = `client`). Änderungen kommen per POST (`ops.service.ts`) und werden nach dem Commit an alle
 * Verbindungen des Boards verteilt. Bewusst ohne Datenbank-Pub/Sub: der Betrieb läuft mit EINER Instanz
 * (siehe `.claude/rules/module-whiteboard.md`); mehrere Instanzen bräuchten LISTEN/NOTIFY.
 *
 * Zugriff wird beim Aufbau, alle 60 s und sofort nach Freigabe-/Aktionsänderungen (`recheckBoard`) geprüft;
 * ohne Zugriff → Ereignis `revoked` und die Verbindung schließt.
 */
import { sql } from 'drizzle-orm';
import {
	authHeadersOf,
	errors,
	num,
	refreshLiveContext,
	type RequestContext,
	rowsOf
} from '$lib/sdk/server';
import { loadBoardContext, resolveBoardAccess } from './access';
import { liveElementOf, mdb } from './boards.service';
import type { LiveEvent, PresenceUser, ShareLevel } from './schemas';

/** Heartbeat (Proxys schließen stille Verbindungen) */
const HEARTBEAT_MS = 20_000;
/** Zugriff regelmäßig neu prüfen */
const RECHECK_MS = 60_000;
/** Höchstzahl offener Verbindungen je Konto */
export const MAX_STREAMS_PER_USER = 20;

interface Subscriber {
	client: string;
	boardId: string;
	userId: string;
	ctx: RequestContext;
	/** Anmeldedaten der Anfrage für die Neuprüfung (`refreshLiveContext`) */
	auth: Headers;
	level: ShareLevel;
	peer: PresenceUser;
	push(event: LiveEvent): void;
	close(): void;
}

const boards = new Map<string, Map<string, Subscriber>>();

function subscribersOf(boardId: string): Map<string, Subscriber> {
	let map = boards.get(boardId);
	if (!map) {
		map = new Map();
		boards.set(boardId, map);
	}
	return map;
}

function remove(sub: Subscriber): void {
	const map = boards.get(sub.boardId);
	if (!map || map.get(sub.client) !== sub) return;
	map.delete(sub.client);
	if (!map.size) boards.delete(sub.boardId);
	broadcast(sub.boardId, { type: 'leave', client: sub.client });
}

/** Ereignis an alle Verbindungen eines Boards (außer `exceptClient`) */
export function broadcast(boardId: string, event: LiveEvent, exceptClient?: string): void {
	const map = boards.get(boardId);
	if (!map) return;
	for (const sub of map.values()) {
		if (sub.client !== exceptClient) sub.push(event);
	}
}

/** Anwesende eines Boards */
export function peersOf(boardId: string): PresenceUser[] {
	return [...(boards.get(boardId)?.values() ?? [])].map((s) => s.peer);
}

export function openStreamCount(userId: string): number {
	let n = 0;
	for (const map of boards.values()) {
		for (const sub of map.values()) if (sub.userId === userId) n++;
	}
	return n;
}

/** Anwesenheit (Cursor, Auswahl, Bearbeiten) einer Verbindung aktualisieren und verteilen */
export function updatePresence(
	boardId: string,
	client: string,
	userId: string,
	patch: Pick<PresenceUser, 'cursor' | 'selection' | 'editing'>
): boolean {
	const sub = boards.get(boardId)?.get(client);
	if (!sub || sub.userId !== userId) return false;
	sub.peer = { ...sub.peer, ...patch };
	broadcast(boardId, { type: 'presence', peer: sub.peer }, client);
	return true;
}

/** Alle Verbindungen eines Boards mit einem letzten Ereignis schließen (Board gelöscht) */
export function closeBoard(boardId: string, event: LiveEvent): void {
	const map = boards.get(boardId);
	if (!map) return;
	for (const sub of [...map.values()]) {
		sub.push(event);
		sub.close();
	}
	boards.delete(boardId);
}

/** Zugriff einer Verbindung neu prüfen (eigene Transaktion, nie aus einer offenen heraus aufrufen) */
async function recheck(sub: Subscriber): Promise<void> {
	let level: ShareLevel | null;
	try {
		// Sitzung, Konto und Rechte neu auflösen – Rollenentzug, Abmelden oder Deaktivieren wirken sofort
		const fresh = await refreshLiveContext(sub.ctx, sub.auth);
		if (fresh) {
			sub.ctx = fresh;
			await loadBoardContext(fresh);
			const access = await mdb().transaction((tx) => resolveBoardAccess(tx, fresh, sub.boardId));
			level = access?.level ?? null;
		} else level = null;
	} catch (e) {
		// Datenbank kurz nicht erreichbar: Verbindung offen lassen, nächster Versuch beim nächsten Takt
		console.warn('[whiteboard] Zugriffsprüfung fehlgeschlagen', e);
		return;
	}
	if (!level) {
		sub.push({ type: 'revoked' });
		sub.close();
		return;
	}
	if (level !== sub.level) {
		sub.level = level;
		sub.peer = { ...sub.peer, canEdit: level === 'edit' };
		sub.push({ type: 'access', level });
		broadcast(sub.boardId, { type: 'presence', peer: sub.peer }, sub.client);
	}
}

/** Nach Freigabe-/Aktionsänderungen: alle Verbindungen des Boards sofort prüfen */
export async function recheckBoard(boardId: string): Promise<void> {
	for (const sub of [...(boards.get(boardId)?.values() ?? [])]) await recheck(sub);
}

/** Für Tests: alle Verbindungen schließen */
export function closeAllStreamsForTests(): void {
	for (const id of [...boards.keys()]) closeBoard(id, { type: 'deleted' });
}

const encoder = new TextEncoder();

/**
 * SSE-Antwort öffnen. Ablauf: anmelden → `hello` (Anwesende, Stand) → mit `since` die Änderungen danach
 * (`ops`, gelöschte inklusive). Elemente sind über ihre Version idempotent: doppelt gesendete schaden nicht.
 */
export function openStream(input: {
	ctx: RequestContext;
	request: Request;
	boardId: string;
	client: string;
	level: ShareLevel;
	since: number | undefined;
	peer: Omit<PresenceUser, 'cursor' | 'selection' | 'editing' | 'canEdit'>;
}): Response {
	const { ctx, boardId, client } = input;
	// fremde Kennung übernehmen (Kennungen stehen in `hello`) wäre ein Rauswurf anderer Personen
	const existing = boards.get(boardId)?.get(client);
	if (existing && existing.userId !== (ctx.userId ?? '')) {
		throw errors.conflict('Diese Verbindungskennung ist bereits vergeben');
	}
	const auth = authHeadersOf(input.request);
	let sub: Subscriber | null = null;
	let closed = false;
	const timers: ReturnType<typeof setInterval>[] = [];

	const cleanup = () => {
		if (closed) return;
		closed = true;
		for (const t of timers) clearInterval(t);
		if (sub) remove(sub);
	};

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const write = (chunk: string) => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(chunk));
				} catch {
					cleanup();
				}
			};
			const push = (event: LiveEvent) => write(`data: ${JSON.stringify(event)}\n\n`);
			sub = {
				client,
				boardId,
				userId: ctx.userId ?? '',
				ctx,
				auth,
				level: input.level,
				peer: {
					...input.peer,
					client,
					canEdit: input.level === 'edit',
					cursor: null,
					selection: [],
					editing: null
				},
				push,
				close: () => {
					cleanup();
					try {
						controller.close();
					} catch {
						// schon geschlossen
					}
				}
			};
			const map = subscribersOf(boardId);
			// gleiche Kennung erneut verbunden (Wiederverbinden): alte Verbindung ablösen
			map.get(client)?.close();
			const peers = [...(boards.get(boardId)?.values() ?? [])].map((s) => s.peer);
			subscribersOf(boardId).set(client, sub);
			write('retry: 3000\n\n');
			const current = sub;
			void (async () => {
				let seq: number;
				let reset: boolean;
				let changed: ReturnType<typeof liveElementOf>[];
				try {
					const data = await mdb().transaction(async (tx) => {
						const [b] = await rowsOf(
							tx,
							sql`SELECT seq, purged_seq FROM boards WHERE id = ${boardId}`
						);
						const boardSeq = num(b?.seq);
						const since = input.since;
						if (since === undefined) return { seq: boardSeq, reset: false, rows: [] };
						if (since < num(b?.purged_seq) || since > boardSeq) {
							return { seq: boardSeq, reset: true, rows: [] };
						}
						const rows =
							since === boardSeq
								? []
								: await rowsOf(
										tx,
										sql`SELECT id, type, data, z, version, deleted FROM elements
											WHERE board_id = ${boardId} AND seq > ${since} ORDER BY seq, id`
									);
						return { seq: boardSeq, reset: false, rows };
					});
					seq = data.seq;
					reset = data.reset;
					changed = data.rows.map(liveElementOf);
				} catch (e) {
					console.warn('[whiteboard] Live-Start fehlgeschlagen', e);
					current.close();
					return;
				}
				push({ type: 'hello', seq, client, level: current.level, peers, reset });
				if (changed.length) {
					push({ type: 'ops', seq, client: null, userId: null, elements: changed });
				}
				broadcast(boardId, { type: 'join', peer: current.peer }, client);
			})();
			timers.push(setInterval(() => write(': ping\n\n'), HEARTBEAT_MS));
			timers.push(
				setInterval(() => {
					if (sub) void recheck(sub);
				}, RECHECK_MS)
			);
		},
		cancel() {
			cleanup();
		}
	});

	input.request.signal?.addEventListener('abort', () => sub?.close(), { once: true });

	return new Response(stream, {
		status: 200,
		headers: {
			'content-type': 'text/event-stream; charset=utf-8',
			'cache-control': 'no-store, no-transform',
			// nginx: nicht puffern (sonst kommen Ereignisse erst gesammelt an)
			'x-accel-buffering': 'no'
		}
	});
}
