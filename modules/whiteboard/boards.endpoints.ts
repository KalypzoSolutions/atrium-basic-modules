/** REST für Whiteboards, Freigaben und Aktions-Verknüpfung (`/api/v1/modules/whiteboard/…`). */
import { sql } from 'drizzle-orm';
import {
	addedPrincipals,
	type AnyApiEndpoint,
	core,
	defineEndpoint,
	describePrincipals,
	errors,
	PRINCIPAL_SEARCH_RATE_LIMIT,
	type RequestContext,
	requireShareCapability,
	rowsOf,
	searchPrincipals,
	type StoredShare,
	type Tx,
	validatePrincipals
} from '$lib/sdk/server';
import {
	boardContextOf,
	boardShareAccess,
	canEditAll,
	requireBoardAccess,
	visibleBoardsFilter
} from './access';
import {
	buildBoards,
	buildDetail,
	loadBoardRows,
	loadDetailRows,
	mdb,
	refOf,
	userRefs
} from './boards.service';
import { broadcast, closeBoard, recheckBoard } from './live';
import { notifyBoardShared } from './notify';
import { removeFiles } from './storage';
import {
	actionParams,
	boardInput,
	boardUpdateInput,
	idParams,
	listQuery,
	MODULE_ID,
	PERM,
	recentQuery,
	searchQuery,
	sharesInput,
	type ActionBoards,
	type Board,
	type BoardDetail,
	type BoardList,
	type BoardShares
} from './schemas';

const tags = ['Whiteboard'];
const STAMM_NAME_SETTING = 'events.stamm.name';

export async function everyoneLabel(): Promise<string> {
	try {
		const value = await core.settings.get<unknown>(STAMM_NAME_SETTING);
		if (typeof value === 'string' && value.trim()) return value.trim();
	} catch {
		// Einstellung nicht registriert (events nicht aktiv) → Standard
	}
	return 'Stamm';
}

/** Aktion verknüpfen: nur mit Bearbeiten-Zugriff auf die Aktion (sonst 422) */
function assertActionEditable(ctx: RequestContext, actionId: string | null | undefined): void {
	if (!actionId) return;
	if (!canEditAll(ctx) && boardContextOf(ctx).actions.get(actionId) !== 'edit') {
		throw errors.validation([
			{ path: ['actionId'], message: 'Aktion nicht gefunden oder ohne Bearbeiten-Recht' }
		]);
	}
}

export async function boardDetail(ctx: RequestContext, boardId: string): Promise<BoardDetail> {
	const rows = await mdb().transaction((tx) => loadDetailRows(tx, ctx, boardId));
	if (!rows) throw errors.notFound('Whiteboard nicht gefunden');
	return buildDetail(ctx, rows);
}

async function boardSummary(ctx: RequestContext, boardId: string): Promise<Board> {
	const data = await mdb().transaction((tx) => loadBoardRows(tx, ctx, sql`b.id = ${boardId}`));
	const [board] = await buildBoards(ctx, data);
	if (!board) throw errors.notFound('Whiteboard nicht gefunden');
	return board;
}

// --- Freigaben --------------------------------------------------------------

async function loadShareState(tx: Tx, ctx: RequestContext, id: string, need: 'read' | 'share') {
	const access = await requireBoardAccess(tx, ctx, id, need);
	const [board] = await rowsOf(tx, sql`SELECT owner_id, name FROM boards WHERE id = ${id}`);
	return {
		access,
		ownerId: String(board?.owner_id),
		name: String(board?.name ?? 'Whiteboard'),
		shares: await boardShareAccess.loadShares(tx, id)
	};
}

async function buildShares(
	ctx: RequestContext,
	state: { ownerId: string; shares: StoredShare[]; canManage: boolean }
): Promise<BoardShares> {
	const label = await everyoneLabel();
	const [owners, described] = await Promise.all([
		userRefs(ctx, [state.ownerId]),
		describePrincipals(ctx, MODULE_ID, state.shares, { everyoneLabel: label })
	]);
	const shares = described.map((p, i) => ({
		type: p.type,
		userId: p.id,
		name: p.name,
		detail: p.detail ?? null,
		color: p.color ?? null,
		image: p.image ?? null,
		level: state.shares[i]!.level
	}));
	shares.sort((a, b) => a.name.localeCompare(b.name, 'de'));
	return {
		owner: refOf(owners, state.ownerId),
		shares,
		canManage: state.canManage,
		everyoneLabel: label
	};
}

