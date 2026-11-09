/**
 * Papierkorb: Löschen in den Papierkorb, Wiederherstellen, endgültig Löschen, Ablauf (Job).
 * Dateien im Storage erst NACH der Transaktion entfernen (`removeObjects`).
 *
 * Modell: Alle Knoten eines gelöschten Teilbaums haben `deleted_at`, nur die Wurzel `trash_root = true`.
 * Ein Teilbaum kann bereits früher gelöschte Unterbäume enthalten (eigene `trash_root`); diese gehören
 * NICHT zum äußeren Eintrag (Wiederherstellen des äußeren lässt sie im Papierkorb). Endgültiges Löschen des
 * äußeren entfernt sie per CASCADE mit.
 */
import { sql } from 'drizzle-orm';
import { todayBerlin } from '$lib/sdk/dates';
import { core, errors, inList, type RequestContext, rowsOf, toIso, type Tx } from '$lib/sdk/server';
import { accessForMany, canManageAll, requireNode, resolveAccess, rootAccess } from './access';
import {
	ancestorsOf,
	filesSettings,
	loadNode,
	loadNodes,
	mdb,
	nodeRowOf,
	NODE_COLUMNS,
	userRefs,
	type NodeRow
} from './db';
import { displayPath, uniqueName } from './names';
import { siblingNames } from './nodes.service';
import { keysFor } from './shares.service';
import { removeObjects } from './storage';
import { ROOT_LABEL, type BulkResult, type TrashItem } from './schemas';

/** Höchstzahl Papierkorb-Einträge je Job-Lauf (Rest beim nächsten Lauf) */
const PURGE_BATCH = 500;
/** Höchstzahl Einträge in der Papierkorb-Liste */
const MAX_TRASH_LIST = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * IDs der Teilbäume unter `rootIds` (inkl. der Wurzeln). Mit `ownOnly` endet der Abstieg an
 * verschachtelten Papierkorb-Wurzeln (die gehören zu einem eigenen Eintrag).
 */
async function subtree(
	tx: Tx,
	rootIds: readonly string[],
	ownOnly: boolean
): Promise<{ root: string; id: string }[]> {
	if (rootIds.length === 0) return [];
	const rows = await rowsOf(
		tx,
		sql`WITH RECURSIVE t(root, id) AS (
				SELECT id, id FROM nodes WHERE id IN (${inList(rootIds)})
				UNION ALL
				SELECT t.root, n.id FROM nodes n JOIN t ON n.parent_id = t.id
				WHERE ${ownOnly ? sql`NOT n.trash_root` : sql`TRUE`}
			)
			SELECT root, id FROM t`
	);
	return rows.map((r) => ({ root: String(r.root), id: String(r.id) }));
}

/** Darf der Aufrufer diesen Papierkorb-Eintrag sehen/wiederherstellen/löschen? */
async function canSeeTrashRoot(
	tx: Tx,
	ctx: RequestContext,
	node: NodeRow,
	keys: readonly string[]
): Promise<boolean> {
	if (canManageAll(ctx)) return true;
	if (ctx.userId && node.ownerId === ctx.userId) return true;
	// Selbst gelöscht und am ursprünglichen Ort (noch) Bearbeiten-Zugriff
	if (!ctx.userId || node.deletedBy !== ctx.userId) return false;
	if (node.parentId) {
		const parent = await loadNode(tx, node.parentId);
		if (parent) return (await resolveAccess(tx, ctx, parent.id, keys))?.level === 'edit';
	}
	return rootAccess(ctx, node.ownerId) === 'edit';
}

/** Sichtbare Papierkorb-Wurzeln zu `ids` laden, sonst 404 */
async function requireTrashRoots(
	tx: Tx,
	ctx: RequestContext,
	ids: readonly string[],
	keys: readonly string[]
): Promise<NodeRow[]> {
	const unique = [...new Set(ids)];
	const rows = await loadNodes(tx, unique, { includeDeleted: true });
	const byId = new Map(rows.map((r) => [r.id, r]));
	const result: NodeRow[] = [];
	for (const id of unique) {
		const node = byId.get(id);
		if (
			!node ||
			!node.trashRoot ||
			!node.deletedAt ||
			!(await canSeeTrashRoot(tx, ctx, node, keys))
		)
			throw errors.notFound('Eintrag im Papierkorb nicht gefunden');
		result.push(node);
	}
	return result;
}

/** Storage-Pfade (Inhalt + Thumbnail) aller Knoten mit diesen IDs */
async function storagePathsOf(tx: Tx, ids: readonly string[]): Promise<string[]> {
	if (ids.length === 0) return [];
	const rows = await rowsOf(
		tx,
		sql`SELECT storage_path, thumb_path FROM nodes WHERE id IN (${inList(ids)})`
	);
	const paths: string[] = [];
	for (const r of rows) {
		if (r.storage_path) paths.push(String(r.storage_path));
		if (r.thumb_path) paths.push(String(r.thumb_path));
	}
	return paths;
}

