/**
 * Reine Logik für die Tages- und Wochenansicht (`pages/TimeGridCalendar.svelte`): Woche ab Montag, Kalenderwoche,
 * Aufteilung in ganztägige/mehrtägige Termine (Leiste oben) und Termine mit Uhrzeit (Blöcke im Zeitraster) sowie die
 * Spaltenaufteilung überlappender Blöcke. Daten `YYYY-MM-DD`, Zeiten `HH:MM`; gerechnet in UTC wie `month-calendar.ts`.
 */

import {
	addDays,
	compareItems,
	itemRange,
	weekdayIndex,
	type CalendarItem
} from '$lib/components/layout/month-calendar';

export type CalendarView = 'day' | 'week' | 'month' | 'list';

/** Standard-Rasterbereich (volle Stunden); frühere/spätere Termine erweitern ihn */
export const DEFAULT_START_HOUR = 8;
export const DEFAULT_END_HOUR = 20;
/** Dauer eines Termins ohne (brauchbare) Enduhrzeit in Minuten */
export const DEFAULT_DURATION = 60;

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)/;

/** Montag der Woche von `date` */
export function startOfWeek(date: string): string {
	return addDays(date, -weekdayIndex(date));
}

/** Die sieben Tage (Mo–So) der Woche von `date` */
export function weekDays(date: string): string[] {
	const monday = startOfWeek(date);
	return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
}

/** Kalenderwoche nach ISO 8601 (Woche mit dem ersten Donnerstag ist KW 1) */
export function isoWeek(date: string): number {
	const thursday = addDays(startOfWeek(date), 3);
	const jan1 = `${thursday.slice(0, 4)}-01-01`;
	const days = Math.round(
		(Date.parse(`${thursday}T00:00:00Z`) - Date.parse(`${jan1}T00:00:00Z`)) / 86_400_000
	);
	return Math.floor(days / 7) + 1;
}

/** `HH:MM` → Minuten seit Mitternacht, sonst `null` */
export function minutesOf(time: string | null | undefined): number | null {
	const m = TIME_RE.exec(time ?? '');
	return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Mit Uhrzeit im Raster: eintägig und mit Startuhrzeit. Alles andere steht in der Leiste oben. */
export function isTimed(item: CalendarItem): boolean {
	const r = itemRange(item);
	return !!r && r.start === r.end && minutesOf(item.startsTime) !== null;
}

export interface TimedBlock {
	item: CalendarItem;
	/** Minuten seit Mitternacht */
	start: number;
	end: number;
	/** Spalte innerhalb der Überlappungsgruppe (0-basiert) und Anzahl Spalten der Gruppe */
	col: number;
	cols: number;
}

/** Beginn/Ende eines Termins mit Uhrzeit in Minuten; fehlendes oder unplausibles Ende → Standarddauer */
export function blockTimes(item: CalendarItem): { start: number; end: number } | null {
	const start = minutesOf(item.startsTime);
	if (start === null) return null;
	const end = minutesOf(item.endsTime);
	const fallback = Math.min(start + DEFAULT_DURATION, 24 * 60);
	return { start, end: end !== null && end > start ? end : Math.max(fallback, start + 15) };
}

/**
 * Blöcke eines Tages mit Spalten: Termine, die sich zeitlich überschneiden (auch über Ketten), bilden eine Gruppe;
 * jeder Termin kommt in die erste freie Spalte, alle Termine der Gruppe teilen sich die Breite.
 */
export function layoutDay(items: CalendarItem[], date: string): TimedBlock[] {
	const timed = items
		.filter((it) => isTimed(it) && it.startsOn === date)
		.map((item) => ({ item, ...blockTimes(item)! }))
		.sort((a, b) => a.start - b.start || b.end - a.end || compareItems(a.item, b.item));

	const result: TimedBlock[] = [];
	let group: TimedBlock[] = [];
	let colEnds: number[] = [];
	let groupEnd = -1;

	const flush = () => {
		for (const b of group) b.cols = colEnds.length;
		result.push(...group);
		group = [];
		colEnds = [];
	};

	for (const t of timed) {
		if (group.length && t.start >= groupEnd) flush();
		let col = colEnds.findIndex((end) => end <= t.start);
		if (col < 0) col = colEnds.push(t.end) - 1;
		else colEnds[col] = t.end;
		group.push({ ...t, col, cols: 1 });
		groupEnd = Math.max(groupEnd, t.end);
	}
	flush();
	return result;
}

/** Ganztägige und mehrtägige Termine (Leiste oben), unverändert für `layoutWeek` aus dem Monatskalender */
export function allDayItems(items: CalendarItem[]): CalendarItem[] {
	return items.filter((it) => !isTimed(it));
}

/**
 * Sichtbarer Stundenbereich: Standard 8–20 Uhr, erweitert auf den frühesten Beginn bzw. das späteste Ende der
 * Termine mit Uhrzeit in `days`.
 */
export function hourRange(items: CalendarItem[], days: string[]): { from: number; to: number } {
	let from = DEFAULT_START_HOUR;
	let to = DEFAULT_END_HOUR;
	for (const date of days) {
		for (const b of layoutDay(items, date)) {
			from = Math.min(from, Math.floor(b.start / 60));
			to = Math.max(to, Math.ceil(b.end / 60));
		}
	}
	return { from, to: Math.min(Math.max(to, from + 1), 24) };
}
