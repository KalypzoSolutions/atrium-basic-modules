/**
 * Löschen, Reset und Datenauskunft. Boards und Aufgaben sind Stammesdaten und bleiben erhalten; Bezüge
 * auf gelöschte Konten werden entfernt bzw. auf `NULL` gesetzt, Eigentum wandert an `transferTo`.
 */
import { sql } from 'drizzle-orm';
import {
	type ModuleDefinition,
	type ModuleSubjectExport,
	type ResetArea,
	rowsOf,
	toIso,
	toIsoOrNull
} from '$lib/sdk/server';
import { mdb } from './boards.service';

export const onUserDeleted: ModuleDefinition['onUserDeleted'] = async (
	tx,
	{ userId, transferTo }
) => {
	await tx.execute(
		sql`DELETE FROM board_shares WHERE principal_type = 'user' AND principal_id = ${userId}`
	);
	if (transferTo) {
		await tx.execute(sql`UPDATE boards SET owner_id = ${transferTo} WHERE owner_id = ${userId}`);
	}
	await tx.execute(sql`DELETE FROM task_assignees WHERE user_id = ${userId}`);
	await tx.execute(sql`UPDATE task_checklist SET assignee_id = NULL WHERE assignee_id = ${userId}`);
	await tx.execute(sql`UPDATE task_checklist SET done_by = NULL WHERE done_by = ${userId}`);
	await tx.execute(sql`UPDATE tasks SET created_by = NULL WHERE created_by = ${userId}`);
	await tx.execute(sql`UPDATE boards SET created_by = NULL WHERE created_by = ${userId}`);
	await tx.execute(sql`UPDATE board_shares SET created_by = NULL WHERE created_by = ${userId}`);
	// eigene Vorlagen gehen an `transferTo`, sonst werden sie gelöscht
	if (transferTo) {
		await tx.execute(
			sql`UPDATE board_templates SET owner_id = ${transferTo} WHERE owner_id = ${userId}`
		);
	} else {
		await tx.execute(sql`DELETE FROM board_templates WHERE owner_id = ${userId}`);
	}
};

export const resetAreas: ResetArea[] = [
	{
		id: 'all',
		label: 'Alle Aufgaben-Boards',
		description:
			'Löscht alle Boards mit Spalten, Aufgaben, Unteraufgaben, Zuständigen und Freigaben – auch die an Aktionen gehängten.',
		// Kind vor Eltern (tasks.column_id ist RESTRICT → Aufgaben vor Spalten)
		tables: [
			'task_dependencies',
			'task_checklist',
			'task_assignees',
			'tasks',
			'board_phases',
			'board_columns',
			'board_shares',
			'boards'
		],
		rebuild: true
	},
	{
		id: 'templates',
		label: 'Eigene Aufgaben-Vorlagen',
		description: 'Löscht alle gespeicherten Board-Vorlagen (die mitgelieferten bleiben).',
		tables: ['board_templates']
	}
];

export const resetUsers: ModuleDefinition['resetUsers'] = async (tx, keepUserId) => {
	await tx.execute(
		sql`DELETE FROM board_shares WHERE principal_type = 'user' AND principal_id <> ${keepUserId}`
	);
	await tx.execute(sql`UPDATE boards SET owner_id = ${keepUserId} WHERE owner_id <> ${keepUserId}`);
	await tx.execute(sql`DELETE FROM task_assignees WHERE user_id <> ${keepUserId}`);
	await tx.execute(
		sql`UPDATE board_templates SET owner_id = ${keepUserId} WHERE owner_id <> ${keepUserId}`
	);
	await tx.execute(
		sql`UPDATE task_checklist SET assignee_id = NULL WHERE assignee_id IS NOT NULL AND assignee_id <> ${keepUserId}`
	);
	await tx.execute(
		sql`UPDATE task_checklist SET done_by = NULL WHERE done_by IS NOT NULL AND done_by <> ${keepUserId}`
	);
	for (const table of ['tasks', 'boards', 'board_shares'] as const) {
		await tx.execute(
			sql`UPDATE ${sql.identifier(table)} SET created_by = ${keepUserId}
				WHERE created_by IS NOT NULL AND created_by <> ${keepUserId}`
		);
	}
};

/** Datenauskunft: eigene Boards, zugewiesene Aufgaben/Unteraufgaben, Freigaben an das Konto */
export const subjectExport: ModuleSubjectExport = {
	run: async ({ userId }) => {
		if (!userId) return null;
		const data = await mdb().transaction(async (tx) => ({
			boards: await rowsOf(
				tx,
				sql`SELECT id, name, created_at FROM boards WHERE owner_id = ${userId} ORDER BY created_at, id`
			),
			tasks: await rowsOf(
				tx,
				sql`SELECT t.id, t.title, b.name AS board, to_char(t.due_on, 'YYYY-MM-DD') AS due_on,
						t.completed_at
					FROM task_assignees a JOIN tasks t ON t.id = a.task_id JOIN boards b ON b.id = t.board_id
					WHERE a.user_id = ${userId} ORDER BY t.created_at, t.id`
			),
			items: await rowsOf(
				tx,
				sql`SELECT c.id, c.title, t.title AS task, c.done
					FROM task_checklist c JOIN tasks t ON t.id = c.task_id
					WHERE c.assignee_id = ${userId} ORDER BY c.created_at, c.id`
			),
			templates: await rowsOf(
				tx,
				sql`SELECT id, name, created_at FROM board_templates WHERE owner_id = ${userId} ORDER BY created_at, id`
			),
			shares: await rowsOf(
				tx,
				sql`SELECT s.board_id, b.name, s.level FROM board_shares s JOIN boards b ON b.id = s.board_id
					WHERE s.principal_type = 'user' AND s.principal_id = ${userId}`
			)
		}));
		if (
			!data.boards.length &&
			!data.tasks.length &&
			!data.items.length &&
			!data.shares.length &&
			!data.templates.length
		) {
			return null;
		}
		return {
			ownedBoards: data.boards.map((r) => ({
				id: String(r.id),
				name: String(r.name),
				createdAt: toIso(r.created_at)
			})),
			assignedTasks: data.tasks.map((r) => ({
				id: String(r.id),
				title: String(r.title),
				board: String(r.board),
				dueOn: r.due_on == null ? null : String(r.due_on),
				completedAt: toIsoOrNull(r.completed_at)
			})),
			assignedSubtasks: data.items.map((r) => ({
				id: String(r.id),
				title: String(r.title),
				task: String(r.task),
				done: r.done === true || r.done === 't'
			})),
			templates: data.templates.map((r) => ({
				id: String(r.id),
				name: String(r.name),
				createdAt: toIso(r.created_at)
			})),
			shares: data.shares.map((r) => ({
				boardId: String(r.board_id),
				name: String(r.name),
				level: String(r.level)
			}))
		};
	}
};
