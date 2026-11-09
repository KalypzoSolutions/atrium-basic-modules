/**
 * Dienst für andere Module (`provides`, Vertrag `contract.ts`): Notizen suchen bzw. auflösen – je Aufrufer*in
 * nach denselben Regeln wie die Listen (sichtbar, nie Papierkorb). Prüft `notes.note.view` selbst und lädt den
 * Zugriffskontext selbst; nur außerhalb offener Transaktionen aufrufen.
 */
import { sql } from 'drizzle-orm';
import { core, inList, type RequestContext, rowsOf, type Row, toIso } from '$lib/sdk/server';
import { loadNoteContext, notInTrashSql, visibleNotesSql } from './access';
import { mdb } from './db';
import { excerptOf } from './doc/text';
import { noteLink } from './notify';
import { likePattern, pathText, visibleAncestors } from './tree.service';
import { PERM } from './schemas';
import type { NoteRefInfo, NoteRefsService } from './contract';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const allowed = (ctx: RequestContext) =>
	ctx.actor.type === 'system' || core.permissions.has(ctx, PERM.view);

function infoOf(r: Row, path: string): NoteRefInfo {
	const id = String(r.id);
	return {
		id,
		title: String(r.title ?? ''),
		icon: r.icon == null ? null : String(r.icon),
		color: r.color == null ? null : String(r.color),
		excerpt: excerptOf(String(r.content_text ?? '')),
		path,
		updatedAt: toIso(r.updated_at),
		href: noteLink(id)
	};
}

async function load(ctx: RequestContext, where: ReturnType<typeof sql>, limit: number) {
	await loadNoteContext(ctx);
	return mdb().transaction(async (tx) => {
		const rows = await rowsOf(
			tx,
			sql`SELECT n.id, n.title, n.icon, n.color, n.content_text, n.updated_at FROM notes n
				WHERE ${visibleNotesSql(ctx, 'n')} AND ${notInTrashSql('n')} AND ${where}
				ORDER BY n.updated_at DESC, n.id LIMIT ${limit}`
		);
		const paths = await visibleAncestors(
			tx,
			ctx,
			rows.map((r) => String(r.id))
		);
		return rows.map((r) => infoOf(r, pathText(paths.get(String(r.id)) ?? [])));
	});
}

export const noteRefsService: NoteRefsService = {
	async searchNoteRefs(ctx, opts = {}) {
		if (!allowed(ctx)) return [];
		const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 20), 1), 50);
		const q = opts.search?.trim() ?? '';
		const where = q
			? sql`(n.title ILIKE ${likePattern(q)}
				OR to_tsvector('german', n.title || ' ' || n.content_text) @@ plainto_tsquery('german', ${q}))`
			: sql`TRUE`;
		return load(ctx, where, limit);
	},
	async describeNoteRefs(ctx, ids) {
		if (!allowed(ctx)) return [];
		const list = [...new Set(ids)].filter((id) => UUID_RE.test(id)).slice(0, 200);
		if (!list.length) return [];
		const found = await load(ctx, sql`n.id IN (${inList(list)})`, list.length);
		const byId = new Map(found.map((f) => [f.id, f]));
		return list.map((id) => byId.get(id)).filter((v): v is NoteRefInfo => !!v);
	}
};
