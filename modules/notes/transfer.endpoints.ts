/**
 * Export (Markdown, ZIP, HTML, Word, PDF) und Import (Markdown, ZIP) der Notizen (`/api/v1/modules/notes/…`).
 * Details: `export/*.ts`.
 */
import { z } from 'zod';
import {
	type AnyApiEndpoint,
	contentDisposition,
	core,
	defineEndpoint,
	errors,
	readFormData,
	safeFileName,
	secureFileResponse,
	takeUpload
} from '$lib/sdk/server';
import { collectExport, type ExportBundle } from './export/collect';
import { exportDocx, type DocxImage } from './export/docx';
import { dataUrl, htmlDocument, pagesFragment } from './export/html';
import { importNotes } from './export/import';
import { exportMarkdown, exportMarkdownFiles, type MarkdownContext } from './export/markdown';
import { exportPdf } from './export/pdf';
import { writeZip } from './export/zip';
import { exportQuery, idParams, MAX_IMPORT_BYTES, PERM, type ExportFormat } from './schemas';

const tags = ['Notizen'];

const EXTENSIONS: Record<ExportFormat, string> = {
	md: 'md',
	zip: 'zip',
	html: 'html',
	docx: 'docx',
	pdf: 'pdf'
};

/** Download mit genauem Typ (inkl. `charset`), immer als Anhang, ohne aktive Inhalte im App-Kontext */
function attachment(body: Uint8Array | string, contentType: string, name: string): Response {
	const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
	return new Response(Buffer.from(bytes), {
		headers: {
			'content-type': contentType,
			'content-disposition': contentDisposition('attachment', name),
			'content-length': String(bytes.byteLength),
			'x-content-type-options': 'nosniff',
			'content-security-policy':
				"default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox",
			'cache-control': 'no-store'
		}
	});
}

function markdownContext(bundle: ExportBundle): MarkdownContext {
	return { images: bundle.images, embeds: bundle.embeds, origin: bundle.origin };
}

/** Bilder für Word (kein WebP): PNG bei Transparenz, sonst JPEG; nicht umwandelbare entfallen */
async function docxImages(bundle: ExportBundle): Promise<Map<string, DocxImage>> {
	const out = new Map<string, DocxImage>();
	for (const img of bundle.images.values()) {
		try {
			const processed = await core.images.process(img.bytes, {
				variants: [{ name: 'docx', maxEdge: 1600, format: 'auto', quality: 85 }]
			});
			const v = processed.variants[0];
			if (!v || v.extension === 'webp') continue;
			out.set(img.id, {
				type: v.extension === 'png' ? 'png' : 'jpg',
				data: v.bytes,
				width: v.width,
				height: v.height
			});
		} catch (e) {
			console.warn('[notes] Bild für Word nicht umwandelbar', e);
		}
	}
	return out;
}

const parentIdField = z.uuid('Ungültige ID');

export const transferEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/notes/:id/export',
		summary: 'Notiz exportieren (Markdown, ZIP mit Bildern, HTML, Word, PDF)',
		description:
			'`format` = md | zip | html | docx | pdf; `subpages=1` mit allen Unterseiten (Baumreihenfolge, Papierkorb ausgenommen); `letterhead=1` = PDF mit Stammes-Briefkopf. Immer als Download. Bilder: im ZIP als Dateien, in HTML/PDF/Word eingebettet, im einzelnen Markdown als Link in die App.',
		tags,
		permission: PERM.view,
		params: idParams,
		query: exportQuery,
		handler: async ({ ctx, params, query }) => {
			const bundle = await collectExport(ctx, params.id, { subpages: query.subpages === '1' });
			const format = query.format;
			const name = `${safeFileName(bundle.root.title || 'Notiz', { german: true, fallback: 'Notiz' })}.${EXTENSIONS[format]}`;
			let response: Response;
			switch (format) {
				case 'md':
					response = attachment(
						exportMarkdown(bundle.pages, markdownContext(bundle)),
						'text/markdown; charset=utf-8',
						name
					);
					break;
				case 'zip': {
					const zip = writeZip(exportMarkdownFiles(bundle.pages, markdownContext(bundle)));
					response = secureFileResponse(zip, {
						contentType: 'application/zip',
						size: zip.byteLength,
						name,
						download: true,
						cache: 'no-store'
					});
					break;
				}
				case 'html': {
					const fragment = pagesFragment(bundle.pages, {
						embeds: bundle.embeds,
						imageSrc: (id) => {
							const img = bundle.images.get(id);
							return img ? dataUrl(img.contentType, img.bytes) : null;
						}
					});
					response = attachment(
						htmlDocument(bundle.root.title, fragment),
						'text/html; charset=utf-8',
						name
					);
					break;
				}
				case 'docx': {
					const bytes = await exportDocx(bundle.pages, {
						images: await docxImages(bundle),
						embeds: bundle.embeds,
						title: bundle.root.title
					});
					response = secureFileResponse(bytes, {
						contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
						size: bytes.byteLength,
						name,
						download: true,
						cache: 'no-store'
					});
					break;
				}
				case 'pdf': {
					const bytes = await exportPdf(ctx, bundle, { letterhead: query.letterhead === '1' });
					response = secureFileResponse(bytes, {
						contentType: 'application/pdf',
						size: bytes.byteLength,
						name,
						download: true,
						cache: 'no-store'
					});
					break;
				}
			}
			await core.audit.logFromContext(ctx, 'notes.note.exported', {
				target: params.id,
				metadata: {
					format,
					pages: bundle.pages.length,
					images: bundle.images.size,
					letterhead: format === 'pdf' && query.letterhead === '1'
				}
			});
			return response;
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/notes/import',
		summary: 'Markdown oder ZIP importieren (multipart, Feld "file", optional "parentId")',
		description:
			'`.md`/`.markdown`/`.txt` → eine neue Notiz; `.zip` → je `.md` eine Seite, Ordner werden Unterseiten, Bilder aus dem Archiv (JPEG/PNG/WebP/GIF/AVIF) werden übernommen, externe Bilder nicht. Ohne `parentId` Recht `notes.note.create`, mit `parentId` Bearbeiten-Zugriff auf die Oberseite. Antwort: `{ id }` der obersten neuen Notiz. Bis 50 MB, ZIP ≤ 500 Einträge, entpackt ≤ 200 MB.',
		tags,
		permission: PERM.view,
		handler: async ({ ctx, request }): Promise<{ id: string }> => {
			const form = await readFormData(request);
			const rawParent = form.get('parentId');
			let parentId: string | null = null;
			if (typeof rawParent === 'string' && rawParent.trim()) {
				const parsed = parentIdField.safeParse(rawParent.trim());
				if (!parsed.success) {
					throw errors.validation([{ path: ['parentId'], message: 'Ungültige ID' }]);
				}
				parentId = parsed.data;
			}
			const upload = await takeUpload(form, {
				maxBytes: MAX_IMPORT_BYTES,
				sniff: false,
				fallbackName: 'import.md'
			});
			const result = await importNotes(ctx, { name: upload.name, bytes: upload.bytes }, parentId);
			await core.audit.logFromContext(ctx, 'notes.note.imported', {
				target: result.id,
				metadata: {
					pages: result.pages,
					images: result.images,
					zip: /\.zip$/i.test(upload.name),
					withParent: !!parentId
				}
			});
			return { id: result.id };
		}
	})
];
