/**
 * Ordner/Dateien: Auflisten (eine Ansicht: eigene + mir freigegebene Einträge), Anlegen, Umbenennen,
 * Verschieben, Suche, DTO-Aufbau.
 * Muster: `principalKeysFor` vor der Transaktion → DB in `mdb().transaction` → Namen (`userRefs`) danach → Audit danach.
 */
import { sql, type SQL } from 'drizzle-orm';
import { todayBerlin } from '$lib/sdk/dates';
import { loadIconSet } from '$lib/sdk/icons';
import {
	core,
	errors,
	inList,
	isUniqueViolation,
	principalMatchSql,
	type RequestContext,
	rowsOf,
	type Tx
} from '$lib/sdk/server';
import {
	accessForMany,
	canManageAll,
	requireFolderTarget,
	requireNode,
	rootAccess,
	sharedWithMeRoots,
	stammSharedSql,
	visibleNodesFilter
} from './access';
import {
	ancestorsOf,
	descendantIds,
	filesSettings,
	loadNode,
	loadNodes,
	mdb,
	NODE_COLUMNS,
	nodeRowOf,
	userRefs,
	type NodeRow
} from './db';
import { displayPath, normalizeName, uniqueName } from './names';
import { keysFor } from './shares.service';
import { assertQuota } from './storage';
import {
	MAX_DEPTH,
	MAX_SEARCH_RESULTS,
	ROOT_LABEL,
	type AccessLevel,
	type Breadcrumb,
	type BulkResult,
	type FileNode,
	type FolderCreateInput,
	type FolderListing,
	type MoveInput,
	type SearchResult,
	type StyleInput,
	type UserRef
} from './schemas';

/** Zusatzinfos je Knoten für `FileNode` (in der Transaktion ermittelt) */
export interface NodeExtras {
	access: AccessLevel;
	/** Darf Freigaben/Links verwalten (Eigentümer*in oder `manage-all`, nicht über eine Freigabe) */
	canShare: boolean;
	/** Gehört dem Aufrufer */
	own: boolean;
	/** An `everyone:*` freigegeben (Knoten oder Vorfahr) */
	stamm: boolean;
	shared: boolean;
	linked: boolean;
	childCount: number | null;
	/** Ordner: Summe der Dateien im Teilbaum ohne Papierkorb */
	folderBytes: number | null;
}

// ---------------------------------------------------------------------------
// Interne Helfer
// ---------------------------------------------------------------------------

/** Größe der `IN (…)`-Listen je Abfrage */
const CHUNK = 500;

function chunks<T>(list: readonly T[], size = CHUNK): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
	return out;
}

const maxLevel = (a: AccessLevel | null | undefined, b: AccessLevel | null | undefined) =>
	a === 'edit' || b === 'edit' ? 'edit' : a === 'read' || b === 'read' ? 'read' : null;

/** Sortierung: Ordner zuerst, dann Name (de, ohne Groß/Klein, Zahlen natürlich) */
function compareNodes(a: NodeRow, b: NodeRow): number {
	if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
	return a.name.localeCompare(b.name, 'de', { sensitivity: 'base', numeric: true });
}

/** Ort eines Knotens: Ordner (`parentId`) oder Wurzel der Eigentümer*in (`parentId = null`) */
export interface SiblingScope {
	ownerId: string;
	parentId: string | null;
}

/** Bedingung „gleicher Ordner“ (Alias `n`) – passend zum Unique-Index der Migration (alle Knoten `personal`) */
function siblingCondition(input: SiblingScope): SQL {
	if (input.parentId) return sql`n.parent_id = ${input.parentId}`;
	return sql`n.parent_id IS NULL AND n.owner_id = ${input.ownerId}`;
}

const sameKey = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function conflictError(name: string, existing: readonly string[]) {
	return errors.conflict(
		`Es gibt hier schon „${name}“. Vorschlag: „${uniqueName(existing, name)}“`
	);
}

function depthError(path: string) {
	return errors.validation([
		{ path: [path], message: `Höchstens ${MAX_DEPTH} Ordnerebenen möglich` }
	]);
}

/** Tiefe eines Knotens (Wurzel-Kind = 1) */
async function depthOf(tx: Tx, id: string | null): Promise<number> {
	if (!id) return 0;
	return (await ancestorsOf(tx, id)).length;
}

