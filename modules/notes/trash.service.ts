/**
 * Papierkorb der Notizen: Löschen verschiebt einen ganzen Teilbaum dorthin (nur die oberste Seite ist
 * `trash_root`), nach `TRASH_DAYS` löscht der Tagesjob endgültig (mit Dateien).
 */
import { sql } from 'drizzle-orm';
import { rowsOf, type Tx } from '$lib/sdk/server';
import { mdb } from './db';
import { dropDoc } from './doc.service';
import { closeNotes } from './live';
import { removeFiles } from './storage';
import { purgeSubtrees } from './tree.service';
import { TRASH_DAYS } from './schemas';

const PURGE_BATCH = 200;

/** Nach dem Commit: Dateien, Dokumente im Speicher und Live-Verbindungen der gelöschten Seiten aufräumen */
export async function afterPurge(result: { noteIds: string[]; paths: string[] }): Promise<void> {
	for (const id of result.noteIds) dropDoc(id);
	closeNotes(result.noteIds);
	await removeFiles(result.paths);
}

/** Endgültig löschen (in der Transaktion) – Aufräumen danach über `afterPurge` */
export function purgeInTx(tx: Tx, rootIds: readonly string[]) {
	return purgeSubtrees(tx, rootIds);
}

/** Job: abgelaufene Papierkorb-Einträge endgültig löschen → Anzahl Seiten */
export async function purgeExpiredTrash(): Promise<number> {
	const result = await mdb().transaction(async (tx) => {
		const rows = await rowsOf(
			tx,
			sql`SELECT id FROM notes
				WHERE trash_root AND deleted_at < now() - make_interval(days => ${TRASH_DAYS})
				ORDER BY deleted_at, id LIMIT ${PURGE_BATCH}`
		);
		return purgeSubtrees(
			tx,
			rows.map((r) => String(r.id))
		);
	});
	await afterPurge(result);
	return result.noteIds.length;
}
