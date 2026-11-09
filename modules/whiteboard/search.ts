/**
 * Globale Suche (Befehlspalette): Whiteboards nach Name/Beschreibung und Rahmen nach Titel, sichtbar wie
 * `GET /boards` (`visibleBoardsFilter`). Zugriffskontext VOR der Transaktion.
 */
import { sql } from 'drizzle-orm';
import { type ModuleSearchProvider, rowsOf, type SearchHit } from '$lib/sdk/server';
import { loadBoardContext, visibleBoardsFilter } from './access';
import { mdb } from './boards.service';
import { boardLink } from './notify';
import { PERM } from './schemas';

const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export const whiteboardSearch: ModuleSearchProvider = {
	permission: PERM.view,
	async run(ctx, query, limit) {
		await loadBoardContext(ctx);
		const p = like(query);
		const rows = await mdb().transaction((tx) =>
			rowsOf(
				tx,
				sql`(SELECT 'board' AS kind, b.id, b.id AS board_id, b.name AS title, NULL AS board_name, b.updated_at
						FROM boards b WHERE ${visibleBoardsFilter(ctx)} AND (b.name ILIKE ${p} OR b.description ILIKE ${p}))
					UNION ALL
					(SELECT 'frame' AS kind, e.id, b.id AS board_id, e.data->>'title' AS title, b.name AS board_name,
							e.updated_at
						FROM elements e JOIN boards b ON b.id = e.board_id
						WHERE ${visibleBoardsFilter(ctx)} AND e.type = 'frame' AND NOT e.deleted
							AND e.data->>'title' ILIKE ${p})
					ORDER BY kind, updated_at DESC
					LIMIT ${limit}`
			)
		);
		return rows.map((r): SearchHit =>
			r.kind === 'board'
				? {
						id: String(r.id),
						title: String(r.title),
						href: boardLink(String(r.id)),
						icon: 'presentation',
						type: 'Whiteboard'
					}
				: {
						id: String(r.id),
						title: String(r.title),
						subtitle: String(r.board_name),
						href: `${boardLink(String(r.board_id))}?focus=${encodeURIComponent(String(r.id))}`,
						icon: 'presentation',
						type: 'Rahmen'
					}
		);
	}
};
