/** Bilder in Notizen hochladen und ausliefern (`/api/v1/modules/notes/…`). */
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import {
	type AnyApiEndpoint,
	core,
	defineEndpoint,
	errors,
	IMAGE_RATE_LIMIT,
	readUpload,
	rowsOf
} from '$lib/sdk/server';
import { EXTENSION_CONTENT_TYPES } from '$lib/sdk/content-types';
import { resolveNoteAccess } from './access';
import { mdb } from './db';
import { assetPaths, uploadImage } from './assets.service';
import { fileResponse } from './storage';
import { assetParams, idParams, MAX_ASSET_BYTES, PERM, type NoteAsset } from './schemas';

const tags = ['Notizen'];
const downloadQuery = z.object({ download: z.enum(['0', '1']).optional() });

/** Fehlenden/allgemeinen Browser-Typ über die Endung bestimmen */
function guessType(name: string, type: string): string {
	if (type && type !== 'application/octet-stream') return type;
	const ext = name.split('.').pop()?.toLowerCase() ?? '';
	return EXTENSION_CONTENT_TYPES[ext] ?? type;
}

export const assetEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'POST',
		path: '/notes/:id/assets',
		summary: 'Bild hochladen (multipart, Feld "file")',
		description:
			'JPEG, PNG, WebP, AVIF oder GIF bis 25 MB; wird ohne Metadaten neu gespeichert (Vorschau 640 px, Ansicht 2000 px). Bearbeiten-Zugriff nötig. Den Bild-Knoten (`assetId`) fügt der Editor danach ein.',
		tags,
		permission: PERM.view,
		params: idParams,
		handler: async ({ ctx, params, request }): Promise<NoteAsset> => {
			const file = await readUpload(request, {
				maxBytes: MAX_ASSET_BYTES,
				detectMissingType: true,
				sniff: false,
				fallbackName: 'bild'
			});
			const asset = await uploadImage(ctx, params.id, {
				bytes: file.bytes,
				contentType: guessType(file.name, file.contentType),
				name: file.name.slice(0, 200)
			});
			await core.audit.logFromContext(ctx, 'notes.asset.uploaded', {
				target: params.id,
				metadata: { assetId: asset.id, bytes: asset.sizeBytes }
			});
			return asset;
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/assets/:assetId/:variant',
		summary: 'Bild abrufen (`thumb`, `web`, `file` = größte Variante)',
		description: 'Lesezugriff auf die Notiz des Bildes nötig, sonst 404.',
		tags,
		permission: PERM.view,
		// eigenes Kontingent: eine Notiz lädt viele Bilder
		rateLimit: IMAGE_RATE_LIMIT,
		params: assetParams,
		query: downloadQuery,
		handler: async ({ ctx, params, query }) => {
			const row = await mdb().transaction(async (tx) => {
				const [r] = await rowsOf(
					tx,
					sql`SELECT note_id, name, paths FROM note_assets WHERE id = ${params.assetId}`
				);
				if (!r) return null;
				return (await resolveNoteAccess(tx, ctx, String(r.note_id))) ? r : null;
			});
			if (!row) throw errors.notFound('Bild nicht gefunden');
			const paths = assetPaths(row.paths);
			const path = paths[params.variant] ?? (params.variant === 'file' ? paths.web : undefined);
			if (!path) throw errors.notFound('Bild nicht gefunden');
			return fileResponse(path, {
				name: String(row.name),
				download: query.download === '1',
				cache: 'private, max-age=3600'
			});
		}
	})
];
