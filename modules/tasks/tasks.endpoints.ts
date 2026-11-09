/** REST für Aufgaben, Unteraufgaben (Checkliste) und „Meine Aufgaben“ (`/api/v1/modules/tasks/…`). */
import { sql } from 'drizzle-orm';
import {
	type AnyApiEndpoint,
	core,
	defineEndpoint,
	errors,
	num,
	rowsOf,
	type Tx
} from '$lib/sdk/server';
import { requireBoardAccess, requireTask } from './access';
import {
	assertAssignable,
	assertPhaseOfBoard,
	bool,
	lockBoard,
	mdb,
	strOrNull,
	taskDetail,
	writeColumnOrder
} from './boards.service';
import { createsCycle } from './dependencies';
import { notifyAssigned } from './notify';
import {
	checklistItemInput,
	checklistItemUpdateInput,
	checklistParams,
	dependenciesInput,
	idParams,
	MAX_CHECKLIST,
	MAX_TASKS_PER_BOARD,
	myTasksQuery,
	orderInput,
	PERM,
	reorder,
	taskDateIssues,
	taskInput,
	taskMoveInput,
	taskParams,
	taskUpdateInput,
	type MyTask,
	type Priority
} from './schemas';

const tags = ['Aufgaben'];

/** Board-Name, Aufgabentitel, Fälligkeit (für Benachrichtigungen) */
async function taskInfo(tx: Tx, taskId: string) {
	const [r] = await rowsOf(
		tx,
		sql`SELECT t.title, t.board_id, b.name AS board_name, to_char(t.due_on, 'YYYY-MM-DD') AS due_on
			FROM tasks t JOIN boards b ON b.id = t.board_id WHERE t.id = ${taskId}`
	);
	return {
		taskTitle: String(r?.title ?? ''),
		boardId: String(r?.board_id ?? ''),
		boardName: String(r?.board_name ?? ''),
		dueOn: r?.due_on == null ? null : String(r.due_on)
	};
}

async function columnOf(tx: Tx, boardId: string, columnId: string | undefined) {
	const [col] = columnId
		? await rowsOf(
				tx,
				sql`SELECT id, is_done FROM board_columns WHERE id = ${columnId} AND board_id = ${boardId}`
			)
		: await rowsOf(
				tx,
				sql`SELECT id, is_done FROM board_columns WHERE board_id = ${boardId}
					ORDER BY position, created_at, id LIMIT 1`
			);
	if (!col) {
		throw errors.validation([{ path: ['columnId'], message: 'Spalte nicht gefunden' }]);
	}
	return { id: String(col.id), isDone: col.is_done === true || col.is_done === 't' };
}

async function columnTaskIds(tx: Tx, columnId: string): Promise<string[]> {
	const rows = await rowsOf(
		tx,
		sql`SELECT id FROM tasks WHERE column_id = ${columnId} ORDER BY position, created_at, id`
	);
	return rows.map((r) => String(r.id));
}

async function replaceAssignees(tx: Tx, taskId: string, ids: readonly string[]): Promise<string[]> {
	const before = await rowsOf(
		tx,
		sql`SELECT user_id FROM task_assignees WHERE task_id = ${taskId}`
	);
	const old = new Set(before.map((r) => String(r.user_id)));
	await tx.execute(sql`DELETE FROM task_assignees WHERE task_id = ${taskId}`);
	for (const id of ids) {
		await tx.execute(sql`INSERT INTO task_assignees (task_id, user_id) VALUES (${taskId}, ${id})`);
	}
	return ids.filter((id) => !old.has(id));
}

async function touchTask(tx: Tx, taskId: string, boardId: string) {
	await tx.execute(sql`UPDATE tasks SET updated_at = now() WHERE id = ${taskId}`);
	await tx.execute(sql`UPDATE boards SET updated_at = now() WHERE id = ${boardId}`);
}

/**
 * Zeitraum/Meilenstein beim Ändern mit dem gespeicherten Stand zusammenführen und prüfen (422).
 * Wird eine Aufgabe zum Meilenstein, entfällt ein gespeicherter Beginn automatisch.
 */