/** Höhe des Teilbaums unter einem Knoten (Datei/leerer Ordner = 0), inkl. gelöschter Nachfahren */
async function subtreeHeight(tx: Tx, id: string): Promise<number> {
	const rows = await rowsOf(
		tx,
		sql`WITH RECURSIVE t(id, d) AS (
				SELECT id, 0 FROM nodes WHERE id = ${id}
				UNION ALL
				SELECT c.id, t.d + 1 FROM nodes c JOIN t ON c.parent_id = t.id WHERE t.d < ${MAX_DEPTH + 1}
			)
			SELECT COALESCE(max(d), 0) AS h FROM t`
	);
	return Number(rows[0]?.h ?? 0);
}

/** Summe der Dateigrößen eines Teilbaums (inkl. Papierkorb-Einträge) */
async function subtreeBytes(tx: Tx, id: string): Promise<number> {
	const rows = await rowsOf(
		tx,
		sql`WITH RECURSIVE t(id) AS (
				SELECT id FROM nodes WHERE id = ${id}
				UNION ALL
				SELECT c.id FROM nodes c JOIN t ON c.parent_id = t.id
			)
			SELECT COALESCE(sum(n.size_bytes), 0) AS b FROM nodes n JOIN t ON t.id = n.id
			WHERE n.kind = 'file'`
	);
	return Number(rows[0]?.b ?? 0);
}

/** Daten für DTOs aus der Transaktion: Zeilen + Extras */
interface NodeBundle {
	rows: NodeRow[];
	extras: Map<string, NodeExtras>;
}

async function bundle(
	tx: Tx,
	ctx: RequestContext,
	rows: NodeRow[],
	keys: readonly string[],
	minLevel: AccessLevel | null = null
): Promise<NodeBundle> {
	const levels = rows.length ? await accessForMany(tx, ctx, rows, keys) : new Map();
	const access = new Map<string, AccessLevel>();
	for (const r of rows) access.set(r.id, maxLevel(levels.get(r.id), minLevel) ?? 'read');
	return { rows, extras: await extrasForMany(tx, rows, access, ctx) };
}

/** Namen für `toFileNode`: Eigentümer*innen und anlegende Personen */
async function usersFor(ctx: RequestContext, rows: readonly NodeRow[]) {
	return userRefs(
		ctx,
		rows.flatMap((r) => [r.ownerId, r.createdBy])
	);
}

function toDtos(b: NodeBundle, users: Map<string, UserRef>): FileNode[] {
	return b.rows.map((r) => toFileNode(r, b.extras.get(r.id)!, users));
}

async function loadWithKeys(ctx: RequestContext, id: string, keys: readonly string[]) {
	const b = await mdb().transaction(async (tx) => {
		const row = await loadNode(tx, id);
		if (!row) throw errors.notFound('Datei oder Ordner nicht gefunden');
		return bundle(tx, ctx, [row], keys);
	});
	return toDtos(b, await usersFor(ctx, b.rows))[0]!;
}

// ---------------------------------------------------------------------------
// Öffentliche Funktionen
// ---------------------------------------------------------------------------

/** Eigentümer*in oder `manage-all`/System – Freigaben zählen nicht */
function hasRootEdit(ctx: RequestContext, row: Pick<NodeRow, 'ownerId'>): boolean {
	return rootAccess(ctx, row.ownerId) === 'edit';
}

/**
 * Extras (Freigaben/Links/Kinderzahl/Stamm) für viele Knoten in der Transaktion;
 * ohne `ctx` sind `canShare` und `own` immer `false`.
 */
