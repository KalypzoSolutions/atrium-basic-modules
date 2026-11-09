/**
 * Seitenbaum der Notizen: Zeilen laden (in der Transaktion), zu `NoteNode`/`NoteDetail` aufbauen (danach, mit
 * Benutzernamen), Pfade aus sichtbaren Oberseiten, Positionen unter Geschwistern und Teilbaum-Operationen
 * (Papierkorb, endgültig löschen).
 */
import { sql, type SQL } from 'drizzle-orm';
import {
	core,
	errors,
	inList,
	num,
	type RequestContext,
	rowsOf,
	type Row,
	toIso,
	type Tx
} from '$lib/sdk/server';
import {
	accessForMany,
	canEditAll,
	lockNote,
	lockRoots,
	MAX_WALK,
	noteContextOf,
	requireNoteAccess
} from './access';
import { mdb, refOf, userRefs } from './db';
import { excerptOf } from './doc/text';
import { PERM, type Breadcrumb, type NoteDetail, type NoteNode, type ShareLevel } from './schemas';

export type AccessEntry = { level: ShareLevel; isOwner: boolean; canShare: boolean };

/** Spalten einer Notiz für Listen (Alias `n`) */
export const NODE_COLUMNS = sql`n.id, n.parent_id, n.title, n.icon, n.color, n.position, n.owner_id, n.action_id,
	n.updated_at, n.updated_by, n.created_at, n.size_bytes, n.content_text,
	EXISTS (SELECT 1 FROM notes c WHERE c.parent_id = n.id AND c.deleted_at IS NULL) AS has_children,
	EXISTS (SELECT 1 FROM note_shares s WHERE s.note_id = n.id) AS shared,
	EXISTS (
		WITH RECURSIVE up AS (
			SELECT u.id, u.parent_id, 0 AS depth FROM notes u WHERE u.id = n.id
			UNION ALL
			SELECT p.id, p.parent_id, up.depth + 1 FROM notes p JOIN up ON p.id = up.parent_id
			WHERE up.depth < ${MAX_WALK}
		)
		SELECT 1 FROM up JOIN note_shares es ON es.note_id = up.id AND es.principal_type = 'everyone'
	) AS stamm`;

export interface NodeData {
	rows: Row[];
	access: Map<string, AccessEntry>;
}

const bool = (v: unknown) => v === true || v === 't';
const strOrNull = (v: unknown) => (v == null ? null : String(v));

/** Notizen laden (nur die mit Zugriff; `where`/`order` mit Alias `n`) */
export async function loadNodes(
	tx: Tx,
	ctx: RequestContext,
	where: SQL,
	opts: { order?: SQL; limit?: number } = {}
): Promise<NodeData> {
	const rows = await rowsOf(
		tx,
		sql`SELECT ${NODE_COLUMNS} FROM notes n WHERE ${where}
			ORDER BY ${opts.order ?? sql`n.position, n.title, n.id`}
			${opts.limit ? sql`LIMIT ${opts.limit}` : sql``}`
	);
	const access = await accessForMany(
		tx,
		ctx,
		rows.map((r) => String(r.id))
	);
	return { rows: rows.filter((r) => access.has(String(r.id))), access };
}

/** Eintrag ohne Benutzer-Anzeige (für `buildNodes`/`buildDetail`) */
function nodeOf(
	r: Row,
	a: AccessEntry,
	users: ReadonlyMap<string, { id: string; name: string; image: string | null }>,
	withExcerpt: boolean
): NoteNode {
	const node: NoteNode = {
		id: String(r.id),
		parentId: strOrNull(r.parent_id),
		title: String(r.title ?? ''),
		icon: strOrNull(r.icon),
		color: strOrNull(r.color),
		position: num(r.position),
		hasChildren: bool(r.has_children),
		ownerId: strOrNull(r.owner_id),
		actionId: strOrNull(r.action_id),
		level: a.level,
		isOwner: a.isOwner,
		canShare: a.canShare,
		stamm: bool(r.stamm),
		shared: bool(r.shared),
		updatedAt: toIso(r.updated_at),
		updatedBy: refOf(users, strOrNull(r.updated_by))
	};
	if (withExcerpt) node.excerpt = excerptOf(String(r.content_text ?? ''));
	return node;
}

/** Zeilen → `NoteNode[]` (NACH der Transaktion, löst Namen auf) */
export async function buildNodes(
	ctx: RequestContext,
	data: NodeData,
	opts: { excerpt?: boolean } = {}
): Promise<NoteNode[]> {
	const users = await userRefs(
		ctx,
		data.rows.map((r) => strOrNull(r.updated_by))
	);
	return data.rows.map((r) => nodeOf(r, data.access.get(String(r.id))!, users, !!opts.excerpt));
}

