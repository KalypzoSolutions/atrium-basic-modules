/**
 * Vorschaubilder für den Bestand nachziehen (Job `files.thumbs-backfill`, stündlich).
 *
 * Neue Uploads bekommen ihr Vorschaubild sofort (`storeContent`) und `thumb_attempted_at`. Dateien von vor
 * Migration 0005 (z. B. PDFs, die damals keine Vorschau hatten) werden hier **einmal** versucht: Inhalt laden,
 * `createThumbnail`, dann `thumb_path` setzen – nur, wenn die Datei inzwischen nicht ersetzt wurde
 * (`storage_path` unverändert), sonst wird das frische Vorschaubild wieder entfernt.
 * Storage-Aufrufe nur außerhalb der Transaktionen.
 */
import { sql } from 'drizzle-orm';
import { core, inList, isCoreError, logBestEffort, rowsOf } from '$lib/sdk/server';
import { filesCtx, mdb } from './db';
import { MODULE_ID, PREVIEW_IMAGE_TYPES, PREVIEW_PDF } from './schemas';
import { createThumbnail, removeObjects } from './storage';

/** Dateien je Lauf */
export const BACKFILL_BATCH = 50;
/** Größere Dateien werden nicht nachträglich geladen */
export const BACKFILL_MAX_BYTES = 50 * 1024 * 1024;

const THUMB_TYPES = [...PREVIEW_IMAGE_TYPES, PREVIEW_PDF];

export interface BackfillResult {
	created: number;
	failed: number;
	skipped: number;
	stopped: boolean;
}

async function markAttempted(id: string, storagePath: string, thumbPath: string | null) {
	const updated = await mdb().transaction(async (tx) =>
		rowsOf(
			tx,
			sql`UPDATE nodes SET thumb_path = ${thumbPath}, thumb_attempted_at = now()
				WHERE id = ${id} AND storage_path = ${storagePath} AND thumb_path IS NULL
				RETURNING id`
		)
	);
	if (!updated.length && thumbPath) await removeObjects([thumbPath]);
	return updated.length > 0;
}

export async function backfillThumbnails(): Promise<string> {
	const result = await runBackfill();
	const parts = [`${result.created} Vorschaubilder erzeugt`];
	if (result.failed) parts.push(`${result.failed} ohne Vorschau`);
	if (result.skipped) parts.push(`${result.skipped} übersprungen`);
	if (result.stopped) parts.push('Speicher nicht verfügbar – später erneut');
	return parts.join(', ');
}

export async function runBackfill(limit = BACKFILL_BATCH): Promise<BackfillResult> {
	const result: BackfillResult = { created: 0, failed: 0, skipped: 0, stopped: false };
	const rows = await mdb().transaction(async (tx) => {
		// Typen ohne Vorschau gleich als erledigt markieren (hält den Teilindex klein)
		await tx.execute(
			sql`UPDATE nodes SET thumb_attempted_at = now()
				WHERE kind = 'file' AND thumb_path IS NULL AND thumb_attempted_at IS NULL
					AND deleted_at IS NULL
					AND (content_type IS NULL OR content_type NOT IN (${inList(THUMB_TYPES)}))`
		);
		return rowsOf(
			tx,
			sql`SELECT id, storage_path, content_type, size_bytes FROM nodes
				WHERE kind = 'file' AND thumb_path IS NULL AND thumb_attempted_at IS NULL
					AND deleted_at IS NULL AND storage_path IS NOT NULL
				ORDER BY created_at
				LIMIT ${limit}`
		);
	});

	for (const row of rows) {
		const id = String(row.id);
		const storagePath = String(row.storage_path);
		const contentType = String(row.content_type);
		if (Number(row.size_bytes ?? 0) > BACKFILL_MAX_BYTES) {
			await markAttempted(id, storagePath, null);
			result.skipped++;
			continue;
		}
		let bytes: Uint8Array;
		try {
			bytes = (await core.storage.download(filesCtx(), { module: MODULE_ID, path: storagePath }))
				.buffer;
		} catch (e) {
			if (isCoreError(e) && e.code === 'not_found') {
				await markAttempted(id, storagePath, null);
				result.skipped++;
				continue;
			}
			// Speicher nicht eingerichtet/erreichbar: nichts markieren, nächster Lauf versucht es erneut
			logBestEffort('files.thumbs-backfill', e, { target: id });
			result.stopped = true;
			break;
		}
		const thumbPath = await createThumbnail(storagePath, bytes, contentType);
		const stored = await markAttempted(id, storagePath, thumbPath);
		if (thumbPath && stored) result.created++;
		else if (!thumbPath) result.failed++;
	}
	return result;
}