export async function extrasForMany(
	tx: Tx,
	rows: readonly NodeRow[],
	access: Map<string, AccessLevel>,
	ctx?: RequestContext
): Promise<Map<string, NodeExtras>> {
	const out = new Map<string, NodeExtras>();
	const byId = new Map(rows.map((r) => [r.id, r]));
	const canShareOf = (id: string) => {
		const row = byId.get(id);
		return !!ctx && !!row && hasRootEdit(ctx, row);
	};
	const ownOf = (id: string) => {
		const row = byId.get(id);
		return !!ctx?.userId && !!row && row.ownerId === ctx.userId;
	};
	const ids = [...new Set(rows.map((r) => r.id))];
	for (const part of chunks(ids)) {
		const res = await rowsOf(
			tx,
			sql`SELECT n.id,
					EXISTS (SELECT 1 FROM node_shares s WHERE s.node_id = n.id) AS shared,
					${stammSharedSql(sql`n.id`)} AS stamm,
					EXISTS (SELECT 1 FROM share_links l WHERE l.node_id = n.id AND l.revoked_at IS NULL
						AND (l.expires_on IS NULL OR l.expires_on >= ${todayBerlin()}::date)) AS linked,
					CASE WHEN n.kind = 'folder' THEN
						(SELECT count(*) FROM nodes c WHERE c.parent_id = n.id AND c.deleted_at IS NULL)
					END AS child_count
				FROM nodes n WHERE n.id IN (${inList(part)})`
		);
		for (const r of res) {
			const id = String(r.id);
			out.set(id, {
				access: access.get(id) ?? 'read',
				canShare: canShareOf(id),
				own: ownOf(id),
				stamm: r.stamm === true || r.stamm === 't',
				shared: r.shared === true || r.shared === 't',
				linked: r.linked === true || r.linked === 't',
				childCount: r.child_count == null ? null : Number(r.child_count),
				folderBytes: null
			});
		}
		const folderIds = part.filter((id) => byId.get(id)?.kind === 'folder');
		if (folderIds.length) {
			// Größe je Ordner über den ganzen Teilbaum (Tiefe begrenzt, gelöschte Zweige ausgenommen)
			const sizes = await rowsOf(
				tx,
				sql`WITH RECURSIVE t(root, id, d) AS (
						SELECT n.id, n.id, 0 FROM nodes n WHERE n.id IN (${inList(folderIds)})
						UNION ALL
						SELECT t.root, c.id, t.d + 1 FROM nodes c JOIN t ON c.parent_id = t.id
						WHERE c.deleted_at IS NULL AND t.d < ${MAX_DEPTH + 1}
					)
					SELECT t.root, COALESCE(sum(n.size_bytes), 0) AS bytes
					FROM t JOIN nodes n ON n.id = t.id AND n.kind = 'file'
					GROUP BY t.root`
			);
			for (const r of sizes) {
				const e = out.get(String(r.root));
				if (e) e.folderBytes = Number(r.bytes ?? 0);
			}
			for (const id of folderIds) {
				const e = out.get(id);
				if (e && e.folderBytes === null) e.folderBytes = 0;
			}
		}
	}
	// Fallback für Knoten ohne Treffer (sollte nicht vorkommen)
	for (const r of rows) {
		if (!out.has(r.id)) {
			out.set(r.id, {
				access: access.get(r.id) ?? 'read',
				canShare: canShareOf(r.id),
				own: ownOf(r.id),
				stamm: false,
				shared: false,
				linked: false,
				childCount: r.kind === 'folder' ? 0 : null,
				folderBytes: r.kind === 'folder' ? 0 : null
			});
		}
	}
	return out;
}

/** DTO aus Zeile + Extras + Namen (rein); `users` sollte Eigentümer*in und `createdBy` enthalten (sonst „Unbekannt“) */
export function toFileNode(
	row: NodeRow,
	extras: NodeExtras,
	users: Map<string, UserRef>
): FileNode {
	const isFile = row.kind === 'file';
	return {
		id: row.id,
		parentId: row.parentId,
		kind: row.kind,
		name: row.name,
		ownerId: row.ownerId,
		owner: users.get(row.ownerId) ?? { id: row.ownerId, name: 'Unbekannt' },
		own: extras.own,
		stamm: extras.stamm,
		contentType: isFile ? row.contentType : null,
		sizeBytes: isFile ? (row.sizeBytes ?? 0) : null,
		hasThumb: isFile && !!row.thumbPath,
		access: extras.access,
		canShare: extras.canShare,
		shared: extras.shared,
		linked: extras.linked,
		childCount: isFile ? null : (extras.childCount ?? 0),
		folderBytes: isFile ? null : (extras.folderBytes ?? 0),
		icon: isFile ? null : row.icon,
		color: isFile ? null : row.color,
		createdBy: row.createdBy
			? (users.get(row.createdBy) ?? { id: row.createdBy, name: 'Unbekannt' })
			: null,
		uploadedByName: row.uploadedByName,
		viaLink: row.uploadedViaLink !== null,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt
	};
}

