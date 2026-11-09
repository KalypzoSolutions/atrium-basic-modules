/**
 * Laden und Aufbau der Antworten. Zeilen werden IN der Modul-Transaktion gelesen, Namen/Bilder
 * (`core.users.byIds`) und Aktionsnamen erst DANACH aufgelöst (PGlite hat nur eine Sitzung).
 */
import { sql } from 'drizzle-orm';
import {
	core,
	moduleDb,
	num,
	type RequestContext,
	type Row,
	rowsOf,
	toIso,
	type Tx
} from '$lib/sdk/server';
import { boardAccessForMany, boardContextOf, resolveBoardAccess } from './access';
import {
	BACKGROUNDS,
	DEFAULT_BOARD_MB,
	MODULE_ID,
	SETTING_BOARD_MB,
	type Asset,
	type Background,
	type Board,
	type BoardAccess,
	type BoardDetail,
	type ElementType,
	type LiveElement,
	type UserRef,
	type WbElement
} from './schemas';

export const mdb = () => moduleDb(MODULE_ID);

const strOrNull = (v: unknown): string | null => (v == null || v === '' ? null : String(v));
export const bool = (v: unknown) => v === true || v === 't' || v === 'true';

/** Board-Spalten (Alias `b`) */
export const BOARD_COLUMNS = sql`b.id, b.name, b.description, b.color, b.background, b.owner_id, b.action_id,
	b.element_count, b.seq, b.created_at, b.updated_at, b.updated_by`;

export interface BoardRows {
	rows: Row[];
	access: Map<string, BoardAccess>;
}

export async function loadBoardRows(
	tx: Tx,
	ctx: RequestContext,
	where: ReturnType<typeof sql>,
	page?: { limit: number; offset: number }
): Promise<BoardRows> {
	const rows = await rowsOf(
		tx,
		sql`SELECT ${BOARD_COLUMNS} FROM boards b WHERE ${where}
			ORDER BY b.updated_at DESC, b.name, b.id
			${page ? sql`LIMIT ${page.limit} OFFSET ${page.offset}` : sql``}`
	);
	const access = await boardAccessForMany(
		tx,
		ctx,
		rows.map((r) => ({
			id: String(r.id),
			ownerId: String(r.owner_id),
			actionId: strOrNull(r.action_id)
		}))
	);
	return { rows, access };
}

/** Benutzer-Anzeige (aktive Konten; Unbekannte → „Unbekannt“) */
export async function userRefs(
	ctx: RequestContext,
	ids: Iterable<string | null>
): Promise<Map<string, UserRef>> {
	const unique = [...new Set(ids)].filter((v): v is string => !!v);
	const map = new Map<string, UserRef>();
	if (!unique.length) return map;
	for (const u of (await core.users.byIds(ctx, unique)).values()) {
		map.set(u.id, { id: u.id, name: u.name, image: u.image ?? null });
	}
	return map;
}

export const refOf = (map: Map<string, UserRef>, id: string): UserRef =>
	map.get(id) ?? { id, name: 'Unbekannt', image: null };

/** Name der verknüpften Aktion: aus dem Kontext (sichtbare Aktionen), sonst über `actions` */
async function actionNames(ctx: RequestContext, ids: string[]): Promise<Map<string, string>> {
	const map = new Map<string, string>();
	if (!ids.length) return map;
	const bc = boardContextOf(ctx);
	const missing: string[] = [];
	for (const id of new Set(ids)) {
		const name = bc.actionNames.get(id);
		if (name) map.set(id, name);
		else missing.push(id);
	}
	if (missing.length && bc.actionsAvailable) {
		const service = await core.modules.useOptional<{
			listActionRefs(q: { ids: string[] }): Promise<{ id: string; name: string }[]>;
		}>('actions', MODULE_ID);
		for (const r of service ? await service.listActionRefs({ ids: missing }) : []) {
			map.set(r.id, r.name);
		}
	}
	return map;
}

const background = (v: unknown): Background =>
	(BACKGROUNDS as readonly string[]).includes(String(v)) ? (String(v) as Background) : 'dots';

