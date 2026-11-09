/** Dienst `TaskRefsService` (siehe `contract.ts`): Verweise auf Boards und Aufgaben für andere Module */
import { sql } from 'drizzle-orm';
import { core, inList, type RequestContext, type Row, rowsOf, toIso } from '$lib/sdk/server';
import { boardAccessForMany, loadTaskContext, visibleBoardsFilter } from './access';
import { mdb } from './boards.service';
import { boardLink } from './notify';
import { PERM, PRIORITIES, type Priority } from './schemas';
import type { TaskBoardRefInfo, TaskMilestoneRef, TaskRefInfo, TaskRefsService } from './contract';

const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const clampLimit = (n: number | undefined) => Math.min(Math.max(n ?? 20, 1), 50);
const MAX_IDS = 200;

const BOARD_SELECT = sql`b.id, b.name, b.color,
	(SELECT count(*)::int FROM tasks t WHERE t.board_id = b.id AND t.completed_at IS NULL) AS open,
	(SELECT count(*)::int FROM tasks t WHERE t.board_id = b.id AND t.completed_at IS NOT NULL) AS done`;

const TASK_SELECT = sql`t.id, t.title, t.board_id, b.name AS board_name, c.name AS column_name, t.priority,
	to_char(t.due_on, 'YYYY-MM-DD') AS due_on, t.completed_at`;

const toBoard = (r: Row): TaskBoardRefInfo => ({
	id: String(r.id),
	name: String(r.name),
	color: r.color == null ? null : String(r.color),
	open: Number(r.open ?? 0),
	done: Number(r.done ?? 0),
	href: boardLink(String(r.id))
});

const toTask = (r: Row): TaskRefInfo => ({
	id: String(r.id),
	title: String(r.title),
	boardId: String(r.board_id),
	boardName: String(r.board_name),
	columnName: String(r.column_name),
	priority: (PRIORITIES as readonly string[]).includes(String(r.priority))
		? (String(r.priority) as Priority)
		: 'medium',
	dueOn: r.due_on == null ? null : String(r.due_on),
	done: r.completed_at != null,
	href: boardLink(String(r.board_id), String(r.id))
});

/** Rechte prüfen und Zugriffskontext laden; `false` = keine Treffer */
async function prepare(ctx: RequestContext): Promise<boolean> {
	if (ctx.actor.type !== 'system' && !core.permissions.has(ctx, PERM.view)) return false;
	await loadTaskContext(ctx);
	return true;
}

const ordered = <T extends { id: string }>(ids: readonly string[], items: T[]): T[] => {
	const byId = new Map(items.map((i) => [i.id, i]));
	return ids.map((id) => byId.get(id)).filter((i): i is T => !!i);
};

export const taskRefsService: TaskRefsService = {
	async searchBoardRefs(ctx, opts = {}) {
		if (!(await prepare(ctx))) return [];
		const search = opts.search?.trim();
		const rows = await mdb().transaction((tx) =>
			rowsOf(
				tx,
				sql`SELECT ${BOARD_SELECT} FROM boards b
					WHERE ${visibleBoardsFilter(ctx)} ${search ? sql`AND b.name ILIKE ${like(search)}` : sql``}
					ORDER BY b.updated_at DESC, b.id LIMIT ${clampLimit(opts.limit)}`
			)
		);
		return rows.map(toBoard);
	},
	async describeBoardRefs(ctx, ids) {
		const list = [...new Set(ids)].slice(0, MAX_IDS);
		if (!list.length || !(await prepare(ctx))) return [];
		const rows = await mdb().transaction((tx) =>
			rowsOf(
				tx,
				sql`SELECT ${BOARD_SELECT} FROM boards b
					WHERE b.id IN (${inList(list)}) AND ${visibleBoardsFilter(ctx)}`
			)
		);
		return ordered(list, rows.map(toBoard));
	},
	async searchTaskRefs(ctx, opts = {}) {
		if (!(await prepare(ctx))) return [];
		const search = opts.search?.trim();
		const rows = await mdb().transaction((tx) =>
			rowsOf(
				tx,
				sql`SELECT ${TASK_SELECT} FROM tasks t
					JOIN boards b ON b.id = t.board_id JOIN board_columns c ON c.id = t.column_id
					WHERE ${visibleBoardsFilter(ctx)} ${search ? sql`AND t.title ILIKE ${like(search)}` : sql``}
					ORDER BY t.updated_at DESC, t.id LIMIT ${clampLimit(opts.limit)}`
			)
		);
		return rows.map(toTask);
	},
	async describeTaskRefs(ctx, ids) {
		const list = [...new Set(ids)].slice(0, MAX_IDS);
		if (!list.length || !(await prepare(ctx))) return [];
		const rows = await mdb().transaction((tx) =>
			rowsOf(
				tx,
				sql`SELECT ${TASK_SELECT} FROM tasks t
					JOIN boards b ON b.id = t.board_id JOIN board_columns c ON c.id = t.column_id
					WHERE t.id IN (${inList(list)}) AND ${visibleBoardsFilter(ctx)}`
			)
		);
		return ordered(list, rows.map(toTask));
	},
	async calendarMilestones(ctx, window) {
		if (!ctx.userId || !(await prepare(ctx))) return [];
		const userId = ctx.userId;
		const rows = await mdb().transaction(async (tx) => {
			const list = await rowsOf(
				tx,
				sql`SELECT t.id, t.title, t.board_id, b.name AS board_name, b.owner_id, b.action_id,
						to_char(t.due_on, 'YYYY-MM-DD') AS due_on, t.completed_at, t.updated_at,
						EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = t.id AND a.user_id = ${userId}) AS mine,
						EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = t.id) AS assigned
					FROM tasks t JOIN boards b ON b.id = t.board_id
					WHERE b.calendar_milestones AND t.is_milestone
						AND t.due_on BETWEEN ${window.from}::date AND ${window.to}::date
						AND ${visibleBoardsFilter(ctx)}
					ORDER BY t.due_on, t.id LIMIT 500`
			);
			const boards = new Map<string, { id: string; ownerId: string; actionId: string | null }>();
			for (const r of list) {
				boards.set(String(r.board_id), {
					id: String(r.board_id),
					ownerId: String(r.owner_id),
					actionId: r.action_id == null ? null : String(r.action_id)
				});
			}
			const access = await boardAccessForMany(tx, ctx, [...boards.values()]);
			const flag = (v: unknown) => v === true || v === 't';
			return list.filter(
				(r) =>
					flag(r.mine) || (!flag(r.assigned) && access.get(String(r.board_id))?.level === 'edit')
			);
		});
		return rows.map((r): TaskMilestoneRef => ({
			id: String(r.id),
			title: String(r.title),
			boardId: String(r.board_id),
			boardName: String(r.board_name),
			dueOn: String(r.due_on),
			done: r.completed_at != null,
			updatedAt: toIso(r.updated_at),
			href: boardLink(String(r.board_id), String(r.id))
		}));
	}
};
