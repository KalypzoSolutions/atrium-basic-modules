/**
 * Export/Import (`.epwhiteboard`) und PDF-Export (`/api/v1/modules/whiteboard/…`).
 * PNG/SVG erzeugt der Browser selbst; für das PDF schickt er die gerenderten Seiten als PNG, der Server
 * setzt sie über `core.pdf` zu einem Dokument zusammen.
 */
import { sql } from 'drizzle-orm';
import {
	type AnyApiEndpoint,
	checkUploadBytes,
	core,
	defineEndpoint,
	errors,
	readFormData,
	rowsOf,
	takeUpload
} from '$lib/sdk/server';
import { DEFAULT_ALLOWED_CONTENT_TYPES } from '$lib/sdk/content-types';
import { formatDateDe, todayBerlin } from '$lib/sdk/dates';
import { requireBoardAccess } from './access';
import {
	ArchiveError,
	buildArchive,
	fileSlug,
	parseArchive,
	type ArchiveAsset,
	type ArchiveDocument
} from './archive';
import { IMAGE_TYPES, insertAsset, processAndStore, type StoredAsset } from './assets.service';
import { boardDetail } from './boards.endpoints';
import { BOARD_COLUMNS, boardLimitBytes, mdb } from './boards.service';
import { checkOps, writeOps } from './ops.service';
import { readFile, removeFiles } from './storage';
import {
	ARCHIVE_EXTENSION,
	ARCHIVE_FORMAT,
	ARCHIVE_VERSION,
	BACKGROUNDS,
	idParams,
	MAX_BOARD_NAME,
	MAX_IMPORT_BYTES,
	MAX_PDF_PAGE_BYTES,
	MAX_PDF_PAGES,
	MAX_PDF_TOTAL_BYTES,
	PERM,
	type Background,
	type BoardDetail,
	type ElementOp,
	type ElementType
} from './schemas';

const tags = ['Whiteboard'];

const parseJson = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;

