/**
 * Globale Suche (Befehlspalette): Notizen nach Titel und Volltext, sichtbar wie `GET /notes/search`.
 * Zugriffskontext VOR der Transaktion.
 */
import { sql } from 'drizzle-orm';
import { type ModuleSearchProvider, rowsOf, type SearchHit } from '$lib/sdk/server';
import { loadNoteContext, notInTrashSql, visibleNotesSql } from './access';
import { mdb } from './db';
import { noteLink } from './notify';
import { likePattern, pathText, visibleAncestors } from './tree.service';
import { PERM } from './schemas';

export const notesSearch: ModuleSearchProvider = {
	permission: PERM.view,
	async run(ctx, query, limit) {
		await loadNoteContext(ctx);
		const p = likePattern(query);
		const data = await mdb().transaction(async (tx) => {
			const rows = await rowsOf(
				tx,
				sql`SELECT n.id, n.title FROM notes n
					WHERE ${visibleNotesSql(ctx, 'n')} AND ${notInTrashSql('n')}
						AND (n.title ILIKE ${p}
							OR to_tsvector('german', n.title || ' ' || n.content_text) @@ plainto_tsquery('german', ${query}))
					ORDER BY (n.title ILIKE ${p}) DESC, n.updated_at DESC, n.id
					LIMIT ${limit}`
			);
			const paths = await visibleAncestors(
				tx,
				ctx,
				rows.map((r) => String(r.id))
			);
			return { rows, paths };
		});
		return data.rows.map((r): SearchHit => {
			const path = pathText(data.paths.get(String(r.id)) ?? []);
			return {
				id: String(r.id),
				title: String(r.title ?? '') || 'Ohne Titel',
				...(path ? { subtitle: path } : {}),
				href: noteLink(String(r.id)),
				icon: 'notebook-pen',
				type: 'Notiz'
			};
		});
	}
};