/** Ein Knoten als DTO (Zugriff prüft der Aufrufer nicht erneut) – eigene Transaktion, Namen danach */
export async function loadFileNode(ctx: RequestContext, id: string): Promise<FileNode> {
	const keys = await keysFor(ctx);
	return loadWithKeys(ctx, id, keys);
}

/**
 * GET `/nodes`: Ordnerinhalt (Ordner zuerst, dann Name, `localeCompare('de')`) + Breadcrumbs.
 * Wurzel (`parentId = null`) = eigene Wurzelknoten + mir freigegebene Einträge anderer (`sharedWithMeRoots`,
 * auch an den ganzen Stamm); mit `manage-all` und `ownerId` die Wurzel einer anderen Person (nur deren Knoten).
 * Breadcrumbs: `ROOT_LABEL` + Vorfahren; bei fremden Ordnern erst ab dem ersten zugänglichen Vorfahren.
 */
export async function listFolder(
	ctx: RequestContext,
	input: { parentId: string | null; ownerId?: string }
): Promise<FolderListing> {
	const keys = await keysFor(ctx);
	const data = await mdb().transaction(async (tx) => {
		const breadcrumbs: Breadcrumb[] = [{ id: null, name: ROOT_LABEL }];

		if (input.parentId === null) {
			const owner = input.ownerId ?? ctx.userId;
			if (!owner) throw errors.notFound('Ordner nicht gefunden');
			const self = owner === ctx.userId;
			if (!self && !canManageAll(ctx)) throw errors.notFound('Ordner nicht gefunden');

			const rows = (
				await rowsOf(
					tx,
					sql`SELECT ${NODE_COLUMNS} FROM nodes n
						WHERE ${siblingCondition({ ownerId: owner, parentId: null })} AND n.deleted_at IS NULL`
				)
			).map(nodeRowOf);
			if (self) {
				const seen = new Set(rows.map((r) => r.id));
				for (const r of await sharedWithMeRoots(tx, ctx, keys)) {
					if (!seen.has(r.id)) rows.push(r);
				}
			}
			rows.sort(compareNodes);
			// keine Mindeststufe: freigegebene Einträge behalten ihre eigene Freigabestufe
			const items = await bundle(tx, ctx, rows, keys);
			const level: AccessLevel = 'edit';
			return { level, breadcrumbs, items, self: null };
		}

		const acc = await requireNode(tx, ctx, input.parentId, keys, 'read');
		if (acc.node.kind !== 'folder') {
			throw errors.validation([{ path: ['parent'], message: 'Das ist kein Ordner' }]);
		}
		const folder = acc.node;
		const level = acc.level;

		const chain = await ancestorsOf(tx, folder.id);
		if (rootAccess(ctx, folder.ownerId)) {
			for (const a of chain) breadcrumbs.push({ id: a.id, name: a.name });
		} else {
			// keine Namen privater Oberordner: erst ab dem ersten Vorfahren mit Zugriff
			const levels = await accessForMany(tx, ctx, chain, keys);
			const first = chain.findIndex((a) => levels.has(a.id));
			const visible = first < 0 ? chain.slice(-1) : chain.slice(first);
			for (const a of visible) breadcrumbs.push({ id: a.id, name: a.name });
		}

		const rows = (
			await rowsOf(
				tx,
				sql`SELECT ${NODE_COLUMNS} FROM nodes n
					WHERE n.parent_id = ${folder.id} AND n.deleted_at IS NULL`
			)
		).map(nodeRowOf);
		rows.sort(compareNodes);
		const items = await bundle(tx, ctx, rows, keys, level);
		const self = await bundle(tx, ctx, [folder], keys, level);
		return { level, breadcrumbs, items, self };
	});

	const users = await usersFor(ctx, [...data.items.rows, ...(data.self?.rows ?? [])]);
	return {
		folder: data.self ? toDtos(data.self, users)[0]! : null,
		breadcrumbs: data.breadcrumbs,
		access: data.level,
		items: toDtos(data.items, users)
	};
}

