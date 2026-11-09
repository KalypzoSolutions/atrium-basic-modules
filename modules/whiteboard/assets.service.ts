/**
 * Dateien eines Whiteboards: Bilder werden über `core.images.process` neu kodiert (Metadaten/GPS entfernt,
 * Varianten `thumb`/`web`), sonstige Dateien unverändert gespeichert (PDF mit Vorschaubild der ersten Seite).
 * Ablauf: Vorprüfung (Transaktion 1) → Verarbeitung + Speicher → Eintrag mit erneuter Prüfung (Transaktion 2);
 * schlägt Transaktion 2 fehl, werden die Dateien wieder entfernt.
 */
import { sql } from 'drizzle-orm';
import { core, errors, logBestEffort, type RequestContext, type Tx } from '$lib/sdk/server';
import { lockBoard, requireBoardAccess } from './access';
import { assetOf, boardLimitBytes, mdb, usedBytes } from './boards.service';
import { assetPath, IMAGE_VARIANTS, PDF_THUMB, removeFiles, storeFile } from './storage';
import type { Asset } from './schemas';

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif'];

/** Speicherplatz des Boards prüfen (in der Transaktion; `limit` vorher über `boardLimitBytes()` holen) */
async function assertSpace(
	tx: Tx,
	boardId: string,
	addBytes: number,
	limit: number
): Promise<void> {
	if (!limit) return;
	const used = await usedBytes(tx, boardId);
	if (used + addBytes > limit) {
		throw errors.tooLarge(
			`Für dieses Whiteboard ist nicht genug Speicherplatz frei (höchstens ${Math.round(limit / 1024 / 1024)} MB)`
		);
	}
}

export interface StoredAsset {
	id: string;
	kind: 'image' | 'file';
	name: string;
	contentType: string;
	sizeBytes: number;
	width: number | null;
	height: number | null;
	paths: Record<string, string>;
}

/** Datei verarbeiten und im Speicher ablegen (ohne Datenbank, ohne Prüfung). Fehler räumen selbst auf. */
export async function processAndStore(
	boardId: string,
	file: { bytes: Uint8Array; contentType: string; name: string },
	assetId = crypto.randomUUID()
): Promise<StoredAsset> {
	const uploaded: string[] = [];
	try {
		if (IMAGE_TYPES.includes(file.contentType)) {
			const processed = await core.images.process(file.bytes, { variants: IMAGE_VARIANTS });
			const paths: Record<string, string> = {};
			let size = 0;
			let web: (typeof processed.variants)[number] | undefined;
			for (const v of processed.variants) {
				const path = assetPath(boardId, assetId, v.name as 'thumb' | 'web', v.extension);
				await storeFile(path, v.bytes, v.contentType, `${assetId}-${v.name}.${v.extension}`);
				uploaded.push(path);
				paths[v.name] = path;
				size += v.bytes.byteLength;
				if (v.name === 'web') web = v;
			}
			if (!web) throw errors.unavailable('Bildverarbeitung unvollständig');
			return {
				id: assetId,
				kind: 'image',
				name: file.name,
				contentType: web.contentType,
				sizeBytes: size,
				width: web.width,
				height: web.height,
				paths
			};
		}
		const path = assetPath(boardId, assetId, 'file');
		await storeFile(path, file.bytes, file.contentType, file.name);
		uploaded.push(path);
		const paths: Record<string, string> = { file: path };
		let size = file.bytes.byteLength;
		if (file.contentType === 'application/pdf') {
			try {
				const page = await core.pdf.renderPage(file.bytes, { page: 1, maxEdge: 640 });
				const processed = await core.images.process(page.png, { variants: PDF_THUMB });
				const thumb = processed.variants[0];
				if (thumb) {
					const thumbPath = assetPath(boardId, assetId, 'thumb', thumb.extension);
					await storeFile(thumbPath, thumb.bytes, thumb.contentType, `${assetId}-thumb.webp`);
					uploaded.push(thumbPath);
					paths.thumb = thumbPath;
					size += thumb.bytes.byteLength;
				}
			} catch (e) {
				// Vorschau ist kein Muss (kaputtes/verschlüsseltes PDF)
				logBestEffort('whiteboard.pdf-thumb', e, { target: boardId });
			}
		}
		return {
			id: assetId,
			kind: 'file',
			name: file.name,
			contentType: file.contentType,
			sizeBytes: size,
			width: null,
			height: null,
			paths
		};
	} catch (e) {
		await removeFiles(uploaded);
		throw e;
	}
}

/**
 * Eintrag anlegen (in der Transaktion, prüft den Speicherplatz unter `lockBoard`). `limitBytes` = `boardLimitBytes()`,
 * VOR der Transaktion ermittelt (Core-Einstellung, PGlite).
 */
export async function insertAsset(
	tx: Tx,
	ctx: RequestContext,
	boardId: string,
	asset: StoredAsset,
	limitBytes: number
): Promise<void> {
	await lockBoard(tx, boardId);
	await assertSpace(tx, boardId, asset.sizeBytes, limitBytes);
	await tx.execute(
		sql`INSERT INTO assets (id, board_id, kind, name, content_type, size_bytes, width, height, paths, created_by)
			VALUES (${asset.id}, ${boardId}, ${asset.kind}, ${asset.name}, ${asset.contentType}, ${asset.sizeBytes},
				${asset.width}, ${asset.height}, ${JSON.stringify(asset.paths)}::jsonb, ${ctx.userId})`
	);
}

/** Upload eines Benutzers: Vorprüfung, Speicher, Eintrag */
export async function uploadAsset(
	ctx: RequestContext,
	boardId: string,
	file: { bytes: Uint8Array; contentType: string; name: string }
): Promise<Asset> {
	const limit = await boardLimitBytes();
	await mdb().transaction(async (tx) => {
		await requireBoardAccess(tx, ctx, boardId, 'edit');
		await assertSpace(tx, boardId, file.bytes.byteLength, limit);
	});
	const stored = await processAndStore(boardId, file);
	try {
		await mdb().transaction(async (tx) => {
			await requireBoardAccess(tx, ctx, boardId, 'edit');
			await insertAsset(tx, ctx, boardId, stored, limit);
		});
	} catch (e) {
		await removeFiles(Object.values(stored.paths));
		throw e;
	}
	return assetOf({
		id: stored.id,
		kind: stored.kind,
		name: stored.name,
		content_type: stored.contentType,
		size_bytes: stored.sizeBytes,
		width: stored.width,
		height: stored.height,
		paths: stored.paths
	});
}
