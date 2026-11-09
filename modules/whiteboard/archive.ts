/**
 * Export-Archiv eines Whiteboards (`.epwhiteboard` = ZIP), reine Funktionen (Server + Tests):
 *
 *   board.json             Format, Version, Board-Eigenschaften, Elemente, Dateiliste
 *   assets/<assetId>       Dateiinhalte (Bilder als WebP-Ansicht, sonstige Dateien unverändert)
 *
 * Lesen mit festen Grenzen (Einträge, Größen, keine ZIP64, nur erwartete Pfade), Elemente werden beim Import
 * zusätzlich je Typ geprüft (`checkOps`).
 */
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { z } from 'zod';
import {
	ARCHIVE_FORMAT,
	ARCHIVE_VERSION,
	BACKGROUNDS,
	ELEMENT_TYPES,
	MAX_ASSET_BYTES,
	MAX_BOARD_DESCRIPTION,
	MAX_BOARD_NAME,
	MAX_ELEMENTS,
	MAX_IMPORT_BYTES
} from './schemas';

export const MAX_ARCHIVE_ENTRIES = MAX_ELEMENTS + 10;
export const MAX_UNPACKED_BYTES = 300 * 1024 * 1024;
const MAX_JSON_BYTES = 50 * 1024 * 1024;

export class ArchiveError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ArchiveError';
	}
}

const uuid = z.uuid();

export const archiveAssetSchema = z.strictObject({
	id: uuid,
	kind: z.enum(['image', 'file']),
	name: z.string().trim().min(1).max(200),
	contentType: z.string().trim().min(1).max(200)
});
export type ArchiveAsset = z.output<typeof archiveAssetSchema>;