export async function buildBoards(ctx: RequestContext, data: BoardRows): Promise<Board[]> {
	const users = await userRefs(
		ctx,
		data.rows.flatMap((r) => [String(r.owner_id), strOrNull(r.updated_by)])
	);
	const names = await actionNames(
		ctx,
		data.rows.map((r) => strOrNull(r.action_id)).filter((v): v is string => !!v)
	);
	return data.rows.map((r) => {
		const id = String(r.id);
		const actionId = strOrNull(r.action_id);
		const updatedBy = strOrNull(r.updated_by);
		return {
			id,
			name: String(r.name),
			description: strOrNull(r.description),
			color: strOrNull(r.color),
			background: background(r.background),
			owner: refOf(users, String(r.owner_id)),
			actionId,
			actionName: actionId ? (names.get(actionId) ?? null) : null,
			elementCount: num(r.element_count),
			access: data.access.get(id) ?? { level: 'read', isOwner: false, canShare: false },
			updatedAt: toIso(r.updated_at),
			updatedBy: updatedBy ? refOf(users, updatedBy) : null,
			createdAt: toIso(r.created_at)
		};
	});
}

/** Elementzeile → DTO (Daten wurden beim Schreiben geprüft) */
export function elementOf(r: Row): WbElement {
	return {
		id: String(r.id),
		type: String(r.type) as ElementType,
		data: (typeof r.data === 'string' ? JSON.parse(r.data) : r.data) as never,
		z: Number(r.z),
		version: num(r.version)
	} as WbElement;
}

export function liveElementOf(r: Row): LiveElement {
	return {
		id: String(r.id),
		type: String(r.type) as ElementType,
		data: typeof r.data === 'string' ? JSON.parse(r.data) : r.data,
		z: Number(r.z),
		version: num(r.version),
		deleted: bool(r.deleted)
	};
}

export function assetOf(r: Row): Asset {
	const paths = (typeof r.paths === 'string' ? JSON.parse(r.paths) : r.paths) as Record<
		string,
		string
	>;
	return {
		id: String(r.id),
		kind: r.kind === 'image' ? 'image' : 'file',
		name: String(r.name),
		contentType: String(r.content_type),
		sizeBytes: num(r.size_bytes),
		width: r.width == null ? null : num(r.width),
		height: r.height == null ? null : num(r.height),
		hasThumb: !!paths?.thumb
	};
}

/** Grenze je Board in Byte (0 = unbegrenzt) */
export async function boardLimitBytes(): Promise<number> {
	let mb = DEFAULT_BOARD_MB;
	try {
		const v = await core.settings.get<unknown>(SETTING_BOARD_MB);
		if (typeof v === 'number' && Number.isFinite(v) && v >= 0) mb = v;
	} catch {
		// Einstellung (noch) nicht registriert → Standard
	}
	return Math.round(mb * 1024 * 1024);
}

export async function usedBytes(tx: Tx, boardId: string): Promise<number> {
	const [r] = await rowsOf(
		tx,
		sql`SELECT COALESCE(sum(size_bytes), 0)::bigint AS n FROM assets WHERE board_id = ${boardId}`
	);
	return num(r?.n);
}

export interface DetailRows {
	board: BoardRows;
	elements: Row[];
	assets: Row[];
	used: number;
}

/** Board mit allen (nicht gelöschten) Elementen und Dateien; 404 ohne Zugriff */
export async function loadDetailRows(
	tx: Tx,
	ctx: RequestContext,
	boardId: string
): Promise<DetailRows | null> {
	const access = await resolveBoardAccess(tx, ctx, boardId);
	if (!access) return null;
	const rows = await rowsOf(tx, sql`SELECT ${BOARD_COLUMNS} FROM boards b WHERE b.id = ${boardId}`);
	const elements = await rowsOf(
		tx,
		sql`SELECT id, type, data, z, version FROM elements
			WHERE board_id = ${boardId} AND NOT deleted ORDER BY z, id`
	);
	const assets = await rowsOf(
		tx,
		sql`SELECT id, kind, name, content_type, size_bytes, width, height, paths FROM assets
			WHERE board_id = ${boardId} ORDER BY created_at, id`
	);
	return {
		board: { rows, access: new Map([[boardId, access]]) },
		elements,
		assets,
		used: await usedBytes(tx, boardId)
	};
}

export async function buildDetail(ctx: RequestContext, data: DetailRows): Promise<BoardDetail> {
	const [board] = await buildBoards(ctx, data.board);
	return {
		...board!,
		seq: num(data.board.rows[0]?.seq),
		elements: data.elements.map(elementOf),
		assets: data.assets.map(assetOf),
		storage: { usedBytes: data.used, limitBytes: await boardLimitBytes() }
	};
}
