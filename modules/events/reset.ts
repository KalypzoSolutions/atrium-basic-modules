/** Bereiche für den Admin-Reset (Core `system/reset`). Siehe `ResetArea`. */
import { sql } from 'drizzle-orm';
import type { ModuleDefinition, ResetArea } from '$lib/sdk/server';

/** Das Modul speichert keine Dateien – daher keine `storagePrefixes`. */
export const resetAreas: ResetArea[] = [
	{
		id: 'all',
		label: 'Alle Termine',
		description:
			'Löscht alle Termine samt Serien-Ausnahmen, Tags, Gruppen-Zuordnungen und Freigaben. ' +
			'Termine auf der Stammeswebsite verschwinden ebenfalls. Kalender-Abos (iCal-Links) werden gelöscht.',
		tables: [
			'event_exceptions',
			'event_shares',
			'event_groups',
			'event_tags',
			'events',
			'calendar_feeds'
		],
		rebuild: true
	}
];

/** Verweise auf gelöschte Benutzer bereinigen (läuft im Modulschema). */
export const resetUsers: ModuleDefinition['resetUsers'] = async (tx, keepUserId) => {
	await tx.execute(
		sql`DELETE FROM event_shares WHERE principal_type = 'user' AND principal_id <> ${keepUserId}`
	);
	await tx.execute(sql`UPDATE events SET owner_id = ${keepUserId} WHERE owner_id <> ${keepUserId}`);
	await tx.execute(sql`DELETE FROM calendar_feeds WHERE user_id <> ${keepUserId}`);
	await tx.execute(
		sql`UPDATE events SET created_by = ${keepUserId}
			WHERE created_by IS NOT NULL AND created_by <> ${keepUserId}`
	);
	await tx.execute(
		sql`UPDATE event_exceptions SET updated_by = ${keepUserId}
			WHERE updated_by IS NOT NULL AND updated_by <> ${keepUserId}`
	);
	await tx.execute(
		sql`UPDATE event_shares SET created_by = ${keepUserId}
			WHERE created_by IS NOT NULL AND created_by <> ${keepUserId}`
	);
};
