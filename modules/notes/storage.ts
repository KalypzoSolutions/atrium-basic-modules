/**
 * Dateien der Notizen (Bilder in Varianten). Sie liegen im Core-Storage (Modul `notes`) und werden NACH der
 * Objektprüfung mit einem System-Kontext gelesen/geschrieben – Bearbeitende brauchen keine Storage-Rechte.
 * Alle Funktionen mit `core.*` nur AUSSERHALB offener Modul-Transaktionen aufrufen (PGlite).
 */
import { core, secureFileResponse, type ImageVariantSpec } from '$lib/sdk/server';
import { filesCtx } from './db';
import { MODULE_ID } from './schemas';

/** Varianten für `core.images.process` (Metadaten/GPS entfernt) */
export const IMAGE_VARIANTS: ImageVariantSpec[] = [
	{ name: 'thumb', maxEdge: 640, format: 'webp', quality: 76 },
	{ name: 'web', maxEdge: 2000, format: 'webp', quality: 84 }
];

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif'];

/** Storage-Pfad: `notes/<noteId>/<assetId>-<variant>.<ext>` */
export function assetPath(
	noteId: string,
	assetId: string,
	variant: 'thumb' | 'web' | 'file',
	extension: string
): string {
	return `notes/${noteId}/${assetId}-${variant}.${extension}`;
}

/** Dateien best-effort entfernen (Fehler werden protokolliert, nicht geworfen) */
export async function removeFiles(paths: readonly (string | null | undefined)[]): Promise<void> {
	const list = paths.filter((p): p is string => !!p);
	if (!list.length) return;
	await core.storage.removeMany(filesCtx(), { module: MODULE_ID, paths: list }).catch((e) => {
		console.warn('[notes] Dateien konnten nicht gelöscht werden', e);
	});
}

export async function storeFile(
	path: string,
	bytes: Uint8Array,
	contentType: string,
	name: string
): Promise<void> {
	await core.storage.upload(filesCtx(), {
		module: MODULE_ID,
		path,
		file: bytes,
		contentType,
		name
	});
}

export async function readFile(path: string): Promise<Uint8Array> {
	const { buffer } = await core.storage.download(filesCtx(), { module: MODULE_ID, path });
	return new Uint8Array(buffer);
}

/** Datei als rohe Response (gestreamt) */
export async function fileResponse(
	path: string,
	opts: { name: string; download: boolean; cache: string }
): Promise<Response> {
	const { stream, file } = await core.storage.downloadStream(filesCtx(), {
		module: MODULE_ID,
		path
	});
	return secureFileResponse(stream, {
		contentType: file.contentType,
		size: file.size,
		name: opts.name,
		download: opts.download,
		cache: opts.cache
	});
}
