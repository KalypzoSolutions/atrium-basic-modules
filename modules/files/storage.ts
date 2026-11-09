/**
 * Datei-Inhalte im Core-Storage (Modul `files`), Thumbnails, Auslieferung, Kontingent.
 * VERTRAG (Welle 0) – Implementierung: Welle 1.2. Signaturen nicht ändern.
 * Storage-Aufrufe nur AUSSERHALB offener Transaktionen (Ausnahme: `quotaUsed`/`assertQuota` sind reine SQL-Helfer).
 */
import { sql } from 'drizzle-orm';
import { DEFAULT_ALLOWED_CONTENT_TYPES, EXTENSION_CONTENT_TYPES } from '$lib/sdk/content-types';
import {
	contentDisposition,
	core,
	errors,
	isCoreError,
	logBestEffort,
	rowsOf,
	type Tx
} from '$lib/sdk/server';
import { filesCtx } from './db';
import {
	MODULE_ID,
	NEVER_INLINE_TYPES,
	PREVIEW_IMAGE_TYPES,
	PREVIEW_PDF,
	PREVIEW_TEXT_TYPES
} from './schemas';

export interface StoredContent {
	storagePath: string;
	thumbPath: string | null;
	contentType: string;
	sizeBytes: number;
}

/** Aktive Inhalte: wie im Core nur zulässig, wenn ausdrücklich in der Allowlist genannt */
const ACTIVE_CONTENT_TYPES = new Set<string>(NEVER_INLINE_TYPES);

const OCTET = 'application/octet-stream';

const THUMB_SPEC = { name: 'thumb', maxEdge: 320, format: 'webp', quality: 75 } as const;
/** PDF-Seiten etwas größer, damit Text auf der Karte erkennbar bleibt */
const PDF_THUMB_SPEC = { name: 'thumb', maxEdge: 480, format: 'webp', quality: 75 } as const;

/** Typen, für die ein Vorschaubild erzeugt wird */
export function canThumbnail(contentType: string | null | undefined): boolean {
	const ct = cleanType(contentType);
	return !!ct && (includes(PREVIEW_IMAGE_TYPES, ct) || ct === PREVIEW_PDF);
}

/** Pfad des Vorschaubilds zu einem Inhalt */
export const thumbPathFor = (storagePath: string) => `${storagePath}-thumb.webp`;

/**
 * Vorschaubild (WebP) für Bilder (`core.images.process`) und PDFs (erste Seite per `core.pdf.renderPage`,
 * danach ebenfalls durch `core.images.process`) unter `thumbPathFor(storagePath)` ablegen.
 * Fehler sind kein Abbruch → `null`. Nur außerhalb offener Transaktionen aufrufen.
 */
export async function createThumbnail(
	storagePath: string,
	bytes: Uint8Array,
	contentType: string
): Promise<string | null> {
	const ct = cleanType(contentType);
	if (!ct || !canThumbnail(ct)) return null;
	const path = thumbPathFor(storagePath);
	try {
		let source = bytes;
		let spec: typeof THUMB_SPEC | typeof PDF_THUMB_SPEC = THUMB_SPEC;
		if (ct === PREVIEW_PDF) {
			source = (await core.pdf.renderPage(bytes, { page: 1, maxEdge: PDF_THUMB_SPEC.maxEdge })).png;
			spec = PDF_THUMB_SPEC;
		}
		const processed = await core.images.process(source, { variants: [spec] });
		const thumb = processed.variants[0];
		if (!thumb) return null;
		await core.storage.upload(filesCtx(), {
			module: MODULE_ID,
			path,
			file: thumb.bytes,
			contentType: thumb.contentType,
			name: 'thumb.webp'
		});
		return path;
	} catch (e) {
		logBestEffort('files.thumbnail', e, { target: storagePath });
		return null;
	}
}

const includes = (list: readonly string[], v: string) => list.includes(v);

/** Typ ohne Parameter, klein geschrieben; leer → `null` */
function cleanType(ct: string | null | undefined): string | null {
	const t = (ct ?? '').split(';')[0]!.trim().toLowerCase();
	return t || null;
}

/** Browser-Typ, sonst nach Endung, sonst `application/octet-stream` */
function normalizeType(ct: string | null, name: string): string {
	const t = cleanType(ct);
	if (t && t !== OCTET) return t;
	const dot = name.lastIndexOf('.');
	const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
	return EXTENSION_CONTENT_TYPES[ext] ?? OCTET;
}