export const boardEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/boards',
		summary: 'Whiteboards auflisten (eigene, freigegebene, über Aktionen sichtbare)',
		tags,
		permission: PERM.view,
		query: listQuery,
		handler: async ({ ctx, query }): Promise<BoardList> => {
			const term = query.search?.replace(/[%_\\]/g, '');
			const where = sql`${visibleBoardsFilter(ctx)}
				AND ${term ? sql`(b.name ILIKE ${`%${term}%`} OR b.description ILIKE ${`%${term}%`})` : sql`TRUE`}
				AND ${query.actionId ? sql`b.action_id = ${query.actionId}` : sql`TRUE`}`;
			const { data, total } = await mdb().transaction(async (tx) => {
				const [t] = await rowsOf(tx, sql`SELECT count(*)::int AS n FROM boards b WHERE ${where}`);
				return {
					data: await loadBoardRows(tx, ctx, where, query),
					total: Number(t?.n ?? 0)
				};
			});
			return { items: await buildBoards(ctx, data), total };
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/boards/recent',
		summary: 'Zuletzt geänderte Whiteboards (Dashboard)',
		tags,
		permission: PERM.view,
		query: recentQuery,
		handler: async ({ ctx, query }): Promise<Board[]> => {
			const data = await mdb().transaction((tx) =>
				loadBoardRows(tx, ctx, visibleBoardsFilter(ctx), { limit: query.limit, offset: 0 })
			);
			return buildBoards(ctx, data);
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/boards',
		summary: 'Whiteboard anlegen',
		description:
			'Mit `actionId` wird das Whiteboard an eine Aktion gehängt (Bearbeiten-Zugriff auf die Aktion nötig, mehrere je Aktion möglich). Wer die Aktion sehen bzw. bearbeiten darf, darf das auch beim Whiteboard.',
		tags,
		permission: PERM.create,
		body: boardInput,
		handler: async ({ ctx, body }) => {
			if (!ctx.userId) throw errors.badRequest('Whiteboards können nur Benutzer*innen anlegen');
			assertActionEditable(ctx, body.actionId);
			const id = crypto.randomUUID();
			await mdb().transaction(async (tx) => {
				await tx.execute(
					sql`INSERT INTO boards (id, name, description, color, background, owner_id, action_id,
							created_by, updated_by)
						VALUES (${id}, ${body.name}, ${body.description}, ${body.color}, ${body.background},
							${ctx.userId}, ${body.actionId}, ${ctx.userId}, ${ctx.userId})`
				);
			});
			await core.audit.logFromContext(ctx, 'whiteboard.board.created', {
				target: id,
				metadata: { withAction: !!body.actionId }
			});
			return boardDetail(ctx, id);
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/boards/by-action/:actionId',
		summary: 'Whiteboards einer Aktion (Karte in der Aktion)',
		tags,
		permission: PERM.view,
		params: actionParams,
		handler: async ({ ctx, params }): Promise<ActionBoards> => {
			const level = boardContextOf(ctx).actions.get(params.actionId) ?? null;
			if (!level && !canEditAll(ctx)) throw errors.notFound('Aktion nicht gefunden');
			const data = await mdb().transaction((tx) =>
				loadBoardRows(
					tx,
					ctx,
					sql`b.action_id = ${params.actionId} AND ${visibleBoardsFilter(ctx)}`
				)
			);
			return {
				boards: await buildBoards(ctx, data),
				canCreate: (level === 'edit' || canEditAll(ctx)) && core.permissions.has(ctx, PERM.create)
			};
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/boards/:id',
		summary: 'Whiteboard mit allen Elementen und Dateien',
		tags,
		permission: PERM.view,
		params: idParams,
		handler: ({ ctx, params }) => boardDetail(ctx, params.id)
	}),
	defineEndpoint({
		method: 'PATCH',
		path: '/boards/:id',
		summary: 'Whiteboard ändern (Name, Beschreibung, Farbe, Hintergrund, Aktion)',
		description: 'Aktion verknüpfen/lösen nur Eigentümer*in bzw. `edit-all`.',
		tags,
		permission: PERM.view,
		params: idParams,
		body: boardUpdateInput,
		handler: async ({ ctx, params, body }): Promise<Board> => {
			if (body.actionId !== undefined) assertActionEditable(ctx, body.actionId);
			await mdb().transaction(async (tx) => {
				const access = await requireBoardAccess(
					tx,
					ctx,
					params.id,
					body.actionId !== undefined ? 'share' : 'edit'
				);
				if (access.level !== 'edit') {
					throw errors.forbidden('Keine Berechtigung zum Bearbeiten dieses Whiteboards');
				}
				const sets = [
					body.name !== undefined ? sql`name = ${body.name}` : null,
					body.description !== undefined ? sql`description = ${body.description ?? null}` : null,
					body.color !== undefined ? sql`color = ${body.color ?? null}` : null,
					body.background !== undefined ? sql`background = ${body.background}` : null,
					body.actionId !== undefined ? sql`action_id = ${body.actionId}` : null
				].filter((v) => v !== null);
				await tx.execute(
					sql`UPDATE boards SET ${sql.join(
						[...sets, sql`updated_at = now()`, sql`updated_by = ${ctx.userId}`],
						sql`, `
					)} WHERE id = ${params.id}`
				);
			});
			await core.audit.logFromContext(ctx, 'whiteboard.board.updated', {
				target: params.id,
				metadata: { fields: Object.keys(body) }
			});
			const board = await boardSummary(ctx, params.id);
			broadcast(params.id, {
				type: 'board',
				board: {
					name: board.name,
					description: board.description,
					color: board.color,
					background: board.background,
					actionId: board.actionId
				}
			});
			if (body.actionId !== undefined) await recheckBoard(params.id);
			return board;
		}
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/boards/:id',
		summary: 'Whiteboard löschen (mit allen Elementen, Dateien und Versionen)',
		description: 'Nur Eigentümer*in oder `whiteboard.board.edit-all`.',
		tags,
		permission: PERM.view,
		params: idParams,
		handler: async ({ ctx, params }) => {
			const removed = await mdb().transaction(async (tx) => {
				await requireBoardAccess(tx, ctx, params.id, 'share');
				const [n] = await rowsOf(tx, sql`SELECT element_count FROM boards WHERE id = ${params.id}`);
				const assets = await rowsOf(
					tx,
					sql`SELECT paths FROM assets WHERE board_id = ${params.id}`
				);
				await tx.execute(sql`DELETE FROM boards WHERE id = ${params.id}`);
				return {
					elements: Number(n?.element_count ?? 0),
					paths: assets.flatMap((a) =>
						Object.values(
							(typeof a.paths === 'string' ? JSON.parse(a.paths) : a.paths) as Record<
								string,
								string
							>
						)
					)
				};
			});
			closeBoard(params.id, { type: 'deleted' });
			await removeFiles(removed.paths);
			await core.audit.logFromContext(ctx, 'whiteboard.board.deleted', {
				target: params.id,
				metadata: { elements: removed.elements, files: removed.paths.length }
			});
			return { id: params.id, deleted: true };
		}
	}),

	// --- Freigaben ---
	defineEndpoint({
		method: 'GET',
		path: '/boards/:id/shares',
		summary: 'Freigaben eines Whiteboards',
		tags,
		permission: PERM.view,
		params: idParams,
		handler: async ({ ctx, params }) => {
			const state = await mdb().transaction((tx) => loadShareState(tx, ctx, params.id, 'read'));
			return buildShares(ctx, { ...state, canManage: state.access.canShare });
		}
	}),
	defineEndpoint({
		method: 'PUT',
		path: '/boards/:id/shares',
		summary: 'Freigaben eines Whiteboards ersetzen',
		description:
			'Stamm, Gruppe, Rolle, Mitglied, Benutzer*in mit `read`/`edit`. Nur Eigentümer*in oder `edit-all`. Offene Live-Verbindungen werden sofort neu geprüft.',
		tags,
		permission: PERM.view,
		params: idParams,
		body: sharesInput,
		handler: async ({ ctx, params, body }) => {
			const current = await mdb().transaction((tx) => loadShareState(tx, ctx, params.id, 'share'));
			body.shares.forEach((s, i) => {
				if (s.type === 'user' && s.id === current.ownerId) {
					throw errors.validation([
						{ path: ['shares', i, 'id'], message: 'Die Eigentümer*in hat bereits Zugriff' }
					]);
				}
			});
			await validatePrincipals(ctx, MODULE_ID, body.shares, {
				keep: new Set(current.shares.map((s) => `${s.type}:${s.id}`))
			});
			const before = await mdb().transaction(async (tx) => {
				const state = await loadShareState(tx, ctx, params.id, 'share');
				await boardShareAccess.replaceShares(tx, ctx, params.id, body.shares);
				return state.shares;
			});
			const old = new Map(before.map((s) => [`${s.type}:${s.id}`, s.level]));
			const changed = [
				...addedPrincipals(before, body.shares),
				...body.shares.filter((s) => s.level === 'edit' && old.get(`${s.type}:${s.id}`) === 'read')
			];
			if (changed.length) {
				await notifyBoardShared(ctx, {
					boardId: params.id,
					boardName: current.name,
					ownerId: current.ownerId,
					principals: changed
				});
			}
			await core.audit.logFromContext(ctx, 'whiteboard.board.shared', {
				target: params.id,
				metadata: {
					shares: body.shares.length,
					added: addedPrincipals(before, body.shares).length,
					removed: addedPrincipals(body.shares, before).length
				}
			});
			await recheckBoard(params.id);
			return buildShares(ctx, { ownerId: current.ownerId, shares: body.shares, canManage: true });
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/principals',
		summary: 'Freigabe-Ziele suchen (Stamm, Gruppen, Rollen, Mitglieder, Benutzer*innen)',
		description:
			'Nur für Personen, die Whiteboards teilen können (`whiteboard.board.create`, `edit-all` oder Eigentümer*in eines Whiteboards), sonst 403.',
		tags,
		permission: PERM.view,
		rateLimit: PRINCIPAL_SEARCH_RATE_LIMIT,
		query: searchQuery,
		handler: async ({ ctx, query }) => {
			await requireShareCapability(ctx, MODULE_ID, {
				anyPermission: [PERM.create, PERM.editAll],
				canShareSql: (userId) => sql`SELECT 1 FROM boards WHERE owner_id = ${userId}`
			});
			return searchPrincipals(ctx, MODULE_ID, query.search, {
				everyoneLabel: await everyoneLabel()
			});
		}
	})
];
