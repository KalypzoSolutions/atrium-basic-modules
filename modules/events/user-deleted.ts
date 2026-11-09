/**
 * Hook `onUserDeleted` (Core `deleteUser`): Termine sind Stammesdaten und bleiben erhalten. Eigentum geht
 * an die löschende Person (`transferTo`, ohne sie – Systemaufruf – bleibt es unverändert und nur
 * `view-all`/`edit-all` verwalten die Termine). Freigaben an die Person werden gelöscht, Verweise in
 * `created_by`/`updated_by` auf `NULL` gesetzt. Kalender-Abos der Person werden gelöscht.
 */
import { sql } from 'drizzle-orm';
import type { ModuleDefinition } from '$lib/sdk/server';

export const onUserDeleted: ModuleDefinition['onUserDeleted'] = async (
	tx,
	{ userId, transferTo }
) => {
	await tx.execute(
		sql`DELETE FROM event_shares WHERE principal_type = 'user' AND principal_id = ${userId}`
	);
	if (transferTo) {
		await tx.execute(sql`UPDATE events SET owner_id = ${transferTo} WHERE owner_id = ${userId}`);
	}
	await tx.execute(sql`UPDATE events SET created_by = NULL WHERE created_by = ${userId}`);
	await tx.execute(sql`UPDATE event_exceptions SET updated_by = NULL WHERE updated_by = ${userId}`);
	await tx.execute(sql`UPDATE event_shares SET created_by = NULL WHERE created_by = ${userId}`);
	// Kalender-Abos gehören nur der Person: löschen (Links werden sofort ungültig)
	await tx.execute(sql`DELETE FROM calendar_feeds WHERE user_id = ${userId}`);
};
