/**
 * Objektbezogener Zugriff auf Whiteboards. Basisrecht `whiteboard.board.view` prüft der Router.
 *
 *   - System, `whiteboard.board.edit-all`, Eigentümer*in           -> bearbeiten + teilen/löschen
 *   - Freigabe `edit` an einen passenden Principal                  -> bearbeiten
 *   - verknüpfte Aktion mit Bearbeiten-Zugriff (`actions`)          -> bearbeiten
 *   - Freigabe `read`, `view-all`, Aktion mit Lesezugriff           -> lesen
 *   - sonst 404 (Existenz nicht verraten)
 *
 * Principal-Schlüssel und Aktions-Zugriffe rufen Core bzw. `actions` auf und stehen daher VOR der
 * Transaktion fest (`loadBoardContext`, für alle Endpoints über `withBoardContext`).
 */
import { sql, type SQL } from 'drizzle-orm';
import {
	core,
	createShareAccess,
	errors,
	inList,
	principalKeysFor,
	rowsOf,
	type AnyApiEndpoint,
	type RequestContext,
	type Tx
} from '$lib/sdk/server';
import type { ActionsService } from './peer-contracts';
import { MODULE_ID, PERM, type BoardAccess, type ShareLevel } from './schemas';

export const boardShareAccess = createShareAccess({
	table: 'boards',
	shareTable: 'board_shares',
	fk: 'board_id',
	perms: { viewAll: PERM.viewAll, editAll: PERM.editAll },
	notFoundText: 'Whiteboard nicht gefunden',
	forbiddenText: 'Keine Berechtigung zum Bearbeiten dieses Whiteboards'
});

export interface BoardContext {
	keys: readonly string[];
	/** Zugriffsstufe je sichtbarer Aktion (nur mit aktivem `actions`) */
	actions: ReadonlyMap<string, ShareLevel>;
	/** Namen der sichtbaren Aktionen */
	actionNames: ReadonlyMap<string, string>;
	actionsAvailable: boolean;
}

const store = new WeakMap<RequestContext, BoardContext>();

export async function actionsService(): Promise<ActionsService | null> {
	return core.modules.useOptional<ActionsService>('actions', MODULE_ID);
}

/** Schlüssel und Aktions-Zugriffe des Aufrufers ermitteln (nie in einer Transaktion) */
export async function loadBoardContext(ctx: RequestContext): Promise<BoardContext> {
	const keys = ctx.userId ? await principalKeysFor(ctx, MODULE_ID) : [];
	const service = await actionsService();
	const list = service ? await service.accessibleActions(ctx) : [];
	const value: BoardContext = {
		keys,
		actions: new Map(list.map((a) => [a.id, a.level])),
		actionNames: new Map(list.map((a) => [a.id, a.name])),
		actionsAvailable: !!service
	};
	store.set(ctx, value);
	return value;
}

export function boardContextOf(ctx: RequestContext): BoardContext {
	const value = store.get(ctx);
	if (!value) throw new Error('whiteboard: loadBoardContext(ctx) fehlt vor der Transaktion');
	return value;
}

/** Endpoints so einhüllen, dass der Zugriffskontext vor dem Handler feststeht */
export function withBoardContext(endpoints: AnyApiEndpoint[]): AnyApiEndpoint[] {
	return endpoints.map((endpoint) => {
		const handler = endpoint.handler;
		return {
			...endpoint,
			handler: async (args: Parameters<typeof handler>[0]) => {
				await loadBoardContext(args.ctx);
				return handler(args);
			}
		};
	});
}

export const canEditAll = (ctx: RequestContext) => boardShareAccess.canEditAll(ctx);
export const canViewAll = (ctx: RequestContext) => boardShareAccess.canViewAll(ctx);

const max = (a: ShareLevel | null, b: ShareLevel | null): ShareLevel | null =>
	a === 'edit' || b === 'edit' ? 'edit' : (a ?? b);

/** Zugriff auf ein Board oder `null` */
export async function resolveBoardAccess(
	tx: Tx,
	ctx: RequestContext,
	boardId: string
): Promise<BoardAccess | null> {
	const [board] = await rowsOf(
		tx,
		sql`SELECT b.owner_id, b.action_id FROM boards b WHERE b.id = ${boardId}`
	);
	if (!board) return null;
	const bc = canEditAll(ctx) ? null : boardContextOf(ctx);
	const base = await boardShareAccess.resolveAccess(tx, ctx, boardId, bc?.keys ?? []);
	const isOwner = !!ctx.userId && String(board.owner_id) === ctx.userId;
	const fromAction =
		board.action_id && bc ? (bc.actions.get(String(board.action_id)) ?? null) : null;
	const level = max(base?.level ?? null, fromAction);
	if (!level) return null;
	return { level, isOwner, canShare: canEditAll(ctx) || isOwner };
}

export async function requireBoardAccess(
	tx: Tx,
	ctx: RequestContext,
	boardId: string,
	need: 'read' | 'edit' | 'share' = 'read'
): Promise<BoardAccess> {
	const access = await resolveBoardAccess(tx, ctx, boardId);
	if (!access) throw errors.notFound('Whiteboard nicht gefunden');
	if (need === 'edit' && access.level !== 'edit') {
		throw errors.forbidden('Keine Berechtigung zum Bearbeiten dieses Whiteboards');
	}
	if (need === 'share' && !access.canShare) {
		throw errors.forbidden(
			'Nur die Eigentümer*in darf Freigaben ändern, die Aktion wechseln oder das Whiteboard löschen'
		);
	}
	return access;
}

/** SQL-Bedingung für Listen (Alias `b`): alles oder eigene + freigegebene + über Aktionen sichtbare */
export function visibleBoardsFilter(ctx: RequestContext): SQL {
	if (canViewAll(ctx)) return sql`TRUE`;
	const bc = boardContextOf(ctx);
	const actionIds = [...bc.actions.keys()];
	const viaAction = actionIds.length ? sql`b.action_id IN (${inList(actionIds)})` : sql`FALSE`;
	return sql`(${boardShareAccess.visibleFilter(ctx, bc.keys, 'b')} OR ${viaAction})`;
}

/** Zugriff je Board für Listen (ein Abfrageschritt für Freigaben) */
export async function boardAccessForMany(
	tx: Tx,
	ctx: RequestContext,
	rows: readonly { id: string; ownerId: string; actionId: string | null }[]
): Promise<Map<string, BoardAccess>> {
	const bc = canEditAll(ctx) ? null : boardContextOf(ctx);
	const base = await boardShareAccess.accessForMany(tx, ctx, rows, bc?.keys ?? []);
	const map = new Map<string, BoardAccess>();
	for (const r of rows) {
		const b = base.get(r.id);
		const fromAction = r.actionId && bc ? (bc.actions.get(r.actionId) ?? null) : null;
		const isOwner = !!ctx.userId && r.ownerId === ctx.userId;
		map.set(r.id, {
			level: max(b?.level ?? 'read', fromAction) ?? 'read',
			isOwner,
			canShare: canEditAll(ctx) || isOwner
		});
	}
	return map;
}

/** Advisory-Sperre je Board (Änderungsnummer, Elementzahl, Speicher) */
export async function lockBoard(tx: Tx, boardId: string): Promise<void> {
	await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`whiteboard:board:${boardId}`}))`);
}
