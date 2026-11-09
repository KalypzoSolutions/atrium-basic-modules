/**
 * Hook `onUserDeleted` (Core `deleteUser`): Die Ablage einer gelöschten Person wird **gelöscht**, nicht
 * übergeben (Recht auf Löschung) – anders als beim Admin-Reset (`reset.ts`, dort Übernahme).
 *
 * In der Modul-Transaktion:
 *   - alle Knoten mit `owner_id` = Person samt Teilbäumen löschen (CASCADE entfernt Kinder, Freigaben und
 *     öffentliche Links dieser Knoten – auch Ansicht- und Upload-Links);
 *   - übrige Links, die die Person angelegt hat, widerrufen;
 *   - Freigaben an die Person (`user:<id>`) löschen;
 *   - Verweise in fremden Ablagen (`created_by`, `deleted_by`) auf `NULL` setzen;
 *   - eigenes Speicherkontingent löschen, `user_quotas.updated_by` auf `NULL`.
 * Nach dem Commit: Storage-Objekte (Inhalt + Vorschaubild) aller gelöschten Dateien entfernen.
 */
import { sql } from 'drizzle-orm';
import { type ModuleDefinition, rowsOf } from '$lib/sdk/server';
import { removeObjects } from './storage';

export const onUserDeleted: ModuleDefinition['onUserDeleted'] = async (tx, { userId }) => {
	const objects = await rowsOf(
		tx,
		sql`WITH RECURSIVE tree AS (
				SELECT id, storage_path, thumb_path FROM nodes WHERE owner_id = ${userId}
				UNION
				SELECT n.id, n.storage_path, n.thumb_path FROM nodes n JOIN tree t ON n.parent_id = t.id
			)
			SELECT storage_path, thumb_path FROM tree`
	);
	const paths = objects
		.flatMap((r) => [r.storage_path, r.thumb_path])
		.map((p) => (p ? String(p) : null));

	await tx.execute(sql`DELETE FROM nodes WHERE owner_id = ${userId}`);
	await tx.execute(
		sql`UPDATE share_links SET revoked_at = now(), created_by = NULL
			WHERE created_by = ${userId} AND revoked_at IS NULL`
	);
	await tx.execute(sql`UPDATE share_links SET created_by = NULL WHERE created_by = ${userId}`);
	await tx.execute(
		sql`DELETE FROM node_shares WHERE principal_type = 'user' AND principal_id = ${userId}`
	);
	await tx.execute(sql`UPDATE node_shares SET created_by = NULL WHERE created_by = ${userId}`);
	await tx.execute(sql`UPDATE nodes SET created_by = NULL WHERE created_by = ${userId}`);
	await tx.execute(sql`UPDATE nodes SET deleted_by = NULL WHERE deleted_by = ${userId}`);
	await tx.execute(sql`DELETE FROM user_quotas WHERE user_id = ${userId}`);
	await tx.execute(sql`UPDATE user_quotas SET updated_by = NULL WHERE updated_by = ${userId}`);

	return { afterCommit: () => removeObjects(paths) };
};
