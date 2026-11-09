/**
 * Globale Suche (Befehlspalette): Termine nach Titel, Ort und Tags. Sichtbar wie in `GET /events`
 * (`visibleEventsFilter` mit den Principal-Schlüsseln, die VOR der Transaktion ermittelt werden).
 * Serien erscheinen einmal mit ihrem nächsten (sonst letzten) Vorkommen. Reihenfolge: kommende
 * zuerst (früheste zuerst), danach vergangene (jüngste zuerst).
 */
import { sql } from 'drizzle-orm';
import {
	moduleDb,
	type ModuleSearchProvider,
	principalKeysFor,
	rowsOf,
	type SearchHit
} from '$lib/sdk/server';
import { visibleEventsFilter } from './access';
import {
	EVENT_COLUMNS,
	EVENT_ORDER,
	expandRow,
	hydrateRows,
	loadExceptions,
	singleOccurrence,
	todayBerlin,
	type OccurrenceRow
} from './events.service';
import { formatEventRange } from './format';
import { addDays } from './recurrence';
import { MODULE_ID, OPEN_WINDOW_DAYS } from './schemas';

/** Höchstzahl Kandidaten-Zeilen (danach wird in JS sortiert und gekürzt) */
const ROW_CAP = 200;

const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const endOf = (o: OccurrenceRow) => o.endsOn ?? o.startsOn;

export const eventsSearch: ModuleSearchProvider = {
	permission: 'events.event.view',
	async run(ctx, query, limit) {
		const keys = await principalKeysFor(ctx, MODULE_ID);
		const p = like(query);
		const today = todayBerlin();

		const { rows, exceptions } = await moduleDb(MODULE_ID).transaction(async (tx) => {
			const raw = await rowsOf(
				tx,
				sql`SELECT ${EVENT_COLUMNS} FROM events e
					WHERE ${visibleEventsFilter(ctx, keys)}
						AND (e.title ILIKE ${p} OR e.location ILIKE ${p}
							OR EXISTS (SELECT 1 FROM event_tags t WHERE t.event_id = e.id AND t.tag ILIKE ${p}))
					ORDER BY ${EVENT_ORDER} LIMIT ${ROW_CAP}`
			);
			const rows = await hydrateRows(tx, raw);
			const exceptions = await loadExceptions(
				tx,
				rows.filter((r) => r.recurrence).map((r) => r.id)
			);
			return { rows, exceptions };
		});

		const picked: OccurrenceRow[] = [];
		for (const row of rows) {
			if (!row.recurrence) {
				picked.push(singleOccurrence(row));
				continue;
			}
			const exc = exceptions.get(row.id);
			const next = expandRow(row, exc, today, addDays(today, OPEN_WINDOW_DAYS), { max: 50 }).sort(
				(a, b) => (a.startsOn < b.startsOn ? -1 : a.startsOn > b.startsOn ? 1 : 0)
			)[0];
			if (next) {
				picked.push(next);
				continue;
			}
			const last = expandRow(row, exc, addDays(today, -OPEN_WINDOW_DAYS), addDays(today, -1))
				.sort((a, b) => (a.startsOn < b.startsOn ? -1 : a.startsOn > b.startsOn ? 1 : 0))
				.at(-1);
			if (last) picked.push(last);
		}

		const upcoming = picked
			.filter((o) => endOf(o) >= today)
			.sort((a, b) => (a.startsOn < b.startsOn ? -1 : a.startsOn > b.startsOn ? 1 : 0));
		const past = picked
			.filter((o) => endOf(o) < today)
			.sort((a, b) => (a.startsOn > b.startsOn ? -1 : a.startsOn < b.startsOn ? 1 : 0));

		return [...upcoming, ...past].slice(0, limit).map((o): SearchHit => {
			const params = new URLSearchParams({ month: o.startsOn.slice(0, 7), event: o.id });
			if (o.occurrenceDate) params.set('occurrence', o.occurrenceDate);
			return {
				id: o.id,
				title: o.title,
				subtitle: [formatEventRange(o), o.location, o.recurrence ? 'Serie' : null]
					.filter(Boolean)
					.join(' · '),
				href: `/modules/events?${params}`,
				icon: 'calendar',
				type: 'Termin'
			};
		});
	}
};