function typeAllowed(ct: string, allowed: readonly string[]): boolean {
	if (ACTIVE_CONTENT_TYPES.has(ct) && !allowed.includes(ct)) return false;
	return allowed.some((a) => (a.endsWith('/*') ? ct.startsWith(a.slice(0, -1)) : a === ct));
}

/** Lesbare Größe (de-DE): KB/MB/GB */
function formatBytes(n: number): string {
	const fmt = (v: number) => v.toLocaleString('de-DE', { maximumFractionDigits: 1 });
	if (n >= 1024 ** 3) return `${fmt(n / 1024 ** 3)} GB`;
	if (n >= 1024 ** 2) return `${fmt(n / 1024 ** 2)} MB`;
	if (n >= 1024) return `${fmt(n / 1024)} KB`;
	return `${n} Byte`;
}

/** Inhalt als Stream (nicht komplett im Speicher); `file.size` = Länge */
async function download(path: string) {
	try {
		return await core.storage.downloadStream(filesCtx(), { module: MODULE_ID, path });
	} catch (e) {
		if (isCoreError(e) && e.code === 'not_found') throw errors.notFound('Datei nicht gefunden');
		throw e;
	}
}

/** Grenzen aus den Core-Storage-Einstellungen (`core.storage.maxFileSizeMb`, erlaubte Typen) */
export async function storageLimits(): Promise<{
	maxFileBytes: number;
	allowedContentTypes: string[];
}> {
	const s = await core.settings.getMany([
		'core.storage.maxFileSizeMb',
		'core.storage.allowedContentTypes'
	]);
	const mb = Number(s['core.storage.maxFileSizeMb'] ?? 50);
	const configured = Array.isArray(s['core.storage.allowedContentTypes'])
		? (s['core.storage.allowedContentTypes'] as unknown[])
				.map((v) => String(v).trim().toLowerCase())
				.filter(Boolean)
		: [];
	return {
		maxFileBytes: (Number.isFinite(mb) && mb > 0 ? mb : 50) * 1024 * 1024,
		allowedContentTypes: configured.length ? configured : [...DEFAULT_ALLOWED_CONTENT_TYPES]
	};
}

/**
 * Inhalt ablegen: Pfad `<nodeId>/<uuid>`; Typ normalisieren (Browser-Typ, sonst nach Endung, sonst
 * `application/octet-stream`), Größe/Typ prüfen (413/422 mit deutscher Meldung), für `PREVIEW_IMAGE_TYPES`
 * und PDFs (erste Seite) ein Thumbnail per `createThumbnail` (WebP) unter `<nodeId>/<uuid>-thumb.webp` – Fehler
 * beim Thumbnail sind kein Abbruch (`thumbPath = null`). Original bleibt unverändert.
 */
export async function storeContent(input: {
	nodeId: string;
	bytes: Uint8Array;
	name: string;
	contentType: string | null;
}): Promise<StoredContent> {
	const contentType = normalizeType(input.contentType, input.name);
	const sizeBytes = input.bytes.byteLength;
	const limits = await storageLimits();
	if (!typeAllowed(contentType, limits.allowedContentTypes)) {
		const message = `Dateityp nicht erlaubt: ${contentType}`;
		throw errors.validation({ file: message }, message);
	}
	if (sizeBytes > limits.maxFileBytes) {
		throw errors.tooLarge(
			`Die Datei ist zu groß (${formatBytes(sizeBytes)}, erlaubt sind höchstens ${formatBytes(limits.maxFileBytes)}).`
		);
	}

	const ctx = filesCtx();
	const id = crypto.randomUUID();
	const storagePath = `${input.nodeId}/${id}`;
	await core.storage.upload(ctx, {
		module: MODULE_ID,
		path: storagePath,
		file: input.bytes,
		contentType,
		name: input.name
	});

	const thumbPath = await createThumbnail(storagePath, input.bytes, contentType);

	return { storagePath, thumbPath, contentType, sizeBytes };
}

/**
 * Inhalt als rohe Response. Inline nur für Bilder (`PREVIEW_IMAGE_TYPES`), PDF und Text
 * (Text als `text/plain; charset=utf-8`); `NEVER_INLINE_TYPES` und alles andere als `attachment`.
 * Header: `content-type`, `content-length`, `content-disposition` (RFC 5987, sicherer Name),
 * `x-content-type-options: nosniff`, `content-security-policy: default-src 'none'; sandbox`,
 * `cache-control: private, max-age=60`.
 */