/** POST `/folders` → 201; Namenskonflikt → 409 `conflict` mit Vorschlag in der Meldung */
export async function createFolder(
	ctx: RequestContext,
	input: FolderCreateInput
): Promise<FileNode> {
	const keys = await keysFor(ctx);
	const name = normalizeName(input.name);
	if (!name) throw errors.validation([{ path: ['name'], message: 'Bitte einen Namen angeben' }]);
	const id = crypto.randomUUID();
	await mdb().transaction(async (tx) => {
		const target = await requireFolderTarget(tx, ctx, input.parentId, keys, 'edit');
		const parentId = target.folder?.id ?? null;
		if ((await depthOf(tx, parentId)) + 1 > MAX_DEPTH) throw depthError('parentId');
		const siblings = await siblingNames(tx, { ownerId: target.ownerId, parentId });
		if (siblings.some((s) => sameKey(s, name))) throw conflictError(name, siblings);
		try {
			await tx.execute(
				sql`INSERT INTO nodes (id, parent_id, kind, space, owner_id, name, created_by)
					VALUES (${id}, ${parentId}, 'folder', 'personal', ${target.ownerId}, ${name}, ${ctx.userId})`
			);
		} catch (e) {
			if (isUniqueViolation(e)) throw conflictError(name, siblings);
			throw e;
		}
	});
	const node = await loadWithKeys(ctx, id, keys);
	await core.audit.logFromContext(ctx, 'files.node.created', {
		target: id,
		metadata: { kind: 'folder' }
	});
	return node;
}

/**
 * Ordnerkette unter `parentId` sicherstellen (vorhandene gleichnamige Ordner wiederverwenden, sonst anlegen),
 * in der laufenden Transaktion. Liefert die ID des letzten Ordners (`parentId`, wenn `folders` leer).
 * Tiefe > `MAX_DEPTH` → 422.
 */
export async function ensureFolderPath(
	tx: Tx,
	input: {
		ownerId: string;
		parentId: string | null;
		folders: readonly string[];
		createdBy: string | null;
	}
): Promise<string | null> {
	let parentId = input.parentId;
	if (input.folders.length === 0) return parentId;
	let depth = await depthOf(tx, parentId);
	for (const raw of input.folders) {
		const wanted = normalizeName(raw);
		if (!wanted || wanted === '.' || wanted === '..') continue;
		if (++depth > MAX_DEPTH) throw depthError('relativePath');

		const cond = siblingCondition({ ownerId: input.ownerId, parentId });
		// gleichnamige Datei blockiert → „Name (2)“ usw.; ein vorhandener Ordner mit dem Namen wird genutzt
		const blocked: string[] = [];
		let candidate = wanted;
		let found: string | null = null;
		for (let i = 0; i < 1000; i++) {
			const rows = await rowsOf(
				tx,
				sql`SELECT n.id, n.kind FROM nodes n
					WHERE ${cond} AND n.deleted_at IS NULL AND lower(n.name) = lower(${candidate}) LIMIT 1`
			);
			const hit = rows[0];
			if (!hit) break;
			if (String(hit.kind) === 'folder') {
				found = String(hit.id);
				break;
			}
			blocked.push(candidate);
			candidate = uniqueName(blocked, candidate);
		}
		if (found) {
			parentId = found;
			continue;
		}
		const id = crypto.randomUUID();
		await tx.execute(
			sql`INSERT INTO nodes (id, parent_id, kind, space, owner_id, name, created_by)
				VALUES (${id}, ${parentId}, 'folder', 'personal', ${input.ownerId}, ${candidate},
					${input.createdBy})`
		);
		parentId = id;
	}
	return parentId;
}

/** Namen der nicht gelöschten Geschwister in einem Ordner (für `uniqueName`) */
export async function siblingNames(tx: Tx, input: SiblingScope): Promise<string[]> {
	const rows = await rowsOf(
		tx,
		sql`SELECT n.name FROM nodes n WHERE ${siblingCondition(input)} AND n.deleted_at IS NULL`
	);
	return rows.map((r) => String(r.name));
}