async function mergedDates(
	tx: Tx,
	taskId: string,
	body: { startsOn?: string | null; dueOn?: string | null; isMilestone?: boolean }
): Promise<{ startsOn: string | null; startsChanged: boolean }> {
	const [cur] = await rowsOf(
		tx,
		sql`SELECT to_char(starts_on, 'YYYY-MM-DD') AS starts_on, to_char(due_on, 'YYYY-MM-DD') AS due_on,
				is_milestone FROM tasks WHERE id = ${taskId}`
	);
	const stored = strOrNull(cur?.starts_on);
	const merged = {
		startsOn: body.startsOn !== undefined ? body.startsOn : stored,
		dueOn: body.dueOn !== undefined ? body.dueOn : strOrNull(cur?.due_on),
		isMilestone: body.isMilestone ?? bool(cur?.is_milestone)
	};
	if (merged.isMilestone && body.startsOn === undefined) merged.startsOn = null;
	const issues = taskDateIssues(merged);
	if (issues.length) throw errors.validation(issues);
	return { startsOn: merged.startsOn ?? null, startsChanged: (merged.startsOn ?? null) !== stored };
}

async function storedAssignees(taskId: string): Promise<Set<string>> {
	const rows = await mdb().transaction((tx) =>
		rowsOf(
			tx,
			sql`SELECT user_id FROM task_assignees WHERE task_id = ${taskId}
				UNION SELECT assignee_id FROM task_checklist WHERE task_id = ${taskId} AND assignee_id IS NOT NULL`
		)
	);
	return new Set(rows.map((r) => String(r.user_id)));
}

