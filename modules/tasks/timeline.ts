/** Reine Rechnung für die Zeitleiste (Maßstab, Raster, Verschieben/Ändern von Zeiträumen). */
import { addDays, daysBetween } from '$lib/sdk/dates';

export type TimelineScale = 'week' | 'month';

/** Breite eines Tages in Pixeln je Maßstab */
export const DAY_WIDTH: Record<TimelineScale, number> = { week: 28, month: 7 };

/** Ziel einer Änderung in der Zeitleiste */
export interface TimelineTarget {
	kind: 'task' | 'phase';
	id: string;
}

export interface DateRange {
	from: string;
	to: string;
}

const MONTHS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];

const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
function monthEnd(d: string): string {
	const y = Number(d.slice(0, 4));
	const m = Number(d.slice(5, 7));
	const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
	return addDays(next, -1);
}

/**
 * Sichtbarer Zeitraum: ganze Monate vom frühesten bis zum spätesten Datum (inkl. heute), mindestens
 * drei Monate. Ohne Daten: Monat von heute plus zwei.
 */
export function timelineRange(
	dates: readonly (string | null | undefined)[],
	today: string
): DateRange {
	const list = [...dates.filter((d): d is string => !!d), today].sort();
	const from = monthStart(list[0]!);
	let to = monthEnd(list[list.length - 1]!);
	const minTo = monthEnd(addDays(monthEnd(addDays(monthEnd(from), 1)), 1));
	if (to < minTo) to = minTo;
	return { from, to };
}

/** Tage seit `range.from` (0 = erster sichtbarer Tag) */
export const dayIndex = (range: DateRange, date: string): number => daysBetween(range.from, date);

/** Länge in Tagen (inklusive beider Enden) */
export const rangeDays = (range: DateRange): number => daysBetween(range.from, range.to) + 1;

export interface Tick {
	date: string;
	label: string;
	/** Tage seit Beginn */
	offset: number;
	/** Dauer in Tagen */
	days: number;
}

/** Monatsköpfe im Zeitraum (`Jan 2027` beim Jahreswechsel und am Anfang, sonst Kurzname) */
export function monthTicks(range: DateRange): Tick[] {
	const ticks: Tick[] = [];
	let d = range.from;
	let first = true;
	while (d <= range.to) {
		const end = monthEnd(d) < range.to ? monthEnd(d) : range.to;
		const m = Number(d.slice(5, 7));
		const label = first || m === 1 ? `${MONTHS[m - 1]} ${d.slice(0, 4)}` : MONTHS[m - 1]!;
		ticks.push({ date: d, label, offset: dayIndex(range, d), days: daysBetween(d, end) + 1 });
		first = false;
		d = addDays(end, 1);
	}
	return ticks;
}

/** Wochenanfänge (Montag) im Zeitraum mit Kalenderwoche als Beschriftung */
export function weekTicks(range: DateRange): Tick[] {
	const ticks: Tick[] = [];
	const weekday = (iso: string) => (new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7; // 0 = Mo
	let d = addDays(range.from, (7 - weekday(range.from)) % 7);
	while (d <= range.to) {
		ticks.push({ date: d, label: `KW ${isoWeek(d)}`, offset: dayIndex(range, d), days: 7 });
		d = addDays(d, 7);
	}
	return ticks;
}

/** ISO-Kalenderwoche */
export function isoWeek(iso: string): number {
	const date = new Date(`${iso}T00:00:00Z`);
	const day = (date.getUTCDay() + 6) % 7;
	date.setUTCDate(date.getUTCDate() - day + 3);
	const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
	const diff = (date.getTime() - firstThursday.getTime()) / 86_400_000;
	return 1 + Math.round((diff - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
}

/** Pixel → ganze Tage (gerundet) */
export const pxToDays = (px: number, scale: TimelineScale): number =>
	Math.round(px / DAY_WIDTH[scale]);

/** Zeitraum um `days` verschieben */
export const moveRange = (r: DateRange, days: number): DateRange => ({
	from: addDays(r.from, days),
	to: addDays(r.to, days)
});

/** Beginn oder Ende um `days` ändern; das Ende bleibt nie vor dem Beginn */
export function resizeRange(r: DateRange, edge: 'start' | 'end', days: number): DateRange {
	if (edge === 'start') {
		const from = addDays(r.from, days);
		return { from: from > r.to ? r.to : from, to: r.to };
	}
	const to = addDays(r.to, days);
	return { from: r.from, to: to < r.from ? r.from : to };
}
