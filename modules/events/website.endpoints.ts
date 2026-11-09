import { sql } from 'drizzle-orm';
import { type AnyApiEndpoint, defineEndpoint, errors, moduleDb, rowsOf } from '$lib/sdk/server';
import type { RequestContext } from '$lib/sdk/types';
import {
	EVENT_COLUMNS,
	EVENT_ORDER,
	compareOccurrences,
	expandRow,
	hydrateRows,
	loadExceptions,
	resolveWebsiteOccurrence,
	singleOccurrence,
	todayBerlin,
	type OccurrenceRow
} from './events.service';
import { loadGroupMap } from './groups';
import { addDays } from './recurrence';
import {
	MAX_OCCURRENCES,
	MODULE_ID,
	OPEN_WINDOW_DAYS,
	idParams,
	websiteEventQuery,
	type WebsiteEvent
} from './schemas';
import { websiteEventsQuery, type WebsiteEventPage } from './website.schemas';

/** Heutiges Datum in Europe/Berlin (liegt in `events.service.ts`, hier für bestehende Importe) */
export { todayBerlin };

/** Höchstzahl Kandidaten-Zeilen (einmalige Termine + Serien) vor dem Expandieren */
const WEBSITE_ROW_CAP = 5000;

const WEBSITE_RATE_LIMIT = { limit: 600, windowSec: 60 };

/**
 * Vorkommen in öffentliche DTOs umwandeln (nach der Transaktion: Gruppennamen aus Einstellung und
 * `members`). `groups` und `groupIds` in gleicher Reihenfolge (Stamm zuerst, dann nach Name);
 * Zuordnungen zu unbekannten Gruppen (z. B. `members` deaktiviert) fallen weg.
 */
async function toWebsiteEvents(
	ctx: RequestContext,
	rows: readonly OccurrenceRow[]
): Promise<WebsiteEvent[]> {
	const groupMap = await loadGroupMap(ctx);
	return rows.map((r): WebsiteEvent => {
		// nur Namen/IDs – keine Treffen-Daten (meeting*) der Gruppen
		const groups = [...groupMap.values()].filter((g) => r.groupIds.includes(g.id));
		return {
			id: r.id,
			title: r.title,
			description: r.description,
			location: r.location,
			color: r.color,
			startsOn: r.startsOn,
			startsTime: r.startsTime,
			endsOn: r.endsOn,
			endsTime: r.endsTime,
			tags: r.tags,
			groups: groups.map((g) => g.name),
			groupIds: groups.map((g) => g.id),
			recurring: !!r.recurrence,
			occurrenceDate: r.occurrenceDate
		};
	});
}

