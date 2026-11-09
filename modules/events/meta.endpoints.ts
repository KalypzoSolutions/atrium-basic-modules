import { sql } from 'drizzle-orm';
import {
	type ApiEndpoint,
	defineEndpoint,
	moduleDb,
	PRINCIPAL_SEARCH_RATE_LIMIT,
	principalMatchSql,
	requireShareCapability,
	searchPrincipals
} from '$lib/sdk/server';
import { loadGroupMap, stammName } from './groups';
import { MODULE_ID, principalSearchQuery, tagsQuery } from './schemas';

const TAGS = ['Modul: events'];
const MAX_TAG_SUGGESTIONS = 50;

/** LIKE-Sonderzeichen maskieren (Escape-Zeichen `\`) */
function escapeLike(value: string): string {
	return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export const metaEndpoints = [
	defineEndpoint({
		method: 'GET',
		path: '/groups',
		summary: 'Zuordenbare Gruppen (ganzer Stamm zuerst, danach Gruppen aus Mitglieder)',
		tags: TAGS,
		permission: 'events.event.view',
		handler: async ({ ctx }) => [...(await loadGroupMap(ctx)).values()]
	}),
	defineEndpoint({
		method: 'GET',
		path: '/tags',
		summary: 'Bereits verwendete Tags (häufigste zuerst, max. 50, optional Teilsuche)',
		tags: TAGS,
		permission: 'events.event.view',
		query: tagsQuery,
		handler: async ({ query }) => {
			const search = query.search?.trim();
			const filter = search
				? sql`WHERE lower(tag) LIKE ${`%${escapeLike(search.toLowerCase())}%`} ESCAPE '\\'`
				: sql``;
			const rows = await moduleDb(MODULE_ID).transaction(async (tx) => {
				const res = await tx.execute(sql`
					SELECT min(tag) AS tag, count(*)::int AS uses
					FROM event_tags
					${filter}
					GROUP BY lower(tag)
					ORDER BY uses DESC, lower(tag) ASC
					LIMIT ${MAX_TAG_SUGGESTIONS}
				`);
				return res.rows as { tag: string }[];
			});
			return rows.map((r) => String(r.tag));
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/principals',
		summary: 'Freigabe-Kandidaten suchen (Stamm, Gruppen, Rollen, Benutzer*innen, Mitglieder)',
		description:
			'Nur für Personen, die Termine teilen können (`events.event.create`, `edit-all`, Eigentümer*in oder `edit`-Freigabe eines Termins), sonst 403. Mitglieder nur mit `members.member.view`, E-Mail-Adressen nur mit `core.users.view`.',
		tags: TAGS,
		permission: 'events.event.view',
		rateLimit: PRINCIPAL_SEARCH_RATE_LIMIT,
		query: principalSearchQuery,
		handler: async ({ ctx, query }) => {
			await requireShareCapability(ctx, MODULE_ID, {
				anyPermission: ['events.event.create', 'events.event.edit-all'],
				canShareSql: (userId, keys) =>
					sql`SELECT 1 FROM events WHERE owner_id = ${userId}
						UNION ALL
						SELECT 1 FROM event_shares s WHERE s.level = 'edit' AND ${principalMatchSql('s', keys)}`
			});
			return searchPrincipals(ctx, MODULE_ID, query.search, { everyoneLabel: await stammName() });
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/settings/stamm',
		summary: 'Name des Stamms (Anzeige „ganzer Stamm“)',
		tags: TAGS,
		permission: 'events.event.view',
		handler: async () => ({ name: await stammName() })
	})
] as ApiEndpoint[];
