/**
 * Globale Suche (Befehlspalette): Boards nach Name und Aufgaben nach Titel, sichtbar wie `GET /boards`
 * (`visibleBoardsFilter`). Zugriffskontext VOR der Transaktion.
 */
import { sql } from 'drizzle-orm';
import { type ModuleSearchProvider, rowsOf, type SearchHit } from '$lib/sdk/server';
import { loadTaskContext, visibleBoardsFilter } from './access';
import { mdb } from './boards.service';
import { PERM } from './schemas';
import { boardLink } from './notify';

const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export const tasksSearch: ModuleSearchProvider = {
	permission: PERM.view,
	async run(ctx, query, limit) {
		await loadTaskContext(ctx);
		const p = like(query);
		const rows = await mdb().transaction((tx) =>
			rowsOf(
				tx,
				sql`(SELECT 'board' AS kind, b.id, b.id AS board_id, b.name AS title, NULL AS board_name, b.updated_at
						FROM boards b WHERE ${visibleBoardsFilter(ctx)} AND b.name ILIKE ${p})
					UNION ALL
					(SELECT 'task' AS kind, t.id, b.id AS board_id, t.title, b.name AS board_name, t.updated_at
						FROM tasks t JOIN boards b ON b.id = t.board_id
						WHERE ${visibleBoardsFilter(ctx)} AND t.title ILIKE ${p})
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
						icon: 'kanban',
						type: 'Board'
					}
				: {
						id: String(r.id),
						title: String(r.title),
						subtitle: String(r.board_name),
						href: boardLink(String(r.board_id), String(r.id)),
						icon: 'kanban',
						type: 'Aufgabe'
					}
		);
	}
};