/** PATCH `/nodes/:id` (edit nötig); Konflikt 409 */
export async function renameNode(ctx: RequestContext, id: string, name: string): Promise<FileNode> {
	const keys = await keysFor(ctx);
	const wanted = normalizeName(name);
	if (!wanted) throw errors.validation([{ path: ['name'], message: 'Bitte einen Namen angeben' }]);
	let kind: NodeRow['kind'] = 'file';
	const changed = await mdb().transaction(async (tx) => {
		const { node } = await requireNode(tx, ctx, id, keys, 'edit');
		kind = node.kind;
		if (node.name === wanted) return false;
		const siblings = await siblingNames(tx, { ownerId: node.ownerId, parentId: node.parentId });
		// den Knoten selbst einmal herausnehmen (Umbenennen nur in Groß/Klein ist erlaubt)
		const own = siblings.indexOf(node.name);
		if (own >= 0) siblings.splice(own, 1);
		if (siblings.some((s) => sameKey(s, wanted))) throw conflictError(wanted, siblings);
		try {
			await tx.execute(sql`UPDATE nodes SET name = ${wanted}, updated_at = now() WHERE id = ${id}`);
		} catch (e) {
			if (isUniqueViolation(e)) throw conflictError(wanted, siblings);
			throw e;
		}
		return true;
	});
	const result = await loadWithKeys(ctx, id, keys);
	if (changed) {
		await core.audit.logFromContext(ctx, 'files.node.renamed', {
			target: id,
			metadata: { kind }
		});
	}
	return result;
}

/**
 * POST `/nodes/style`: Icon und/oder Farbe eines oder mehrerer Ordner setzen bzw. zurücksetzen (`null`).
 * Bearbeiten-Zugriff auf jeden Ordner nötig (unbekannt/kein Zugriff → 404, nur Lesen → 403), Dateien → 422,
 * unbekanntes Icon → 422. Ändert `updated_at` nicht (kein Inhalt).
 */
export async function setNodeStyle(ctx: RequestContext, input: StyleInput): Promise<BulkResult> {
	const ids = [...new Set(input.ids)];
	if (input.icon) {
		const icons = await loadIconSet();
		if (!icons.has(input.icon)) {
			throw errors.validation([{ path: ['icon'], message: 'Unbekanntes Icon' }]);
		}
	}
	const keys = await keysFor(ctx);
	await mdb().transaction(async (tx) => {
		const rows = await loadNodes(tx, ids);
		const levels = await accessForMany(tx, ctx, rows, keys);
		const byId = new Map(rows.map((r) => [r.id, r]));
		for (const id of ids) {
			const row = byId.get(id);
			const level = levels.get(id);
			if (!row || !level) throw errors.notFound('Ordner nicht gefunden');
			if (level !== 'edit') throw errors.forbidden('Du darfst diesen Ordner nicht bearbeiten');
			if (row.kind !== 'folder') {
				throw errors.validation([
					{ path: ['ids'], message: 'Icon und Farbe gibt es nur für Ordner' }
				]);
			}
		}
		const sets: SQL[] = [];
		if (input.icon !== undefined) sets.push(sql`icon = ${input.icon}`);
		if (input.color !== undefined) sets.push(sql`color = ${input.color?.toLowerCase() ?? null}`);
		await tx.execute(sql`UPDATE nodes SET ${sql.join(sets, sql`, `)} WHERE id IN (${inList(ids)})`);
	});
	await core.audit.logFromContext(ctx, 'files.node.styled', {
		target: ids.length === 1 ? ids[0] : undefined,
		metadata: {
			count: ids.length,
			icon: input.icon === undefined ? 'unchanged' : input.icon === null ? 'reset' : 'set',
			color: input.color === undefined ? 'unchanged' : input.color === null ? 'reset' : 'set'
		}
	});
	return { affected: ids.length };
}

/**
 * IDs der Knoten aus `chainIds` (Quelle + Vorfahren), auf denen eine edit-Freigabe an einen der `keys` liegt –
 * die „Anker“, die einem Nicht-Eigentümer das Bearbeiten verleihen.
 */
async function editShareAnchors(
	tx: Tx,
	chainIds: readonly string[],
	keys: readonly string[]
): Promise<Set<string>> {
	if (chainIds.length === 0 || keys.length === 0) return new Set();
	const rows = await rowsOf(
		tx,
		sql`SELECT DISTINCT s.node_id FROM node_shares s
			WHERE s.node_id IN (${inList(chainIds)}) AND s.level = 'edit' AND ${principalMatchSql('s', keys)}`
	);
	return new Set(rows.map((r) => String(r.node_id)));
}

