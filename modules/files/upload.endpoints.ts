/**
 * Hochladen und Ausliefern von Datei-Inhalten (internes Multipart, Muster `galleries/images.endpoints.ts`).
 *
 * Ablauf Upload: Rechte/Einstellungen vor der Transaktion → Felder/Name prüfen → Ziel auflösen (Eigentümer*in) →
 * `storeIntoFolder` (Tx 1, Storage außerhalb jeder Transaktion, Tx 2, Aufräumen; `upload.service.ts`) → Audit.
 * Core-Services (Storage, Audit, Einstellungen) nie in einer offenen Transaktion (PGlite).
 */
import {
	core,
	defineEndpoint,
	errors,
	IMAGE_RATE_LIMIT,
	type AnyApiEndpoint,
	type Tx
} from '$lib/sdk/server';
import { requireFolderTarget, requireNode } from './access';
import { filesSettings, mdb } from './db';
import { normalizeName, splitRelativePath } from './names';
import { loadFileNode } from './nodes.service';
import { keysFor } from './shares.service';
import { contentResponse, storageLimits, thumbResponse } from './storage';
import { storeIntoFolder } from './upload.service';
import {
	PERMISSIONS,
	contentQuery,
	idParams,
	nodeName,
	parentParams,
	uploadFields,
	type FileNode
} from './schemas';

const tags = ['Modul: files'];

/** Zuschlag für Multipart-Rahmen und Textfelder bei der Vorab-Prüfung von `content-length` */
const MULTIPART_OVERHEAD = 1024 * 1024;

/** Optionales Textfeld aus dem Formular (fehlt → `undefined`, Datei statt Text → 400) */
function textField(form: FormData, key: string): string | undefined {
	const v = form.get(key);
	if (v === null) return undefined;
	if (typeof v !== 'string') throw errors.badRequest(`Feld "${key}" muss Text sein`);
	return v;
}

