/** Vorlagen laden, auf ein neues Board anwenden und aus einem Board erzeugen (in der Modul-Transaktion). */
import { sql } from 'drizzle-orm';
import { errors, type RequestContext, rowsOf, toIso, type Tx } from '$lib/sdk/server';
import { canEditAll } from './access';
import { bool, PHASE_SELECT, strOrNull } from './boards.service';
import { MAX_CHECKLIST, type Priority } from './schemas';
import {
	type AppliedTemplate,
	builtinTemplate,
	templateDataSchema,
	type TemplateData,
	type TemplateSource
} from './templates';

export interface StoredTemplate {
	id: string;
	name: string;
	description: string | null;
	ownerId: string;
	data: TemplateData;
	createdAt: string;
}

/** Eigene Vorlagen des Aufrufers (mit `edit-all` alle); kaputte JSON-Daten werden übersprungen */
export async function listStoredTemplates(tx: Tx, ctx: RequestContext): Promise<StoredTemplate[]> {
	const all = canEditAll(ctx);
	if (!all && !ctx.userId) return [];
	const rows = await rowsOf(
		tx,
		sql`SELECT id, name, description, owner_id, data, created_at FROM board_templates
			${all ? sql`` : sql`WHERE owner_id = ${ctx.userId!}`}
			ORDER BY lower(name), created_at, id`
	);
	return rows.flatMap((r) => {
		const parsed = templateDataSchema.safeParse(
			typeof r.data === 'string' ? JSON.parse(r.data) : r.data
		);
		if (!parsed.success) return [];
		return [
			{
				id: String(r.id),
				name: String(r.name),
				description: strOrNull(r.description),
				ownerId: String(r.owner_id),
				data: parsed.data,
				createdAt: toIso(r.created_at)
			}
		];
	});
}

/** Vorlage für `templateId` (mitgeliefert oder eigene); unbekannt/fremd → 422 `templateId` */
export async function loadTemplateData(
	tx: Tx,
	ctx: RequestContext,
	templateId: string
): Promise<TemplateData> {
	const builtin = builtinTemplate(templateId);
	if (builtin) return builtin.data;
	const found = (await listStoredTemplates(tx, ctx)).find((t) => t.id === templateId);
	if (!found) {
		throw errors.validation([{ path: ['templateId'], message: 'Vorlage nicht gefunden' }]);
	}
	return found.data;
}

/** Spalten, Phasen und Aufgaben einer angewendeten Vorlage in ein neues (leeres) Board schreiben */
export async function insertApplied(
	tx: Tx,
	boardId: string,
	applied: AppliedTemplate,
	userId: string | null
): Promise<{ tasks: number }> {
	const columnIds: string[] = [];
	for (const [i, c] of applied.columns.entries()) {
		const id = crypto.randomUUID();
		columnIds.push(id);
		await tx.execute(
			sql`INSERT INTO board_columns (id, board_id, name, position, is_done)
				VALUES (${id}, ${boardId}, ${c.name}, ${i}, ${c.isDone})`
		);
	}
	// Erledigt-Spalte höchstens einmal (Vorlagen von Hand bearbeitet)
	const doneIndex = applied.columns.findIndex((c) => c.isDone);
	await tx.execute(
		sql`UPDATE board_columns SET is_done = (position = ${doneIndex}) WHERE board_id = ${boardId}`
	);
	const phaseIds: string[] = [];
	for (const [i, p] of applied.phases.entries()) {
		const id = crypto.randomUUID();
		phaseIds.push(id);
		await tx.execute(
			sql`INSERT INTO board_phases (id, board_id, name, color, starts_on, ends_on, position)
				VALUES (${id}, ${boardId}, ${p.name}, ${p.color}, ${p.startsOn}, ${p.endsOn}, ${i})`
		);
	}
	const firstOpen = applied.columns.findIndex((c) => !c.isDone);
	const column = columnIds[firstOpen >= 0 ? firstOpen : 0]!;
	for (const [i, t] of applied.tasks.entries()) {
		const id = crypto.randomUUID();
		await tx.execute(
			sql`INSERT INTO tasks (id, board_id, column_id, title, description, priority, due_on, starts_on,
					is_milestone, phase_id, position, created_by)
				VALUES (${id}, ${boardId}, ${column}, ${t.title}, ${t.description}, ${t.priority}, ${t.dueOn},
					${t.isMilestone ? null : t.startsOn}, ${t.isMilestone},
					${t.phase !== null ? (phaseIds[t.phase] ?? null) : null}, ${i}, ${userId})`
		);
		for (const [j, title] of t.checklist.slice(0, MAX_CHECKLIST).entries()) {
			await tx.execute(
				sql`INSERT INTO task_checklist (id, task_id, title, position)
					VALUES (${crypto.randomUUID()}, ${id}, ${title}, ${j})`
			);
		}
	}
	return { tasks: applied.tasks.length };
}

/** Board als Quelle für eine Vorlage lesen (ohne Zuständige, Erledigt-Stand und Abhängigkeiten) */
export async function boardTemplateSource(tx: Tx, boardId: string): Promise<TemplateSource> {
	const columns = await rowsOf(
		tx,
		sql`SELECT name, is_done FROM board_columns WHERE board_id = ${boardId}
			ORDER BY position, created_at, id`
	);
	const phases = await rowsOf(
		tx,
		sql`SELECT ${PHASE_SELECT} FROM board_phases WHERE board_id = ${boardId}
			ORDER BY position, created_at, id`
	);
	const tasks = await rowsOf(
		tx,
		sql`SELECT t.id, t.title, t.description, t.priority, t.phase_id, t.is_milestone,
				to_char(t.starts_on, 'YYYY-MM-DD') AS starts_on, to_char(t.due_on, 'YYYY-MM-DD') AS due_on
			FROM tasks t JOIN board_columns c ON c.id = t.column_id
			WHERE t.board_id = ${boardId} ORDER BY c.position, t.position, t.created_at, t.id`
	);
	const items = await rowsOf(
		tx,
		sql`SELECT x.task_id, x.title FROM task_checklist x JOIN tasks t ON t.id = x.task_id
			WHERE t.board_id = ${boardId} ORDER BY x.position, x.created_at, x.id`
	);
	const byTask = new Map<string, string[]>();
	for (const i of items) {
		const list = byTask.get(String(i.task_id)) ?? [];
		list.push(String(i.title));
		byTask.set(String(i.task_id), list);
	}
	return {
		columns: columns.map((c) => ({ name: String(c.name), isDone: bool(c.is_done) })),
		phases: phases.map((p) => ({
			id: String(p.id),
			name: String(p.name),
			color: strOrNull(p.color),
			startsOn: strOrNull(p.starts_on),
			endsOn: strOrNull(p.ends_on)
		})),
		tasks: tasks.map((t) => ({
			title: String(t.title),
			description: strOrNull(t.description),
			priority: String(t.priority) as Priority,
			phaseId: strOrNull(t.phase_id),
			startsOn: strOrNull(t.starts_on),
			dueOn: strOrNull(t.due_on),
			isMilestone: bool(t.is_milestone),
			checklist: byTask.get(String(t.id)) ?? []
		}))
	};
}