/** Teilbäume endgültig löschen (in der Transaktion) → Storage-Pfade zum Entfernen danach */
async function deleteRoots(tx: Tx, rootIds: readonly string[]): Promise<string[]> {
	if (rootIds.length === 0) return [];
	const all = await subtree(tx, rootIds, false);
	const paths = await storagePathsOf(tx, [...new Set(all.map((r) => r.id))]);
	// CASCADE entfernt Kinder, Freigaben und öffentliche Links
	await tx.execute(sql`DELETE FROM nodes WHERE id IN (${inList(rootIds)})`);
	return paths;
}

/** Kalendertag (Europe/Berlin), an dem der Eintrag endgültig gelöscht wird */
function purgeDate(deletedAt: string, trashDays: number): string {
	return todayBerlin(new Date(new Date(deletedAt).getTime() + trashDays * DAY_MS));
}

/** POST `/nodes/trash`: edit nötig; Teilbaum bekommt `deleted_at`, die Wurzel `trash_root = true` */
export async function trashNodes(ctx: RequestContext, ids: readonly string[]): Promise<BulkResult> {
	const keys = await keysFor(ctx);
	const unique = [...new Set(ids)];
	const uid = ctx.userId ?? null;
	const affected = await mdb().transaction(async (tx) => {
		for (const id of unique) await requireNode(tx, ctx, id, keys, 'edit');
		// Nur die obersten Knoten: liegt ein Vorfahre ebenfalls in `ids`, wird er mitgelöscht
		const wanted = new Set(unique);
		const roots: string[] = [];
		for (const id of unique) {
			const chain = await ancestorsOf(tx, id);
			if (!chain.some((a) => a.id !== id && wanted.has(a.id))) roots.push(id);
		}
		for (const root of roots) {
			const ids = (await subtree(tx, [root], false)).map((r) => r.id);
			// Bereits gelöschte Unterbäume behalten ihren eigenen Papierkorb-Eintrag
			await tx.execute(
				sql`UPDATE nodes SET deleted_at = now(), deleted_by = ${uid}
					WHERE id IN (${inList(ids)}) AND deleted_at IS NULL`
			);
			await tx.execute(sql`UPDATE nodes SET trash_root = true WHERE id = ${root}`);
		}
		return roots.length;
	});
	await core.audit.logFromContext(ctx, 'files.node.trashed', { metadata: { count: affected } });
	return { affected };
}

/**
 * GET `/trash`: Papierkorb-Wurzeln, die der Aufrufer sieht: eigene Einträge, alles mit `manage-all`;
 * sowie Knoten, die man selbst gelöscht hat und auf deren Ort man (über eine Freigabe) noch edit hätte. `purgeOn` = `deletedAt` + `trashDays`.
 */
export async function listTrash(ctx: RequestContext): Promise<TrashItem[]> {
	const keys = await keysFor(ctx);
	const { trashDays } = await filesSettings();
	const uid = ctx.userId ?? '';
	const all = canManageAll(ctx);

	const data = await mdb().transaction(async (tx) => {
		const cond = all ? sql`TRUE` : sql`(n.owner_id = ${uid} OR n.deleted_by = ${uid})`;
		const rows = (
			await rowsOf(
				tx,
				sql`SELECT ${NODE_COLUMNS} FROM nodes n
					WHERE n.trash_root AND n.deleted_at IS NOT NULL AND ${cond}
					ORDER BY n.deleted_at DESC, n.name
					LIMIT ${MAX_TRASH_LIST}`
			)
		).map(nodeRowOf);
		const visible: NodeRow[] = [];
		for (const r of rows) if (await canSeeTrashRoot(tx, ctx, r, keys)) visible.push(r);

		// Größe je Eintrag: Summe der Dateien im eigenen Teilbaum
		const sizes = new Map<string, number>();
		if (visible.length > 0) {
			const sizeRows = await rowsOf(
				tx,
				sql`WITH RECURSIVE t(root, id) AS (
						SELECT id, id FROM nodes WHERE id IN (${inList(visible.map((v) => v.id))})
						UNION ALL
						SELECT t.root, n.id FROM nodes n JOIN t ON n.parent_id = t.id WHERE NOT n.trash_root
					)
					SELECT t.root, COALESCE(SUM(n.size_bytes), 0) AS size
					FROM t JOIN nodes n ON n.id = t.id
					WHERE n.kind = 'file'
					GROUP BY t.root`
			);
			for (const s of sizeRows) sizes.set(String(s.root), Number(s.size ?? 0));
		}

		// Ursprünglicher Ort: ohne Zugang zur Wurzel der Eigentümer*in nur ab dem ersten zugänglichen
		// Vorfahren (wie `searchNodes`), damit keine Namen fremder Ordner sichtbar werden
		const chains = new Map<string, NodeRow[]>();
		const hidden: NodeRow[] = [];
		for (const v of visible) {
			const chain = (await ancestorsOf(tx, v.id)).filter((a) => a.id !== v.id);
			chains.set(v.id, chain);
			if (!rootAccess(ctx, v.ownerId)) hidden.push(...chain);
		}
		const hiddenLevels = hidden.length ? await accessForMany(tx, ctx, hidden, keys) : new Map();
		const paths = new Map<string, string>();
		for (const v of visible) {
			const chain = chains.get(v.id) ?? [];
			if (rootAccess(ctx, v.ownerId)) {
				paths.set(v.id, displayPath([ROOT_LABEL, ...chain.map((a) => a.name)]));
			} else {
				const first = chain.findIndex((a) => hiddenLevels.has(a.id));
				const shown = first < 0 ? [] : chain.slice(first);
				paths.set(v.id, displayPath([ROOT_LABEL, ...shown.map((a) => a.name)]));
			}
		}
		return { visible, sizes, paths };
	});

	const users = await userRefs(
		ctx,
		data.visible.map((v) => v.deletedBy)
	);
	return data.visible.map((v) => {
		const deletedAt = toIso(v.deletedAt);
		return {
			id: v.id,
			kind: v.kind,
			name: v.name,
			originalPath: data.paths.get(v.id) ?? ROOT_LABEL,
			sizeBytes: data.sizes.get(v.id) ?? 0,
			deletedAt,
			deletedBy: v.deletedBy ? (users.get(v.deletedBy) ?? null) : null,
			purgeOn: purgeDate(deletedAt, trashDays)
		};
	});
}

