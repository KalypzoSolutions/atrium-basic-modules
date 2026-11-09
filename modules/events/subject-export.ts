/**
 * Datenauskunft (Art. 15/20 DSGVO, Core `/admin/privacy`): Daten einer Person im Modul Termine –
 * eigene bzw. angelegte Termine (Konto), Freigaben an das Konto oder an Mitglieder der Person und
 * von der Person geänderte Einzeltermine einer Serie, eigene Kalender-Abos (ohne Link). Gruppen-Zuordnungen
 * sind keine Personendaten.
 * Eigene Modul-Transaktion, keine Core-Services darin.
 */
import { sql } from 'drizzle-orm';
import {
	type DataSubject,
	inList,
	moduleDb,
	type ModuleSubjectExport,
	rowsOf,
	toIsoOrNull
} from '$lib/sdk/server';
import { MODULE_ID } from './schemas';

const text = (v: unknown): string | null => (v == null || v === '' ? null : String(v));
const jsonList = (v: unknown): string[] => {
	const list: unknown = typeof v === 'string' ? JSON.parse(v) : v;
	return Array.isArray(list) ? list.map(String) : [];
};
async function run({ userId, memberIds }: DataSubject): Promise<Record<string, unknown> | null> {
	if (!userId && !memberIds.length) return null;
	const data = await moduleDb(MODULE_ID).transaction(async (tx) => {
		const owned = userId
			? await rowsOf(
					tx,
					sql`SELECT e.id, e.title, e.description, e.location, e.color,
							to_char(e.starts_on, 'YYYY-MM-DD') AS starts_on, e.starts_at,
							to_char(e.ends_on, 'YYYY-MM-DD') AS ends_on, e.ends_at, e.on_website,
							e.recurrence IS NOT NULL AS recurring, e.owner_id, e.created_by,
							e.created_at, e.updated_at,
							COALESCE((SELECT json_agg(t.tag ORDER BY t.position, t.tag)
								FROM event_tags t WHERE t.event_id = e.id), '[]'::json) AS tags
						FROM events e WHERE e.owner_id = ${userId} OR e.created_by = ${userId}
						ORDER BY e.starts_on, e.id`
				)
			: [];
		const conds = [];
		if (userId) conds.push(sql`(s.principal_type = 'user' AND s.principal_id = ${userId})`);
		if (memberIds.length) {
			conds.push(sql`(s.principal_type = 'member' AND s.principal_id IN (${inList(memberIds)}))`);
		}
		const shares = await rowsOf(
			tx,
			sql`SELECT s.event_id, e.title, to_char(e.starts_on, 'YYYY-MM-DD') AS starts_on,
					s.principal_type, s.principal_id, s.level, s.created_at
				FROM event_shares s JOIN events e ON e.id = s.event_id
				WHERE ${sql.join(conds, sql` OR `)}
				ORDER BY s.created_at, s.event_id`
		);
		const exceptions = userId
			? await rowsOf(
					tx,
					sql`SELECT x.event_id, e.title, to_char(x.occurrence_date, 'YYYY-MM-DD') AS occurrence_date,
							x.cancelled, x.updated_at
						FROM event_exceptions x JOIN events e ON e.id = x.event_id
						WHERE x.updated_by = ${userId} ORDER BY x.updated_at, x.event_id`
				)
			: [];
		const feeds = userId
			? await rowsOf(
					tx,
					sql`SELECT id, name, include_events, include_actions, include_tasks, group_ids, tags, created_at, last_used_at
						FROM calendar_feeds WHERE user_id = ${userId} ORDER BY created_at, id`
				)
			: [];
		return { owned, shares, exceptions, feeds };
	});
	if (!data.owned.length && !data.shares.length && !data.exceptions.length && !data.feeds.length) {
		return null;
	}
	return {
		events: data.owned.map((r) => ({
			id: String(r.id),
			title: String(r.title),
			description: text(r.description),
			location: text(r.location),
			color: text(r.color),
			startsOn: String(r.starts_on),
			startsAt: text(r.starts_at),
			endsOn: text(r.ends_on),
			endsAt: text(r.ends_at),
			onWebsite: r.on_website === true,
			recurring: r.recurring === true,
			tags: jsonList(r.tags),
			isOwner: r.owner_id === userId,
			createdByPerson: r.created_by === userId,
			createdAt: toIsoOrNull(r.created_at),
			updatedAt: toIsoOrNull(r.updated_at)
		})),
		sharesToPerson: data.shares.map((r) => ({
			eventId: String(r.event_id),
			eventTitle: String(r.title),
			startsOn: String(r.starts_on),
			principal: `${String(r.principal_type)}:${String(r.principal_id)}`,
			level: String(r.level),
			createdAt: toIsoOrNull(r.created_at)
		})),
		occurrenceChanges: data.exceptions.map((r) => ({
			eventId: String(r.event_id),
			eventTitle: String(r.title),
			occurrenceDate: String(r.occurrence_date),
			cancelled: r.cancelled === true,
			updatedAt: toIsoOrNull(r.updated_at)
		})),
		// Ohne Link/Token (geheim, nur in der App sichtbar)
		calendarFeeds: data.feeds.map((r) => ({
			id: String(r.id),
			name: String(r.name),
			includeEvents: r.include_events === true,
			includeActions: r.include_actions === true,
			includeTasks: r.include_tasks === true,
			groupIds: jsonList(r.group_ids),
			tags: jsonList(r.tags),
			createdAt: toIsoOrNull(r.created_at),
			lastUsedAt: toIsoOrNull(r.last_used_at)
		}))
	};
}

export const subjectExport: ModuleSubjectExport = { run };
