/**
 * Bilder in Notizen: über `core.images.process` neu kodiert (Metadaten/GPS entfernt, Varianten `thumb`/`web`).
 * Ablauf: Vorprüfung (Transaktion 1) → Verarbeitung + Speicher → Eintrag mit erneuter Prüfung (Transaktion 2);
 * schlägt Transaktion 2 fehl, werden die Dateien wieder entfernt.
 */
import { sql } from 'drizzle-orm';
import { core, errors, inList, num, rowsOf, type RequestContext, type Row } from '$lib/sdk/server';
import { requireNoteAccess } from './access';
import { mdb } from './db';
import { bytesOf, flushAll, jsonFromState, usedAssetIds } from './doc.service';
import { assetIdsOf } from './doc/text';
import { assetPath, IMAGE_TYPES, IMAGE_VARIANTS, removeFiles, storeFile } from './storage';
import type { NoteAsset } from './schemas';

export function assetOf(r: Row): NoteAsset {
	return {
		id: String(r.id),
		kind: r.kind === 'file' ? 'file' : 'image',
		name: String(r.name ?? ''),
		contentType: String(r.content_type ?? ''),
		sizeBytes: num(r.size_bytes),
		width: r.width == null ? null : num(r.width),
		height: r.height == null ? null : num(r.height)
	};
}

export const assetPaths = (v: unknown): Record<string, string> =>
	((typeof v === 'string' ? JSON.parse(v) : v) ?? {}) as Record<string, string>;

/** Bild hochladen (Bearbeiten-Zugriff) → Eintrag */
export async function uploadImage(
	ctx: RequestContext,
	noteId: string,
	file: { bytes: Uint8Array; contentType: string; name: string }
): Promise<NoteAsset> {
	if (!IMAGE_TYPES.includes(file.contentType)) {
		throw errors.validation([
			{ path: ['file'], message: 'Nur Bilder (JPEG, PNG, WebP, AVIF, GIF) erlaubt' }
		]);
	}
	await mdb().transaction((tx) => requireNoteAccess(tx, ctx, noteId, 'edit'));
	const assetId = crypto.randomUUID();
	const processed = await core.images.process(file.bytes, { variants: IMAGE_VARIANTS });
	const paths: Record<string, string> = {};
	let size = 0;
	let web: (typeof processed.variants)[number] | undefined;
	try {
		for (const v of processed.variants) {
			const path = assetPath(noteId, assetId, v.name as 'thumb' | 'web', v.extension);
			await storeFile(path, v.bytes, v.contentType, `${assetId}-${v.name}.${v.extension}`);
			paths[v.name] = path;
			size += v.bytes.byteLength;
			if (v.name === 'web') web = v;
		}
		if (!web) throw errors.unavailable('Bildverarbeitung unvollständig');
		const asset: NoteAsset = {
			id: assetId,
			kind: 'image',
			name: file.name,
			contentType: web.contentType,
			sizeBytes: size,
			width: web.width,
			height: web.height
		};
		await mdb().transaction(async (tx) => {
			await requireNoteAccess(tx, ctx, noteId, 'edit');
			await tx.execute(
				sql`INSERT INTO note_assets (id, note_id, kind, name, content_type, size_bytes, width, height,
						paths, created_by)
					VALUES (${asset.id}, ${noteId}, 'image', ${asset.name}, ${asset.contentType}, ${asset.sizeBytes},
						${asset.width}, ${asset.height}, ${JSON.stringify(paths)}::jsonb, ${ctx.userId})`
			);
		});
		return asset;
	} catch (e) {
		await removeFiles(Object.values(paths));
		throw e;
	}
}

/** Ungenutzte Bilder erst nach dieser Frist löschen (Rückgängig im Editor, kurz entfernt und wieder eingefügt) */
export const UNUSED_ASSET_DAYS = 7;
const UNUSED_BATCH = 200;

/**
 * Job: Bilder löschen, die seit `UNUSED_ASSET_DAYS` Tagen in keiner Notiz (aktueller Inhalt, auch im Papierkorb)
 * und keiner Version ihrer Notiz mehr vorkommen → Anzahl gelöschter Bilder.
 */
export async function purgeUnusedAssets(): Promise<number> {
	// abgeleitetes `content_json` aktuell halten (offene Dokumente)
	await flushAll();
	const candidates = await mdb().transaction((tx) =>
		rowsOf(
			tx,
			sql`SELECT a.id, a.note_id FROM note_assets a
				WHERE a.created_at < now() - make_interval(days => ${UNUSED_ASSET_DAYS})
					AND NOT EXISTS (
						SELECT 1 FROM notes n WHERE strpos(COALESCE(n.content_json::text, ''), a.id) > 0
					)
				ORDER BY a.created_at, a.id LIMIT ${UNUSED_BATCH}`
		)
	);
	if (!candidates.length) return 0;
	const byNote = new Map<string, string[]>();
	for (const r of candidates) {
		const list = byNote.get(String(r.note_id)) ?? [];
		list.push(String(r.id));
		byNote.set(String(r.note_id), list);
	}
	const unused: string[] = [];
	for (const [noteId, ids] of byNote) {
		// gespeicherter Stand (falls `content_json` noch nicht abgeleitet) und alle Versionen der Notiz
		const used = await usedAssetIds(noteId).catch(() => new Set(ids));
		const versions = await mdb().transaction((tx) =>
			rowsOf(tx, sql`SELECT ydoc FROM note_versions WHERE note_id = ${noteId}`)
		);
		for (const v of versions) {
			const state = bytesOf(v.ydoc);
			if (!state) continue;
			try {
				for (const id of assetIdsOf(jsonFromState(state))) used.add(id);
			} catch {
				// kaputte Version: Bilder dieser Notiz sicherheitshalber behalten
				for (const id of ids) used.add(id);
			}
		}
		for (const id of ids) if (!used.has(id)) unused.push(id);
	}
	if (!unused.length) return 0;
	const removed = await mdb().transaction((tx) =>
		rowsOf(
			tx,
			sql`DELETE FROM note_assets a WHERE a.id IN (${inList(unused)})
					AND NOT EXISTS (
						SELECT 1 FROM notes n WHERE strpos(COALESCE(n.content_json::text, ''), a.id) > 0
					)
				RETURNING a.paths`
		)
	);
	await removeFiles(removed.flatMap((r) => Object.values(assetPaths(r.paths))));
	return removed.length;
}
