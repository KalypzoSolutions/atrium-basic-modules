/**
 * Speicherkontingent je Person (Verwaltung, Abschnitt im Dialog „Benutzer bearbeiten“): lesen und setzen.
 * Ohne Zeile in `user_quotas` gilt der Standard `files.quota.mb`; `quota_mb NULL` = unbegrenzt.
 * Kein Existenz-Check der Benutzer-ID (deaktivierte Konten sollen bearbeitbar bleiben, `core.users.byIds` kennt
 * nur aktive); unbekannte IDs liefern Belegung 0 und schaden nicht. Beim Löschen des Kontos räumt `onUserDeleted` auf.
 */
import { sql } from 'drizzle-orm';
import {
	core,
	defineEndpoint,
	rowsOf,
	type AnyApiEndpoint,
	type RequestContext
} from '$lib/sdk/server';
import { filesSettings, mdb } from './db';
import { quotaLimitFor, quotaUsed } from './storage';
import { PERMISSIONS, userIdParams, userQuotaInput, type UserQuota } from './schemas';

const tags = ['Modul: files'];

async function loadUserQuota(userId: string): Promise<UserQuota> {
	const { quotaBytes } = await filesSettings();
	return mdb().transaction(async (tx) => {
		const [row] = await rowsOf(tx, sql`SELECT quota_mb FROM user_quotas WHERE user_id = ${userId}`);
		const customMb =
			row && row.quota_mb !== null && row.quota_mb !== undefined ? Number(row.quota_mb) : null;
		return {
			userId,
			mode: !row ? 'default' : customMb === null ? 'unlimited' : 'custom',
			customMb,
			defaultBytes: quotaBytes,
			limitBytes: await quotaLimitFor(tx, userId, quotaBytes),
			usedBytes: await quotaUsed(tx, userId)
		};
	});
}

async function saveUserQuota(
	ctx: RequestContext,
	userId: string,
	mode: UserQuota['mode'],
	mb: number | null
): Promise<UserQuota> {
	await mdb().transaction(async (tx) => {
		if (mode === 'default') {
			await tx.execute(sql`DELETE FROM user_quotas WHERE user_id = ${userId}`);
			return;
		}
		const value = mode === 'unlimited' ? null : mb;
		await tx.execute(
			sql`INSERT INTO user_quotas (user_id, quota_mb, updated_by, updated_at)
				VALUES (${userId}, ${value}, ${ctx.userId}, now())
				ON CONFLICT (user_id) DO UPDATE
				SET quota_mb = EXCLUDED.quota_mb, updated_by = EXCLUDED.updated_by, updated_at = now()`
		);
	});
	await core.audit.logFromContext(ctx, 'files.quota.updated', {
		target: userId,
		metadata: { mode, mb: mode === 'custom' ? mb : null }
	});
	return loadUserQuota(userId);
}

export const quotaEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/quotas/:userId',
		summary: 'Speicherkontingent und Belegung einer Person',
		tags,
		permission: PERMISSIONS.quotaManage,
		params: userIdParams,
		handler: async ({ params }): Promise<UserQuota> => loadUserQuota(params.userId)
	}),
	defineEndpoint({
		method: 'PUT',
		path: '/quotas/:userId',
		summary: 'Speicherkontingent einer Person setzen (Standard, eigenes Limit oder unbegrenzt)',
		tags,
		permission: PERMISSIONS.quotaManage,
		params: userIdParams,
		body: userQuotaInput,
		handler: async ({ ctx, params, body }): Promise<UserQuota> =>
			saveUserQuota(ctx, params.userId, body.mode, body.mb ?? null)
	})
];
