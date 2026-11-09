/**
 * Objektbezogener Zugriff auf Notizen (Seitenbaum). Basisrecht `notes.note.view` prüft der Router.
 *
 *   - System, `notes.note.edit-all`                                   -> bearbeiten + teilen/löschen (alles)
 *   - Eigentümer*in der Seite oder einer Oberseite (`owner_id`)        -> bearbeiten + teilen/löschen
 *   - Freigabe auf der Seite ODER einer Oberseite (vererbt, `everyone:*` = Stamm), höchste Stufe gewinnt
 *   - Wurzel hängt an einer Aktion (`action_id`) → Stufe der Aktion (`ActionsService.accessibleActions`)
 *   - `notes.note.view-all`                                            -> mindestens lesen
 *   - Papierkorb (Seite oder Oberseite gelöscht) und sonst              -> 404 (Existenz nicht verraten)
 *
 * Teilen, Löschen, Verschieben aus dem Teilbaum heraus und Aktion wechseln: nur Eigentümer*in bzw. `edit-all`
 * (eine Bearbeiten-Freigabe reicht nicht, sonst ließen sich fremde Inhalte weiterverteilen – wie `files`).
 *
 * Principal-Schlüssel und Aktions-Zugriffe rufen Core bzw. `actions` auf und stehen daher VOR der Transaktion fest
 * (`loadNoteContext`, für alle Endpoints über `withNoteContext`).
 */
import { sql, type SQL } from 'drizzle-orm';
import {
	core,
	errors,
	inList,
	principalKeysFor,
	principalMatchSql,
	rowsOf,
	toIso,
	type AnyApiEndpoint,
	type RequestContext,
	type ShareTable,
	type Tx
} from '$lib/sdk/server';
import type { ActionsService } from './peer-contracts';
import { MODULE_ID, PERM, type ShareLevel } from './schemas';

/** Freigabe-Tabelle für die SDK-Bausteine (`loadObjectShares`, `replaceObjectShares`) */
export const NOTE_SHARES: ShareTable = { shareTable: 'note_shares', fk: 'note_id' };

/** Schutz gegen Zyklen beim Hochlaufen (MAX_DEPTH ist deutlich kleiner) */
export const MAX_WALK = 64;

export interface NoteContext {
	keys: readonly string[];
	/** Zugriffsstufe je sichtbarer Aktion (nur mit aktivem `actions`) */
	actions: ReadonlyMap<string, ShareLevel>;
	actionNames: ReadonlyMap<string, string>;
	actionsAvailable: boolean;
}

const store = new WeakMap<RequestContext, NoteContext>();

export async function actionsService(): Promise<ActionsService | null> {
	return core.modules.useOptional<ActionsService>('actions', MODULE_ID);
}

/** Schlüssel und Aktions-Zugriffe des Aufrufers ermitteln (nie in einer Transaktion) */
export async function loadNoteContext(ctx: RequestContext): Promise<NoteContext> {
	const keys = ctx.userId ? await principalKeysFor(ctx, MODULE_ID) : [];
	const service = await actionsService();
	const list = service ? await service.accessibleActions(ctx) : [];
	const value: NoteContext = {
		keys,
		actions: new Map(list.map((a) => [a.id, a.level])),
		actionNames: new Map(list.map((a) => [a.id, a.name])),
		actionsAvailable: !!service
	};
	store.set(ctx, value);
	return value;
}

export function noteContextOf(ctx: RequestContext): NoteContext {
	const value = store.get(ctx);
	if (!value) throw new Error('notes: loadNoteContext(ctx) fehlt vor der Transaktion');
	return value;
}

/** Kurzzeit-Cache für die häufigen Live-Aufrufe (der Editor schickt etwa alle 100 ms) */
const HOT_TTL_MS = 5_000;
const hot = new Map<string, { at: number; value: NoteContext }>();

function hotKey(ctx: RequestContext): string {
	return `${ctx.actor.type}:${ctx.actor.id ?? ''}:${ctx.userId ?? ''}:${[...ctx.permissions].sort().join(',')}`;
}

/** Wie `loadNoteContext`, aber je Person und Rechten bis zu 5 s wiederverwendet (nur Live-Updates) */
export async function loadNoteContextCached(ctx: RequestContext): Promise<NoteContext> {
	const key = hotKey(ctx);
	const now = Date.now();
	const cached = hot.get(key);
	if (cached && now - cached.at < HOT_TTL_MS) {
		store.set(ctx, cached.value);
		return cached.value;
	}
	const value = await loadNoteContext(ctx);
	if (hot.size > 1000) {
		for (const [k, v] of hot) if (now - v.at >= HOT_TTL_MS) hot.delete(k);
	}
	hot.set(key, { at: now, value });
	return value;
}