export async function contentResponse(input: {
	path: string;
	name: string;
	contentType: string;
	download: boolean;
}): Promise<Response> {
	const { stream, file } = await download(input.path);
	const ct = cleanType(input.contentType) ?? OCTET;
	const isText = includes(PREVIEW_TEXT_TYPES, ct);
	const never = includes(NEVER_INLINE_TYPES, ct);
	const inlineOk = !never && (includes(PREVIEW_IMAGE_TYPES, ct) || ct === PREVIEW_PDF || isText);
	const inline = inlineOk && !input.download;

	let contentType: string;
	if (never) contentType = OCTET;
	else if (inline && isText) contentType = 'text/plain; charset=utf-8';
	else if (isText) contentType = `${ct}; charset=utf-8`;
	else contentType = ct;

	return new Response(stream, {
		status: 200,
		headers: {
			'content-type': contentType,
			'content-length': String(file.size),
			'content-disposition': contentDisposition(inline ? 'inline' : 'attachment', input.name),
			'x-content-type-options': 'nosniff',
			'content-security-policy': "default-src 'none'; sandbox",
			'cache-control': 'private, max-age=60'
		}
	});
}

/** Thumbnail (WebP) als Response, `cache-control: private, max-age=3600` */
export async function thumbResponse(path: string): Promise<Response> {
	const { stream, file } = await download(path);
	return new Response(stream, {
		status: 200,
		headers: {
			'content-type': 'image/webp',
			'content-length': String(file.size),
			'content-disposition': 'inline',
			'x-content-type-options': 'nosniff',
			'content-security-policy': "default-src 'none'; sandbox",
			'cache-control': 'private, max-age=3600'
		}
	});
}

/**
 * Objekte best-effort entfernen (Fehler ignorieren). Sammel-Löschung über `core.storage.removeMany`
 * (S3 DeleteObjects in Paketen à 1000, ein Audit-Eintrag) – Papierkorb leeren bleibt auch bei
 * Tausenden Dateien schnell.
 */
export async function removeObjects(paths: readonly (string | null | undefined)[]): Promise<void> {
	const list = [...new Set(paths)].filter((p): p is string => !!p);
	if (!list.length) return;
	await core.storage
		.removeMany(filesCtx(), { module: MODULE_ID, paths: list })
		.catch(() => undefined);
}

/** Belegter Platz einer Person (alle eigenen Dateien inkl. Papierkorb), in der Transaktion */
export async function quotaUsed(tx: Tx, ownerId: string): Promise<number> {
	const [row] = await rowsOf(
		tx,
		sql`SELECT COALESCE(SUM(size_bytes), 0)::bigint AS used FROM nodes
			WHERE owner_id = ${ownerId} AND kind = 'file'`
	);
	return Number(row?.used ?? 0);
}

/**
 * Wirksames Kontingent einer Person in der Transaktion: eigenes Limit aus `user_quotas` (Zeile mit
 * `quota_mb NULL` = unbegrenzt), sonst `defaultBytes` aus den Einstellungen (`null` = unbegrenzt).
 */
export async function quotaLimitFor(
	tx: Tx,
	ownerId: string,
	defaultBytes: number | null
): Promise<number | null> {
	const [row] = await rowsOf(tx, sql`SELECT quota_mb FROM user_quotas WHERE user_id = ${ownerId}`);
	if (!row) return defaultBytes;
	return row.quota_mb === null || row.quota_mb === undefined
		? null
		: Number(row.quota_mb) * 1024 * 1024;
}

/**
 * 413 „Dein Speicherplatz ist voll …“, wenn `used + addBytes` das wirksame Kontingent übersteigt.
 * `defaultBytes` = Standard aus `filesSettings()` (`null` = unbegrenzt); ein eigenes Limit der Person gewinnt.
 */
export async function assertQuota(
	tx: Tx,
	ownerId: string,
	addBytes: number,
	defaultBytes: number | null
): Promise<void> {
	const limitBytes = await quotaLimitFor(tx, ownerId, defaultBytes);
	if (limitBytes === null) return;
	// Sperre je Eigentümer*in bis Transaktionsende: parallele Uploads (Client lädt 3 gleichzeitig,
	// dazu Link-Uploads) sehen sonst die Belegung der anderen nicht (Check-then-insert, #72 06-12/07-05).
	// Immer als letzte Sperre einer Transaktion nehmen (nach Link-/Verschiebe-Sperren) → keine Verklemmung.
	await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'files:quota:' + ownerId}))`);
	const used = await quotaUsed(tx, ownerId);
	if (used + addBytes > limitBytes) {
		throw errors.tooLarge(
			`Dein Speicherplatz ist voll: ${formatBytes(used)} von ${formatBytes(limitBytes)} belegt.`
		);
	}
}