/**
 * POST `/trash/restore`: Teilbaum zurück; ist der ursprüngliche Ordner weg (gelöscht/nicht mehr vorhanden),
 * landet der Knoten in der Wurzel seiner Eigentümer*in; Namenskonflikt → `uniqueName`. Kontingent wird nicht erneut geprüft
 * (Papierkorb zählt bereits).
 */
export async function restoreNodes(
	ctx: RequestContext,
	ids: readonly string[]
): Promise<BulkResult> {
	const keys = await keysFor(ctx);
	const affected = await mdb().transaction(async (tx) => {
		const roots = await requireTrashRoots(tx, ctx, ids, keys);
		for (const root of roots) {
			// Elternordner noch da (nicht gelöscht, gleiche Eigentümer*in)? Sonst eigene Wurzel der Eigentümer*in
			let parentId: string | null = null;
			if (root.parentId) {
				const parent = await loadNode(tx, root.parentId);
				if (parent && parent.kind === 'folder' && parent.ownerId === root.ownerId)
					parentId = parent.id;
			}
			const existing = await siblingNames(tx, { ownerId: root.ownerId, parentId });
			const name = uniqueName(existing, root.name);
			const own = (await subtree(tx, [root.id], true)).map((r) => r.id);
			// Wurzel zuerst (Name/Ort ändern sich), dann der Rest des eigenen Teilbaums
			await tx.execute(
				sql`UPDATE nodes SET parent_id = ${parentId}, name = ${name}, deleted_at = NULL,
					deleted_by = NULL, trash_root = false, updated_at = now()
					WHERE id = ${root.id}`
			);
			const rest = own.filter((id) => id !== root.id);
			if (rest.length > 0)
				await tx.execute(
					sql`UPDATE nodes SET deleted_at = NULL, deleted_by = NULL
						WHERE id IN (${inList(rest)})`
				);
		}
		return roots.length;
	});
	await core.audit.logFromContext(ctx, 'files.node.restored', { metadata: { count: affected } });
	return { affected };
}

/** POST `/trash/purge`: nur Papierkorb-Wurzeln; Zeilen löschen (CASCADE), danach Storage-Objekte entfernen */
export async function purgeNodes(ctx: RequestContext, ids: readonly string[]): Promise<BulkResult> {
	const keys = await keysFor(ctx);
	const { affected, paths } = await mdb().transaction(async (tx) => {
		const roots = await requireTrashRoots(tx, ctx, ids, keys);
		const paths = await deleteRoots(
			tx,
			roots.map((r) => r.id)
		);
		return { affected: roots.length, paths };
	});
	await removeObjects(paths);
	await core.audit.logFromContext(ctx, 'files.node.purged', { metadata: { count: affected } });
	return { affected };
}

/** Job `files.purge-trash` (täglich): abgelaufene Papierkorb-Einträge endgültig löschen → Statusmeldung */
export async function purgeExpired(ctx: RequestContext): Promise<string> {
	const { trashDays } = await filesSettings();
	const { count, paths, more } = await mdb().transaction(async (tx) => {
		const rows = await rowsOf(
			tx,
			sql`SELECT id FROM nodes
				WHERE trash_root AND deleted_at IS NOT NULL
					AND deleted_at < now() - make_interval(days => ${trashDays}::int)
				ORDER BY deleted_at
				LIMIT ${PURGE_BATCH + 1}`
		);
		const ids = rows.slice(0, PURGE_BATCH).map((r) => String(r.id));
		const paths = await deleteRoots(tx, ids);
		return { count: ids.length, paths, more: rows.length > PURGE_BATCH };
	});
	await removeObjects(paths);
	if (count === 0) return 'Keine abgelaufenen Einträge im Papierkorb';
	await core.audit.logFromContext(ctx, 'files.node.purged', {
		metadata: { count, expired: true }
	});
	const msg = count === 1 ? '1 Eintrag endgültig gelöscht' : `${count} Einträge endgültig gelöscht`;
	return more ? `${msg} (weitere beim nächsten Lauf)` : msg;
}
