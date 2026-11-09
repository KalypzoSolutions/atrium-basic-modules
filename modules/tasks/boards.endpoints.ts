/** REST für Boards, Freigaben, Spalten und Personensuche (`/api/v1/modules/tasks/…`). */
import { sql } from 'drizzle-orm';
import {
	addedPrincipals,
	type AnyApiEndpoint,
	core,
	defineEndpoint,
	describePrincipals,
	errors,
	isUniqueViolation,
	PRINCIPAL_SEARCH_RATE_LIMIT,
	principalUserIds,
	type RequestContext,
	requireShareCapability,
	rowsOf,
	searchPrincipals,
	type StoredShare,
	type Tx,
	validatePrincipals
} from '$lib/sdk/server';
import {
	boardShareAccess,
	canEditAll,
	requireBoardAccess,
	taskContextOf,
	visibleBoardsFilter
} from './access';
import {
	buildBoards,
	buildDetail,
	loadBoardRows,
	loadDetailRows,
	lockBoard,
	mdb,
	refOf,
	userRefs
} from './boards.service';
import { notifyBoardShared } from './notify';
import { applyTemplate } from './templates';
import { insertApplied, loadTemplateData } from './templates.service';
import { addDays, daysBetween, todayBerlin } from '$lib/sdk/dates';
import {
	actionParams,
	boardInput,
	boardUpdateInput,
	columnDeleteQuery,
	columnInput,
	columnParams,
	columnUpdateInput,
	DEFAULT_COLUMNS,
	idParams,
	listQuery,
	MAX_COLUMNS,
	MODULE_ID,
	orderInput,
	peopleQuery,
	PERM,
	searchQuery,
	sharesInput,
	type ActionBoardInfo,
	type BoardDetail,
	type BoardList,
	type BoardShares,
	type UserRef
} from './schemas';

const tags = ['Aufgaben'];
const STAMM_NAME_SETTING = 'events.stamm.name';

async function everyoneLabel(): Promise<string> {
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
	if (taskContextOf(ctx).actions.get(actionId) !== 'edit') {
		throw errors.validation([
			{ path: ['actionId'], message: 'Aktion nicht gefunden oder ohne Bearbeiten-Recht' }
		]);
	}
}

const actionTaken = () => errors.conflict('Für diese Aktion gibt es bereits ein Board');

async function detail(ctx: RequestContext, boardId: string): Promise<BoardDetail> {
	const rows = await mdb().transaction((tx) => loadDetailRows(tx, ctx, boardId));
	return buildDetail(ctx, rows);
}

/** Erledigt-Zeitpunkt der Aufgaben an die Spalten anpassen (nach Spaltenänderungen) */
async function syncCompletion(tx: Tx, boardId: string): Promise<void> {
	await tx.execute(
		sql`UPDATE tasks t SET completed_at = CASE WHEN c.is_done THEN COALESCE(t.completed_at, now()) ELSE NULL END
			FROM board_columns c
			WHERE c.id = t.column_id AND t.board_id = ${boardId}
				AND (c.is_done = (t.completed_at IS NULL))`
	);
}

async function touch(tx: Tx, boardId: string): Promise<void> {
	await tx.execute(sql`UPDATE boards SET updated_at = now() WHERE id = ${boardId}`);
}

// --- Freigaben --------------------------------------------------------------

