/**
 * Yjs-Dokumente der Notizen im Prozess: je geöffneter Notiz ein `Y.Doc` (aus `notes.ydoc` + `note_updates`
 * geladen), Schreiben unter einer Sperre je Notiz, Verteilen an die Live-Verbindungen, Verdichten und das
 * verzögerte Ableiten von `content_json`/`content_text` (Suche, Vorschau, Export).
 *
 * Ein Update wird erst vollständig dekodiert (kaputte Daten → 422), dann gespeichert, dann angewandt. Der Server
 * vertraut dem Inhalt nicht: alles, was ausgegeben wird (Export, Suche), läuft über das Schema (`doc/extensions.ts`)
 * und eigene Serialisierer mit Escaping.
 *
 * Wie der Live-Hub: nur EINE App-Instanz (Dokumente im Speicher). Alle Funktionen öffnen eigene Transaktionen –
 * nie aus einer offenen Modul-Transaktion aufrufen (PGlite).
 */
import { sql } from 'drizzle-orm';
import * as Y from 'yjs';
import { prosemirrorToYXmlFragment, yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import { errors, rowsOf, type Tx } from '$lib/sdk/server';
import { noteSchema } from './doc/extensions';
import { assetIdsOf, plainTextOf } from './doc/text';
import { hub } from './live';
import {
	COMPACT_AFTER_UPDATES,
	DERIVE_DELAY_MS,
	MAX_DOC_BYTES,
	MAX_UPDATE_BYTES,
	YDOC_FIELD,
	type LiveEvent
} from './schemas';

export { mdb } from './db';
import { mdb } from './db';

/** Ungenutzte Dokumente nach dieser Zeit aus dem Speicher nehmen */
const IDLE_MS = 5 * 60_000;
const SWEEP_MS = 60_000;

interface Entry {
	doc: Y.Doc;
	/** Bytes des verdichteten Stands + Summe der Einzel-Updates */
	sizeBytes: number;
	/** Einzel-Updates seit der letzten Verdichtung */
	pending: number;
	lastUsed: number;
	deriveTimer: ReturnType<typeof setTimeout> | null;
	/** letzte Änderung (für `updated_by`) */
	lastUserId: string | null;
	dirty: boolean;
}

const entries = new Map<string, Entry>();
const loading = new Map<string, Promise<Entry>>();
/** Steigt bei `discardAllDocs`: vorher begonnene Ladevorgänge landen nicht mehr im Speicher */
let generation = 0;
const locks = new Map<string, Promise<unknown>>();
let sweeper: ReturnType<typeof setInterval> | null = null;

/** Aufgaben je Notiz nacheinander ausführen (Schreiben, Verdichten, Ersetzen) */
export function withDocLock<T>(noteId: string, fn: () => Promise<T>): Promise<T> {
	const prev = locks.get(noteId) ?? Promise.resolve();
	const next = prev.then(fn, fn);
	const tail = next.catch(() => undefined);
	locks.set(noteId, tail);
	void tail.then(() => {
		if (locks.get(noteId) === tail) locks.delete(noteId);
	});
	return next;
}

const toBytes = (v: unknown): Uint8Array | null => {
	if (v == null) return null;
	if (v instanceof Uint8Array) return v;
	if (typeof v === 'string') {
		// pg liefert bytea je nach Einstellung als `\x…`-Text
		if (v.startsWith('\\x')) return new Uint8Array(Buffer.from(v.slice(2), 'hex'));
		return new Uint8Array(Buffer.from(v, 'base64'));
	}
	if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
	return null;
};

export const bytesOf = toBytes;

function ensureSweeper(): void {
	if (sweeper) return;
	sweeper = setInterval(() => void sweep(), SWEEP_MS);
	// Prozess nicht wegen des Timers am Leben halten (Tests, Shutdown)
	sweeper.unref?.();
}

async function sweep(): Promise<void> {
	const now = Date.now();
	for (const [id, e] of entries) {
		if (hub.subscribers(id).length) continue;
		if (now - e.lastUsed < IDLE_MS) continue;
		try {
			await flushNote(id);
		} catch (err) {
			console.warn('[notes] Verdichten beim Entladen fehlgeschlagen', err);
			continue;
		}
		const cur = entries.get(id);
		if (cur && !hub.subscribers(id).length && Date.now() - cur.lastUsed >= IDLE_MS) {
			if (cur.deriveTimer) clearTimeout(cur.deriveTimer);
			cur.doc.destroy();
			entries.delete(id);
		}
	}
}

/** Gespeicherten Stand (verdichtet + Einzel-Updates) als neues `Y.Doc` laden – ohne Zwischenspeicher */
async function loadStoredDoc(
	noteId: string
): Promise<{ doc: Y.Doc; size: number; updates: number }> {
	const data = await mdb().transaction(async (tx) => {
		const [n] = await rowsOf(tx, sql`SELECT ydoc FROM notes WHERE id = ${noteId}`);
		if (!n) return null;
		const updates = await rowsOf(
			tx,
			sql`SELECT data FROM note_updates WHERE note_id = ${noteId} ORDER BY seq`
		);
		return { ydoc: toBytes(n.ydoc), updates: updates.map((u) => toBytes(u.data)!) };
	});
	if (!data) throw errors.notFound('Notiz nicht gefunden');
	const doc = new Y.Doc({ gc: true });
	let size = 0;
	if (data.ydoc?.byteLength) {
		Y.applyUpdate(doc, data.ydoc);
		size += data.ydoc.byteLength;
	}
	for (const u of data.updates) {
		Y.applyUpdate(doc, u);
		size += u.byteLength;
	}
	return { doc, size, updates: data.updates.length };
}

async function loadEntry(noteId: string): Promise<Entry> {
	const { doc, size, updates } = await loadStoredDoc(noteId);
	return {
		doc,
		sizeBytes: size,
		pending: updates,
		lastUsed: Date.now(),
		deriveTimer: null,
		lastUserId: null,
		dirty: false
	};
}

/** Dokument einer Notiz (aus dem Speicher oder geladen) */
export async function docEntry(noteId: string): Promise<Entry> {
	ensureSweeper();
	const cached = entries.get(noteId);
	if (cached) {
		cached.lastUsed = Date.now();
		return cached;
	}
	const gen = generation;
	let pending = loading.get(noteId);
	if (!pending) {
		pending = loadEntry(noteId).finally(() => loading.delete(noteId));
		loading.set(noteId, pending);
	}
	const entry = await pending;
	if (gen !== generation) return docEntry(noteId);
	const existing = entries.get(noteId);
	if (existing) return existing;
	entries.set(noteId, entry);
	return entry;
}

/** Update vollständig dekodieren (wirft 422 bei kaputten Daten) */
export function assertValidUpdate(update: Uint8Array): void {
	if (!update.byteLength) throw errors.validation([{ path: ['body'], message: 'Leeres Update' }]);
	if (update.byteLength > MAX_UPDATE_BYTES) {
		throw errors.tooLarge('Die Änderung ist zu groß');
	}
	try {
		Y.decodeUpdate(update);
	} catch {
		throw errors.validation([{ path: ['body'], message: 'Ungültige Änderung' }]);
	}
}

const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');

/**
 * Wartezeit bis zum Ableiten (Suche/Vorschau): je 256 KB Zustand 5 s länger, höchstens 60 s. Bei großen Notizen kostet
 * jedes Ableiten (ganzes Dokument als JSON + Volltext in die Datenbank) spürbar Zeit – während jemand tippt, soll das
 * nicht alle paar Sekunden passieren. Jede Änderung schiebt den Zeitpunkt nach hinten; Entladen und Job holen es nach.
 */
export function deriveDelayMs(sizeBytes: number): number {
	return Math.min(
		60_000,
		DERIVE_DELAY_MS + Math.floor(Math.max(0, sizeBytes) / (256 * 1024)) * 5_000
	);
}

/**
 * Verdichten nach so vielen Einzel-Updates: mindestens `COMPACT_AFTER_UPDATES`, bei großen Notizen mehr (je 4 KB Zustand
 * ein Update, höchstens 2000) – Verdichten schreibt den ganzen Zustand neu, Laden von 2000 kleinen Updates dauert < 0,2 s.
 */
export function compactThreshold(sizeBytes: number): number {
	return Math.max(COMPACT_AFTER_UPDATES, Math.min(2000, Math.round(Math.max(0, sizeBytes) / 4096)));
}

function scheduleDerive(noteId: string, entry: Entry): void {
	entry.dirty = true;
	if (entry.deriveTimer) clearTimeout(entry.deriveTimer);
	entry.deriveTimer = setTimeout(() => {
		entry.deriveTimer = null;
		void deriveNote(noteId).catch((e) => console.warn('[notes] Ableiten fehlgeschlagen', e));
	}, deriveDelayMs(entry.sizeBytes));
	entry.deriveTimer.unref?.();
}

/** Update speichern (Tabelle) – in der Transaktion des Aufrufers */
async function insertUpdate(
	tx: Tx,
	noteId: string,
	update: Uint8Array,
	userId: string | null
): Promise<void> {
	await tx.execute(
		sql`INSERT INTO note_updates (note_id, data, created_by) VALUES (${noteId}, ${Buffer.from(update)}, ${userId})`
	);
	await tx.execute(
		sql`UPDATE notes SET update_count = update_count + 1, size_bytes = size_bytes + ${update.byteLength},
			updated_at = now(), updated_by = ${userId} WHERE id = ${noteId}`
	);
}

/**
 * Update eines Clients anwenden: prüfen, speichern, anwenden, an die anderen Verbindungen verteilen.
 * Zugriff (edit) prüft der Aufrufer vorher.
 */
export async function applyClientUpdate(
	noteId: string,
	update: Uint8Array,
	opts: { userId: string | null; client: string | null }
): Promise<{ sizeBytes: number }> {
	assertValidUpdate(update);
	return withDocLock(noteId, async () => {
		const entry = await docEntry(noteId);
		if (entry.sizeBytes + update.byteLength > MAX_DOC_BYTES) {
			throw errors.tooLarge(
				`Die Notiz ist zu groß (höchstens ${Math.round(MAX_DOC_BYTES / 1024 / 1024)} MB). Teile sie in Unterseiten auf.`
			);
		}
		await mdb().transaction((tx) => insertUpdate(tx, noteId, update, opts.userId));
		Y.applyUpdate(entry.doc, update, 'client');
		entry.sizeBytes += update.byteLength;
		entry.pending += 1;
		entry.lastUsed = Date.now();
		entry.lastUserId = opts.userId;
		const event: LiveEvent = {
			type: 'update',
			client: opts.client ?? 'server',
			update: b64(update)
		};
		hub.broadcast(noteId, event, opts.client ?? undefined);
		scheduleDerive(noteId, entry);
		if (entry.pending >= compactThreshold(entry.sizeBytes)) await compactLocked(noteId, entry);
		return { sizeBytes: entry.sizeBytes };
	});
}

/** Verdichten: ganzen Zustand nach `notes.ydoc`, Einzel-Updates löschen (unter der Sperre) */
async function compactLocked(noteId: string, entry: Entry): Promise<void> {
	if (!entry.pending) return;
	const state = Y.encodeStateAsUpdate(entry.doc);
	await mdb().transaction(async (tx) => {
		await tx.execute(
			sql`UPDATE notes SET ydoc = ${Buffer.from(state)}, size_bytes = ${state.byteLength} WHERE id = ${noteId}`
		);
		await tx.execute(sql`DELETE FROM note_updates WHERE note_id = ${noteId}`);
	});
	entry.sizeBytes = state.byteLength;
	entry.pending = 0;
}

/** Ausstehendes Ableiten + Verdichten sofort erledigen (Job, Entladen, Tests) */
export async function flushNote(noteId: string): Promise<void> {
	const entry = entries.get(noteId);
	if (!entry) return;
	if (entry.deriveTimer) {
		clearTimeout(entry.deriveTimer);
		entry.deriveTimer = null;
	}
	if (entry.dirty) await deriveNote(noteId);
	await withDocLock(noteId, () => compactLocked(noteId, entry));
}

/** Alle geladenen Notizen verdichten (stündlicher Job) */
export async function flushAll(): Promise<number> {
	let n = 0;
	for (const id of [...entries.keys()]) {
		const e = entries.get(id);
		if (!e?.pending && !e?.dirty) continue;
		await flushNote(id);
		n++;
	}
	return n;
}

/** ProseMirror-JSON eines Yjs-Dokuments (ungültige Knoten fallen über das Schema weg) */
export function jsonOfDoc(doc: Y.Doc): Record<string, unknown> {
	const raw = yXmlFragmentToProsemirrorJSON(doc.getXmlFragment(YDOC_FIELD));
	try {
		const node = noteSchema().nodeFromJSON(raw);
		node.check();
		return node.toJSON() as Record<string, unknown>;
	} catch {
		// Inhalt passt nicht zum Schema (z. B. manipuliert): nur die schemakonformen Blöcke behalten
		const content = Array.isArray(raw.content) ? raw.content : [];
		const kept: unknown[] = [];
		for (const block of content) {
			try {
				const n = noteSchema().nodeFromJSON(block);
				n.check();
				kept.push(n.toJSON());
			} catch {
				// verworfen
			}
		}
		return { type: 'doc', content: kept.length ? kept : [{ type: 'paragraph' }] };
	}
}

/** Abgeleitete Felder neu schreiben (`content_json`, `content_text`) */
export async function deriveNote(noteId: string): Promise<void> {
	const entry = entries.get(noteId);
	if (!entry) return;
	entry.dirty = false;
	const json = jsonOfDoc(entry.doc);
	const text = plainTextOf(json);
	await mdb().transaction(async (tx) => {
		await tx.execute(
			sql`UPDATE notes SET content_json = ${JSON.stringify(json)}::jsonb, content_text = ${text}
				WHERE id = ${noteId}`
		);
	});
}

/**
 * Zustand für einen Client: mit `sv` (State-Vector des Clients) nur die fehlenden Änderungen.
 * Liefert zusätzlich den State-Vector des Servers (der Client schickt damit eigene, noch fehlende Änderungen).
 */
export async function stateFor(
	noteId: string,
	sv: Uint8Array | null
): Promise<{ update: Uint8Array; stateVector: Uint8Array }> {
	const entry = await docEntry(noteId);
	let update: Uint8Array;
	try {
		update = sv ? Y.encodeStateAsUpdate(entry.doc, sv) : Y.encodeStateAsUpdate(entry.doc);
	} catch {
		throw errors.validation([{ path: ['sv'], message: 'Ungültiger State-Vector' }]);
	}
	return { update, stateVector: Y.encodeStateVector(entry.doc) };
}

/** Ganzer Zustand (Versionen, Export) */
export async function fullState(noteId: string): Promise<Uint8Array> {
	return Y.encodeStateAsUpdate((await docEntry(noteId)).doc);
}

/** Aktuelles ProseMirror-JSON (immer frisch aus dem Dokument, nicht aus `content_json`) */
export async function currentJson(noteId: string): Promise<Record<string, unknown>> {
	return jsonOfDoc((await docEntry(noteId)).doc);
}

/**
 * Aktueller Inhalt zum Lesen (Export, Aufräumen): offenes Dokument aus dem Speicher, sonst der gespeicherte
 * Stand – ohne ihn in den Live-Speicher zu laden (große Exporte füllen sonst den Arbeitsspeicher).
 */
export async function snapshotJson(noteId: string): Promise<Record<string, unknown>> {
	const cached = entries.get(noteId);
	if (cached) return jsonOfDoc(cached.doc);
	const { doc } = await loadStoredDoc(noteId);
	try {
		return jsonOfDoc(doc);
	} finally {
		doc.destroy();
	}
}

/**
 * ProseMirror-JSON in ein Yjs-Fragment schreiben. Den Knoten baut UNSER Schema – nicht `prosemirrorJSONToYXmlFragment`:
 * Im Produktions-Build bündelt Vite `@tiptap/y-tiptap` (Modul-Paket) mit einer eigenen Kopie von `prosemirror-model`;
 * dessen `Node.fromJSON` mit unserem Schema scheitert dann („Can not convert … to a Fragment“, mehrere Versionen
 * geladen) – neue Notiz mit Inhalt, Import und Wiederherstellen einer Version brachen ab. Der Weg Knoten → Yjs nutzt
 * nur Eigenschaften der Knoten, keine Klassen.
 */
function writeJson(json: unknown, fragment: Y.XmlFragment): void {
	prosemirrorToYXmlFragment(noteSchema().nodeFromJSON(json), fragment);
}

/** Yjs-Startzustand aus ProseMirror-JSON (neue Notiz, Import) */
export function stateFromJson(json: unknown): Uint8Array {
	const doc = new Y.Doc();
	writeJson(json, doc.getXmlFragment(YDOC_FIELD));
	const state = Y.encodeStateAsUpdate(doc);
	doc.destroy();
	return state;
}

/** ProseMirror-JSON aus gespeichertem Yjs-Zustand (Version) */
export function jsonFromState(state: Uint8Array): Record<string, unknown> {
	const doc = new Y.Doc();
	Y.applyUpdate(doc, state);
	const json = jsonOfDoc(doc);
	doc.destroy();
	return json;
}

/**
 * Inhalt vollständig ersetzen (Version wiederherstellen): eine Yjs-Transaktion auf dem Live-Dokument, die
 * als normales Update gespeichert und verteilt wird – offene Editoren übernehmen sie ohne Neuladen.
 */
export async function replaceContent(
	noteId: string,
	json: unknown,
	userId: string | null
): Promise<void> {
	await withDocLock(noteId, async () => {
		const entry = await docEntry(noteId);
		const updates: Uint8Array[] = [];
		const onUpdate = (u: Uint8Array) => updates.push(u);
		entry.doc.on('update', onUpdate);
		try {
			entry.doc.transact(() => {
				const fragment = entry.doc.getXmlFragment(YDOC_FIELD);
				if (fragment.length) fragment.delete(0, fragment.length);
				writeJson(json, fragment);
			}, 'server');
		} finally {
			entry.doc.off('update', onUpdate);
		}
		if (!updates.length) return;
		const merged = Y.mergeUpdates(updates);
		await mdb().transaction((tx) => insertUpdate(tx, noteId, merged, userId));
		entry.sizeBytes += merged.byteLength;
		entry.pending += 1;
		entry.lastUserId = userId;
		hub.broadcast(noteId, {
			type: 'update',
			client: 'server',
			update: b64(merged)
		} satisfies LiveEvent);
		scheduleDerive(noteId, entry);
		await compactLocked(noteId, entry);
	});
	await flushNote(noteId);
}

/** Notiz gelöscht/endgültig entfernt: aus dem Speicher nehmen */
export function dropDoc(noteId: string): void {
	const e = entries.get(noteId);
	if (!e) return;
	if (e.deriveTimer) clearTimeout(e.deriveTimer);
	e.doc.destroy();
	entries.delete(noteId);
}

/**
 * Daten wurden außerhalb des Moduls ersetzt (Zurücksetzen, Wiederherstellen): alle Dokumente im Speicher
 * verwerfen, OHNE sie zurückzuschreiben, und offene Editoren neu laden lassen (`reset`).
 */
export function discardAllDocs(): void {
	generation++;
	for (const id of [...entries.keys()]) dropDoc(id);
	loading.clear();
	hub.closeAll({ type: 'reset' } satisfies LiveEvent);
}

/** Asset-IDs im aktuellen Inhalt (Aufräumen nicht mehr genutzter Bilder) */
export async function usedAssetIds(noteId: string): Promise<Set<string>> {
	return new Set(assetIdsOf(await snapshotJson(noteId)));
}

/** Für Tests: alles verdichten/ableiten und den Speicher leeren */
export async function resetDocsForTests(): Promise<void> {
	for (const id of [...entries.keys()]) {
		try {
			await flushNote(id);
		} catch {
			// Notiz evtl. schon gelöscht
		}
		dropDoc(id);
	}
	if (sweeper) clearInterval(sweeper);
	sweeper = null;
}

/** Für Tests: ausstehendes Ableiten sofort ausführen */
export async function flushAllForTests(): Promise<void> {
	for (const id of [...entries.keys()]) await flushNote(id).catch(() => undefined);
}
