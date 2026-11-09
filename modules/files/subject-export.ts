/**
 * Datenauskunft (Art. 15/20 DSGVO, Core `/admin/privacy`): Daten einer Person im Modul Dateien –
 * Metadaten der eigenen Ablage (Ordner/Dateien inkl. Papierkorb, **keine Inhalte**, keine
 * Speicherpfade), von der Person in fremde Ordner hochgeladene Dateien, Freigaben an das Konto bzw.
 * an Mitglieder der Person und die von ihr angelegten öffentlichen Links (ohne Token/Passwort-Hash/
 * Chiffrat). Eigene Modul-Transaktion, keine Core-Services darin.
 */
import { sql } from 'drizzle-orm';
import {
	type DataSubject,
	inList,
	type ModuleSubjectExport,
	rowsOf,
	toIso,
	toIsoOrNull
} from '$lib/sdk/server';
import { mdb } from './db';

const text = (v: unknown): string | null => (v == null || v === '' ? null : String(v));
const sizeOf = (v: unknown): number | null => (v == null ? null : Number(v));
async function run({ userId, memberIds }: DataSubject): Promise<Record<string, unknown> | null> {
	if (!userId && !memberIds.length) return null;
	const data = await mdb().transaction(async (tx) => {
		const owned = userId
			? await rowsOf(
					tx,
					sql`SELECT id, parent_id, kind, name, content_type, size_bytes, created_at, updated_at,
							deleted_at FROM nodes WHERE owner_id = ${userId} ORDER BY created_at, id`
				)
			: [];
		const foreignUploads = userId
			? await rowsOf(
					tx,
					sql`SELECT id, parent_id, kind, name, content_type, size_bytes, created_at
						FROM nodes WHERE created_by = ${userId} AND owner_id <> ${userId}
						ORDER BY created_at, id`
				)
			: [];
		const conds = [];
		if (userId) conds.push(sql`(s.principal_type = 'user' AND s.principal_id = ${userId})`);
		if (memberIds.length) {
			conds.push(sql`(s.principal_type = 'member' AND s.principal_id IN (${inList(memberIds)}))`);
		}
		const shares = await rowsOf(
			tx,
			sql`SELECT s.node_id, n.name, n.kind, s.principal_type, s.principal_id, s.level, s.created_at
				FROM node_shares s JOIN nodes n ON n.id = s.node_id
				WHERE ${sql.join(conds, sql` OR `)}
				ORDER BY s.created_at, s.node_id`
		);
		const links = userId
			? await rowsOf(
					tx,
					sql`SELECT l.id, l.node_id, n.name, l.mode, to_char(l.expires_on, 'YYYY-MM-DD') AS expires_on,
							l.password_hash IS NOT NULL AS has_password, l.created_at, l.revoked_at,
							l.last_access_at, l.access_count
						FROM share_links l JOIN nodes n ON n.id = l.node_id
						WHERE l.created_by = ${userId} ORDER BY l.created_at, l.id`
				)
			: [];
		const [quota] = userId
			? await rowsOf(
					tx,
					sql`SELECT quota_mb, updated_at FROM user_quotas WHERE user_id = ${userId}`
				)
			: [];
		return { owned, foreignUploads, shares, links, quota };
	});
	if (
		!data.owned.length &&
		!data.foreignUploads.length &&
		!data.shares.length &&
		!data.links.length &&
		!data.quota
	) {
		return null;
	}
	return {
		ownNodes: data.owned.map((r) => ({
			id: String(r.id),
			parentId: text(r.parent_id),
			kind: String(r.kind),
			name: String(r.name),
			contentType: text(r.content_type),
			sizeBytes: sizeOf(r.size_bytes),
			createdAt: toIso(r.created_at),
			updatedAt: toIso(r.updated_at),
			inTrashSince: toIsoOrNull(r.deleted_at)
		})),
		uploadsToOtherFolders: data.foreignUploads.map((r) => ({
			id: String(r.id),
			parentId: text(r.parent_id),
			kind: String(r.kind),
			name: String(r.name),
			contentType: text(r.content_type),
			sizeBytes: sizeOf(r.size_bytes),
			createdAt: toIso(r.created_at)
		})),
		sharesToPerson: data.shares.map((r) => ({
			nodeId: String(r.node_id),
			name: String(r.name),
			kind: String(r.kind),
			principal: `${String(r.principal_type)}:${String(r.principal_id)}`,
			level: String(r.level),
			createdAt: toIso(r.created_at)
		})),
		publicLinks: data.links.map((r) => ({
			id: String(r.id),
			nodeId: String(r.node_id),
			name: String(r.name),
			mode: String(r.mode),
			expiresOn: text(r.expires_on),
			hasPassword: r.has_password === true,
			createdAt: toIso(r.created_at),
			revokedAt: toIsoOrNull(r.revoked_at),
			lastAccessAt: toIsoOrNull(r.last_access_at),
			accessCount: Number(r.access_count ?? 0)
		})),
		// Eigenes Speicherkontingent (fehlt = Standard der Einstellungen)
		storageQuota: data.quota
			? {
					quotaMb: data.quota.quota_mb == null ? null : Number(data.quota.quota_mb),
					unlimited: data.quota.quota_mb == null,
					updatedAt: toIso(data.quota.updated_at)
				}
			: null
	};
}

export const subjectExport: ModuleSubjectExport = { run };
