/**
 * Import von Markdown (`.md`, `.markdown`, `.txt`) und ZIP-Archiven (je `.md` eine Seite, Ordner → Unterseiten,
 * Bilder aus dem Archiv) als neue Notizen.
 *
 * Ablauf: Prüfung (Transaktion 1: Recht/Zugriff, Tiefe) → Archiv lesen, Bilder über `core.images.process` (Varianten
 * thumb/web WebP, Metadaten entfernt) in den Speicher → Transaktion 2: erneute Prüfung, Seiten und `note_assets`
 * anlegen. Scheitert Transaktion 2, werden die Dateien wieder entfernt.
 *
 * Bilder: nur relative Verweise auf Dateien im Archiv (`![…](bilder/x.png)`, auch `../`), nur JPEG/PNG/WebP/GIF/AVIF,
 * je Bild ≤ `MAX_ASSET_BYTES`; unlesbare Bilder entfallen (Alt-Text bleibt als `[Bild: …]`). Externe Bilder werden nie
 * übernommen. Titel = erste Überschrift 1 am Anfang (wird aus dem Inhalt entfernt) bzw. Datei-/Ordnername.
 */
import { sql } from 'drizzle-orm';
import { core, errors, type RequestContext } from '$lib/sdk/server';
import { requireNoteAccess } from '../access';
import { mdb } from '../db';
import { jsonFromState, stateFromJson } from '../doc.service';
import { plainTextOf } from '../doc/text';
import { MAX_ASSET_BYTES, MAX_CHILDREN, MAX_DEPTH, MAX_DOC_BYTES, MAX_TITLE } from '../schemas';
import { assetPath, IMAGE_VARIANTS, removeFiles, storeFile } from '../storage';
import {
	canCreate,
	childCount,
	lockContainer,
	nextPosition,
	type Container
} from '../tree.service';
import { parseMarkdown, resolveRelative, rewriteImageRefs, takeTitle } from './markdown';
import { readZip, ZipError } from './zip';

/** Bilder je Import */
export const MAX_IMPORT_IMAGES = 300;

const TEXT_EXT = /\.(?:md|markdown|txt)$/i;
const MD_EXT = /\.(?:md|markdown)$/i;
const IMAGE_EXT = /\.(?:jpe?g|png|webp|gif|avif)$/i;

const invalid = (message: string) => errors.validation([{ path: ['file'], message }]);

export interface ImportFile {
	name: string;
	bytes: Uint8Array;
}

export interface ImportResult {
	id: string;
	pages: number;
	images: number;
}

/** Text einer Datei (UTF-8, BOM entfernt; Binärinhalt → 422) */
export function decodeText(bytes: Uint8Array): string {
	let text: string;
	try {
		text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		throw invalid('Die Datei ist keine UTF-8-Textdatei');
	}
	if (text.includes('\u0000')) throw invalid('Die Datei ist keine Textdatei');
	// Byte-Order-Mark (U+FEFF) am Anfang entfernen
	return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Dateiname ohne Endung als Ersatztitel */
const baseTitle = (name: string) =>
	(name.split('/').pop() ?? name)
		.replace(/\.[A-Za-z0-9]{1,10}$/, '')
		.replace(/[_]+/g, ' ')
		.trim()
		.slice(0, MAX_TITLE) || 'Import';

interface PlannedPage {
	id: string;
	/** Schlüssel im Archiv (Pfad ohne Endung), Wurzel des Imports = '' bei Hülle */
	key: string;
	parentKey: string | null;
	title: string;
	markdown: string;
	/** Ordner der `.md` (für relative Bildpfade) */
	dir: string;
	position: number;
	depth: number;
}

interface PlannedImage {
	assetId: string;
	pageId: string;
	path: string;
	bytes: Uint8Array;
}

interface StoredImage {
	assetId: string;
	pageId: string;
	name: string;
	contentType: string;
	sizeBytes: number;
	width: number;
	height: number;
	paths: Record<string, string>;
}

/** Seitenbaum aus den Pfaden der `.md`-Dateien (Ordner ohne eigene `.md` werden leere Seiten) */
function planZipPages(files: Map<string, Uint8Array>, zipName: string): PlannedPage[] {
	const nodes = new Map<string, { key: string; md: string | null }>();
	for (const name of files.keys()) {
		if (!MD_EXT.test(name)) continue;
		const key = name.replace(MD_EXT, '');
		const parts = key.split('/');
		for (let i = 1; i < parts.length; i++) {
			const dirKey = parts.slice(0, i).join('/');
			if (!nodes.has(dirKey)) nodes.set(dirKey, { key: dirKey, md: null });
		}
		nodes.set(key, { key, md: name });
	}
	if (!nodes.size) throw invalid('Das Archiv enthält keine Markdown-Dateien (.md)');
	const parentOf = (key: string) => (key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : null);
	const tops = [...nodes.keys()].filter((k) => parentOf(k) === null);
	// Mehrere oberste Seiten → eine Hülle mit dem Namen des Archivs
	const wrap = tops.length > 1;
	const children = new Map<string | null, string[]>();
	for (const k of nodes.keys()) {
		const p = parentOf(k);
		const list = children.get(p) ?? [];
		list.push(k);
		children.set(p, list);
	}
	const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });
	const out: PlannedPage[] = [];
	const visit = (key: string, parentKey: string | null, depth: number, position: number) => {
		const node = nodes.get(key)!;
		const dir = parentOf(key) ?? '';
		const md = node.md ? decodeText(files.get(node.md)!) : '';
		out.push({
			id: crypto.randomUUID(),
			key,
			parentKey,
			title: baseTitle(key),
			markdown: md,
			dir,
			position,
			depth
		});
		const list = (children.get(key) ?? []).sort((a, b) => collator.compare(a, b));
		list.forEach((c, i) => visit(c, key, depth + 1, i));
	};
	if (wrap) {
		out.push({
			id: crypto.randomUUID(),
			key: '',
			parentKey: null,
			title: baseTitle(zipName),
			markdown: '',
			dir: '',
			position: 0,
			depth: 0
		});
		tops.sort((a, b) => collator.compare(a, b)).forEach((k, i) => visit(k, '', 1, i));
	} else {
		visit(tops[0]!, null, 0, 0);
	}
	return out;
}