export const archiveDocumentSchema = z.strictObject({
	format: z.literal(ARCHIVE_FORMAT),
	version: z.literal(ARCHIVE_VERSION),
	exportedAt: z.string().max(40),
	board: z.strictObject({
		name: z.string().trim().min(1).max(MAX_BOARD_NAME),
		description: z.string().max(MAX_BOARD_DESCRIPTION).nullable(),
		color: z
			.string()
			.regex(/^#[0-9a-f]{6}$/)
			.nullable(),
		background: z.enum(BACKGROUNDS)
	}),
	elements: z
		.array(
			z.strictObject({
				id: uuid,
				type: z.enum(ELEMENT_TYPES),
				data: z.unknown(),
				z: z.number().finite()
			})
		)
		.max(MAX_ELEMENTS),
	assets: z.array(archiveAssetSchema).max(MAX_ELEMENTS)
});
export type ArchiveDocument = z.output<typeof archiveDocumentSchema>;

const ASSET_PATH_RE = /^assets\/[0-9a-f-]{36}$/;

/** Eintragsname prüfen: nur `board.json`, `assets/` und `assets/<uuid>` */
export function assertSafeArchivePath(name: string): void {
	if (!name || name.length > 255)
		throw new ArchiveError('Archiv enthält einen ungültigen Dateinamen');
	for (const ch of name) {
		const code = ch.charCodeAt(0);
		if (code < 0x20 || code === 0x7f || ch === '\\' || ch === ':') {
			throw new ArchiveError('Archiv enthält einen ungültigen Dateinamen');
		}
	}
	if (name.startsWith('/')) throw new ArchiveError('Archiv enthält einen absoluten Pfad');
	if (name.split('/').some((s) => s === '.' || s === '..')) {
		throw new ArchiveError('Archiv enthält einen unzulässigen Pfad');
	}
	if (name === 'board.json' || name === 'assets/' || ASSET_PATH_RE.test(name)) return;
	throw new ArchiveError('Archiv enthält eine unerwartete Datei');
}

export function buildArchive(doc: ArchiveDocument, files: Map<string, Uint8Array>): Uint8Array {
	const zip: Zippable = { 'board.json': strToU8(JSON.stringify(doc)) };
	for (const [id, bytes] of files) zip[`assets/${id}`] = [bytes, { level: 0 }];
	return zipSync(zip, { level: 6 });
}

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;

/** ZIP64 abweisen, bevor fflate liest (präparierte Header können `unzipSync` endlos laufen lassen) */
function assertNoZip64(data: Uint8Array): void {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const min = Math.max(0, data.byteLength - 22 - 0xffff);
	let eocd = -1;
	for (let i = data.byteLength - 22; i >= min; i--) {
		if (view.getUint32(i, true) === EOCD_SIGNATURE) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw new ArchiveError('Datei ist kein gültiges Whiteboard-Archiv');
	if (eocd >= 20 && view.getUint32(eocd - 20, true) === ZIP64_LOCATOR_SIGNATURE) {
		throw new ArchiveError('ZIP64-Archive werden nicht unterstützt');
	}
	const entries = view.getUint16(eocd + 10, true);
	const cdSize = view.getUint32(eocd + 12, true);
	const cdOffset = view.getUint32(eocd + 16, true);
	if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
		throw new ArchiveError('ZIP64-Archive werden nicht unterstützt');
	}
}

/** Archiv entpacken und prüfen; wirft `ArchiveError` (→ 422) */
export function parseArchive(data: Uint8Array): {
	doc: ArchiveDocument;
	files: Map<string, Uint8Array>;
} {
	if (data.byteLength > MAX_IMPORT_BYTES) throw new ArchiveError('Archiv ist zu groß');
	if (data.byteLength < 22 || data[0] !== 0x50 || data[1] !== 0x4b) {
		throw new ArchiveError('Datei ist kein gültiges Whiteboard-Archiv');
	}
	assertNoZip64(data);
	let count = 0;
	let total = 0;
	const seen = new Set<string>();
	let out: Record<string, Uint8Array>;
	try {
		out = unzipSync(data, {
			filter(file) {
				count += 1;
				if (count > MAX_ARCHIVE_ENTRIES) throw new ArchiveError('Archiv enthält zu viele Einträge');
				assertSafeArchivePath(file.name);
				if (file.name.endsWith('/')) return false;
				if (seen.has(file.name)) throw new ArchiveError('Archiv enthält doppelte Einträge');
				seen.add(file.name);
				const limit = file.name === 'board.json' ? MAX_JSON_BYTES : MAX_ASSET_BYTES;
				if (file.originalSize > limit) throw new ArchiveError('Archiv enthält eine zu große Datei');
				total += file.originalSize;
				if (total > MAX_UNPACKED_BYTES) throw new ArchiveError('Archiv ist entpackt zu groß');
				return true;
			}
		});
	} catch (e) {
		if (e instanceof ArchiveError) throw e;
		throw new ArchiveError('Archiv ist beschädigt und kann nicht gelesen werden');
	}
	let actual = 0;
	for (const bytes of Object.values(out)) {
		actual += bytes.byteLength;
		if (actual > MAX_UNPACKED_BYTES) throw new ArchiveError('Archiv ist entpackt zu groß');
	}
	const raw = out['board.json'];
	if (!raw) throw new ArchiveError('board.json fehlt im Archiv');
	let json: unknown;
	try {
		json = JSON.parse(strFromU8(raw));
	} catch {
		throw new ArchiveError('board.json ist kein gültiges JSON');
	}
	const parsed = archiveDocumentSchema.safeParse(json);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		throw new ArchiveError(
			`Archiv ist kein gültiges Whiteboard (${issue?.path.join('.') || 'board.json'}: ${issue?.message ?? 'ungültig'})`
		);
	}
	const files = new Map<string, Uint8Array>();
	for (const asset of parsed.data.assets) {
		const bytes = out[`assets/${asset.id}`];
		if (bytes) files.set(asset.id, bytes);
	}
	return { doc: parsed.data, files };
}

/** `Sommerlager Nord` → `sommerlager-nord` (für Dateinamen) */
export function fileSlug(name: string): string {
	const slug = name
		.toLowerCase()
		.replace(/ä/g, 'ae')
		.replace(/ö/g, 'oe')
		.replace(/ü/g, 'ue')
		.replace(/ß/g, 'ss')
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 40)
		.replace(/-+$/g, '');
	return slug || 'whiteboard';
}