// --- Oberseiten / Pfade -----------------------------------------------------------

/** Oberseiten (ohne die Seite selbst) je Seite, von der Wurzel abwärts */
export async function ancestorsOf(
	tx: Tx,
	ids: readonly string[]
): Promise<Map<string, { id: string; title: string; icon: string | null }[]>> {
	const map = new Map<string, { id: string; title: string; icon: string | null }[]>();
	const unique = [...new Set(ids)];
	if (!unique.length) return map;
	const rows = await rowsOf(
		tx,
		sql`WITH RECURSIVE up AS (
			SELECT n.id AS start_id, n.parent_id, 0 AS depth FROM notes n WHERE n.id IN (${inList(unique)})
			UNION ALL
			SELECT up.start_id, p.parent_id, up.depth + 1 FROM notes p JOIN up ON p.id = up.parent_id
			WHERE up.depth < ${MAX_WALK}
		)
		SELECT up.start_id, a.id, a.title, a.icon, up.depth
		FROM up JOIN notes a ON a.id = up.parent_id
		ORDER BY up.start_id, up.depth DESC`
	);
	for (const id of unique) map.set(id, []);
	for (const r of rows) {
		map.get(String(r.start_id))?.push({
			id: String(r.id),
			title: String(r.title ?? ''),
			icon: strOrNull(r.icon)
		});
	}
	return map;
}

/** Sichtbare Oberseiten je Seite (Zugriff vererbt sich nach unten → zugängliche bilden das Ende der Kette) */
export async function visibleAncestors(
	tx: Tx,
	ctx: RequestContext,
	ids: readonly string[]
): Promise<Map<string, Breadcrumb[]>> {
	const all = await ancestorsOf(tx, ids);
	const access = await accessForMany(
		tx,
		ctx,
		[...all.values()].flat().map((a) => a.id)
	);
	const out = new Map<string, Breadcrumb[]>();
	for (const [id, chain] of all) {
		const first = chain.findIndex((a) => access.has(a.id));
		out.set(id, first < 0 ? [] : chain.slice(first));
	}
	return out;
}

export const pathText = (crumbs: readonly Breadcrumb[]) =>
	crumbs.map((c) => c.title || 'Ohne Titel').join(' › ');

// --- Detail ------------------------------------------------------------------------

/** Detail einer Notiz (eigene Transaktion + Namen danach) */
export async function noteDetail(ctx: RequestContext, noteId: string): Promise<NoteDetail> {
	const data = await mdb().transaction(async (tx) => {
		const access = await requireNoteAccess(tx, ctx, noteId);
		const [row] = await rowsOf(tx, sql`SELECT ${NODE_COLUMNS} FROM notes n WHERE n.id = ${noteId}`);
		if (!row) throw errors.notFound('Notiz nicht gefunden');
		const crumbs = (await visibleAncestors(tx, ctx, [noteId])).get(noteId) ?? [];
		return { access, row, crumbs };
	});
	const { access, row, crumbs } = data;
	const users = await userRefs(ctx, [strOrNull(row.owner_id), strOrNull(row.updated_by)]);
	const node = nodeOf(
		row,
		{ level: access.level, isOwner: access.isOwner, canShare: access.canShare },
		users,
		false
	);
	const rootActionId = access.chain[0]?.actionId ?? null;
	return {
		...node,
		owner: refOf(users, node.ownerId),
		breadcrumbs: crumbs,
		actionName: rootActionId ? (noteContextOf(ctx).actionNames.get(rootActionId) ?? null) : null,
		sizeBytes: num(row.size_bytes),
		createdAt: toIso(row.created_at),
		canCreateChild: access.level === 'edit'
	};
}

// --- Positionen ----------------------------------------------------------------------

/** Container einer Seite: Kinder einer Oberseite oder Wurzeln einer Person */
export type Container = { parentId: string } | { ownerId: string | null };

function containerWhere(c: Container): SQL {
	if ('parentId' in c) return sql`parent_id = ${c.parentId}`;
	return c.ownerId
		? sql`parent_id IS NULL AND owner_id = ${c.ownerId}`
		: sql`parent_id IS NULL AND owner_id IS NULL`;
}

/** Sperre auf einen Container (Positionen) */
export async function lockContainer(tx: Tx, c: Container): Promise<void> {
	if ('parentId' in c) await lockNote(tx, c.parentId);
	else if (c.ownerId) await lockRoots(tx, c.ownerId);
}

/** Nächste freie Position (ans Ende) – unter `lockContainer` */
export async function nextPosition(tx: Tx, c: Container): Promise<number> {
	const [r] = await rowsOf(
		tx,
		sql`SELECT COALESCE(MAX(position), -1) + 1 AS p FROM notes WHERE ${containerWhere(c)}`
	);
	return num(r?.p);
}