/** Höhe des geplanten Baums (nur die Wurzel = 1) */
const heightOf = (pages: readonly PlannedPage[]) => Math.max(...pages.map((p) => p.depth)) + 1;

/** Prüfung vor dem Anlegen; liefert Eigentümer*in und Container der obersten neuen Seite */
async function checkTarget(
	ctx: RequestContext,
	parentId: string | null,
	height: number
): Promise<{ ownerId: string | null; container: Container }> {
	if (!parentId) {
		if (!canCreate(ctx)) {
			throw errors.forbidden('Keine Berechtigung zum Anlegen von Notizen');
		}
		if (height > MAX_DEPTH) {
			throw invalid(`Das Archiv ist zu tief verschachtelt (höchstens ${MAX_DEPTH} Ebenen)`);
		}
		return { ownerId: ctx.userId, container: { ownerId: ctx.userId } };
	}
	return mdb().transaction(async (tx) => {
		const parent = await requireNoteAccess(tx, ctx, parentId, 'edit');
		if (parent.chain.length + height > MAX_DEPTH) {
			throw errors.validation([{ path: ['parentId'], message: `Höchstens ${MAX_DEPTH} Ebenen` }]);
		}
		if ((await childCount(tx, parentId)) >= MAX_CHILDREN) {
			throw errors.validation([
				{ path: ['parentId'], message: `Höchstens ${MAX_CHILDREN} Unterseiten je Seite` }
			]);
		}
		return {
			ownerId: parent.chain[0]?.ownerId ?? ctx.userId,
			container: { parentId } as Container
		};
	});
}

async function storeImages(planned: PlannedImage[]): Promise<{
	stored: Map<string, StoredImage>;
	paths: string[];
}> {
	const stored = new Map<string, StoredImage>();
	const paths: string[] = [];
	try {
		for (const img of planned) {
			let processed;
			try {
				processed = await core.images.process(img.bytes, { variants: IMAGE_VARIANTS });
			} catch {
				// kein lesbares Bild → entfällt (Alt-Text bleibt)
				continue;
			}
			const variantPaths: Record<string, string> = {};
			let size = 0;
			let web: (typeof processed.variants)[number] | undefined;
			for (const v of processed.variants) {
				const path = assetPath(img.pageId, img.assetId, v.name as 'thumb' | 'web', v.extension);
				await storeFile(path, v.bytes, v.contentType, `${img.assetId}-${v.name}.${v.extension}`);
				paths.push(path);
				variantPaths[v.name] = path;
				size += v.bytes.byteLength;
				if (v.name === 'web') web = v;
			}
			if (!web) continue;
			stored.set(img.assetId, {
				assetId: img.assetId,
				pageId: img.pageId,
				name: (img.path.split('/').pop() ?? 'bild').slice(0, 200),
				contentType: web.contentType,
				sizeBytes: size,
				width: web.width,
				height: web.height,
				paths: variantPaths
			});
		}
	} catch (e) {
		await removeFiles(paths);
		throw e;
	}
	return { stored, paths };
}

