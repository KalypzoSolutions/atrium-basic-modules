/**
 * Laden und Aufbau der Antworten. Zeilen werden IN der Modul-Transaktion gelesen, Namen/Bilder
 * (`core.users.byIds`) und Aktionsdaten erst DANACH aufgelöst (PGlite hat nur eine Sitzung).
 */
import { sql } from 'drizzle-orm';
import {
	core,
	errors,
	inList,
	moduleDb,
	num,
	type RequestContext,
	type Row,
	rowsOf,
	toIso,
	toIsoOrNull,
	type Tx
} from '$lib/sdk/server';
import { daysBetween, todayBerlin } from '$lib/sdk/dates';
import { boardAccessForMany, requireTask, resolveBoardAccess, taskContextOf } from './access';
import { currentPhase } from './phases';
import {
	MODULE_ID,
	PERM,
	VIEWS,
	type Board,
	type BoardAccess,
	type BoardDetail,
	type BoardView,
	type ChecklistItem,
	type Column,
	type Phase,
	type Priority,
	type TaskCard,
	type TaskDetail,
	type UserRef
} from './schemas';

export const mdb = () => moduleDb(MODULE_ID);

export const strOrNull = (v: unknown): string | null => (v == null || v === '' ? null : String(v));
export const bool = (v: unknown) => v === true || v === 't';

/** Board-Spalten inkl. Zählern (Alias `b`) */
const boardColumns = () => sql`b.id, b.name, b.description, b.color, b.owner_id, b.action_id,
	b.default_view, b.calendar_milestones, to_char(b.anchor_on, 'YYYY-MM-DD') AS anchor_on,
	b.created_at, b.updated_at,
	(SELECT count(*)::int FROM tasks t WHERE t.board_id = b.id) AS total,
	(SELECT count(*)::int FROM tasks t WHERE t.board_id = b.id AND t.completed_at IS NOT NULL) AS done,
	(SELECT count(*)::int FROM tasks t WHERE t.board_id = b.id AND t.completed_at IS NULL
		AND t.due_on < ${todayBerlin()}::date) AS overdue`;

export const PHASE_SELECT = sql`id, board_id, name, color, to_char(starts_on, 'YYYY-MM-DD') AS starts_on,
	to_char(ends_on, 'YYYY-MM-DD') AS ends_on, position`;

export interface BoardRows {
	rows: Row[];
	access: Map<string, BoardAccess>;
	phases: Row[];
	milestones: Row[];
}

