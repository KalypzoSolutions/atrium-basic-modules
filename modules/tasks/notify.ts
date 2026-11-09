/**
 * Benachrichtigungen der Aufgaben über `core.notifications` (Kanal wählt jede Person im Profil):
 * neu zugewiesene Aufgaben/Unteraufgaben, fällige Aufgaben (Job), neu geteilte Boards.
 * Immer nach der Transaktion, nie an die handelnde Person, wirft nie.
 */
import { sql } from 'drizzle-orm';
import {
	bestEffort,
	core,
	moduleDb,
	principalUserIds,
	rowsOf,
	type RequestContext,
	type StoredShare
} from '$lib/sdk/server';
import { addDays, formatDateDe, todayBerlin } from '$lib/sdk/dates';
import {
	MODULE_ID,
	NOTIFY_BOARD_SHARED,
	NOTIFY_TASK_ASSIGNED,
	NOTIFY_TASK_DUE,
	PERM
} from './schemas';

export const boardLink = (boardId: string, taskId?: string) =>
	`/modules/tasks/${encodeURIComponent(boardId)}${taskId ? `?task=${encodeURIComponent(taskId)}` : ''}`;

async function actorName(ctx: RequestContext): Promise<string> {
	if (!ctx.userId) return 'Jemand';
	return (await core.users.byIds(ctx, [ctx.userId])).get(ctx.userId)?.name ?? 'Jemand';
}

/** Neu zugewiesen: `userIds` = hinzugekommene Personen (Aufgabe oder Unteraufgabe) */
export async function notifyAssigned(
	ctx: RequestContext,
	input: {
		boardId: string;
		boardName: string;
		taskId: string;
		taskTitle: string;
		userIds: string[];
		/** Titel der Unteraufgabe, wenn nur diese zugewiesen wurde */
		itemTitle?: string;
		dueOn?: string | null;
	}
): Promise<void> {
	const userIds = [...new Set(input.userIds)].filter((id) => id !== ctx.userId);
	if (!userIds.length) return;
	await bestEffort(
		'tasks.notify.assigned',
		async () => {
			const who = await actorName(ctx);
			const due = input.dueOn ? ` Fällig am ${formatDateDe(input.dueOn)}.` : '';
			await core.notifications.send(ctx, MODULE_ID, [
				{
					type: NOTIFY_TASK_ASSIGNED,
					userIds,
					title: input.itemTitle
						? `Unteraufgabe für dich: ${input.itemTitle}`
						: `Neue Aufgabe für dich: ${input.taskTitle}`,
					body: input.itemTitle
						? `${who} hat dir in „${input.taskTitle}“ (Board „${input.boardName}“) die Unteraufgabe „${input.itemTitle}“ zugewiesen.${due}`
						: `${who} hat dir im Board „${input.boardName}“ die Aufgabe „${input.taskTitle}“ zugewiesen.${due}`,
					link: boardLink(input.boardId, input.taskId),
					group: input.boardName
				}
			]);
		},
		{ ctx, target: input.taskId }
	);
}

/** Board neu geteilt oder hochgestuft: an die Konten hinter den Freigaben (ohne „ganzer Stamm“) */
export async function notifyBoardShared(
	ctx: RequestContext,
	input: { boardId: string; boardName: string; ownerId: string; principals: StoredShare[] }
): Promise<void> {
	await bestEffort(
		'tasks.notify.shared',
		async () => {
			const userIds = await principalUserIds(MODULE_ID, input.principals, {
				permission: PERM.view,
				exclude: [ctx.userId, input.ownerId]
			});
			if (!userIds.length) return;
			const who = await actorName(ctx);
			await core.notifications.send(ctx, MODULE_ID, [
				{
					type: NOTIFY_BOARD_SHARED,
					userIds,
					title: `${who} hat das Board „${input.boardName}“ mit dir geteilt`,
					body: `Du kannst das Aufgaben-Board „${input.boardName}“ jetzt öffnen.`,
					link: boardLink(input.boardId)
				}
			]);
		},
		{ ctx, target: input.boardId }
	);
}

/**
 * Job `due-reminders` (täglich): offene Aufgaben, die heute oder morgen fällig sind, einmal je Tag an die
 * Zuständigen (Aufgabe + Unteraufgaben). `reminded_on` verhindert doppelte Nachrichten.
 */
export async function sendDueReminders(
	ctx: RequestContext
): Promise<{ tasks: number; people: number }> {
	const today = todayBerlin();
	const tomorrow = addDays(today, 1);
	type DueRow = {
		id: string;
		title: string;
		boardId: string;
		boardName: string;
		dueOn: string;
		userIds: string[];
	};
	const rows = await moduleDb(MODULE_ID).transaction(async (tx): Promise<DueRow[]> => {
		const due = await rowsOf(
			tx,
			sql`SELECT t.id, t.title, t.board_id, b.name AS board_name, to_char(t.due_on, 'YYYY-MM-DD') AS due_on
				FROM tasks t JOIN boards b ON b.id = t.board_id
				WHERE t.completed_at IS NULL AND t.due_on IN (${today}::date, ${tomorrow}::date)
					AND (t.reminded_on IS NULL OR t.reminded_on < ${today}::date)
				ORDER BY t.due_on, t.title
				LIMIT 500`
		);
		if (!due.length) return [];
		const ids = due.map((r) => String(r.id));
		const people = await rowsOf(
			tx,
			sql`SELECT task_id, user_id FROM task_assignees WHERE task_id IN (${sql.join(
				ids.map((i) => sql`${i}`),
				sql`, `
			)})
				UNION SELECT task_id, assignee_id AS user_id FROM task_checklist
				WHERE done = false AND assignee_id IS NOT NULL AND task_id IN (${sql.join(
					ids.map((i) => sql`${i}`),
					sql`, `
				)})`
		);
		await tx.execute(
			sql`UPDATE tasks SET reminded_on = ${today}::date WHERE id IN (${sql.join(
				ids.map((i) => sql`${i}`),
				sql`, `
			)})`
		);
		return due.map((r) => ({
			id: String(r.id),
			title: String(r.title),
			boardId: String(r.board_id),
			boardName: String(r.board_name),
			dueOn: String(r.due_on),
			userIds: people.filter((p) => p.task_id === r.id).map((p) => String(p.user_id))
		}));
	});
	const allowed = new Set(await core.permissions.usersWith(PERM.view));
	const items = rows
		.map((r) => ({ ...r, userIds: r.userIds.filter((u) => allowed.has(u)) }))
		.filter((r) => r.userIds.length)
		.map((r) => ({
			type: NOTIFY_TASK_DUE,
			userIds: r.userIds,
			title: r.dueOn === today ? `Heute fällig: ${r.title}` : `Morgen fällig: ${r.title}`,
			body: `Die Aufgabe „${r.title}“ im Board „${r.boardName}“ ist am ${formatDateDe(r.dueOn)} fällig.`,
			link: boardLink(r.boardId, r.id),
			group: r.boardName
		}));
	if (items.length) await core.notifications.send(ctx, MODULE_ID, items);
	return { tasks: items.length, people: new Set(items.flatMap((i) => i.userIds)).size };
}
