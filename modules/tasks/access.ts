/**
 * Objektbezogener Zugriff auf Boards. Basisrecht `tasks.board.view` prüft der Router.
 *
 *   - System, `tasks.board.edit-all`, Eigentümer*in              -> bearbeiten + teilen/löschen
 *   - Freigabe `edit` an einen passenden Principal                 -> bearbeiten
 *   - verknüpfte Aktion mit Bearbeiten-Zugriff (`actions`)         -> bearbeiten
 *   - Freigabe `read`, `view-all`, Aktion mit Lesezugriff          -> lesen
 *   - einer Aufgabe oder Unteraufgabe zugewiesen                   -> lesen (+ eigene Aufgaben verschieben/abhaken)
 *   - sonst 404 (Existenz nicht verraten)
 *
 * Principal-Schlüssel und Aktions-Zugriffe rufen Core bzw. `actions` auf und stehen daher VOR der
 * Transaktion fest (`loadTaskContext`, für alle Endpoints über `withTaskContext`).
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
	notFoundText: 'Board nicht gefunden',
	forbiddenText: 'Keine Berechtigung zum Bearbeiten dieses Boards'
});

export interface TaskContext {
	keys: readonly string[];
	/** Zugriffsstufe je sichtbarer Aktion (nur mit aktivem `actions`) */
	actions: ReadonlyMap<string, ShareLevel>;
	/** Namen der sichtbaren Aktionen (Anzeige am Board) */
	actionNames: ReadonlyMap<string, string>;
	/** Beginn/Ende der sichtbaren Aktionen (Vorlagen, Mitverschieben) */
	actionDates: ReadonlyMap<string, { startsOn: string; endsOn: string | null }>;
	actionsAvailable: boolean;
}

const store = new WeakMap<RequestContext, TaskContext>();

export async function actionsService(): Promise<ActionsService | null> {
	return core.modules.useOptional<ActionsService>('actions', MODULE_ID);
}

/** Schlüssel und Aktions-Zugriffe des Aufrufers ermitteln (nie in einer Transaktion) */
export async function loadTaskContext(ctx: RequestContext): Promise<TaskContext> {
	const keys = ctx.userId ? await principalKeysFor(ctx, MODULE_ID) : [];
	const service = await actionsService();
	const list = service ? await service.accessibleActions(ctx) : [];
	const value: TaskContext = {
		keys,
		actions: new Map(list.map((a) => [a.id, a.level])),
		actionNames: new Map(list.map((a) => [a.id, a.name])),
		actionDates: new Map(list.map((a) => [a.id, { startsOn: a.startsOn, endsOn: a.endsOn }])),
		actionsAvailable: !!service
	};
	store.set(ctx, value);
	return value;
}

export function taskContextOf(ctx: RequestContext): TaskContext {
	const value = store.get(ctx);
	if (!value) throw new Error('tasks: loadTaskContext(ctx) fehlt vor der Transaktion');
	return value;
}

/** Endpoints so einhüllen, dass der Zugriffskontext vor dem Handler feststeht */
export function withTaskContext(endpoints: AnyApiEndpoint[]): AnyApiEndpoint[] {
	return endpoints.map((endpoint) => {
		const handler = endpoint.handler;
		return {
			...endpoint,
			handler: async (args: Parameters<typeof handler>[0]) => {
				await loadTaskContext(args.ctx);
				return handler(args);
			}
		};
	});
}

export const canEditAll = (ctx: RequestContext) => boardShareAccess.canEditAll(ctx);
export const canViewAll = (ctx: RequestContext) => boardShareAccess.canViewAll(ctx);