async function loadShareState(tx: Tx, ctx: RequestContext, id: string, need: 'read' | 'share') {
	const access = await requireBoardAccess(tx, ctx, id, need);
	const [board] = await rowsOf(tx, sql`SELECT owner_id, name FROM boards WHERE id = ${id}`);
	return {
		access,
		ownerId: String(board?.owner_id),
		name: String(board?.name ?? 'Board'),
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
		summary: 'Boards auflisten (eigene, freigegebene, über Aktionen und Zuweisungen sichtbare)',
		tags,
		permission: PERM.view,
		query: listQuery,
		handler: async ({ ctx, query }): Promise<BoardList> => {
			const term = query.search?.replace(/[%_\\]/g, '');
			const where = sql`${visibleBoardsFilter(ctx)} AND ${
				term ? sql`(b.name ILIKE ${`%${term}%`} OR b.description ILIKE ${`%${term}%`})` : sql`TRUE`
			}`;
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
		method: 'POST',
		path: '/boards',
		summary: 'Board anlegen (mit Spalten Offen · In Arbeit · Erledigt)',
		description:
			'Mit `actionId` wird das Board an eine Aktion gehängt (Bearbeiten-Zugriff auf die Aktion nötig, je Aktion ein Board, sonst 409). Wer die Aktion sehen bzw. bearbeiten darf, darf das auch beim Board.',
		tags,
		permission: PERM.create,
		body: boardInput,
		handler: async ({ ctx, body }) => {
			if (!ctx.userId) throw errors.badRequest('Boards können nur Benutzer*innen anlegen');
			assertActionEditable(ctx, body.actionId);
			const id = crypto.randomUUID();
			// Bezugsdatum: angegeben, sonst Beginn der Aktion, mit Vorlage sonst heute
			const action = body.actionId ? taskContextOf(ctx).actionDates.get(body.actionId) : undefined;
			const anchorOn =
				body.anchorOn ?? action?.startsOn ?? (body.templateId ? todayBerlin() : null);
			const anchorEnd =
				anchorOn && action?.startsOn && action.endsOn
					? addDays(anchorOn, daysBetween(action.startsOn, action.endsOn))
					: null;
			let tasks = 0;
			try {
				await mdb().transaction(async (tx) => {
					await tx.execute(
						sql`INSERT INTO boards (id, name, description, color, owner_id, action_id, anchor_on, created_by)
							VALUES (${id}, ${body.name}, ${body.description}, ${body.color}, ${ctx.userId},
								${body.actionId}, ${anchorOn}, ${ctx.userId})`
					);
					if (body.templateId) {
						const data = await loadTemplateData(tx, ctx, body.templateId);
						const applied = applyTemplate(data, { startsOn: anchorOn!, endsOn: anchorEnd });
						tasks = (await insertApplied(tx, id, applied, ctx.userId)).tasks;
						return;
					}
					for (const [i, c] of DEFAULT_COLUMNS.entries()) {
						await tx.execute(
							sql`INSERT INTO board_columns (id, board_id, name, position, is_done)
								VALUES (${crypto.randomUUID()}, ${id}, ${c.name}, ${i}, ${c.isDone})`
						);
					}
				});
			} catch (e) {
				if (isUniqueViolation(e)) throw actionTaken();
				throw e;
			}
			await core.audit.logFromContext(ctx, 'tasks.board.created', {
				target: id,
				metadata: { withAction: !!body.actionId, template: !!body.templateId, tasks }
			});
			return detail(ctx, id);
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/boards/by-action/:actionId',
		summary: 'Board einer Aktion (für den Tab in der Aktion)',
		tags,
		permission: PERM.view,
		params: actionParams,
		handler: async ({ ctx, params }): Promise<ActionBoardInfo> => {
			const tc = taskContextOf(ctx);
			const level = tc.actions.get(params.actionId) ?? null;
			if (!level && !canEditAll(ctx)) throw errors.notFound('Aktion nicht gefunden');
			const data = await mdb().transaction((tx) =>
				loadBoardRows(tx, ctx, sql`b.action_id = ${params.actionId}`)
			);
			const [board] = await buildBoards(ctx, data);
			return {
				board: board ?? null,
				canCreate: !board && level === 'edit' && core.permissions.has(ctx, PERM.create)
			};
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/boards/:id',
		summary: 'Board mit Spalten und Aufgaben',
		tags,
		permission: PERM.view,
		params: idParams,
		handler: ({ ctx, params }) => detail(ctx, params.id)
	}),
	defineEndpoint({
		method: 'PATCH',
		path: '/boards/:id',
		summary: 'Board ändern (Name, Beschreibung, Farbe, Aktion)',
		description: 'Aktion verknüpfen/lösen nur Eigentümer*in bzw. `edit-all`.',
		tags,
		permission: PERM.view,
		params: idParams,
		body: boardUpdateInput,
		handler: async ({ ctx, params, body }) => {
			if (body.actionId !== undefined) assertActionEditable(ctx, body.actionId);
			const linkedStart = body.actionId
				? (taskContextOf(ctx).actionDates.get(body.actionId)?.startsOn ?? null)
				: null;
			try {
				await mdb().transaction(async (tx) => {
					const access = await requireBoardAccess(
						tx,
						ctx,
						params.id,
						body.actionId !== undefined ? 'share' : 'edit'
					);
					if (access.level !== 'edit') throw errors.forbidden('Keine Berechtigung');
					const sets = [
						body.name !== undefined ? sql`name = ${body.name}` : null,
						body.description !== undefined ? sql`description = ${body.description ?? null}` : null,
						body.color !== undefined ? sql`color = ${body.color ?? null}` : null,
						body.actionId !== undefined ? sql`action_id = ${body.actionId}` : null,
						linkedStart ? sql`anchor_on = COALESCE(anchor_on, ${linkedStart}::date)` : null,
						body.defaultView !== undefined ? sql`default_view = ${body.defaultView}` : null,
						body.calendarMilestones !== undefined
							? sql`calendar_milestones = ${body.calendarMilestones}`
							: null
					].filter((v) => v !== null);
					await tx.execute(
						sql`UPDATE boards SET ${sql.join([...sets, sql`updated_at = now()`], sql`, `)}
							WHERE id = ${params.id}`
					);
				});
			} catch (e) {
				if (isUniqueViolation(e)) throw actionTaken();
				throw e;
			}
			await core.audit.logFromContext(ctx, 'tasks.board.updated', {
				target: params.id,
				metadata: { fields: Object.keys(body) }
			});
			return detail(ctx, params.id);
		}
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/boards/:id',
		summary: 'Board löschen (mit allen Aufgaben)',
		description: 'Nur Eigentümer*in oder `tasks.board.edit-all`.',
		tags,
		permission: PERM.view,
		params: idParams,
		handler: async ({ ctx, params }) => {
			const count = await mdb().transaction(async (tx) => {
				await requireBoardAccess(tx, ctx, params.id, 'share');
				const [n] = await rowsOf(
					tx,
					sql`SELECT count(*)::int AS n FROM tasks WHERE board_id = ${params.id}`
				);
				// Aufgaben zuerst (column_id RESTRICT), dann das Board samt Spalten/Freigaben
				await tx.execute(sql`DELETE FROM tasks WHERE board_id = ${params.id}`);
				await tx.execute(sql`DELETE FROM boards WHERE id = ${params.id}`);
				return Number(n?.n ?? 0);
			});
			await core.audit.logFromContext(ctx, 'tasks.board.deleted', {
				target: params.id,
				metadata: { tasks: count }
			});
			return { id: params.id, deleted: true };
		}
	}),

	// --- Freigaben ---
	defineEndpoint({
		method: 'GET',
		path: '/boards/:id/shares',
		summary: 'Freigaben eines Boards',
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
		summary: 'Freigaben eines Boards ersetzen',
		description:
			'Stamm, Gruppe, Rolle, Mitglied, Benutzer*in mit `read`/`edit`. Nur Eigentümer*in oder `edit-all`.',
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
			await core.audit.logFromContext(ctx, 'tasks.board.shared', {
				target: params.id,
				metadata: {
					shares: body.shares.length,
					added: addedPrincipals(before, body.shares).length,
					removed: addedPrincipals(body.shares, before).length
				}
			});
			return buildShares(ctx, { ownerId: current.ownerId, shares: body.shares, canManage: true });
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/principals',
		summary: 'Freigabe-Ziele suchen (Stamm, Gruppen, Rollen, Mitglieder, Benutzer*innen)',
		description:
			'Nur für Personen, die Boards teilen können (`tasks.board.create`, `edit-all` oder Eigentümer*in eines Boards), sonst 403.',
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
	}),
	defineEndpoint({
		method: 'GET',
		path: '/boards/:id/people',
		summary: 'Personen, denen Aufgaben zugewiesen werden können',
		description:
			'Ohne `search`: Personen mit Zugriff auf das Board (Eigentümer*in, Freigaben außer „Stamm“, bisherige Zuständige). Mit `search` (ab 2 Zeichen): alle aktiven Konten mit `tasks.board.view`. Nur mit Bearbeiten-Zugriff.',
		tags,
		permission: PERM.view,
		rateLimit: PRINCIPAL_SEARCH_RATE_LIMIT,
		params: idParams,
		query: peopleQuery,
		handler: async ({ ctx, params, query }): Promise<UserRef[]> => {
			const state = await mdb().transaction(async (tx) => {
				await requireBoardAccess(tx, ctx, params.id, 'edit');
				const [board] = await rowsOf(tx, sql`SELECT owner_id FROM boards WHERE id = ${params.id}`);
				const assigned = await rowsOf(
					tx,
					sql`SELECT DISTINCT ta.user_id FROM task_assignees ta JOIN tasks t ON t.id = ta.task_id
						WHERE t.board_id = ${params.id}
						UNION SELECT DISTINCT c.assignee_id FROM task_checklist c JOIN tasks t ON t.id = c.task_id
						WHERE t.board_id = ${params.id} AND c.assignee_id IS NOT NULL`
				);
				return {
					ownerId: String(board?.owner_id),
					shares: await boardShareAccess.loadShares(tx, params.id),
					assigned: assigned.map((r) => String(r.user_id))
				};
			});
			const allowed = new Set(await core.permissions.usersWith(PERM.view));
			let ids: string[];
			const search = query.search?.trim() ?? '';
			if (search.length >= 2) {
				const found = await core.users.directory(ctx, { search, limit: 30 });
				ids = found.map((u) => u.id);
			} else {
				const fromShares = await principalUserIds(
					MODULE_ID,
					state.shares.filter((s) => s.type !== 'everyone'),
					{ permission: PERM.view }
				);
				ids = [state.ownerId, ...fromShares, ...state.assigned];
			}
			const users = await userRefs(
				ctx,
				ids.filter((id) => allowed.has(id))
			);
			return [...users.values()].sort((a, b) => a.name.localeCompare(b.name, 'de')).slice(0, 50);
		}
	}),

	// --- Spalten ---
	defineEndpoint({
		method: 'POST',
		path: '/boards/:id/columns',
		summary: 'Spalte anlegen (am Ende)',
		description: '`isDone: true` macht sie zur einzigen Erledigt-Spalte.',
		tags,
		permission: PERM.view,
		params: idParams,
		body: columnInput,
		handler: async ({ ctx, params, body }) => {
			await mdb().transaction(async (tx) => {
				await requireBoardAccess(tx, ctx, params.id, 'edit');
				await lockBoard(tx, params.id);
				const [n] = await rowsOf(
					tx,
					sql`SELECT count(*)::int AS n, COALESCE(max(position), -1)::int AS max
						FROM board_columns WHERE board_id = ${params.id}`
				);
				if (Number(n?.n ?? 0) >= MAX_COLUMNS) {
					throw errors.conflict(`Höchstens ${MAX_COLUMNS} Spalten je Board`);
				}
				if (body.isDone) {
					await tx.execute(
						sql`UPDATE board_columns SET is_done = false WHERE board_id = ${params.id}`
					);
				}
				await tx.execute(
					sql`INSERT INTO board_columns (id, board_id, name, position, is_done)
						VALUES (${crypto.randomUUID()}, ${params.id}, ${body.name}, ${Number(n?.max ?? -1) + 1},
							${body.isDone})`
				);
				await syncCompletion(tx, params.id);
				await touch(tx, params.id);
			});
			await core.audit.logFromContext(ctx, 'tasks.column.created', { target: params.id });
			return detail(ctx, params.id);
		}
	}),
	defineEndpoint({
		method: 'PUT',
		path: '/boards/:id/columns/order',
		summary: 'Spalten umsortieren (alle IDs genau einmal)',
		tags,
		permission: PERM.view,
		params: idParams,
		body: orderInput,
		handler: async ({ ctx, params, body }) => {
			await mdb().transaction(async (tx) => {
				await requireBoardAccess(tx, ctx, params.id, 'edit');
				await lockBoard(tx, params.id);
				const rows = await rowsOf(
					tx,
					sql`SELECT id FROM board_columns WHERE board_id = ${params.id}`
				);
				const known = new Set(rows.map((r) => String(r.id)));
				if (
					body.ids.length !== known.size ||
					new Set(body.ids).size !== body.ids.length ||
					body.ids.some((id) => !known.has(id))
				) {
					throw errors.validation([
						{ path: ['ids'], message: 'Alle Spalten des Boards genau einmal angeben' }
					]);
				}
				for (const [i, id] of body.ids.entries()) {
					await tx.execute(sql`UPDATE board_columns SET position = ${i} WHERE id = ${id}`);
				}
				await touch(tx, params.id);
			});
			await core.audit.logFromContext(ctx, 'tasks.column.reordered', { target: params.id });
			return detail(ctx, params.id);
		}
	}),
	defineEndpoint({
		method: 'PATCH',
		path: '/boards/:id/columns/:columnId',
		summary: 'Spalte umbenennen oder als „erledigt“ markieren',
		tags,
		permission: PERM.view,
		params: columnParams,
		body: columnUpdateInput,
		handler: async ({ ctx, params, body }) => {
			await mdb().transaction(async (tx) => {
				await requireBoardAccess(tx, ctx, params.id, 'edit');
				await lockBoard(tx, params.id);
				const [col] = await rowsOf(
					tx,
					sql`SELECT id FROM board_columns WHERE id = ${params.columnId} AND board_id = ${params.id}`
				);
				if (!col) throw errors.notFound('Spalte nicht gefunden');
				if (body.name !== undefined) {
					await tx.execute(
						sql`UPDATE board_columns SET name = ${body.name} WHERE id = ${params.columnId}`
					);
				}
				if (body.isDone !== undefined) {
					if (body.isDone) {
						await tx.execute(
							sql`UPDATE board_columns SET is_done = (id = ${params.columnId}) WHERE board_id = ${params.id}`
						);
					} else {
						await tx.execute(
							sql`UPDATE board_columns SET is_done = false WHERE id = ${params.columnId}`
						);
					}
					await syncCompletion(tx, params.id);
				}
				await touch(tx, params.id);
			});
			await core.audit.logFromContext(ctx, 'tasks.column.updated', {
				target: params.id,
				metadata: { fields: Object.keys(body) }
			});
			return detail(ctx, params.id);
		}
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/boards/:id/columns/:columnId',
		summary: 'Spalte löschen',
		description:
			'Enthält die Spalte Aufgaben, müssen sie mit `?moveTo=<Spalte>` verschoben werden (sonst 409). Die letzte Spalte bleibt (409).',
		tags,
		permission: PERM.view,
		params: columnParams,
		query: columnDeleteQuery,
		handler: async ({ ctx, params, query }) => {
			const moved = await mdb().transaction(async (tx) => {
				await requireBoardAccess(tx, ctx, params.id, 'edit');
				await lockBoard(tx, params.id);
				const cols = await rowsOf(
					tx,
					sql`SELECT id FROM board_columns WHERE board_id = ${params.id}`
				);
				const ids = new Set(cols.map((c) => String(c.id)));
				if (!ids.has(params.columnId)) throw errors.notFound('Spalte nicht gefunden');
				if (ids.size <= 1) throw errors.conflict('Ein Board braucht mindestens eine Spalte');
				const tasks = await rowsOf(
					tx,
					sql`SELECT id FROM tasks WHERE column_id = ${params.columnId} ORDER BY position, created_at`
				);
				if (tasks.length) {
					if (!query.moveTo || query.moveTo === params.columnId || !ids.has(query.moveTo)) {
						throw errors.conflict(
							'Die Spalte enthält Aufgaben – bitte eine Zielspalte zum Verschieben wählen'
						);
					}
					const [m] = await rowsOf(
						tx,
						sql`SELECT COALESCE(max(position), -1)::int AS max FROM tasks WHERE column_id = ${query.moveTo}`
					);
					let pos = Number(m?.max ?? -1);
					for (const t of tasks) {
						pos++;
						await tx.execute(
							sql`UPDATE tasks SET column_id = ${query.moveTo}, position = ${pos} WHERE id = ${String(t.id)}`
						);
					}
				}
				await tx.execute(sql`DELETE FROM board_columns WHERE id = ${params.columnId}`);
				await syncCompletion(tx, params.id);
				await touch(tx, params.id);
				return tasks.length;
			});
			await core.audit.logFromContext(ctx, 'tasks.column.deleted', {
				target: params.id,
				metadata: { movedTasks: moved }
			});
			return detail(ctx, params.id);
		}
	})
];
