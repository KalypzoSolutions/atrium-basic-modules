/**
 * Löschen, Reset und Datenauskunft. Private Notizen einer gelöschten Person (oberste Seiten ohne Freigaben im
 * Teilbaum und ohne Aktion) werden endgültig gelöscht; geteilte bzw. an Aktionen hängende bleiben als
 * Stammesdaten erhalten (Eigentum an `transferTo`, sonst ohne Eigentümer*in – verwaltbar mit `edit-all`).
 * Inhalte gehören zur Notiz, nicht zur Person, und stehen nicht in der Datenauskunft (nur Metadaten).
 */
import { sql } from 'drizzle-orm';
import {
	type ModuleDefinition,
	type ModuleSubjectExport,
	num,
	type ResetArea,
	rowsOf,
	toIso
} from '$lib/sdk/server';
import { MAX_WALK } from './access';
import { mdb } from './db';
import { afterPurge } from './trash.service';
import { purgeSubtrees } from './tree.service';

const USER_COLUMNS = [
	['notes', 'created_by'],
	['notes', 'updated_by'],
	['notes', 'deleted_by'],
	['note_shares', 'created_by'],
	['note_updates', 'created_by'],
	['note_versions', 'created_by'],
	['note_assets', 'created_by'],
	['note_links', 'created_by']
] as const;

export const onUserDeleted: ModuleDefinition['onUserDeleted'] = async (
	tx,
	{ userId, transferTo }
) => {
	await tx.execute(
		sql`DELETE FROM note_shares WHERE principal_type = 'user' AND principal_id = ${userId}`
	);
	await tx.execute(sql`DELETE FROM user_prefs WHERE user_id = ${userId}`);
	// öffentliche Links der Person widerrufen (Links auf Notizen ohne aktive Eigentümer*in sind ohnehin gesperrt)
	await tx.execute(
		sql`UPDATE note_links SET revoked_at = now() WHERE created_by = ${userId} AND revoked_at IS NULL`
	);
	// private Wurzeln: weder Aktion noch irgendeine Freigabe im Teilbaum
	const privateRoots = await rowsOf(
		tx,
		sql`SELECT r.id FROM notes r
			WHERE r.parent_id IS NULL AND r.owner_id = ${userId} AND r.action_id IS NULL
				AND NOT EXISTS (
					WITH RECURSIVE down AS (
						SELECT d.id, 0 AS depth FROM notes d WHERE d.id = r.id
						UNION ALL
						SELECT c.id, down.depth + 1 FROM notes c JOIN down ON c.parent_id = down.id
						WHERE down.depth < ${MAX_WALK}
					)
					SELECT 1 FROM down JOIN note_shares s ON s.note_id = down.id
				)`
	);
	const purged = await purgeSubtrees(
		tx,
		privateRoots.map((r) => String(r.id))
	);
	await tx.execute(
		sql`UPDATE notes SET owner_id = ${transferTo ?? null} WHERE owner_id = ${userId}`
	);
	for (const [table, column] of USER_COLUMNS) {
		await tx.execute(
			sql`UPDATE ${sql.identifier(table)} SET ${sql.identifier(column)} = NULL
				WHERE ${sql.identifier(column)} = ${userId}`
		);
	}
	return { afterCommit: () => afterPurge(purged) };
};

/** Mitglied gelöscht/anonymisiert: Freigaben an das Mitglied entfernen */
export const onMemberDeleted: ModuleDefinition['onMemberDeleted'] = async (tx, { memberIds }) => {
	for (const id of memberIds) {
		await tx.execute(
			sql`DELETE FROM note_shares WHERE principal_type = 'member' AND principal_id = ${id}`
		);
	}
};

export const resetAreas: ResetArea[] = [
	{
		id: 'all',
		label: 'Alle Notizen',
		description:
			'Löscht alle Notizen mit Unterseiten, Versionen, Bildern und Freigaben – auch die an Aktionen gehängten und den Papierkorb.',
		tables: [
			'note_links',
			'note_versions',
			'note_assets',
			'note_updates',
			'note_shares',
			'notes',
			'user_prefs'
		],
		rebuild: true
	}
];

export const resetUsers: ModuleDefinition['resetUsers'] = async (tx, keepUserId) => {
	await tx.execute(
		sql`DELETE FROM note_shares WHERE principal_type = 'user' AND principal_id <> ${keepUserId}`
	);
	await tx.execute(sql`DELETE FROM user_prefs WHERE user_id <> ${keepUserId}`);
	// Links fremder Personen widerrufen (wie `files`): Inhalte wechseln die Eigentümer*in
	await tx.execute(
		sql`UPDATE note_links SET revoked_at = now()
			WHERE revoked_at IS NULL AND created_by IS DISTINCT FROM ${keepUserId}`
	);
	await tx.execute(
		sql`UPDATE notes SET owner_id = ${keepUserId} WHERE owner_id IS DISTINCT FROM ${keepUserId}`
	);
	for (const [table, column] of USER_COLUMNS) {
		await tx.execute(
			sql`UPDATE ${sql.identifier(table)} SET ${sql.identifier(column)} = ${keepUserId}
				WHERE ${sql.identifier(column)} IS NOT NULL AND ${sql.identifier(column)} <> ${keepUserId}`
		);
	}
};

/** Datenauskunft: eigene Notizen (Metadaten) und Freigaben an das Konto */
export const subjectExport: ModuleSubjectExport = {
	run: async ({ userId }) => {
		if (!userId) return null;
		const data = await mdb().transaction(async (tx) => ({
			notes: await rowsOf(
				tx,
				sql`SELECT id, parent_id, title, created_at, updated_at, size_bytes, deleted_at FROM notes
					WHERE owner_id = ${userId} ORDER BY created_at, id`
			),
			shares: await rowsOf(
				tx,
				sql`SELECT s.note_id, n.title, s.level FROM note_shares s JOIN notes n ON n.id = s.note_id
					WHERE s.principal_type = 'user' AND s.principal_id = ${userId} ORDER BY n.title, s.note_id`
			),
			uploads: await rowsOf(
				tx,
				sql`SELECT a.id, a.note_id, a.size_bytes, a.created_at FROM note_assets a
					WHERE a.created_by = ${userId} ORDER BY a.created_at, a.id`
			),
			prefs: await rowsOf(tx, sql`SELECT prefs FROM user_prefs WHERE user_id = ${userId}`)
		}));
		if (!data.notes.length && !data.shares.length && !data.uploads.length && !data.prefs.length)
			return null;
		return {
			ownedNotes: data.notes.map((r) => ({
				id: String(r.id),
				parentId: r.parent_id == null ? null : String(r.parent_id),
				title: String(r.title ?? ''),
				createdAt: toIso(r.created_at),
				updatedAt: toIso(r.updated_at),
				sizeBytes: num(r.size_bytes),
				inTrash: r.deleted_at != null
			})),
			shares: data.shares.map((r) => ({
				noteId: String(r.note_id),
				title: String(r.title ?? ''),
				level: String(r.level)
			})),
			uploads: data.uploads.map((r) => ({
				id: String(r.id),
				noteId: String(r.note_id),
				sizeBytes: num(r.size_bytes),
				createdAt: toIso(r.created_at)
			})),
			viewPrefs: data.prefs[0]?.prefs ?? null
		};
	}
};
