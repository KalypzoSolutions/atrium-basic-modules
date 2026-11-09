/**
 * Übersicht (`/dashboard`): „Zu erledigen“ = eigene offene Aufgaben (direkt zugewiesen oder über eine
 * offene Unteraufgabe, wie `GET /my/tasks` bzw. die Kachel „Meine Aufgaben“), die überfällig oder in den
 * nächsten 7 Tagen fällig sind; „Diese Woche“ = dieselben Aufgaben mit Fälligkeit im Zeitraum als Frist.
 * Zuweisung gibt Lesezugriff auf das Board, daher keine weitere Freigabeprüfung nötig.
 */
import { sql } from 'drizzle-orm';
import { addDays } from '$lib/sdk/dates';
import {
	type ModuleDashboardSources,
	num,
	type RequestContext,
	type Row,
	rowsOf
} from '$lib/sdk/server';
import type { DashboardAgendaItem, DashboardTodo } from '$lib/sdk/types/dashboard';
import { mdb } from './boards.service';
import { boardLink } from './notify';
import { PERM } from './schemas';

/** So viele Tage im Voraus erscheinen fällige Aufgaben in „Zu erledigen“ */
export const TASKS_DUE_SOON_DAYS = 7;

/** Offene Aufgaben der Person mit Fälligkeit im Zeitraum (`from` = `null` → auch alle überfälligen) */
async function myOpenTasksDue(
	ctx: RequestContext,
	from: string | null,
	to: string,
	limit: number
): Promise<Row[]> {
	const userId = ctx.userId;
	if (!userId) return [];
	return mdb().transaction((tx) =>
		rowsOf(
			tx,
			sql`SELECT t.id, t.title, to_char(t.due_on, 'YYYY-MM-DD') AS due_on,
					b.id AS board_id, b.name AS board_name,
					(SELECT count(*)::int FROM task_checklist x WHERE x.task_id = t.id) AS items,
					(SELECT count(*)::int FROM task_checklist x WHERE x.task_id = t.id AND x.done) AS items_done
				FROM tasks t JOIN boards b ON b.id = t.board_id
				WHERE t.completed_at IS NULL AND t.due_on IS NOT NULL
					AND t.due_on <= ${to}::date
					${from ? sql`AND t.due_on >= ${from}::date` : sql``}
					AND (EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = t.id AND a.user_id = ${userId})
						OR EXISTS (SELECT 1 FROM task_checklist x WHERE x.task_id = t.id
							AND x.assignee_id = ${userId} AND NOT x.done))
				ORDER BY t.due_on,
					CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
					t.created_at, t.id
				LIMIT ${limit}`
		)
	);
}

function detailOf(r: Row): string {
	const parts = ['Aufgabe', String(r.board_name)];
	const total = num(r.items);
	if (total > 0) parts.push(`Unteraufgaben ${num(r.items_done)} von ${total}`);
	return parts.join(' · ');
}

export const tasksDashboard: ModuleDashboardSources = {
	todos: {
		permission: PERM.view,
		async run(ctx, { today, limit }): Promise<DashboardTodo[]> {
			const rows = await myOpenTasksDue(ctx, null, addDays(today, TASKS_DUE_SOON_DAYS), limit);
			return rows.map((r) => {
				const due = String(r.due_on);
				return {
					id: `task:${String(r.id)}`,
					title: String(r.title),
					detail: detailOf(r),
					due,
					severity: due < today ? 'overdue' : 'due',
					action: { label: 'Öffnen', href: boardLink(String(r.board_id), String(r.id)) }
				};
			});
		}
	},
	agenda: {
		permission: PERM.view,
		async run(ctx, { today, from, to }): Promise<DashboardAgendaItem[]> {
			const rows = await myOpenTasksDue(ctx, from, to, 200);
			return rows.map((r) => {
				const due = String(r.due_on);
				return {
					id: `task:${String(r.id)}`,
					kind: 'deadline',
					title: String(r.title),
					date: due,
					detail: detailOf(r),
					href: boardLink(String(r.board_id), String(r.id)),
					late: due < today
				};
			});
		}
	}
};