export const uploadEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'POST',
		path: '/nodes/:parent/upload',
		summary:
			'Datei hochladen (multipart, Feld "file"; `parent` = Ordner-ID oder `root` = eigene Wurzel)',
		description:
			'Textfelder: optional `relativePath` (Ordner-Upload, Ordner werden angelegt) ' +
			'und `conflict` (rename = „Name (2)“, replace = vorhandene Datei ersetzen). Ein Request je Datei.',
		tags,
		permission: PERMISSIONS.view,
		params: parentParams,
		handler: async ({ ctx, params, request }): Promise<FileNode> => {
			const keys = await keysFor(ctx);
			const settings = await filesSettings();
			const limits = await storageLimits();

			// Vorab: nicht unnötig riesige Bodies einlesen (Router liest bei internem Multipart nichts selbst).
			// Ohne Content-Length (z. B. chunked) ließe sich die Größe erst nach dem Einlesen prüfen → ablehnen.
			// Browser (XHR/fetch mit FormData) senden den Header immer.
			const rawLength = request.headers.get('content-length');
			if (rawLength === null || !/^[0-9]+$/.test(rawLength.trim())) {
				throw errors.badRequest('Content-Length fehlt');
			}
			const declaredLength = Number(rawLength.trim());
			if (declaredLength > limits.maxFileBytes + MULTIPART_OVERHEAD) {
				throw errors.tooLarge('Die Datei ist zu groß.');
			}
			const form = await request.formData().catch(() => {
				throw errors.badRequest('Ungültige Formulardaten');
			});
			const file = form.get('file');
			if (!(file instanceof File)) {
				throw errors.validation([{ path: ['file'], message: 'Bitte eine Datei auswählen' }]);
			}
			if (file.size > limits.maxFileBytes) {
				throw errors.tooLarge(
					`Die Datei ist zu groß (höchstens ${Math.floor(limits.maxFileBytes / (1024 * 1024))} MB).`
				);
			}
			const parsed = uploadFields.safeParse({
				relativePath: textField(form, 'relativePath') || undefined,
				conflict: textField(form, 'conflict') || undefined
			});
			if (!parsed.success) throw errors.validation(parsed.error.issues);
			const fields = parsed.data;

			let folders: string[] = [];
			let rawName = file.name;
			if (fields.relativePath !== undefined) {
				const split = splitRelativePath(fields.relativePath);
				if (!split) {
					throw errors.validation([{ path: ['relativePath'], message: 'Ungültiger Pfad' }]);
				}
				folders = split.folders;
				rawName = split.file;
			}
			// Vorprüfung mit passendem Feldpfad (`storeIntoFolder` prüft den Namen noch einmal)
			const checked = nodeName.safeParse(normalizeName(rawName));
			if (!checked.success) {
				const message = checked.error.issues[0]?.message ?? 'Ungültiger Dateiname';
				throw errors.validation([
					{ path: [fields.relativePath !== undefined ? 'relativePath' : 'file'], message }
				]);
			}
			const parentId = params.parent === 'root' ? null : params.parent;

			// Ziel vorab auflösen (Eigentümer*in neuer Knoten); `recheck` prüft in Tx 1 und Tx 2 erneut,
			// dass Zugriff besteht und der Ordner noch derselben Person gehört.
			const ownerId = await mdb().transaction(
				async (tx) => (await requireFolderTarget(tx, ctx, parentId, keys, 'edit')).ownerId
			);
			const recheck = async (tx: Tx) => {
				const target = await requireFolderTarget(tx, ctx, parentId, keys, 'edit');
				if (target.ownerId !== ownerId) {
					throw errors.conflict('Der Ordner wurde inzwischen verschoben. Bitte erneut hochladen.');
				}
			};

			const stored = await storeIntoFolder({
				parentId,
				ownerId,
				bytes: new Uint8Array(await file.arrayBuffer()),
				name: checked.data,
				contentType: file.type || null,
				relativeFolders: folders,
				conflict: fields.conflict,
				createdBy: ctx.userId,
				quotaBytes: settings.quotaBytes,
				recheck
			});

			await core.audit.logFromContext(ctx, 'files.node.uploaded', {
				target: stored.nodeId,
				metadata: {
					size: stored.sizeBytes,
					contentType: stored.contentType,
					replaced: stored.replaced
				}
			});
			return loadFileNode(ctx, stored.nodeId);
		}
	}),

	defineEndpoint({
		method: 'GET',
		path: '/nodes/:id/content',
		summary:
			'Datei-Inhalt (inline bei Bild/PDF/Text, sonst Download; `download=1` erzwingt Download)',
		tags,
		permission: PERMISSIONS.view,
		params: idParams,
		query: contentQuery,
		handler: async ({ ctx, params, query }) => {
			const keys = await keysFor(ctx);
			const node = await mdb().transaction(async (tx) => {
				const { node } = await requireNode(tx, ctx, params.id, keys, 'read');
				return node;
			});
			if (node.kind !== 'file' || !node.storagePath) {
				throw errors.notFound('Datei nicht gefunden');
			}
			// kein Audit: Vorschau/Download wäre zu häufig
			return contentResponse({
				path: node.storagePath,
				name: node.name,
				contentType: node.contentType ?? 'application/octet-stream',
				download: query.download === '1'
			});
		}
	}),

	defineEndpoint({
		method: 'GET',
		path: '/nodes/:id/thumb',
		summary: 'Vorschaubild (WebP, nur für Bilder)',
		tags,
		permission: PERMISSIONS.view,
		params: idParams,
		// eigenes Kontingent: das Dateiraster lädt viele Vorschaubilder (#23)
		rateLimit: IMAGE_RATE_LIMIT,
		handler: async ({ ctx, params }) => {
			const keys = await keysFor(ctx);
			const node = await mdb().transaction(async (tx) => {
				const { node } = await requireNode(tx, ctx, params.id, keys, 'read');
				return node;
			});
			if (node.kind !== 'file' || !node.thumbPath) {
				throw errors.notFound('Kein Vorschaubild vorhanden');
			}
			return thumbResponse(node.thumbPath);
		}
	})
];
