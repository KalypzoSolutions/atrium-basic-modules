/**
 * Löschen, Reset und Datenauskunft. Whiteboards sind Stammesdaten und bleiben erhalten; Bezüge auf gelöschte
 * Konten werden entfernt bzw. auf `NULL` gesetzt, Eigentum wandert an `transferTo`. Inhalte der Elemente
 * (Texte) gehören zum Board, nicht zur Person, und stehen nicht in der Datenauskunft.
 */
import { sql } from 'drizzle-orm';
import {
	type ModuleDefinition,
	type ModuleSubjectExport,
	type ResetArea,
	rowsOf,
	toIso
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
	await tx.execute(sql`DELETE FROM user_prefs WHERE user_id = ${userId}`);
	for (const [table, column] of [
		['boards', 'created_by'],
		['boards', 'updated_by'],
		['board_shares', 'created_by'],
		['elements', 'updated_by'],
		['assets', 'created_by'],
		['snapshots', 'created_by']
	] as const) {
		await tx.execute(
			sql`UPDATE ${sql.identifier(table)} SET ${sql.identifier(column)} = NULL
				WHERE ${sql.identifier(column)} = ${userId}`
		);
	}
};

/** Mitglied gelöscht/anonymisiert: Freigaben an das Mitglied entfernen */
export const onMemberDeleted: ModuleDefinition['onMemberDeleted'] = async (tx, { memberIds }) => {
	for (const id of memberIds) {
		await tx.execute(
			sql`DELETE FROM board_shares WHERE principal_type = 'member' AND principal_id = ${id}`
		);
	}
};

export const resetAreas: ResetArea[] = [
	{
		id: 'all',
		label: 'Alle Whiteboards',
		description:
			'Löscht alle Whiteboards mit Elementen, Bildern/Dateien, Versionen und Freigaben – auch die an Aktionen gehängten.',
		tables: ['snapshots', 'assets', 'elements', 'board_shares', 'boards', 'user_prefs'],
		rebuild: true
	}
];

export const resetUsers: ModuleDefinition['resetUsers'] = async (tx, keepUserId) => {
	await tx.execute(
		sql`DELETE FROM board_shares WHERE principal_type = 'user' AND principal_id <> ${keepUserId}`
	);
	await tx.execute(sql`UPDATE boards SET owner_id = ${keepUserId} WHERE owner_id <> ${keepUserId}`);
	await tx.execute(sql`DELETE FROM user_prefs WHERE user_id <> ${keepUserId}`);
	for (const [table, column] of [
		['boards', 'created_by'],
		['boards', 'updated_by'],
		['board_shares', 'created_by'],
		['elements', 'updated_by'],
		['assets', 'created_by'],
		['snapshots', 'created_by']
	] as const) {
		await tx.execute(
			sql`UPDATE ${sql.identifier(table)} SET ${sql.identifier(column)} = ${keepUserId}
				WHERE ${sql.identifier(column)} IS NOT NULL AND ${sql.identifier(column)} <> ${keepUserId}`
		);
	}
};

/** Datenauskunft: eigene Whiteboards und Freigaben an das Konto */
export const subjectExport: ModuleSubjectExport = {
	run: async ({ userId }) => {
		if (!userId) return null;
		const data = await mdb().transaction(async (tx) => ({
			boards: await rowsOf(
				tx,
				sql`SELECT id, name, created_at FROM boards WHERE owner_id = ${userId} ORDER BY created_at, id`
			),
			shares: await rowsOf(
				tx,
				sql`SELECT s.board_id, b.name, s.level FROM board_shares s JOIN boards b ON b.id = s.board_id
					WHERE s.principal_type = 'user' AND s.principal_id = ${userId}`
			),
			prefs: await rowsOf(tx, sql`SELECT prefs FROM user_prefs WHERE user_id = ${userId}`),
			uploads: await rowsOf(
				tx,
				sql`SELECT a.id, a.name, a.created_at, b.name AS board FROM assets a JOIN boards b ON b.id = a.board_id
					WHERE a.created_by = ${userId} ORDER BY a.created_at, a.id`
			)
		}));
		if (!data.boards.length && !data.shares.length && !data.uploads.length && !data.prefs.length) {
			return null;
		}
		return {
			ownedBoards: data.boards.map((r) => ({
				id: String(r.id),
				name: String(r.name),
				createdAt: toIso(r.created_at)
			})),
			shares: data.shares.map((r) => ({
				boardId: String(r.board_id),
				name: String(r.name),
				level: String(r.level)
			})),
			viewSettings: data.prefs[0]?.prefs ?? null,
			uploads: data.uploads.map((r) => ({
				id: String(r.id),
				name: String(r.name),
				board: String(r.board),
				createdAt: toIso(r.created_at)
			}))
		};
	}
};