/** Ohne Zugriffskontext (prüft nur die eigene Live-Verbindung) bzw. mit Kurzzeit-Cache */
const NO_CONTEXT = new Set(['/notes/:id/awareness']);
const CACHED_CONTEXT = new Set(['/notes/:id/updates']);

/** Endpoints so einhüllen, dass der Zugriffskontext vor dem Handler feststeht */
export function withNoteContext(endpoints: AnyApiEndpoint[]): AnyApiEndpoint[] {
	return endpoints.map((endpoint) => {
		if (NO_CONTEXT.has(endpoint.path)) return endpoint;
		const load = CACHED_CONTEXT.has(endpoint.path) ? loadNoteContextCached : loadNoteContext;
		const handler = endpoint.handler;
		return {
			...endpoint,
			handler: async (args: Parameters<typeof handler>[0]) => {
				await load(args.ctx);
				return handler(args);
			}
		};
	});
}

export function canEditAll(ctx: RequestContext): boolean {
	return ctx.actor.type === 'system' || core.permissions.has(ctx, PERM.editAll);
}

export function canViewAll(ctx: RequestContext): boolean {
	return canEditAll(ctx) || core.permissions.has(ctx, PERM.viewAll);
}

export const maxLevel = (a: ShareLevel | null, b: ShareLevel | null): ShareLevel | null =>
	a === 'edit' || b === 'edit' ? 'edit' : (a ?? b);

/** Eine Seite der Kette (Seite selbst zuletzt) */
export interface ChainNode {
	id: string;
	parentId: string | null;
	title: string;
	icon: string | null;
	ownerId: string | null;
	actionId: string | null;
	deletedAt: string | null;
}

/** Oberseiten-Kette ab der Wurzel bis zur Seite (inkl.); leer, wenn unbekannt */
export async function chainOf(tx: Tx, noteId: string): Promise<ChainNode[]> {
	const rows = await rowsOf(
		tx,
		sql`WITH RECURSIVE up AS (
			SELECT n.id, n.parent_id, n.title, n.icon, n.owner_id, n.action_id, n.deleted_at, 0 AS depth
			FROM notes n WHERE n.id = ${noteId}
			UNION ALL
			SELECT p.id, p.parent_id, p.title, p.icon, p.owner_id, p.action_id, p.deleted_at, up.depth + 1
			FROM notes p JOIN up ON p.id = up.parent_id
			WHERE up.depth < ${MAX_WALK}
		)
		SELECT * FROM up ORDER BY depth DESC`
	);
	return rows.map((r) => ({
		id: String(r.id),
		parentId: r.parent_id == null ? null : String(r.parent_id),
		title: String(r.title ?? ''),
		icon: r.icon == null ? null : String(r.icon),
		ownerId: r.owner_id == null ? null : String(r.owner_id),
		actionId: r.action_id == null ? null : String(r.action_id),
		deletedAt: r.deleted_at == null ? null : toIso(r.deleted_at)
	}));
}

export interface NoteAccess {
	level: ShareLevel;
	/** Eigentümer*in (Seite oder Oberseite) */
	isOwner: boolean;
	/** teilen, löschen, aus dem Teilbaum verschieben, Aktion wechseln */
	canShare: boolean;
	chain: ChainNode[];
}

/** Stufe einer Kette ohne Datenbank (für Listen nutzt `accessForMany` dieselben Regeln in SQL) */
function levelFromChain(
	ctx: RequestContext,
	chain: readonly ChainNode[],
	shared: ShareLevel | null
): { level: ShareLevel | null; isOwner: boolean } {
	const isOwner = !!ctx.userId && chain.some((n) => n.ownerId === ctx.userId);
	if (canEditAll(ctx) || isOwner) return { level: 'edit', isOwner };
	let level = shared;
	const root = chain[0];
	if (root?.actionId) {
		const nc = noteContextOf(ctx);
		level = maxLevel(level, nc.actions.get(root.actionId) ?? null);
	}
	if (canViewAll(ctx)) level = maxLevel(level, 'read');
	return { level, isOwner };
}

async function sharedLevelOnChain(
	tx: Tx,
	ctx: RequestContext,
	ids: readonly string[]
): Promise<ShareLevel | null> {
	const keys = canEditAll(ctx) ? [] : noteContextOf(ctx).keys;
	if (!ids.length || !keys.length) return null;
	const rows = await rowsOf(
		tx,
		sql`SELECT DISTINCT s.level FROM note_shares s
			WHERE s.note_id IN (${inList([...ids])}) AND ${principalMatchSql('s', keys)}`
	);
	if (rows.some((r) => r.level === 'edit')) return 'edit';
	return rows.length ? 'read' : null;
}