export async function loadBoardRows(
	tx: Tx,
	ctx: RequestContext,
	where: ReturnType<typeof sql>,
	page?: { limit: number; offset: number }
): Promise<BoardRows> {
	const rows = await rowsOf(
		tx,
		sql`SELECT ${boardColumns()} FROM boards b WHERE ${where}
			ORDER BY b.updated_at DESC, b.name
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
	const ids = rows.map((r) => String(r.id));
	const phases = ids.length
		? await rowsOf(
				tx,
				sql`SELECT ${PHASE_SELECT} FROM board_phases WHERE board_id IN (${inList(ids)})
					ORDER BY position, created_at, id`
			)
		: [];
	const milestones = ids.length
		? await rowsOf(
				tx,
				sql`SELECT DISTINCT ON (board_id) id, board_id, title, to_char(due_on, 'YYYY-MM-DD') AS due_on
					FROM tasks
					WHERE board_id IN (${inList(ids)}) AND is_milestone AND completed_at IS NULL
						AND due_on >= ${todayBerlin()}::date
					ORDER BY board_id, due_on, id`
			)
		: [];
	return { rows, access, phases, milestones };
}

/** Benutzer-Anzeige (aktive Konten; Unbekannte → „Unbekannt“) */
export async function userRefs(
	ctx: RequestContext,
	ids: Iterable<string>
): Promise<Map<string, UserRef>> {
	const unique = [...new Set(ids)].filter(Boolean);
	const map = new Map<string, UserRef>();
	if (!unique.length) return map;
	for (const u of (await core.users.byIds(ctx, unique)).values()) {
		map.set(u.id, { id: u.id, name: u.name, image: u.image ?? null });
	}
	return map;
}

export const refOf = (map: Map<string, UserRef>, id: string): UserRef =>
	map.get(id) ?? { id, name: 'Unbekannt', image: null };

export interface ActionInfo {
	name: string;
	startsOn: string | null;
	endsOn: string | null;
}

/** Name und Daten verknüpfter Aktionen: aus dem Kontext (sichtbare Aktionen), sonst über `actions` */
export async function actionInfos(
	ctx: RequestContext,
	ids: string[]
): Promise<Map<string, ActionInfo>> {
	const map = new Map<string, ActionInfo>();
	if (!ids.length) return map;
	const tc = taskContextOf(ctx);
	const missing: string[] = [];
	for (const id of new Set(ids)) {
		const name = tc.actionNames.get(id);
		const dates = tc.actionDates.get(id);
		if (name)
			map.set(id, { name, startsOn: dates?.startsOn ?? null, endsOn: dates?.endsOn ?? null });
		else missing.push(id);
	}
	if (missing.length) {
		const service = await core.modules.useOptional<{
			listActionRefs(q: {
				ids: string[];
			}): Promise<{ id: string; name: string; startsOn: string; endsOn: string | null }[]>;
		}>('actions', MODULE_ID);
		for (const r of service ? await service.listActionRefs({ ids: missing }) : []) {
			map.set(r.id, { name: r.name, startsOn: r.startsOn, endsOn: r.endsOn });
		}
	}
	return map;
}

export function phaseOf(r: Row): Phase {
	return {
		id: String(r.id),
		name: String(r.name),
		color: strOrNull(r.color),
		startsOn: strOrNull(r.starts_on),
		endsOn: strOrNull(r.ends_on),
		position: num(r.position)
	};
}

const viewOf = (v: unknown): BoardView =>
	(VIEWS as readonly string[]).includes(String(v)) ? (String(v) as BoardView) : 'board';

export async function buildBoards(ctx: RequestContext, data: BoardRows): Promise<Board[]> {
	const users = await userRefs(
		ctx,
		data.rows.map((r) => String(r.owner_id))
	);
	const actions = await actionInfos(
		ctx,
		data.rows.map((r) => strOrNull(r.action_id)).filter((v): v is string => !!v)
	);
	const today = todayBerlin();
	return data.rows.map((r) => {
		const id = String(r.id);
		const actionId = strOrNull(r.action_id);
		const total = num(r.total);
		const done = num(r.done);
		const phase = currentPhase(
			data.phases.filter((p) => String(p.board_id) === id).map(phaseOf),
			today
		);
		const milestone = data.milestones.find((m) => String(m.board_id) === id);
		return {
			id,
			name: String(r.name),
			description: strOrNull(r.description),
			color: strOrNull(r.color),
			owner: refOf(users, String(r.owner_id)),
			action: actionId ? { id: actionId, name: actions.get(actionId)?.name ?? 'Aktion' } : null,
			access: data.access.get(id) ?? { level: 'read', isOwner: false, canShare: false },
			counts: { total, done, open: total - done, overdue: num(r.overdue) },
			defaultView: viewOf(r.default_view),
			calendarMilestones: bool(r.calendar_milestones),
			currentPhase: phase ? { id: phase.id, name: phase.name, color: phase.color } : null,
			nextMilestone: milestone
				? {
						id: String(milestone.id),
						title: String(milestone.title),
						dueOn: String(milestone.due_on)
					}
				: null,
			createdAt: toIso(r.created_at),
			updatedAt: toIso(r.updated_at)
		};
	});
}

// --- Board-Detail -----------------------------------------------------------

export interface DetailRows extends BoardRows {
	columns: Row[];
	tasks: Row[];
	assignees: Row[];
	checklist: Row[];
	dependencies: Row[];
	movable: Set<string>;
}

export const TASK_COLUMNS = sql`t.id, t.board_id, t.column_id, t.title, t.description, t.priority,
	to_char(t.due_on, 'YYYY-MM-DD') AS due_on, to_char(t.starts_on, 'YYYY-MM-DD') AS starts_on,
	t.is_milestone, t.phase_id, t.position, t.completed_at, t.created_by, t.created_at, t.updated_at`;

export async function loadDetailRows(
	tx: Tx,
	ctx: RequestContext,
	boardId: string
): Promise<DetailRows> {
	const base = await loadBoardRows(tx, ctx, sql`b.id = ${boardId}`);
	const access = await resolveBoardAccess(tx, ctx, boardId);
	if (!base.rows.length || !access) throw errors.notFound('Board nicht gefunden');
	base.access.set(boardId, access);
	const columns = await rowsOf(
		tx,
		sql`SELECT id, name, position, is_done FROM board_columns WHERE board_id = ${boardId}
			ORDER BY position, created_at, id`
	);
	const tasks = await rowsOf(
		tx,
		sql`SELECT ${TASK_COLUMNS} FROM tasks t WHERE t.board_id = ${boardId}
			ORDER BY t.position, t.created_at, t.id`
	);
	const ids = tasks.map((t) => String(t.id));
	const assignees = ids.length
		? await rowsOf(
				tx,
				sql`SELECT task_id, user_id FROM task_assignees WHERE task_id IN (${inList(ids)})
					ORDER BY created_at, user_id`
			)
		: [];
	const checklist = ids.length
		? await rowsOf(
				tx,
				sql`SELECT task_id, done, assignee_id FROM task_checklist WHERE task_id IN (${inList(ids)})`
			)
		: [];
	const dependencies = ids.length
		? await rowsOf(
				tx,
				sql`SELECT task_id, blocked_by_id FROM task_dependencies WHERE task_id IN (${inList(ids)})
					ORDER BY created_at, blocked_by_id`
			)
		: [];
	const movable = new Set<string>();
	if (access.level === 'edit') for (const id of ids) movable.add(id);
	else if (ctx.userId) {
		for (const a of assignees) if (a.user_id === ctx.userId) movable.add(String(a.task_id));
		for (const c of checklist) if (c.assignee_id === ctx.userId) movable.add(String(c.task_id));
	}
	return { ...base, columns, tasks, assignees, checklist, dependencies, movable };
}

interface Blockers {
	/** Aufgabe → Vorgänger */
	edges: Map<string, string[]>;
	/** erledigte Aufgaben (für offene Vorgänger) */
	done: Set<string>;
}

function cardOf(
	t: Row,
	assignees: Map<string, string[]>,
	checklist: Map<string, { done: number; total: number }>,
	users: Map<string, UserRef>,
	canMove: boolean,
	blockers: Blockers
): TaskCard {
	const id = String(t.id);
	const blockedBy = blockers.edges.get(id) ?? [];
	return {
		id,
		columnId: String(t.column_id),
		title: String(t.title),
		priority: String(t.priority) as Priority,
		dueOn: strOrNull(t.due_on),
		position: num(t.position),
		assignees: (assignees.get(id) ?? []).map((u) => refOf(users, u)),
		checklist: checklist.get(id) ?? { done: 0, total: 0 },
		hasDescription: !!strOrNull(t.description),
		completedAt: toIsoOrNull(t.completed_at),
		startsOn: strOrNull(t.starts_on),
		isMilestone: bool(t.is_milestone),
		phaseId: strOrNull(t.phase_id),
		blockedBy,
		openBlockers: blockedBy.filter((b) => !blockers.done.has(b)).length,
		canMove
	};
}

function groupAssignees(rows: Row[]): Map<string, string[]> {
	const map = new Map<string, string[]>();
	for (const a of rows) {
		const list = map.get(String(a.task_id)) ?? [];
		list.push(String(a.user_id));
		map.set(String(a.task_id), list);
	}
	return map;
}

function groupDependencies(rows: Row[]): Map<string, string[]> {
	const map = new Map<string, string[]>();
	for (const d of rows) {
		const list = map.get(String(d.task_id)) ?? [];
		list.push(String(d.blocked_by_id));
		map.set(String(d.task_id), list);
	}
	return map;
}

function countChecklist(rows: Row[]): Map<string, { done: number; total: number }> {
	const map = new Map<string, { done: number; total: number }>();
	for (const c of rows) {
		const v = map.get(String(c.task_id)) ?? { done: 0, total: 0 };
		v.total++;
		if (bool(c.done)) v.done++;
		map.set(String(c.task_id), v);
	}
	return map;
}

/** Verschiebung des Aktionsbeginns gegenüber dem Bezugsdatum (0 bzw. ohne Daten → `null`) */
export function actionShiftOf(
	anchorOn: string | null,
	actionStartsOn: string | null
): number | null {
	if (!anchorOn || !actionStartsOn) return null;
	const diff = daysBetween(anchorOn, actionStartsOn);
	return Number.isFinite(diff) && diff !== 0 ? diff : null;
}

export async function buildDetail(ctx: RequestContext, data: DetailRows): Promise<BoardDetail> {
	const [board] = await buildBoards(ctx, data);
	if (!board) throw errors.notFound('Board nicht gefunden');
	const assignees = groupAssignees(data.assignees);
	const users = await userRefs(ctx, [...assignees.values()].flat());
	const checklist = countChecklist(data.checklist);
	const blockers: Blockers = {
		edges: groupDependencies(data.dependencies),
		done: new Set(data.tasks.filter((t) => t.completed_at != null).map((t) => String(t.id)))
	};
	const columns: Column[] = data.columns.map((c) => ({
		id: String(c.id),
		name: String(c.name),
		position: num(c.position),
		isDone: bool(c.is_done)
	}));
	const row = data.rows[0]!;
	const anchorOn = strOrNull(row.anchor_on);
	const actionStartsOn = board.action
		? ((await actionInfos(ctx, [board.action.id])).get(board.action.id)?.startsOn ?? null)
		: null;
	return {
		...board,
		columns,
		phases: data.phases.map(phaseOf),
		tasks: data.tasks.map((t) =>
			cardOf(t, assignees, checklist, users, data.movable.has(String(t.id)), blockers)
		),
		anchorOn,
		actionStartsOn,
		actionShift: actionShiftOf(anchorOn, actionStartsOn)
	};
}

// --- Aufgaben-Detail --------------------------------------------------------

export interface TaskRows {
	task: Row;
	assignees: Row[];
	items: Row[];
	dependencies: Row[];
	access: BoardAccess;
	canMove: boolean;
}

export async function loadTaskRows(tx: Tx, ctx: RequestContext, taskId: string): Promise<TaskRows> {
	const { access, canMove } = await requireTask(tx, ctx, taskId, 'read');
	const [task] = await rowsOf(tx, sql`SELECT ${TASK_COLUMNS} FROM tasks t WHERE t.id = ${taskId}`);
	if (!task) throw errors.notFound('Aufgabe nicht gefunden');
	const assignees = await rowsOf(
		tx,
		sql`SELECT task_id, user_id FROM task_assignees WHERE task_id = ${taskId} ORDER BY created_at, user_id`
	);
	const items = await rowsOf(
		tx,
		sql`SELECT id, task_id, title, done, assignee_id, to_char(due_on, 'YYYY-MM-DD') AS due_on,
				position, done_at
			FROM task_checklist WHERE task_id = ${taskId} ORDER BY position, created_at, id`
	);
	const dependencies = await rowsOf(
		tx,
		sql`SELECT d.task_id, d.blocked_by_id, (b.completed_at IS NOT NULL) AS blocker_done
			FROM task_dependencies d JOIN tasks b ON b.id = d.blocked_by_id
			WHERE d.task_id = ${taskId} ORDER BY d.created_at, d.blocked_by_id`
	);
	return { task, assignees, items, dependencies, access, canMove };
}

export async function buildTask(ctx: RequestContext, data: TaskRows): Promise<TaskDetail> {
	const assignees = groupAssignees(data.assignees);
	const createdBy = strOrNull(data.task.created_by);
	const users = await userRefs(ctx, [
		...(assignees.get(String(data.task.id)) ?? []),
		...data.items.map((i) => strOrNull(i.assignee_id)).filter((v): v is string => !!v),
		...(createdBy ? [createdBy] : [])
	]);
	const blockers: Blockers = {
		edges: groupDependencies(data.dependencies),
		done: new Set(
			data.dependencies.filter((d) => bool(d.blocker_done)).map((d) => String(d.blocked_by_id))
		)
	};
	const card = cardOf(
		data.task,
		assignees,
		countChecklist(data.items),
		users,
		data.canMove,
		blockers
	);
	const items: ChecklistItem[] = data.items.map((i) => {
		const assignee = strOrNull(i.assignee_id);
		return {
			id: String(i.id),
			title: String(i.title),
			done: bool(i.done),
			assignee: assignee ? refOf(users, assignee) : null,
			dueOn: strOrNull(i.due_on),
			position: num(i.position),
			doneAt: toIsoOrNull(i.done_at)
		};
	});
	return {
		...card,
		boardId: String(data.task.board_id),
		description: strOrNull(data.task.description),
		items,
		createdBy: createdBy ? refOf(users, createdBy) : null,
		createdAt: toIso(data.task.created_at),
		updatedAt: toIso(data.task.updated_at),
		canEdit: data.access.level === 'edit'
	};
}

/** Aufgabe neu laden und aufbauen (eigene Transaktion) */
export async function taskDetail(ctx: RequestContext, taskId: string): Promise<TaskDetail> {
	const rows = await mdb().transaction((tx) => loadTaskRows(tx, ctx, taskId));
	return buildTask(ctx, rows);
}

// --- Zuständige -------------------------------------------------------------

/**
 * Zuständige müssen aktive Konten mit `tasks.board.view` sein (sonst 422 mit dem angegebenen Pfad).
 * Bereits gespeicherte IDs (`keep`) bleiben ohne Prüfung erlaubt (z. B. inzwischen ohne Recht).
 */
export async function assertAssignable(
	entries: readonly { id: string | null; path: (string | number)[] }[],
	keep: ReadonlySet<string> = new Set()
): Promise<void> {
	const check = entries.filter((e) => !!e.id && !keep.has(e.id));
	if (!check.length) return;
	const allowed = new Set(await core.permissions.usersWith(PERM.view));
	const issues = check
		.filter((e) => !allowed.has(e.id!))
		.map((e) => ({ path: e.path, message: 'Unbekannte Person oder ohne Zugriff auf Aufgaben' }));
	if (issues.length) throw errors.validation(issues);
}

/** Positionen aller Aufgaben einer Spalte neu durchnummerieren (in der Transaktion) */
export async function writeColumnOrder(tx: Tx, ids: readonly string[]): Promise<void> {
	for (let i = 0; i < ids.length; i++) {
		await tx.execute(
			sql`UPDATE tasks SET position = ${i} WHERE id = ${ids[i]!} AND position <> ${i}`
		);
	}
}

/** Advisory-Sperre je Board (Positionen, Spalten, Phasen) */
export async function lockBoard(tx: Tx, boardId: string): Promise<void> {
	await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`tasks:board:${boardId}`}))`);
}

/** Phase muss zum Board gehören (sonst 422 `phaseId`) */
export async function assertPhaseOfBoard(
	tx: Tx,
	boardId: string,
	phaseId: string | null | undefined
): Promise<void> {
	if (!phaseId) return;
	const [p] = await rowsOf(
		tx,
		sql`SELECT 1 AS ok FROM board_phases WHERE id = ${phaseId} AND board_id = ${boardId}`
	);
	if (!p) throw errors.validation([{ path: ['phaseId'], message: 'Phase nicht gefunden' }]);
}
