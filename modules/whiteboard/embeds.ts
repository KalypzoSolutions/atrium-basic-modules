/**
 * Whiteboards als einbettbarer Inhalt (z. B. in Notizen, `ModuleDefinition.embeds`): Suche und Auflösung je
 * Betrachter*in, sichtbar wie `GET /boards`. Zugriffskontext VOR der Transaktion; Pfad `<boardId>` →
 * `/embed/whiteboard/<id>` (Browser: `ui.ts` `embedRoutes`) bzw. `/modules/whiteboard/<id>`.
 */
import { sql } from 'drizzle-orm';
import { inList, rowsOf, type ModuleEmbedProvider } from '$lib/sdk/server';
import { loadBoardContext, resolveBoardAccess, visibleBoardsFilter } from './access';
import { mdb } from './boards.service';
import { PERM } from './schemas';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export const boardEmbed: ModuleEmbedProvider = {
	kind: 'board',
	label: 'Whiteboard',
	icon: 'presentation',
	permission: PERM.view,
	async search(ctx, query, limit) {
		await loadBoardContext(ctx);
		const rows = await mdb().transaction((tx) =>
			rowsOf(
				tx,
				sql`SELECT b.id, b.name, b.element_count FROM boards b
					WHERE ${visibleBoardsFilter(ctx)} AND (b.name ILIKE ${like(query)} OR b.description ILIKE ${like(query)})
					ORDER BY b.updated_at DESC, b.id LIMIT ${limit}`
			)
		);
		return rows.map((r) => ({
			refId: String(r.id),
			title: String(r.name),
			subtitle: `${Number(r.element_count ?? 0)} Elemente`
		}));
	},
	async describe(ctx, ids) {
		const map = new Map<string, { title: string; canEdit: boolean; path: string }>();
		const wanted = [...new Set(ids)].filter((id) => UUID_RE.test(id)).slice(0, 200);
		if (!wanted.length) return map;
		await loadBoardContext(ctx);
		await mdb().transaction(async (tx) => {
			const rows = await rowsOf(
				tx,
				sql`SELECT b.id, b.name FROM boards b
					WHERE b.id IN (${inList(wanted)}) AND ${visibleBoardsFilter(ctx)}`
			);
			for (const r of rows) {
				const id = String(r.id);
				const access = await resolveBoardAccess(tx, ctx, id);
				if (!access) continue;
				map.set(id, { title: String(r.name), canEdit: access.level === 'edit', path: id });
			}
		});
		return map;
	}
};