/**
 * Zugriff auf eine Seite oder `null` (unbekannt, im Papierkorb oder kein Zugriff).
 * `includeDeleted` nur für Papierkorb-Abläufe (Wiederherstellen/endgültig löschen).
 */
export async function resolveNoteAccess(
	tx: Tx,
	ctx: RequestContext,
	noteId: string,
	opts: { includeDeleted?: boolean } = {}
): Promise<NoteAccess | null> {
	const chain = await chainOf(tx, noteId);
	const self = chain[chain.length - 1];
	if (!self || self.id !== noteId) return null;
	if (!opts.includeDeleted && chain.some((n) => n.deletedAt !== null)) return null;
	const pre = levelFromChain(ctx, chain, null);
	const level =
		pre.level === 'edit'
			? 'edit'
			: maxLevel(
					pre.level,
					await sharedLevelOnChain(
						tx,
						ctx,
						chain.map((n) => n.id)
					)
				);
	if (!level) return null;
	return { level, isOwner: pre.isOwner, canShare: canEditAll(ctx) || pre.isOwner, chain };
}

export async function requireNoteAccess(
	tx: Tx,
	ctx: RequestContext,
	noteId: string,
	need: 'read' | 'edit' | 'share' = 'read',
	opts: { includeDeleted?: boolean } = {}
): Promise<NoteAccess> {
	const access = await resolveNoteAccess(tx, ctx, noteId, opts);
	if (!access) throw errors.notFound('Notiz nicht gefunden');
	if (need === 'edit' && access.level !== 'edit') {
		throw errors.forbidden('Keine Berechtigung zum Bearbeiten dieser Notiz');
	}
	if (need === 'share' && !access.canShare) {
		throw errors.forbidden(
			'Nur die Eigentümer*in darf diese Notiz teilen, löschen, verschieben oder einer Aktion zuordnen'
		);
	}
	return access;
}

/** Stufe je Seite für Listen (ein Abfrageschritt, Vererbung + Aktion + Eigentum berücksichtigt) */
export async function accessForMany(
	tx: Tx,
	ctx: RequestContext,
	ids: readonly string[]
): Promise<Map<string, { level: ShareLevel; isOwner: boolean; canShare: boolean }>> {
	const map = new Map<string, { level: ShareLevel; isOwner: boolean; canShare: boolean }>();
	const unique = [...new Set(ids)];
	if (!unique.length) return map;
	const editAll = canEditAll(ctx);
	const nc = editAll ? null : noteContextOf(ctx);
	const keys = nc?.keys ?? [];
	const uid = ctx.userId ?? '';
	const rows = await rowsOf(
		tx,
		sql`WITH RECURSIVE chain AS (
			SELECT n.id AS start_id, n.id, n.parent_id, n.owner_id, n.action_id, 0 AS depth
			FROM notes n WHERE n.id IN (${inList(unique)})
			UNION ALL
			SELECT c.start_id, p.id, p.parent_id, p.owner_id, p.action_id, c.depth + 1
			FROM chain c JOIN notes p ON p.id = c.parent_id
			WHERE c.depth < ${MAX_WALK}
		)
		SELECT c.start_id,
			bool_or(c.owner_id = ${uid}) AS owner,
			MAX(CASE WHEN c.parent_id IS NULL THEN c.action_id END) AS action_id,
			MAX(CASE WHEN s.level = 'edit' THEN 2 WHEN s.level = 'read' THEN 1 ELSE 0 END) AS lvl
		FROM chain c
		LEFT JOIN note_shares s ON s.note_id = c.id
			AND ${keys.length ? principalMatchSql('s', keys) : sql`FALSE`}
		GROUP BY c.start_id`
	);
	const viewAll = canViewAll(ctx);
	for (const r of rows) {
		const id = String(r.start_id);
		const isOwner = !!ctx.userId && (r.owner === true || r.owner === 't');
		let level: ShareLevel | null =
			Number(r.lvl) >= 2 ? 'edit' : Number(r.lvl) === 1 ? 'read' : null;
		if (editAll || isOwner) level = 'edit';
		else {
			if (r.action_id && nc) level = maxLevel(level, nc.actions.get(String(r.action_id)) ?? null);
			if (viewAll) level = maxLevel(level, 'read');
		}
		if (level) map.set(id, { level, isOwner, canShare: editAll || isOwner });
	}
	return map;
}

/**
 * SQL-Bedingung „Seite ist für den Aufrufer sichtbar“ (Alias `alias`, Papierkorb NICHT berücksichtigt –
 * dafür `notInTrashSql`). Für Suche, „zuletzt bearbeitet“ und Aktionslisten.
 */
