/**
 * „Zuletzt geändert“ für das Dashboard: Dateien (keine Ordner), die der Aufrufer besitzt oder über eine
 * Freigabe (auch vererbt, auch `everyone:*`) sehen darf, ohne Papierkorb, neueste zuerst. Auch mit
 * `manage-all` nur eigene + freigegebene (keine fremden Ablagen auf dem Dashboard). Nur lesend, ohne Audit.
 */
import { sql } from 'drizzle-orm';
import { type ApiEndpoint, type RequestContext, rowsOf } from '$lib/sdk/server';
import { accessForMany, sharedOnChainSql } from './access';
import { mdb, nodeRowOf, NODE_COLUMNS } from './db';
import { keysFor } from './shares.service';
import { PERMISSIONS, recentQuery, type RecentFile, type RecentQuery } from './schemas';

const tags = ['Modul: files'];

export async function loadRecentFiles(ctx: RequestContext, limit: number): Promise<RecentFile[]> {
	if (!ctx.userId) return [];
	const uid = ctx.userId;
	const keys = await keysFor(ctx);
	const visible = keys.length
		? sql`(n.owner_id = ${uid} OR ${sharedOnChainSql(sql`n.id`, keys)})`
		: sql`n.owner_id = ${uid}`;

	return mdb().transaction(async (tx) => {
		const files = (
			await rowsOf(
				tx,
				sql`SELECT ${NODE_COLUMNS} FROM nodes n
					WHERE n.kind = 'file' AND n.deleted_at IS NULL AND ${visible}
					ORDER BY n.updated_at DESC, n.id
					LIMIT ${limit}`
			)
		).map(nodeRowOf);

		// Elternordner nur verlinken, wenn der Aufrufer ihn selbst öffnen darf
		const parentIds = [
			...new Set(files.map((f) => f.parentId).filter((p): p is string => p !== null))
		];
		const parents = parentIds.length
			? (
					await rowsOf(
						tx,
						sql`SELECT ${NODE_COLUMNS} FROM nodes n WHERE n.id IN (${sql.join(
							parentIds.map((id) => sql`${id}`),
							sql`, `
						)})`
					)
				).map(nodeRowOf)
			: [];
		const parentAccess = await accessForMany(tx, ctx, parents, keys);

		return files.map((f) => ({
			id: f.id,
			name: f.name,
			mime: f.contentType,
			size: f.sizeBytes ?? 0,
			updatedAt: f.updatedAt,
			parentId: f.parentId && parentAccess.has(f.parentId) ? f.parentId : null,
			own: f.ownerId === uid,
			hasThumb: f.thumbPath !== null
		}));
	});
}

export const recentEndpoints = [
	{
		method: 'GET',
		path: '/recent',
		summary: 'Zuletzt geänderte eigene und freigegebene Dateien (ohne Ordner und Papierkorb)',
		tags,
		permission: PERMISSIONS.view,
		query: recentQuery,
		handler: ({ ctx, query }) => loadRecentFiles(ctx, (query as RecentQuery).limit)
	}
] as ApiEndpoint[];
