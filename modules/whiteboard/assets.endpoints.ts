/** Dateien und Bilder eines Whiteboards hochladen und ausliefern (`/api/v1/modules/whiteboard/…`). */
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import {
	type AnyApiEndpoint,
	core,
	defineEndpoint,
	errors,
	checkUploadBytes,
	IMAGE_RATE_LIMIT,
	readUpload,
	rowsOf
} from '$lib/sdk/server';
import { DEFAULT_ALLOWED_CONTENT_TYPES, EXTENSION_CONTENT_TYPES } from '$lib/sdk/content-types';
import { requireBoardAccess } from './access';
import { mdb } from './boards.service';
import { IMAGE_TYPES, uploadAsset } from './assets.service';
import { fileResponse } from './storage';
import { idParams, MAX_ASSET_BYTES, PERM, type Asset } from './schemas';

const tags = ['Whiteboard'];

const assetFileParams = z.object({
	id: z.uuid('Ungültige ID'),
	assetId: z.uuid('Ungültige ID'),
	variant: z.enum(['thumb', 'web', 'file'])
});
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
		path: '/boards/:id/assets',
		summary: 'Bild oder Datei hochladen (multipart, Feld "file")',
		description:
			'Bilder (JPEG, PNG, WebP, AVIF, GIF) werden ohne Metadaten neu gespeichert (Vorschau 640 px, Ansicht 2000 px), andere erlaubte Dateien unverändert (PDF mit Vorschaubild). Bis 25 MB je Datei, Speicher je Whiteboard begrenzt (`whiteboard.storage.boardMb`). Bearbeiten-Zugriff nötig. Das Element (`image`/`file`) legt der Editor danach per `ops` an.',
		tags,
		permission: PERM.view,
		params: idParams,
		handler: async ({ ctx, params, request }): Promise<Asset> => {
			// Typ erst nach der Endung bestimmen (Browser melden oft `application/octet-stream`)
			const file = await readUpload(request, {
				maxBytes: MAX_ASSET_BYTES,
				detectMissingType: true,
				sniff: false,
				fallbackName: 'datei'
			});
			const contentType = guessType(file.name, file.contentType);
			if (!IMAGE_TYPES.includes(contentType)) {
				// Typ erlaubt und Inhalt passend (z. B. kein HTML als PDF); Bilder prüft core.images.process
				checkUploadBytes(
					{ bytes: file.bytes, contentType, name: file.name },
					{
						maxBytes: MAX_ASSET_BYTES,
						allowedTypes: DEFAULT_ALLOWED_CONTENT_TYPES,
						typesLabel: 'Bilder, PDF, Office- oder Textdateien',
						sniff: true
					}
				);
			}
			const asset = await uploadAsset(ctx, params.id, {
				bytes: file.bytes,
				contentType,
				name: file.name.slice(0, 200)
			});
			await core.audit.logFromContext(ctx, 'whiteboard.asset.uploaded', {
				target: params.id,
				metadata: { assetId: asset.id, kind: asset.kind, bytes: asset.sizeBytes }
			});
			return asset;
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/boards/:id/assets/:assetId/:variant',
		summary: 'Bild-/Dateiinhalt abrufen (`thumb`, `web`, `file`)',
		description:
			'Lesezugriff aufs Whiteboard nötig. `file` liefert Bilder/PDF/Text inline, sonst als Download; `download=1` erzwingt den Download.',
		tags,
		permission: PERM.view,
		// eigenes Kontingent: ein Board lädt viele Bilder
		rateLimit: IMAGE_RATE_LIMIT,
		params: assetFileParams,
		query: downloadQuery,
		handler: async ({ ctx, params, query }) => {
			const row = await mdb().transaction(async (tx) => {
				await requireBoardAccess(tx, ctx, params.id);
				const [r] = await rowsOf(
					tx,
					sql`SELECT kind, name, paths FROM assets WHERE id = ${params.assetId} AND board_id = ${params.id}`
				);
				return r;
			});
			if (!row) throw errors.notFound('Datei nicht gefunden');
			const paths = (typeof row.paths === 'string' ? JSON.parse(row.paths) : row.paths) as Record<
				string,
				string
			>;
			// Bilder haben keine Originaldatei: `file` → größte Variante
			const path =
				paths[params.variant] ?? (params.variant === 'file' ? paths.web : undefined) ?? null;
			if (!path) throw errors.notFound('Datei nicht gefunden');
			return fileResponse(path, {
				name: String(row.name),
				download: query.download === '1',
				cache: 'private, max-age=3600'
			});
		}
	})
];