export function visibleNotesSql(ctx: RequestContext, alias: string): SQL {
	if (canViewAll(ctx)) return sql`TRUE`;
	if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error(`Ungültiger Alias: ${alias}`);
	const nc = noteContextOf(ctx);
	const a = sql.raw(alias);
	const uid = ctx.userId ?? '';
	const actionIds = [...nc.actions.keys()];
	return sql`EXISTS (
		WITH RECURSIVE up AS (
			SELECT v.id, v.parent_id, v.owner_id, v.action_id, 0 AS depth FROM notes v WHERE v.id = ${a}.id
			UNION ALL
			SELECT p.id, p.parent_id, p.owner_id, p.action_id, up.depth + 1 FROM notes p JOIN up ON p.id = up.parent_id
			WHERE up.depth < ${MAX_WALK}
		)
		SELECT 1 FROM up
		WHERE up.owner_id = ${uid}
			OR ${actionIds.length ? sql`(up.parent_id IS NULL AND up.action_id IN (${inList(actionIds)}))` : sql`FALSE`}
			OR ${
				nc.keys.length
					? sql`EXISTS (SELECT 1 FROM note_shares vs WHERE vs.note_id = up.id AND ${principalMatchSql('vs', nc.keys)})`
					: sql`FALSE`
			}
	)`;
}

/** SQL-Bedingung „weder Seite noch Oberseite im Papierkorb“ */
export function notInTrashSql(alias: string): SQL {
	if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error(`Ungültiger Alias: ${alias}`);
	const a = sql.raw(alias);
	return sql`${a}.deleted_at IS NULL AND NOT EXISTS (
		WITH RECURSIVE up AS (
			SELECT t.parent_id, 0 AS depth FROM notes t WHERE t.id = ${a}.id
			UNION ALL
			SELECT p.parent_id, up.depth + 1 FROM notes p JOIN up ON p.id = up.parent_id
			WHERE up.depth < ${MAX_WALK}
		)
		SELECT 1 FROM up JOIN notes d ON d.id = up.parent_id WHERE d.deleted_at IS NOT NULL
	)`;
}

/** Haben zwei Oberseiten-Ketten dieselben (vererbten) Freigaben? Für Verschieben ohne Teilen-Recht */
export async function sameInheritedShares(
	tx: Tx,
	before: readonly string[],
	after: readonly string[]
): Promise<boolean> {
	const setOf = async (ids: readonly string[]) => {
		if (!ids.length) return '';
		const rows = await rowsOf(
			tx,
			sql`SELECT s.principal_type, s.principal_id, bool_or(s.level = 'edit') AS edit FROM note_shares s
				WHERE s.note_id IN (${inList([...ids])})
				GROUP BY s.principal_type, s.principal_id`
		);
		return rows
			.map(
				(r) =>
					`${String(r.principal_type)}:${String(r.principal_id)}:${r.edit === true || r.edit === 't' ? 'edit' : 'read'}`
			)
			.sort()
			.join('|');
	};
	return (await setOf(before)) === (await setOf(after));
}

/** Tiefe einer Seite (Wurzel = 1) aus ihrer Kette */
export const depthOf = (chain: readonly ChainNode[]) => chain.length;

/** Höhe des Teilbaums unter einer Seite (nur die Seite = 1) */
export async function subtreeHeight(tx: Tx, noteId: string): Promise<number> {
	const [r] = await rowsOf(
		tx,
		sql`WITH RECURSIVE down AS (
			SELECT n.id, 1 AS depth FROM notes n WHERE n.id = ${noteId}
			UNION ALL
			SELECT c.id, down.depth + 1 FROM notes c JOIN down ON c.parent_id = down.id
			WHERE down.depth < ${MAX_WALK}
		)
		SELECT MAX(depth) AS h FROM down`
	);
	return Number(r?.h ?? 1);
}

/** IDs des Teilbaums (inkl. Seite selbst) */
export async function subtreeIds(tx: Tx, noteId: string): Promise<string[]> {
	const rows = await rowsOf(
		tx,
		sql`WITH RECURSIVE down AS (
			SELECT n.id, 0 AS depth FROM notes n WHERE n.id = ${noteId}
			UNION ALL
			SELECT c.id, down.depth + 1 FROM notes c JOIN down ON c.parent_id = down.id
			WHERE down.depth < ${MAX_WALK}
		)
		SELECT id FROM down`
	);
	return rows.map((r) => String(r.id));
}

/** Advisory-Sperre je Notiz (Positionen der Kinder, Verdichtung) */
export async function lockNote(tx: Tx, noteId: string): Promise<void> {
	await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`notes:note:${noteId}`}))`);
}

/** Advisory-Sperre für die Wurzel-Liste einer Person (Positionen) */
export async function lockRoots(tx: Tx, ownerId: string): Promise<void> {
	await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`notes:roots:${ownerId}`}))`);
}
