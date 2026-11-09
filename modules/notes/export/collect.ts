/**
 * Export: Notiz (optional mit allen Unterseiten) einsammeln – Titel, aktueller Inhalt (ProseMirror-JSON),
 * Bilder (Variante `web`) und aufgelöste Einbettungen. Reihenfolge = Seitenbaum (Tiefensuche nach `position`).
 *
 * Zugriff: Lesen an der Startseite (Unterseiten erben ihn). Seiten im Papierkorb entfallen samt ihrem Teilbaum.
 * Bilder nur, wenn das Asset zu einer der exportierten Seiten gehört (`note_assets.note_id`), sonst fehlt das Bild.
 * Core-Dienste (Storage, Embeds) und `snapshotJson` laufen NACH der Transaktion.
 */
import { sql } from 'drizzle-orm';
import { core, errors, inList, num, rowsOf, type RequestContext } from '$lib/sdk/server';
import type { EmbedInfo, EmbedRef } from '$lib/sdk/types/embeds';
import { requireNoteAccess, subtreeIds } from '../access';
import { filesCtx, mdb } from '../db';
import { snapshotJson } from '../doc.service';
import { assetIdsOf, embedsOf } from '../doc/text';
import { MODULE_ID } from '../schemas';
import { embedKey, type ResolvedEmbed } from './embeds';

export type { ResolvedEmbed } from './embeds';

/** Höchstens so viele Seiten je Export */
export const MAX_EXPORT_PAGES = 300;
/** Bilder zusammen (Bytes); darüber entfallen weitere Bilder */
export const MAX_EXPORT_IMAGE_BYTES = 200 * 1024 * 1024;

export interface ExportImage {
	id: string;
	name: string;
	contentType: string;
	bytes: Uint8Array;
	width: number | null;
	height: number | null;
}

export interface ExportPage {
	id: string;
	parentId: string | null;
	/** Tiefe ab der Startseite (Startseite = 0) */
	depth: number;
	title: string;
	json: Record<string, unknown>;
}

export interface ExportBundle {
	root: ExportPage;
	pages: ExportPage[];
	images: Map<string, ExportImage>;
	embeds: Map<string, ResolvedEmbed>;
	origin: string;
}

interface Row {
	id: string;
	parentId: string | null;
	title: string;
	position: number;
	deleted: boolean;
}

/** Seiten in Baumreihenfolge ab `rootId` (gelöschte Teilbäume fallen weg) */
export function treeOrder(rootId: string, rows: readonly Row[]): { row: Row; depth: number }[] {
	const children = new Map<string, Row[]>();
	const byId = new Map(rows.map((r) => [r.id, r]));
	for (const r of rows) {
		if (!r.parentId || r.id === rootId) continue;
		const list = children.get(r.parentId) ?? [];
		list.push(r);
		children.set(r.parentId, list);
	}
	for (const list of children.values()) {
		list.sort((a, b) => a.position - b.position || a.title.localeCompare(b.title, 'de'));
	}
	const out: { row: Row; depth: number }[] = [];
	const root = byId.get(rootId);
	if (!root) return out;
	const stack: { row: Row; depth: number }[] = [{ row: root, depth: 0 }];
	while (stack.length) {
		const item = stack.pop()!;
		if (item.row.deleted && item.depth > 0) continue;
		out.push(item);
		const list = children.get(item.row.id) ?? [];
		for (let i = list.length - 1; i >= 0; i--) stack.push({ row: list[i]!, depth: item.depth + 1 });
	}
	return out;
}

/** Einbettungen für die Person auflösen (Fehler → alle „nicht verfügbar“) */
async function resolveEmbeds(
	ctx: RequestContext,
	refs: EmbedRef[],
	origin: string
): Promise<Map<string, ResolvedEmbed>> {
	const map = new Map<string, ResolvedEmbed>();
	const unique = [...new Map(refs.map((r) => [embedKey(r), r])).values()].slice(0, 200);
	if (!unique.length) return map;
	let infos: EmbedInfo[] = [];
	try {
		infos = await core.embeds.describe(ctx, unique);
	} catch (e) {
		console.warn('[notes] Einbettungen für den Export nicht auflösbar', e);
	}
	for (const info of infos) {
		map.set(embedKey(info), {
			title: info.available ? info.title : 'Nicht verfügbar',
			kindLabel: info.kindLabel,
			href: info.available && info.openHref ? `${origin}${info.openHref}` : null
		});
	}
	return map;
}

export async function collectExport(
	ctx: RequestContext,
	noteId: string,
	opts: { subpages: boolean }
): Promise<ExportBundle> {
	const data = await mdb().transaction(async (tx) => {
		await requireNoteAccess(tx, ctx, noteId, 'read');
		const ids = opts.subpages ? await subtreeIds(tx, noteId) : [noteId];
		const rows = await rowsOf(
			tx,
			sql`SELECT id, parent_id, title, position, deleted_at FROM notes WHERE id IN (${inList(ids)})`
		);
		const order = treeOrder(
			noteId,
			rows.map((r) => ({
				id: String(r.id),
				parentId: r.parent_id == null ? null : String(r.parent_id),
				title: String(r.title ?? ''),
				position: num(r.position),
				deleted: r.deleted_at != null
			}))
		);
		if (order.length > MAX_EXPORT_PAGES) {
			throw errors.tooLarge(`Höchstens ${MAX_EXPORT_PAGES} Seiten je Export`);
		}
		const pageIds = order.map((o) => o.row.id);
		const assets = await rowsOf(
			tx,
			sql`SELECT id, note_id, name, content_type, width, height, paths FROM note_assets
				WHERE kind = 'image' AND note_id IN (${inList(pageIds)})`
		);
		return { order, assets };
	});

	const pages: ExportPage[] = [];
	for (const { row, depth } of data.order) {
		pages.push({
			id: row.id,
			parentId: depth === 0 ? null : row.parentId,
			depth,
			title: row.title,
			json: await snapshotJson(row.id)
		});
	}

	// Bilder: nur verwendete und nur aus den exportierten Seiten
	const used = new Set(pages.flatMap((p) => assetIdsOf(p.json)));
	const images = new Map<string, ExportImage>();
	let total = 0;
	for (const a of data.assets) {
		const id = String(a.id);
		if (!used.has(id)) continue;
		const paths = (typeof a.paths === 'string' ? JSON.parse(a.paths) : a.paths) as Record<
			string,
			unknown
		> | null;
		const path = typeof paths?.web === 'string' ? paths.web : null;
		if (!path) continue;
		try {
			const { buffer, file } = await core.storage.download(filesCtx(), { module: MODULE_ID, path });
			if (total + buffer.byteLength > MAX_EXPORT_IMAGE_BYTES) continue;
			total += buffer.byteLength;
			images.set(id, {
				id,
				name: String(a.name ?? ''),
				contentType: file.contentType || String(a.content_type ?? ''),
				bytes: new Uint8Array(buffer),
				width: a.width == null ? null : num(a.width),
				height: a.height == null ? null : num(a.height)
			});
		} catch (e) {
			console.warn('[notes] Bild für den Export nicht lesbar', e);
		}
	}

	const origin = core.app.origin();
	const embeds = await resolveEmbeds(
		ctx,
		pages.flatMap((p) => embedsOf(p.json)),
		origin
	);
	return { root: pages[0]!, pages, images, embeds, origin };
}