/**
 * POST `/nodes/move`: edit auf jedem Knoten und auf dem Ziel (`targetId = null` = eigene Wurzel); nicht in sich
 * selbst/Nachfahren (422), Tiefe ≤ `MAX_DEPTH`; Namenskonflikt im Ziel → automatisch `uniqueName`. Gehört das Ziel
 * jemand anderem, wechselt `owner_id` für den ganzen Teilbaum – nur mit Eigentümerschaft bzw. `manage-all` an der
 * Quelle (sonst 403) und mit Prüfung des Kontingents der neuen Eigentümer*in; aktive öffentliche Links im Teilbaum
 * werden dabei widerrufen (Freigaben bleiben). Wer nur über eine edit-Freigabe bearbeitet, darf nur innerhalb des
 * freigegebenen Ordners verschieben (Ziel = Anker der Freigabe oder ein Nachfahre davon), sonst 403.
 */
export async function moveNodes(ctx: RequestContext, input: MoveInput): Promise<BulkResult> {
	const keys = await keysFor(ctx);
	const settings = await filesSettings();
	const ids = [...new Set(input.ids)];
	const moved = await mdb().transaction(async (tx) => {
		// Verschiebungen serialisieren: zwei gleichzeitige Moves könnten sonst einen Zyklus bilden
		await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('files:move'))`);
		const target = await requireFolderTarget(tx, ctx, input.targetId, keys, 'edit');
		const targetId = target.folder?.id ?? null;
		const targetOwner = target.ownerId;
		const targetChain = targetId ? await ancestorsOf(tx, targetId) : [];
		const targetChainIds = new Set(targetChain.map((a) => a.id));
		const targetDepth = targetChain.length;

		// Zugriff auf alle Knoten prüfen, dann nur die obersten bewegen
		const idSet = new Set(ids);
		const nodes: NodeRow[] = [];
		const chains = new Map<string, NodeRow[]>();
		for (const id of ids) {
			const { node } = await requireNode(tx, ctx, id, keys, 'edit');
			const chain = await ancestorsOf(tx, id);
			if (chain.some((a) => a.id !== id && idSet.has(a.id))) continue;
			nodes.push(node);
			chains.set(node.id, chain);
		}

		interface Plan {
			node: NodeRow;
			ownerChange: boolean;
		}
		const plans: Plan[] = [];
		let addBytes = 0;
		for (const node of nodes) {
			if (targetChainIds.has(node.id)) {
				throw errors.validation([
					{
						path: ['targetId'],
						message: 'Ein Ordner kann nicht in sich selbst oder einen Unterordner verschoben werden'
					}
				]);
			}
			const ownerChange = node.ownerId !== targetOwner;
			if (node.parentId === targetId && !ownerChange) continue;
			// Aus einer fremden Ablage heraus nur mit Eigentümerschaft/`manage-all` am Quellknoten –
			// eine edit-Freigabe reicht nicht (sonst ließen sich fremde private Ordner übernehmen)
			if (ownerChange && !hasRootEdit(ctx, node)) {
				throw errors.forbidden(
					'Nur die Eigentümer*in kann Einträge aus dieser Ablage herausverschieben'
				);
			}
			// Nur über eine Freigabe: Ziel muss im Teilbaum eines Ankers mit edit-Freigabe liegen – sonst ließe sich
			// ein nur an mich freigegebener Inhalt in einen weiter freigegebenen/verlinkten Ordner schieben
			if (!hasRootEdit(ctx, node)) {
				const chainIds = (chains.get(node.id) ?? []).map((a) => a.id);
				const anchors = await editShareAnchors(tx, chainIds, keys);
				if (![...anchors].some((a) => targetChainIds.has(a))) {
					throw errors.forbidden(
						'Mit einer Freigabe kannst du nur innerhalb des freigegebenen Ordners verschieben'
					);
				}
			}

			const height = node.kind === 'folder' ? await subtreeHeight(tx, node.id) : 0;
			if (targetDepth + 1 + height > MAX_DEPTH) throw depthError('targetId');

			if (ownerChange) {
				addBytes += node.kind === 'file' ? (node.sizeBytes ?? 0) : await subtreeBytes(tx, node.id);
			}
			plans.push({ node, ownerChange });
		}

		if (addBytes > 0) await assertQuota(tx, targetOwner, addBytes, settings.quotaBytes);

		const siblings = await siblingNames(tx, { ownerId: targetOwner, parentId: targetId });
		let revokedLinks = 0;
		for (const p of plans) {
			const name = uniqueName(siblings, p.node.name);
			siblings.push(name);
			await tx.execute(
				sql`UPDATE nodes SET parent_id = ${targetId}, name = ${name}, space = 'personal',
					owner_id = ${targetOwner}, updated_at = now() WHERE id = ${p.node.id}`
			);
			if (!p.ownerChange) continue;
			const sub = p.node.kind === 'folder' ? await descendantIds(tx, p.node.id) : [];
			for (const part of chunks(sub)) {
				await tx.execute(
					sql`UPDATE nodes SET space = 'personal', owner_id = ${targetOwner}
						WHERE id IN (${inList(part)})`
				);
			}
			// Eigentumsübergabe: öffentliche Links der bisherigen Eigentümer*in gelten nicht weiter
			for (const part of chunks([p.node.id, ...sub])) {
				const revoked = await rowsOf(
					tx,
					sql`UPDATE share_links SET revoked_at = now()
						WHERE revoked_at IS NULL AND node_id IN (${inList(part)}) RETURNING id`
				);
				revokedLinks += revoked.length;
			}
		}
		return { count: plans.length, revokedLinks };
	});
	if (moved.count > 0) {
		await core.audit.logFromContext(ctx, 'files.node.moved', {
			target: input.targetId ?? undefined,
			metadata: { count: moved.count, revokedLinks: moved.revokedLinks }
		});
	}
	return { affected: moved.count };
}

/**
 * GET `/search`: Name enthält `q` (ohne Groß/Klein), nur sichtbare, nicht gelöschte; max `MAX_SEARCH_RESULTS`.
 * Pfad: `ROOT_LABEL` + Vorfahren; bei fremden Einträgen erst ab dem ersten zugänglichen Vorfahren.
 */
export async function searchNodes(
	ctx: RequestContext,
	input: { q: string; limit?: number }
): Promise<SearchResult> {
	const max = Math.min(Math.max(1, input.limit ?? MAX_SEARCH_RESULTS), MAX_SEARCH_RESULTS);
	const keys = await keysFor(ctx);
	const q = input.q.trim().toLowerCase();
	const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
	const data = await mdb().transaction(async (tx) => {
		const rows = (
			await rowsOf(
				tx,
				sql`SELECT ${NODE_COLUMNS} FROM nodes n
					WHERE ${visibleNodesFilter(ctx, keys)} AND n.deleted_at IS NULL
						AND lower(n.name) LIKE ${pattern} ESCAPE '\\'
					ORDER BY CASE WHEN n.kind = 'folder' THEN 0 ELSE 1 END, lower(n.name), n.id
					LIMIT ${max + 1}`
			)
		).map(nodeRowOf);
		const truncated = rows.length > max;
		const hits = rows.slice(0, max);
		hits.sort(compareNodes);

		// Vorfahren je Treffer; ohne Eigentümerschaft nur ab dem ersten zugänglichen Vorfahren
		const chains = new Map<string, NodeRow[]>();
		const hidden: NodeRow[] = [];
		for (const h of hits) {
			const chain = (await ancestorsOf(tx, h.id)).filter((a) => a.id !== h.id);
			chains.set(h.id, chain);
			if (!rootAccess(ctx, h.ownerId)) hidden.push(...chain);
		}
		const hiddenLevels = hidden.length ? await accessForMany(tx, ctx, hidden, keys) : new Map();
		const paths = new Map<string, string>();
		for (const h of hits) {
			const chain = chains.get(h.id)!;
			let visible = chain;
			if (!rootAccess(ctx, h.ownerId)) {
				const first = chain.findIndex((a) => hiddenLevels.has(a.id));
				visible = first < 0 ? [] : chain.slice(first);
			}
			paths.set(h.id, displayPath([ROOT_LABEL, ...visible.map((a) => a.name)]));
		}
		return { b: await bundle(tx, ctx, hits, keys), truncated, paths };
	});
	const users = await usersFor(ctx, data.b.rows);
	return {
		items: toDtos(data.b, users).map((n) => ({ ...n, path: data.paths.get(n.id) ?? '' })),
		truncated: data.truncated
	};
}