export const taskEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/my/tasks',
		summary: 'Mir zugewiesene Aufgaben (direkt oder über eine Unteraufgabe)',
		description: 'Offene zuerst nach Fälligkeit, dann Priorität. Für die Dashboard-Kachel.',
		tags,
		permission: PERM.view,
		query: myTasksQuery,
		handler: async ({ ctx, query }): Promise<MyTask[]> => {
			if (!ctx.userId) return [];
			const rows = await mdb().transaction((tx) =>
				rowsOf(
					tx,
					sql`SELECT t.id, t.title, t.priority, to_char(t.due_on, 'YYYY-MM-DD') AS due_on, t.is_milestone,
							p.id AS phase_id, p.name AS phase_name, p.color AS phase_color,
							b.id AS board_id, b.name AS board_name, b.color AS board_color, c.name AS column_name,
							EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = t.id AND a.user_id = ${ctx.userId}) AS direct,
							(SELECT count(*)::int FROM task_checklist x WHERE x.task_id = t.id) AS items,
							(SELECT count(*)::int FROM task_checklist x WHERE x.task_id = t.id AND x.done) AS items_done
						FROM tasks t
						JOIN boards b ON b.id = t.board_id
						JOIN board_columns c ON c.id = t.column_id
						LEFT JOIN board_phases p ON p.id = t.phase_id
						WHERE (EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = t.id AND a.user_id = ${ctx.userId})
							OR EXISTS (SELECT 1 FROM task_checklist x WHERE x.task_id = t.id
								AND x.assignee_id = ${ctx.userId} AND NOT x.done))
							AND ${query.done ? sql`TRUE` : sql`t.completed_at IS NULL`}
						ORDER BY (t.completed_at IS NOT NULL), t.due_on NULLS LAST,
							CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
							t.created_at
						LIMIT ${query.limit}`
				)
			);
			return rows.map((r) => ({
				id: String(r.id),
				title: String(r.title),
				priority: String(r.priority) as Priority,
				dueOn: r.due_on == null ? null : String(r.due_on),
				board: {
					id: String(r.board_id),
					name: String(r.board_name),
					color: r.board_color == null ? null : String(r.board_color)
				},
				columnName: String(r.column_name),
				checklist: { done: num(r.items_done), total: num(r.items) },
				viaChecklist: !(r.direct === true || r.direct === 't'),
				isMilestone: bool(r.is_milestone),
				phase: r.phase_id
					? {
							id: String(r.phase_id),
							name: String(r.phase_name),
							color: strOrNull(r.phase_color)
						}
					: null
			}));
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/boards/:id/tasks',
		summary: 'Aufgabe anlegen (am Ende der Spalte, ohne Spalte in der ersten)',
		tags,
		permission: PERM.view,
		params: idParams,
		body: taskInput,
		handler: async ({ ctx, params, body }) => {
			await assertAssignable([
				...body.assigneeIds.map((id, i) => ({ id, path: ['assigneeIds', i] })),
				...body.checklist.map((c, i) => ({
					id: c.assigneeId,
					path: ['checklist', i, 'assigneeId']
				}))
			]);
			const id = crypto.randomUUID();
			const info = await mdb().transaction(async (tx) => {
				await requireBoardAccess(tx, ctx, params.id, 'edit');
				await lockBoard(tx, params.id);
				const [n] = await rowsOf(
					tx,
					sql`SELECT count(*)::int AS n FROM tasks WHERE board_id = ${params.id}`
				);
				if (Number(n?.n ?? 0) >= MAX_TASKS_PER_BOARD) {
					throw errors.conflict(`Höchstens ${MAX_TASKS_PER_BOARD} Aufgaben je Board`);
				}
				const col = await columnOf(tx, params.id, body.columnId);
				await assertPhaseOfBoard(tx, params.id, body.phaseId);
				const position = (await columnTaskIds(tx, col.id)).length;
				await tx.execute(
					sql`INSERT INTO tasks (id, board_id, column_id, title, description, priority, due_on,
							starts_on, is_milestone, phase_id, position, completed_at, created_by)
						VALUES (${id}, ${params.id}, ${col.id}, ${body.title}, ${body.description}, ${body.priority},
							${body.dueOn}, ${body.isMilestone ? null : body.startsOn}, ${body.isMilestone},
							${body.phaseId}, ${position}, ${col.isDone ? sql`now()` : sql`NULL`}, ${ctx.userId ?? null})`
				);
				await replaceAssignees(tx, id, body.assigneeIds);
				for (const [i, c] of body.checklist.entries()) {
					await tx.execute(
						sql`INSERT INTO task_checklist (id, task_id, title, done, assignee_id, due_on, position,
								done_at, done_by)
							VALUES (${crypto.randomUUID()}, ${id}, ${c.title}, ${c.done}, ${c.assigneeId}, ${c.dueOn},
								${i}, ${c.done ? sql`now()` : sql`NULL`}, ${c.done ? (ctx.userId ?? null) : null})`
					);
				}
				await touchTask(tx, id, params.id);
				return taskInfo(tx, id);
			});
			await core.audit.logFromContext(ctx, 'tasks.task.created', {
				target: id,
				metadata: {
					board: params.id,
					assignees: body.assigneeIds.length,
					checklist: body.checklist.length
				}
			});
			await notifyAssigned(ctx, { ...info, taskId: id, userIds: body.assigneeIds });
			const itemAssignees = body.checklist.filter(
				(c) => c.assigneeId && !body.assigneeIds.includes(c.assigneeId)
			);
			for (const c of itemAssignees) {
				await notifyAssigned(ctx, {
					...info,
					taskId: id,
					userIds: [c.assigneeId!],
					itemTitle: c.title,
					dueOn: c.dueOn ?? info.dueOn
				});
			}
			return taskDetail(ctx, id);
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/tasks/:id',
		summary: 'Aufgabe mit Unteraufgaben',
		tags,
		permission: PERM.view,
		params: taskParams,
		handler: ({ ctx, params }) => taskDetail(ctx, params.id)
	}),
	defineEndpoint({
		method: 'PATCH',
		path: '/tasks/:id',
		summary: 'Aufgabe ändern (nur übergebene Felder; `assigneeIds` ersetzt die Liste)',
		tags,
		permission: PERM.view,
		params: taskParams,
		body: taskUpdateInput,
		handler: async ({ ctx, params, body }) => {
			if (body.assigneeIds) {
				await assertAssignable(
					body.assigneeIds.map((id, i) => ({ id, path: ['assigneeIds', i] })),
					await storedAssignees(params.id)
				);
			}
			const { added, info } = await mdb().transaction(async (tx) => {
				const { boardId } = await requireTask(tx, ctx, params.id, 'edit');
				const dates = await mergedDates(tx, params.id, body);
				if (body.phaseId !== undefined) await assertPhaseOfBoard(tx, boardId, body.phaseId);
				const sets = [
					body.title !== undefined ? sql`title = ${body.title}` : null,
					body.description !== undefined ? sql`description = ${body.description ?? null}` : null,
					body.priority !== undefined ? sql`priority = ${body.priority}` : null,
					body.dueOn !== undefined ? sql`due_on = ${body.dueOn ?? null}, reminded_on = NULL` : null,
					dates.startsChanged ? sql`starts_on = ${dates.startsOn}` : null,
					body.isMilestone !== undefined ? sql`is_milestone = ${body.isMilestone}` : null,
					body.phaseId !== undefined ? sql`phase_id = ${body.phaseId}` : null
				].filter((v) => v !== null);
				if (sets.length) {
					await tx.execute(
						sql`UPDATE tasks SET ${sql.join(sets, sql`, `)} WHERE id = ${params.id}`
					);
				}
				const added = body.assigneeIds
					? await replaceAssignees(tx, params.id, body.assigneeIds)
					: [];
				await touchTask(tx, params.id, boardId);
				return { added, info: await taskInfo(tx, params.id) };
			});
			await core.audit.logFromContext(ctx, 'tasks.task.updated', {
				target: params.id,
				metadata: { fields: Object.keys(body) }
			});
			await notifyAssigned(ctx, { ...info, taskId: params.id, userIds: added });
			return taskDetail(ctx, params.id);
		}
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/tasks/:id',
		summary: 'Aufgabe löschen',
		tags,
		permission: PERM.view,
		params: taskParams,
		handler: async ({ ctx, params }) => {
			const boardId = await mdb().transaction(async (tx) => {
				const { boardId } = await requireTask(tx, ctx, params.id, 'edit');
				await lockBoard(tx, boardId);
				const [t] = await rowsOf(tx, sql`SELECT column_id FROM tasks WHERE id = ${params.id}`);
				await tx.execute(sql`DELETE FROM tasks WHERE id = ${params.id}`);
				await writeColumnOrder(tx, await columnTaskIds(tx, String(t?.column_id)));
				await tx.execute(sql`UPDATE boards SET updated_at = now() WHERE id = ${boardId}`);
				return boardId;
			});
			await core.audit.logFromContext(ctx, 'tasks.task.deleted', {
				target: params.id,
				metadata: { board: boardId }
			});
			return { id: params.id, deleted: true };
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/tasks/:id/move',
		summary: 'Aufgabe verschieben (Spalte und Position)',
		description:
			'Bearbeiten-Zugriff aufs Board oder der Aufgabe bzw. einer ihrer Unteraufgaben zugewiesen. In der Erledigt-Spalte gilt die Aufgabe als erledigt.',
		tags,
		permission: PERM.view,
		params: taskParams,
		body: taskMoveInput,
		handler: async ({ ctx, params, body }) => {
			await mdb().transaction(async (tx) => {
				const { boardId } = await requireTask(tx, ctx, params.id, 'move');
				await lockBoard(tx, boardId);
				const target = await columnOf(tx, boardId, body.columnId);
				const [t] = await rowsOf(tx, sql`SELECT column_id FROM tasks WHERE id = ${params.id}`);
				const from = String(t?.column_id);
				await tx.execute(
					sql`UPDATE tasks SET column_id = ${target.id},
							completed_at = ${target.isDone ? sql`COALESCE(completed_at, now())` : sql`NULL`},
							updated_at = now()
						WHERE id = ${params.id}`
				);
				const ids = reorder(await columnTaskIds(tx, target.id), params.id, body.position);
				await writeColumnOrder(tx, ids);
				if (from !== target.id) await writeColumnOrder(tx, await columnTaskIds(tx, from));
				await tx.execute(sql`UPDATE boards SET updated_at = now() WHERE id = ${boardId}`);
			});
			return taskDetail(ctx, params.id);
		}
	}),

	defineEndpoint({
		method: 'PUT',
		path: '/tasks/:id/dependencies',
		summary: 'Vorgänger festlegen („blockiert durch“, ersetzt die Liste)',
		description:
			'Nur Aufgaben desselben Boards, keine Kreise (sonst 422). Die Daten werden nicht automatisch verschoben.',
		tags,
		permission: PERM.view,
		params: taskParams,
		body: dependenciesInput,
		handler: async ({ ctx, params, body }) => {
			await mdb().transaction(async (tx) => {
				const { boardId } = await requireTask(tx, ctx, params.id, 'edit');
				await lockBoard(tx, boardId);
				const known = new Set(
					(await rowsOf(tx, sql`SELECT id FROM tasks WHERE board_id = ${boardId}`)).map((r) =>
						String(r.id)
					)
				);
				const issues = body.ids.flatMap((id, i) =>
					id === params.id
						? [{ path: ['ids', i], message: 'Eine Aufgabe kann nicht auf sich selbst warten' }]
						: known.has(id)
							? []
							: [{ path: ['ids', i], message: 'Aufgabe nicht gefunden' }]
				);
				if (issues.length) throw errors.validation(issues);
				const edges = new Map<string, string[]>();
				for (const r of await rowsOf(
					tx,
					sql`SELECT d.task_id, d.blocked_by_id FROM task_dependencies d
						JOIN tasks t ON t.id = d.task_id WHERE t.board_id = ${boardId}`
				)) {
					const list = edges.get(String(r.task_id)) ?? [];
					list.push(String(r.blocked_by_id));
					edges.set(String(r.task_id), list);
				}
				edges.delete(params.id);
				if (createsCycle(edges, params.id, body.ids)) {
					throw errors.validation([
						{ path: ['ids'], message: 'Diese Abhängigkeit würde einen Kreis bilden' }
					]);
				}
				await tx.execute(sql`DELETE FROM task_dependencies WHERE task_id = ${params.id}`);
				for (const id of body.ids) {
					await tx.execute(
						sql`INSERT INTO task_dependencies (task_id, blocked_by_id) VALUES (${params.id}, ${id})`
					);
				}
				await touchTask(tx, params.id, boardId);
			});
			await core.audit.logFromContext(ctx, 'tasks.task.updated', {
				target: params.id,
				metadata: { fields: ['dependencies'], count: body.ids.length }
			});
			return taskDetail(ctx, params.id);
		}
	}),

	// --- Unteraufgaben ---
	defineEndpoint({
		method: 'POST',
		path: '/tasks/:id/checklist',
		summary: 'Unteraufgabe anlegen (am Ende)',
		tags,
		permission: PERM.view,
		params: taskParams,
		body: checklistItemInput,
		handler: async ({ ctx, params, body }) => {
			await assertAssignable([{ id: body.assigneeId, path: ['assigneeId'] }]);
			const info = await mdb().transaction(async (tx) => {
				const { boardId } = await requireTask(tx, ctx, params.id, 'edit');
				await lockBoard(tx, boardId);
				const [n] = await rowsOf(
					tx,
					sql`SELECT count(*)::int AS n, COALESCE(max(position), -1)::int AS max
						FROM task_checklist WHERE task_id = ${params.id}`
				);
				if (Number(n?.n ?? 0) >= MAX_CHECKLIST) {
					throw errors.conflict(`Höchstens ${MAX_CHECKLIST} Unteraufgaben je Aufgabe`);
				}
				await tx.execute(
					sql`INSERT INTO task_checklist (id, task_id, title, done, assignee_id, due_on, position,
							done_at, done_by)
						VALUES (${crypto.randomUUID()}, ${params.id}, ${body.title}, ${body.done},
							${body.assigneeId}, ${body.dueOn}, ${Number(n?.max ?? -1) + 1},
							${body.done ? sql`now()` : sql`NULL`}, ${body.done ? (ctx.userId ?? null) : null})`
				);
				await touchTask(tx, params.id, boardId);
				return taskInfo(tx, params.id);
			});
			if (body.assigneeId) {
				await notifyAssigned(ctx, {
					...info,
					taskId: params.id,
					userIds: [body.assigneeId],
					itemTitle: body.title,
					dueOn: body.dueOn ?? info.dueOn
				});
			}
			return taskDetail(ctx, params.id);
		}
	}),
	defineEndpoint({
		method: 'PUT',
		path: '/tasks/:id/checklist/order',
		summary: 'Unteraufgaben umsortieren (alle IDs genau einmal)',
		tags,
		permission: PERM.view,
		params: taskParams,
		body: orderInput,
		handler: async ({ ctx, params, body }) => {
			await mdb().transaction(async (tx) => {
				const { boardId } = await requireTask(tx, ctx, params.id, 'edit');
				const rows = await rowsOf(
					tx,
					sql`SELECT id FROM task_checklist WHERE task_id = ${params.id}`
				);
				const known = new Set(rows.map((r) => String(r.id)));
				if (
					body.ids.length !== known.size ||
					new Set(body.ids).size !== body.ids.length ||
					body.ids.some((id) => !known.has(id))
				) {
					throw errors.validation([
						{ path: ['ids'], message: 'Alle Unteraufgaben genau einmal angeben' }
					]);
				}
				for (const [i, id] of body.ids.entries()) {
					await tx.execute(sql`UPDATE task_checklist SET position = ${i} WHERE id = ${id}`);
				}
				await touchTask(tx, params.id, boardId);
			});
			return taskDetail(ctx, params.id);
		}
	}),
	defineEndpoint({
		method: 'PATCH',
		path: '/tasks/:id/checklist/:itemId',
		summary: 'Unteraufgabe ändern oder abhaken',
		description:
			'Nur `done` ändern dürfen auch Zugewiesene mit Lesezugriff; alles andere braucht Bearbeiten-Zugriff.',
		tags,
		permission: PERM.view,
		params: checklistParams,
		body: checklistItemUpdateInput,
		handler: async ({ ctx, params, body }) => {
			const onlyDone = Object.keys(body).every((k) => k === 'done');
			if (body.assigneeId !== undefined) {
				await assertAssignable(
					[{ id: body.assigneeId, path: ['assigneeId'] }],
					await storedAssignees(params.id)
				);
			}
			const result = await mdb().transaction(async (tx) => {
				const { boardId } = await requireTask(tx, ctx, params.id, onlyDone ? 'move' : 'edit');
				const [item] = await rowsOf(
					tx,
					sql`SELECT id, title, assignee_id, to_char(due_on, 'YYYY-MM-DD') AS due_on
						FROM task_checklist WHERE id = ${params.itemId} AND task_id = ${params.id}`
				);
				if (!item) throw errors.notFound('Unteraufgabe nicht gefunden');
				const sets = [
					body.title !== undefined ? sql`title = ${body.title}` : null,
					body.assigneeId !== undefined ? sql`assignee_id = ${body.assigneeId}` : null,
					body.dueOn !== undefined ? sql`due_on = ${body.dueOn ?? null}` : null,
					body.done !== undefined
						? body.done
							? sql`done = true, done_at = COALESCE(done_at, now()), done_by = COALESCE(done_by, ${ctx.userId ?? null})`
							: sql`done = false, done_at = NULL, done_by = NULL`
						: null
				].filter((v) => v !== null);
				if (sets.length) {
					await tx.execute(
						sql`UPDATE task_checklist SET ${sql.join(sets, sql`, `)} WHERE id = ${params.itemId}`
					);
				}
				await touchTask(tx, params.id, boardId);
				const newAssignee =
					body.assigneeId && body.assigneeId !== (item.assignee_id ?? null)
						? body.assigneeId
						: null;
				return {
					info: await taskInfo(tx, params.id),
					newAssignee,
					title: body.title ?? String(item.title),
					dueOn: body.dueOn !== undefined ? body.dueOn : (item.due_on as string | null)
				};
			});
			if (result.newAssignee) {
				await notifyAssigned(ctx, {
					...result.info,
					taskId: params.id,
					userIds: [result.newAssignee],
					itemTitle: result.title,
					dueOn: result.dueOn ?? result.info.dueOn
				});
			}
			return taskDetail(ctx, params.id);
		}
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/tasks/:id/checklist/:itemId',
		summary: 'Unteraufgabe löschen',
		tags,
		permission: PERM.view,
		params: checklistParams,
		handler: async ({ ctx, params }) => {
			await mdb().transaction(async (tx) => {
				const { boardId } = await requireTask(tx, ctx, params.id, 'edit');
				const res = await rowsOf(
					tx,
					sql`DELETE FROM task_checklist WHERE id = ${params.itemId} AND task_id = ${params.id} RETURNING id`
				);
				if (!res.length) throw errors.notFound('Unteraufgabe nicht gefunden');
				await touchTask(tx, params.id, boardId);
			});
			return taskDetail(ctx, params.id);
		}
	})
];
