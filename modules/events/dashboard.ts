/**
 * Übersicht (`/dashboard`, „Diese Woche“): sichtbare Termine im Zeitraum, Serien als einzelne
 * Vorkommen (abgesagte fehlen, verschobene am neuen Datum). Sichtbar wie in `GET /events`
 * (`visibleEventsFilter`, Principal-Schlüssel VOR der Transaktion).
 */
import { sql } from 'drizzle-orm';
import { moduleDb, type ModuleDashboardSources, principalKeysFor, rowsOf } from '$lib/sdk/server';
import type { DashboardAgendaItem } from '$lib/sdk/types/dashboard';
import { visibleEventsFilter } from './access';
import {
	EVENT_COLUMNS,
	EVENT_ORDER,
	compareOccurrences,
	expandRow,
	hydrateRows,
	loadExceptions,
	overlapsWindow,
	singleOccurrence,
	type OccurrenceRow
} from './events.service';
import { MODULE_ID } from './schemas';

/** Höchstzahl Kandidaten-Zeilen für den Wochenstreifen */
const ROW_CAP = 500;

const hhmm = (v: string | null): string | null => (v ? v.slice(0, 5) : null);

/** Link wie bei der globalen Suche: Monat, Termin und ggf. Vorkommen */
export function eventHref(o: Pick<OccurrenceRow, 'id' | 'startsOn' | 'occurrenceDate'>): string {
	const params = new URLSearchParams({ month: o.startsOn.slice(0, 7), event: o.id });
	if (o.occurrenceDate) params.set('occurrence', o.occurrenceDate);
	return `/modules/events?${params}`;
}

export function toAgendaItem(o: OccurrenceRow): DashboardAgendaItem {
	const endsOn = o.endsOn && o.endsOn !== o.startsOn ? o.endsOn : null;
	const startTime = hhmm(o.startsTime);
	// Enduhrzeit nur bei eintägigen Terminen mit Beginn (mehrtägig: Ende liegt an einem anderen Tag)
	const endTime = startTime && !endsOn ? hhmm(o.endsTime) : null;
	return {
		id: o.key,
		kind: 'event',
		title: o.title,
		date: o.startsOn,
		endDate: endsOn,
		startTime,
		endTime: endTime && endTime > startTime! ? endTime : null,
		detail: o.location?.trim() || undefined,
		href: eventHref(o),
		groupIds: o.groupIds.length ? o.groupIds : undefined
	};
}

export const eventsDashboard: ModuleDashboardSources = {
	agenda: {
		permission: 'events.event.view',
		async run(ctx, { from, to }) {
			const keys = await principalKeysFor(ctx, MODULE_ID);
			const { rows, exceptions } = await moduleDb(MODULE_ID).transaction(async (tx) => {
				const raw = await rowsOf(
					tx,
					sql`SELECT ${EVENT_COLUMNS} FROM events e
						WHERE ${visibleEventsFilter(ctx, keys)}
							AND ((e.recurrence IS NULL
									AND e.starts_on <= ${to}::date
									AND COALESCE(e.ends_on, e.starts_on) >= ${from}::date)
								OR (e.recurrence IS NOT NULL
									AND e.starts_on <= ${to}::date
									AND (e.recurrence_until IS NULL OR
										e.recurrence_until + COALESCE(e.ends_on - e.starts_on, 0) >= ${from}::date)))
						ORDER BY ${EVENT_ORDER} LIMIT ${ROW_CAP}`
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
				if (!row.recurrence) {
					const o = singleOccurrence(row);
					if (overlapsWindow(o, from, to)) all.push(o);
					continue;
				}
				all.push(...expandRow(row, exceptions.get(row.id), from, to));
			}
			return all.sort(compareOccurrences).map(toAgendaItem);
		}
	}
};
