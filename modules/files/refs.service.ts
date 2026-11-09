/** Dienst `FileRefsService` (siehe `contract.ts`): Verweise auf Dateien/Ordner für andere Module */
import { core, type RequestContext } from '$lib/sdk/server';
import { resolveAccess } from './access';
import type { FileRefInfo, FileRefsService } from './contract';
import { mdb, type NodeRow } from './db';
import { displayPath } from './names';
import { searchNodes } from './nodes.service';
import { keysFor } from './shares.service';
import { BASE_PATH, PERMISSIONS, ROOT_LABEL } from './schemas';

const API = '/api/v1/modules/files';
const MAX_IDS = 200;

const allowed = (ctx: RequestContext) =>
	ctx.actor.type === 'system' || core.permissions.has(ctx, PERMISSIONS.view);

function toRef(
	n: Pick<NodeRow, 'id' | 'kind' | 'name' | 'contentType' | 'sizeBytes' | 'icon' | 'color'> & {
		hasThumb: boolean;
		/** sichtbarer Elternordner (sonst Wurzel) */
		folderId: string | null;
	}
): FileRefInfo {
	const id = encodeURIComponent(n.id);
	const isFile = n.kind === 'file';
	return {
		id: n.id,
		kind: n.kind,
		name: n.name,
		contentType: isFile ? n.contentType : null,
		sizeBytes: isFile ? n.sizeBytes : null,
		hasThumb: isFile && n.hasThumb,
		icon: isFile ? null : n.icon,
		color: isFile ? null : n.color,
		href: isFile
			? n.folderId
				? `${BASE_PATH}?folder=${encodeURIComponent(n.folderId)}`
				: BASE_PATH
			: `${BASE_PATH}?folder=${id}`,
		contentUrl: isFile ? `${API}/nodes/${id}/content` : null
	};
}

export const fileRefsService: FileRefsService = {
	async searchFileRefs(ctx, opts) {
		const q = opts.search.trim();
		if (q.length < 2 || !allowed(ctx)) return [];
		const limit = Math.min(Math.max(opts.limit ?? 20, 1), 50);
		const { items } = await searchNodes(ctx, { q, limit });
		// Pfad nur aus der Wurzel → Elternordner nicht sichtbar (wie `search.ts`)
		const rootOnly = displayPath([ROOT_LABEL]);
		return items.map((n) =>
			toRef({ ...n, folderId: n.parentId !== null && n.path !== rootOnly ? n.parentId : null })
		);
	},
	async describeFileRefs(ctx, ids) {
		const list = [...new Set(ids)].slice(0, MAX_IDS);
		if (!list.length || !allowed(ctx)) return [];
		const keys = await keysFor(ctx);
		const found = await mdb().transaction(async (tx) => {
			const out: FileRefInfo[] = [];
			for (const id of list) {
				const access = await resolveAccess(tx, ctx, id, keys);
				if (!access) continue;
				const n = access.node;
				// Elternordner nur verlinken, wenn er selbst sichtbar ist
				const parent = n.parentId ? await resolveAccess(tx, ctx, n.parentId, keys) : null;
				out.push(toRef({ ...n, hasThumb: !!n.thumbPath, folderId: parent ? n.parentId : null }));
			}
			return out;
		});
		return found;
	}
};