export const websiteEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/website/events',
		summary: 'Termine für die Stammeswebsite (API-Key mit Scope events.website.read)',
		description:
			'Liefert nur Termine mit „auf der Website“, die den Zeitraum ab `from` (Standard: heute, ' +
			'Europe/Berlin) bis optional `to` berühren, sortiert nach Beginn. Serien erscheinen als ' +
			'einzelne Vorkommen (`recurring: true`, `occurrenceDate`; ohne `to` höchstens ein Jahr ' +
			'voraus), abgesagte Vorkommen fehlen. `group` (Gruppen-ID oder `stamm`) filtert auf ' +
			'Termine mit dieser Zuordnung. Nur öffentliche Felder: keine Freigaben, ' +
			'Eigentümer*innen oder Zeitstempel. Paging: `offset` (Standard 0) überspringt Vorkommen; ' +
			'mit `paged=1` kommt statt des Arrays `{ items, total, offset, limit, hasMore }` ' +
			'(ohne `paged` bleibt die Antwort ein Array – abwärtskompatibel).',
		tags: ['Modul: events'],
		permission: 'events.website.read',
		query: websiteEventsQuery,
		rateLimit: WEBSITE_RATE_LIMIT,
		handler: async ({ ctx, query }) => {
			const from = query.from ?? todayBerlin();
			const to = query.to ?? null;
			if (to && to < from) throw errors.validation({ to: 'Das Enddatum liegt vor dem Startdatum' });
			const seriesTo = to ?? addDays(from, OPEN_WINDOW_DAYS);
			const tag = query.tag?.trim().toLowerCase() || null;
			const group = query.group ?? null;

			const { rows, exceptions } = await moduleDb(MODULE_ID).transaction(async (tx) => {
				const raw = await rowsOf(
					tx,
					sql`SELECT ${EVENT_COLUMNS} FROM events e
						WHERE e.on_website = true
							AND (
								(e.recurrence IS NULL
									AND COALESCE(e.ends_on, e.starts_on) >= ${from}::date
									${to ? sql`AND e.starts_on <= ${to}::date` : sql``})
								OR (e.recurrence IS NOT NULL
									AND e.starts_on <= ${seriesTo}::date
									AND (e.recurrence_until IS NULL OR
										e.recurrence_until + COALESCE(e.ends_on - e.starts_on, 0) >= ${from}::date))
							)
							${
								tag
									? sql`AND EXISTS (SELECT 1 FROM event_tags t
										WHERE t.event_id = e.id AND lower(t.tag) = ${tag})`
									: sql``
							}
							${
								group
									? sql`AND EXISTS (SELECT 1 FROM event_groups g
										WHERE g.event_id = e.id AND g.group_id = ${group})`
									: sql``
							}
						ORDER BY ${EVENT_ORDER}
						LIMIT ${WEBSITE_ROW_CAP}`
				);
				const rows = await hydrateRows(tx, raw);
				const exceptions = await loadExceptions(
					tx,
					rows.filter((r) => r.recurrence).map((r) => r.id)
				);
				return { rows, exceptions };
			});

			const all: OccurrenceRow[] = [];
			for (const row of rows) {
				if (row.recurrence) all.push(...expandRow(row, exceptions.get(row.id), from, seriesTo));
				else all.push(singleOccurrence(row));
			}
			all.sort(compareOccurrences);
			if (rows.length >= WEBSITE_ROW_CAP) {
				// Kandidaten gekappt: `total` ist dann eine Untergrenze (sollte praktisch nie eintreten)
				console.warn(`events: /website/events hat ${WEBSITE_ROW_CAP} Kandidaten-Zeilen erreicht`);
			}
			const limit = Math.min(query.limit, MAX_OCCURRENCES);
			const page = all.slice(query.offset, query.offset + limit);
			const items = await toWebsiteEvents(ctx, page);
			if (!query.paged) return items;
			return {
				items,
				total: all.length,
				offset: query.offset,
				limit,
				hasMore: query.offset + page.length < all.length
			} satisfies WebsiteEventPage;
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/website/events/:id',
		summary: 'Ein Termin für die Stammeswebsite (API-Key mit Scope events.website.read)',
		description:
			'Ein Termin mit „auf der Website“ als `WebsiteEvent`, sonst 404. Serien: mit `occurrence` ' +
			'(ursprüngliches Datum) genau dieses Vorkommen inkl. Änderungen (abgesagt oder kein ' +
			'Vorkommen → 404), ohne `occurrence` das nächste Vorkommen ab heute (Europe/Berlin), ' +
			'sonst das letzte. Einmalige Termine mit `occurrence` → 404.',
		tags: ['Modul: events'],
		permission: 'events.website.read',
		params: idParams,
		query: websiteEventQuery,
		rateLimit: WEBSITE_RATE_LIMIT,
		handler: async ({ ctx, params, query }) => {
			const { row, exceptions } = await moduleDb(MODULE_ID).transaction(async (tx) => {
				const raw = await rowsOf(
					tx,
					sql`SELECT ${EVENT_COLUMNS} FROM events e
						WHERE e.id = ${params.id} AND e.on_website = true`
				);
				const [row] = await hydrateRows(tx, raw);
				if (!row) return { row: null, exceptions: undefined };
				const exceptions = row.recurrence
					? (await loadExceptions(tx, [row.id])).get(row.id)
					: undefined;
				return { row, exceptions };
			});
			if (!row) throw errors.notFound('Termin nicht gefunden');
			const occ = resolveWebsiteOccurrence(row, exceptions, query.occurrence);
			const [event] = await toWebsiteEvents(ctx, [occ]);
			return event!;
		}
	})
];