export const transferEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/boards/:id/export',
		summary: 'Whiteboard als Archiv exportieren (.epwhiteboard)',
		description:
			'ZIP mit `board.json` (Board, Elemente) und den Dateien des Boards. Verweise auf andere Module (Karten) bleiben als ID erhalten. Lesezugriff genügt.',
		tags,
		permission: PERM.view,
		params: idParams,
		handler: async ({ ctx, params }) => {
			const data = await mdb().transaction(async (tx) => {
				await requireBoardAccess(tx, ctx, params.id);
				const [board] = await rowsOf(
					tx,
					sql`SELECT ${BOARD_COLUMNS} FROM boards b WHERE b.id = ${params.id}`
				);
				const elements = await rowsOf(
					tx,
					sql`SELECT id, type, data, z FROM elements WHERE board_id = ${params.id} AND NOT deleted
						ORDER BY z, id`
				);
				const assets = await rowsOf(
					tx,
					sql`SELECT id, kind, name, content_type, paths FROM assets WHERE board_id = ${params.id}`
				);
				return { board: board!, elements, assets };
			});
			const used = new Set<string>();
			for (const e of data.elements) {
				const assetId = parseJson<{ assetId?: unknown }>(e.data)?.assetId;
				if (typeof assetId === 'string') used.add(assetId);
			}
			const files = new Map<string, Uint8Array>();
			const assets: ArchiveAsset[] = [];
			for (const a of data.assets) {
				const id = String(a.id);
				if (!used.has(id)) continue;
				const paths = parseJson<Record<string, string>>(a.paths);
				const path = a.kind === 'image' ? paths.web : paths.file;
				if (!path) continue;
				try {
					files.set(id, await readFile(path));
				} catch (e) {
					console.warn('[whiteboard] Datei fehlt beim Export', e);
					continue;
				}
				assets.push({
					id,
					kind: a.kind === 'image' ? 'image' : 'file',
					name: String(a.name),
					contentType: String(a.content_type)
				});
			}
			const doc: ArchiveDocument = {
				format: ARCHIVE_FORMAT,
				version: ARCHIVE_VERSION,
				exportedAt: new Date().toISOString(),
				board: {
					name: String(data.board.name),
					description: data.board.description == null ? null : String(data.board.description),
					color: data.board.color == null ? null : String(data.board.color),
					background: (BACKGROUNDS as readonly string[]).includes(String(data.board.background))
						? (String(data.board.background) as Background)
						: 'dots'
				},
				elements: data.elements.map((e) => ({
					id: String(e.id),
					type: String(e.type) as ElementType,
					data: parseJson(e.data),
					z: Number(e.z)
				})),
				assets
			};
			const zip = buildArchive(doc, files);
			await core.audit.logFromContext(ctx, 'whiteboard.board.exported', {
				target: params.id,
				metadata: { elements: doc.elements.length, files: assets.length }
			});
			const name = `whiteboard-${fileSlug(doc.board.name)}-${todayBerlin()}${ARCHIVE_EXTENSION}`;
			return new Response(Buffer.from(zip), {
				headers: {
					'content-type': 'application/zip',
					'content-disposition': `attachment; filename="${name}"`,
					'cache-control': 'private, no-store',
					'x-content-type-options': 'nosniff'
				}
			});
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/boards/import',
		summary: 'Whiteboard aus einem Archiv importieren (multipart, Feld "file", optional "name")',
		description:
			'Legt immer ein NEUES Whiteboard der importierenden Person an (ohne Freigaben und ohne Aktion). Bilder werden neu verarbeitet, Dateien erneut geprüft; Ungültiges wird ausgelassen. Bis 100 MB.',
		tags,
		permission: PERM.create,
		handler: async ({ ctx, request }): Promise<BoardDetail> => {
			if (!ctx.userId) throw errors.badRequest('Whiteboards können nur Benutzer*innen importieren');
			const form = await readFormData(request);
			const upload = await takeUpload(form, {
				maxBytes: MAX_IMPORT_BYTES,
				sniff: false,
				fallbackName: 'whiteboard.epwhiteboard'
			});
			const rawName = form.get('name');
			const nameOverride =
				typeof rawName === 'string' && rawName.trim()
					? rawName.trim().slice(0, MAX_BOARD_NAME)
					: null;
			let parsed: ReturnType<typeof parseArchive>;
			try {
				parsed = parseArchive(upload.bytes);
			} catch (e) {
				if (e instanceof ArchiveError)
					throw errors.validation([{ path: ['file'], message: e.message }]);
				throw e;
			}
			const { doc, files } = parsed;
			const boardId = crypto.randomUUID();
			await mdb().transaction(async (tx) => {
				await tx.execute(
					sql`INSERT INTO boards (id, name, description, color, background, owner_id, created_by, updated_by)
						VALUES (${boardId}, ${nameOverride ?? doc.board.name}, ${doc.board.description},
							${doc.board.color}, ${doc.board.background}, ${ctx.userId}, ${ctx.userId}, ${ctx.userId})`
				);
			});
			const stored: StoredAsset[] = [];
			const assetMap = new Map<string, string>();
			let skipped = 0;
			try {
				for (const asset of doc.assets) {
					const bytes = files.get(asset.id);
					if (!bytes) {
						skipped++;
						continue;
					}
					try {
						const contentType = asset.kind === 'image' ? 'image/webp' : asset.contentType;
						if (asset.kind === 'file') {
							checkUploadBytes(
								{ bytes, contentType, name: asset.name },
								{ maxBytes: bytes.byteLength + 1, allowedTypes: DEFAULT_ALLOWED_CONTENT_TYPES }
							);
						} else if (!IMAGE_TYPES.includes(contentType)) {
							throw new Error('Kein Bild');
						}
						const s = await processAndStore(boardId, { bytes, contentType, name: asset.name });
						stored.push(s);
						assetMap.set(asset.id, s.id);
					} catch {
						skipped++;
					}
				}
				const ops: ElementOp[] = [];
				for (const e of doc.elements) {
					let data = e.data;
					if (e.type === 'image' || e.type === 'file') {
						const old = (data as { assetId?: unknown })?.assetId;
						const mapped = typeof old === 'string' ? assetMap.get(old) : undefined;
						if (!mapped) {
							skipped++;
							continue;
						}
						data = { ...(data as object), assetId: mapped };
					}
					ops.push({ id: e.id, type: e.type, data, z: e.z });
				}
				let checked: ReturnType<typeof checkOps>;
				try {
					checked = checkOps(ops);
				} catch {
					throw errors.validation([
						{ path: ['file'], message: 'Archiv enthält ungültige Elemente' }
					]);
				}
				const limit = await boardLimitBytes();
				await mdb().transaction(async (tx) => {
					for (const s of stored) await insertAsset(tx, ctx, boardId, s, limit);
					if (checked.length) await writeOps(tx, ctx, boardId, checked);
				});
			} catch (e) {
				await mdb()
					.transaction((tx) => tx.execute(sql`DELETE FROM boards WHERE id = ${boardId}`))
					.catch(() => undefined);
				await removeFiles(stored.flatMap((s) => Object.values(s.paths)));
				throw e;
			}
			await core.audit.logFromContext(ctx, 'whiteboard.board.imported', {
				target: boardId,
				metadata: { elements: doc.elements.length, files: stored.length, skipped }
			});
			return boardDetail(ctx, boardId);
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/boards/:id/export.pdf',
		summary: 'PDF aus gerenderten Seiten erzeugen (multipart: page0 … page19 als PNG/JPEG)',
		description:
			'Der Editor rendert das Board (ganz, Auswahl oder je Rahmen eine Seite) und schickt die Bilder; jede wird eine PDF-Seite (A4, quer oder hoch, seitenfüllend), davor ein Deckblatt. Höchstens 20 Seiten, je 8 MB, zusammen 55 MB. Lesezugriff genügt.',
		tags,
		permission: PERM.view,
		rateLimit: { limit: 20, windowSec: 60 },
		params: idParams,
		handler: async ({ ctx, params, request }) => {
			const length = Number(request.headers.get('content-length') ?? 0);
			if (length > MAX_PDF_TOTAL_BYTES + 1024 * 1024) throw errors.tooLarge('Anfrage ist zu groß');
			const form = await readFormData(request);
			const pages: { bytes: Uint8Array; type: string; label: string | null }[] = [];
			for (let i = 0; i < MAX_PDF_PAGES; i++) {
				const page = await takeUpload(form, {
					field: `page${i}`,
					maxBytes: MAX_PDF_PAGE_BYTES,
					allowedTypes: ['image/png', 'image/jpeg'],
					typesLabel: 'PNG oder JPEG',
					required: false
				});
				if (!page) break;
				const label = form.get(`label${i}`);
				pages.push({
					bytes: page.bytes,
					type: page.contentType,
					label: typeof label === 'string' && label.trim() ? label.trim().slice(0, 120) : null
				});
			}
			if (!pages.length)
				throw errors.validation([{ path: ['page0'], message: 'Keine Seite übergeben' }]);
			if (pages.reduce((n, p) => n + p.bytes.byteLength, 0) > MAX_PDF_TOTAL_BYTES) {
				throw errors.tooLarge(
					'Die Seiten sind zusammen zu groß – exportiere weniger oder kleinere Bereiche'
				);
			}
			const orientation = form.get('orientation') === 'portrait' ? 'portrait' : 'landscape';
			const name = await mdb().transaction(async (tx) => {
				await requireBoardAccess(tx, ctx, params.id);
				const [b] = await rowsOf(tx, sql`SELECT name FROM boards WHERE id = ${params.id}`);
				return String(b?.name ?? 'Whiteboard');
			});
			// Deckblatt als Hauptdokument, jede Seite als Bild-Anlage (seitenfüllend skaliert, bis 60 MB gesamt)
			const pdf = await core.pdf.generate(ctx, {
				template: 'default',
				title: name,
				orientation,
				content: [
					{ type: 'heading', text: name, level: 1 },
					{
						type: 'paragraph',
						text: `Whiteboard-Export vom ${formatDateDe(todayBerlin())} · ${pages.length} ${pages.length === 1 ? 'Seite' : 'Seiten'}`
					},
					{
						type: 'list',
						items: pages.map((p, i) => p.label ?? `Seite ${i + 1}`)
					}
				],
				attachments: pages.map((p, i) => ({
					label: p.label ?? (pages.length === 1 ? name : `Seite ${i + 1}`),
					contentType: p.type,
					data: p.bytes
				}))
			});
			await core.audit.logFromContext(ctx, 'whiteboard.board.exported', {
				target: params.id,
				metadata: { format: 'pdf', pages: pages.length }
			});
			const file = `whiteboard-${fileSlug(name)}-${todayBerlin()}.pdf`;
			return new Response(Buffer.from(pdf.buffer), {
				headers: {
					'content-type': 'application/pdf',
					'content-disposition': `attachment; filename="${file}"`,
					'cache-control': 'private, no-store'
				}
			});
		}
	})
];