/** SQL: Aufrufer ist einer Aufgabe/Unteraufgabe des Boards (Alias `alias`) zugewiesen */
function assignedSql(ctx: RequestContext, alias: string): SQL {
	if (!ctx.userId) return sql`FALSE`;
	const a = sql.raw(alias);
	return sql`(EXISTS (SELECT 1 FROM tasks t JOIN task_assignees ta ON ta.task_id = t.id
			WHERE t.board_id = ${a}.id AND ta.user_id = ${ctx.userId})
		OR EXISTS (SELECT 1 FROM tasks t JOIN task_checklist c ON c.task_id = t.id
			WHERE t.board_id = ${a}.id AND c.assignee_id = ${ctx.userId}))`;
}

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
		sql`SELECT b.owner_id, b.action_id, ${assignedSql(ctx, 'b')} AS assigned
			FROM boards b WHERE b.id = ${boardId}`
	);
	if (!board) return null;
	const tc = canEditAll(ctx) ? null : taskContextOf(ctx);
	const base = await boardShareAccess.resolveAccess(tx, ctx, boardId, tc?.keys ?? []);
	const isOwner = !!ctx.userId && String(board.owner_id) === ctx.userId;
	const fromAction =
		board.action_id && tc ? (tc.actions.get(String(board.action_id)) ?? null) : null;
	const assigned = board.assigned === true || board.assigned === 't' ? 'read' : null;
	const level = max(max(base?.level ?? null, fromAction), assigned);
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
	if (!access) throw errors.notFound('Board nicht gefunden');
	if (need === 'edit' && access.level !== 'edit') {
		throw errors.forbidden('Keine Berechtigung zum Bearbeiten dieses Boards');
	}
	if (need === 'share' && !access.canShare) {
		throw errors.forbidden('Nur die Eigentümer*in darf Freigaben ändern oder das Board löschen');
	}
	return access;
}

/** SQL-Bedingung für Listen (Alias `b`): alles oder eigene + freigegebene + Aktion + zugewiesen */
export function visibleBoardsFilter(ctx: RequestContext): SQL {
	if (canViewAll(ctx)) return sql`TRUE`;
	const tc = taskContextOf(ctx);
	const actionIds = [...tc.actions.keys()];
	const viaAction = actionIds.length ? sql`b.action_id IN (${inList(actionIds)})` : sql`FALSE`;
	return sql`(${boardShareAccess.visibleFilter(ctx, tc.keys, 'b')} OR ${viaAction} OR ${assignedSql(ctx, 'b')})`;
}

/** Zugriff je Board für Listen (ein Abfrageschritt für Freigaben) */
export async function boardAccessForMany(
	tx: Tx,
	ctx: RequestContext,
	rows: readonly { id: string; ownerId: string; actionId: string | null }[]
): Promise<Map<string, BoardAccess>> {
	const tc = canEditAll(ctx) ? null : taskContextOf(ctx);
	const base = await boardShareAccess.accessForMany(tx, ctx, rows, tc?.keys ?? []);
	const map = new Map<string, BoardAccess>();
	for (const r of rows) {
		const b = base.get(r.id);
		const fromAction = r.actionId && tc ? (tc.actions.get(r.actionId) ?? null) : null;
		const isOwner = !!ctx.userId && r.ownerId === ctx.userId;
		map.set(r.id, {
			level: max(b?.level ?? 'read', fromAction) ?? 'read',
			isOwner,
			canShare: canEditAll(ctx) || isOwner
		});
	}
	return map;
}

/**
 * Aufgabe laden und Zugriff prüfen. `edit` = Bearbeiten-Zugriff aufs Board; `move` = zusätzlich
 * Zugewiesene (Aufgabe selbst oder eine ihrer Unteraufgaben) mit Lesezugriff.
 */
export async function requireTask(
	tx: Tx,
	ctx: RequestContext,
	taskId: string,
	need: 'read' | 'edit' | 'move' = 'read'
): Promise<{ boardId: string; access: BoardAccess; canMove: boolean }> {
	const [task] = await rowsOf(tx, sql`SELECT board_id FROM tasks WHERE id = ${taskId}`);
	if (!task) throw errors.notFound('Aufgabe nicht gefunden');
	const boardId = String(task.board_id);
	const access = await resolveBoardAccess(tx, ctx, boardId);
	if (!access) throw errors.notFound('Aufgabe nicht gefunden');
	let canMove = access.level === 'edit';
	if (!canMove && ctx.userId) {
		const [hit] = await rowsOf(
			tx,
			sql`SELECT 1 FROM task_assignees WHERE task_id = ${taskId} AND user_id = ${ctx.userId}
				UNION ALL
				SELECT 1 FROM task_checklist WHERE task_id = ${taskId} AND assignee_id = ${ctx.userId}
				LIMIT 1`
		);
		canMove = !!hit;
	}
	if (need === 'edit' && access.level !== 'edit') {
		throw errors.forbidden('Keine Berechtigung zum Bearbeiten dieser Aufgabe');
	}
	if (need === 'move' && !canMove) {
		throw errors.forbidden('Keine Berechtigung zum Bearbeiten dieser Aufgabe');
	}
	return { boardId, access, canMove };
}
