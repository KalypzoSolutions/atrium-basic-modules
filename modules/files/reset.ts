/** Bereiche für den Admin-Reset (Core `system/reset`). Siehe `ResetArea`. */
import { sql } from 'drizzle-orm';
import type { ModuleDefinition, ResetArea } from '$lib/sdk/server';
import { uniqueName } from './names';

/** Ordner in der Wurzel der ausführenden Person, der die Ablage einer gelöschten Person aufnimmt */
const ADOPTED_FOLDER = 'Übernommen';

export const resetAreas: ResetArea[] = [
	{
		id: 'all',
		label: 'Alle Dateien',
		description:
			'Löscht alle Ordner und Dateien (auch die Inhalte im Speicher), den Papierkorb, alle ' +
			'Freigaben (auch die an den ganzen Stamm), alle öffentlichen Links und die Speicherkontingente einzelner Personen.',
		// Kind vor Eltern
		tables: ['share_links', 'node_shares', 'nodes', 'user_quotas'],
		storagePrefixes: 'all',
		rebuild: true
	}
];

/**
 * Verweise auf gelöschte Benutzer bereinigen (läuft im Modulschema).
 *
 * Daten gehen nicht still verloren: Die Ablagen gelöschter Personen gehen an `keepUserId` über (seit 0003
 * gibt es nur noch `space = 'personal'`). Damit es keine Namenskonflikte auf der Wurzelebene gibt
 * (eindeutiger Index je Eigentümer*in, ohne Groß/Klein), bekommt jede fremde Ablage zuerst einen eigenen neuen Ordner
 * „Übernommen“ / „Übernommen (2)“ … in der Wurzel von `keepUserId`; ihre Wurzelknoten (auch die im
 * Papierkorb) wandern dort hinein. Innerhalb dieses Ordners sind die Namen bereits eindeutig, weil sie es
 * vorher in der eigenen Ablage waren. Erst danach wird `owner_id` umgeschrieben. Der Ordner vergrößert die
 * Tiefe um eine Ebene (bei sehr tiefen Bäumen kann danach `MAX_DEPTH` um 1 überschritten sein – nur
 * relevant für weiteres Verschachteln).
 */
export const resetUsers: ModuleDefinition['resetUsers'] = async (tx, keepUserId) => {
	// Öffentliche Links auf Knoten in fremden Ablagen widerrufen, BEVOR `owner_id` umgeschrieben wird:
	// Die übernehmende Person hat sie nicht angelegt und soll nicht ungewollt Inhalte öffentlich teilen.
	await tx.execute(
		sql`UPDATE share_links SET revoked_at = now()
			WHERE revoked_at IS NULL AND node_id IN (
				SELECT id FROM nodes WHERE owner_id <> ${keepUserId}
			)`
	);
	const owners = (
		await tx.execute(
			sql`SELECT DISTINCT owner_id FROM nodes
				WHERE parent_id IS NULL AND owner_id <> ${keepUserId}
				ORDER BY owner_id`
		)
	).rows.map((r) => String((r as Record<string, unknown>).owner_id));

	for (const owner of owners) {
		const existing = (
			await tx.execute(
				sql`SELECT name FROM nodes
					WHERE parent_id IS NULL AND owner_id = ${keepUserId}
						AND deleted_at IS NULL`
			)
		).rows.map((r) => String((r as Record<string, unknown>).name));
		const folderId = crypto.randomUUID();
		await tx.execute(
			sql`INSERT INTO nodes (id, parent_id, kind, space, owner_id, name, created_by)
				VALUES (${folderId}, NULL, 'folder', 'personal', ${keepUserId},
					${uniqueName(existing, ADOPTED_FOLDER)}, ${keepUserId})`
		);
		await tx.execute(
			sql`UPDATE nodes SET parent_id = ${folderId}
				WHERE parent_id IS NULL AND owner_id = ${owner}`
		);
	}

	await tx.execute(
		sql`DELETE FROM node_shares WHERE principal_type = 'user' AND principal_id <> ${keepUserId}`
	);
	// Alle Wurzeln fremder Personen liegen jetzt in „Übernommen“-Ordnern – Umschreiben ist konfliktfrei
	await tx.execute(sql`UPDATE nodes SET owner_id = ${keepUserId} WHERE owner_id <> ${keepUserId}`);
	await tx.execute(
		sql`UPDATE nodes SET created_by = ${keepUserId}
			WHERE created_by IS NOT NULL AND created_by <> ${keepUserId}`
	);
	await tx.execute(
		sql`UPDATE nodes SET deleted_by = ${keepUserId}
			WHERE deleted_by IS NOT NULL AND deleted_by <> ${keepUserId}`
	);
	await tx.execute(
		sql`UPDATE node_shares SET created_by = ${keepUserId}
			WHERE created_by IS NOT NULL AND created_by <> ${keepUserId}`
	);
	await tx.execute(
		sql`UPDATE share_links SET created_by = ${keepUserId}
			WHERE created_by IS NOT NULL AND created_by <> ${keepUserId}`
	);
	// Kontingente gelöschter Personen entfallen (die übernommene Ablage zählt jetzt bei `keepUserId`)
	await tx.execute(sql`DELETE FROM user_quotas WHERE user_id <> ${keepUserId}`);
	await tx.execute(
		sql`UPDATE user_quotas SET updated_by = ${keepUserId}
			WHERE updated_by IS NOT NULL AND updated_by <> ${keepUserId}`
	);
};