/** Anzahl nicht gelöschter Kinder */
export async function childCount(tx: Tx, parentId: string): Promise<number> {
	const [r] = await rowsOf(
		tx,
		sql`SELECT count(*)::int AS n FROM notes WHERE parent_id = ${parentId} AND deleted_at IS NULL`
	);
	return num(r?.n);
}

/**
 * Geschwister neu nummerieren (0, 1, …); `insert` setzt eine Seite an Index `at` (unter `lockContainer`).
 * Gelöschte Seiten bleiben unberührt.
 */
export async function renumber(
	tx: Tx,
	c: Container,
	insert?: { id: string; at: number }
): Promise<void> {
	const rows = await rowsOf(
		tx,
		sql`SELECT id FROM notes WHERE ${containerWhere(c)} AND deleted_at IS NULL
			${insert ? sql`AND id <> ${insert.id}` : sql``}
			ORDER BY position, title, id`
	);
	const ids = rows.map((r) => String(r.id));
	if (insert) ids.splice(Math.max(0, Math.min(insert.at, ids.length)), 0, insert.id);
	for (let i = 0; i < ids.length; i++) {
		await tx.execute(
			sql`UPDATE notes SET position = ${i} WHERE id = ${ids[i]!} AND position <> ${i}`
		);
	}
}

// --- Teilbaum ----------------------------------------------------------------------

/** Seite + Nachfahren, ohne in schon gelöschte (bzw. eigene Papierkorb-) Teilbäume abzusteigen */
export async function liveSubtree(
	tx: Tx,
	noteId: string,
	stop: 'deleted' | 'trash-root'
): Promise<string[]> {
	const cond = stop === 'deleted' ? sql`c.deleted_at IS NULL` : sql`NOT c.trash_root`;
	const rows = await rowsOf(
		tx,
		sql`WITH RECURSIVE down AS (
			SELECT n.id, 0 AS depth FROM notes n WHERE n.id = ${noteId}
			UNION ALL
			SELECT c.id, down.depth + 1 FROM notes c JOIN down ON c.parent_id = down.id
			WHERE ${cond} AND down.depth < ${MAX_WALK}
		)
		SELECT id FROM down`
	);
	return rows.map((r) => String(r.id));
}

const pathsOf = (v: unknown): string[] =>
	Object.values(
		((typeof v === 'string' ? JSON.parse(v) : v) ?? {}) as Record<string, string>
	).filter((p): p is string => typeof p === 'string' && !!p);

/** Speicherpfade aller Dateien der Seiten */
export async function assetPathsOf(tx: Tx, noteIds: readonly string[]): Promise<string[]> {
	if (!noteIds.length) return [];
	const rows = await rowsOf(
		tx,
		sql`SELECT paths FROM note_assets WHERE note_id IN (${inList([...noteIds])})`
	);
	return rows.flatMap((r) => pathsOf(r.paths));
}

/** Teilbäume endgültig löschen (in der Transaktion) → betroffene Seiten und Dateipfade (danach entfernen) */
export async function purgeSubtrees(
	tx: Tx,
	rootIds: readonly string[]
): Promise<{ noteIds: string[]; paths: string[] }> {
	const noteIds: string[] = [];
	const paths: string[] = [];
	for (const id of rootIds) {
		const rows = await rowsOf(
			tx,
			sql`WITH RECURSIVE down AS (
				SELECT n.id, 0 AS depth FROM notes n WHERE n.id = ${id}
				UNION ALL
				SELECT c.id, down.depth + 1 FROM notes c JOIN down ON c.parent_id = down.id
				WHERE down.depth < ${MAX_WALK}
			)
			SELECT id FROM down`
		);
		const ids = rows.map((r) => String(r.id));
		if (!ids.length) continue;
		paths.push(...(await assetPathsOf(tx, ids)));
		await tx.execute(sql`DELETE FROM notes WHERE id = ${id}`);
		noteIds.push(...ids);
	}
	return { noteIds, paths };
}

/** Recht „Notizen anlegen“ (neue Wurzeln) */
export const canCreate = (ctx: RequestContext) =>
	ctx.actor.type === 'system' || core.permissions.has(ctx, PERM.create);

/** Aktion verknüpfen: nur mit Bearbeiten-Zugriff auf die Aktion (sonst 422) */
export function assertActionEditable(ctx: RequestContext, actionId: string | null | undefined) {
	if (!actionId) return;
	if (!canEditAll(ctx) && noteContextOf(ctx).actions.get(actionId) !== 'edit') {
		throw errors.validation([
			{ path: ['actionId'], message: 'Aktion nicht gefunden oder ohne Bearbeiten-Recht' }
		]);
	}
}

/** LIKE-Muster mit maskierten Platzhaltern */
export const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