/** Datei importieren → oberste neue Notiz */
export async function importNotes(
	ctx: RequestContext,
	file: ImportFile,
	parentId: string | null
): Promise<ImportResult> {
	if (!ctx.userId) throw errors.badRequest('Notizen können nur Benutzer*innen importieren');
	const userId = ctx.userId;
	const isZip = /\.zip$/i.test(file.name);
	if (!isZip && !TEXT_EXT.test(file.name)) {
		throw invalid('Nur Markdown (.md, .markdown, .txt) oder ZIP-Archive (.zip)');
	}

	// Seiten planen (ohne Datenbank)
	let pages: PlannedPage[];
	let archive = new Map<string, Uint8Array>();
	if (isZip) {
		try {
			archive = readZip(file.bytes, {
				maxFileBytes: MAX_ASSET_BYTES,
				keep: (n) => MD_EXT.test(n) || IMAGE_EXT.test(n)
			});
		} catch (e) {
			if (e instanceof ZipError) throw invalid(e.message);
			throw e;
		}
		pages = planZipPages(archive, file.name);
	} else {
		pages = [
			{
				id: crypto.randomUUID(),
				key: '',
				parentKey: null,
				title: baseTitle(file.name),
				markdown: decodeText(file.bytes),
				dir: '',
				position: 0,
				depth: 0
			}
		];
	}
	const height = heightOf(pages);
	const target = await checkTarget(ctx, parentId, height);

	// Bild-Verweise je Seite einsammeln (nur Dateien im Archiv)
	const planned: PlannedImage[] = [];
	const refIds = new Map<string, string>(); // `${pageId}|${path}` → assetId
	if (isZip) {
		for (const p of pages) {
			rewriteImageRefs(p.markdown, (target) => {
				const path = resolveRelative(p.dir, target);
				if (!path || !IMAGE_EXT.test(path) || !archive.has(path)) return null;
				const key = `${p.id}|${path}`;
				if (!refIds.has(key) && planned.length < MAX_IMPORT_IMAGES) {
					const assetId = crypto.randomUUID();
					refIds.set(key, assetId);
					planned.push({ assetId, pageId: p.id, path, bytes: archive.get(path)! });
				}
				return refIds.get(key) ?? null;
			});
		}
	}
	const { stored, paths } = await storeImages(planned);

	// Inhalte bauen (Bild-IDs nur für erfolgreich gespeicherte Bilder)
	const built = pages.map((p) => {
		const markdown = rewriteImageRefs(p.markdown, (target) => {
			const path = isZip ? resolveRelative(p.dir, target) : null;
			const id = path ? refIds.get(`${p.id}|${path}`) : undefined;
			return id && stored.has(id) ? id : null;
		});
		let parsed: Record<string, unknown>;
		try {
			parsed = parseMarkdown(markdown);
		} catch {
			throw invalid('Der Inhalt konnte nicht gelesen werden');
		}
		const { title, json } = takeTitle(parsed, p.title, MAX_TITLE);
		const state = stateFromJson(json);
		if (state.byteLength > MAX_DOC_BYTES) throw errors.tooLarge('Der Inhalt ist zu groß');
		// über das Schema normalisiert (wie beim Laden)
		const normalized = jsonFromState(state);
		return { page: p, title, state, json: normalized, text: plainTextOf(normalized) };
	});
	const idOfKey = new Map(pages.map((p) => [p.key, p.id]));
	const root = pages[0]!;

	try {
		await mdb().transaction(async (tx) => {
			if (parentId) {
				// erneut prüfen (zwischen den Transaktionen geändert?)
				await requireNoteAccess(tx, ctx, parentId, 'edit');
			}
			await lockContainer(tx, target.container);
			const rootPosition = await nextPosition(tx, target.container);
			for (const b of built) {
				const p = b.page;
				const parent = p.parentKey === null ? parentId : (idOfKey.get(p.parentKey) ?? null);
				const position = p.parentKey === null ? rootPosition : p.position;
				await tx.execute(
					sql`INSERT INTO notes (id, parent_id, position, title, owner_id, ydoc, content_json, content_text,
							size_bytes, created_by, updated_by)
						VALUES (${p.id}, ${parent}, ${position}, ${b.title}, ${target.ownerId},
							${Buffer.from(b.state)}, ${JSON.stringify(b.json)}::jsonb, ${b.text},
							${b.state.byteLength}, ${userId}, ${userId})`
				);
			}
			for (const a of stored.values()) {
				await tx.execute(
					sql`INSERT INTO note_assets (id, note_id, kind, name, content_type, size_bytes, width, height,
							paths, created_by)
						VALUES (${a.assetId}, ${a.pageId}, 'image', ${a.name}, ${a.contentType}, ${a.sizeBytes},
							${a.width}, ${a.height}, ${JSON.stringify(a.paths)}::jsonb, ${userId})`
				);
			}
		});
	} catch (e) {
		await removeFiles(paths);
		throw e;
	}
	return { id: root.id, pages: pages.length, images: stored.size };
}
