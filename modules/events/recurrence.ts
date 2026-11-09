/**
 * Serien (Wiederholungstermine) – reine Logik für Server und UI, ohne Server-/Svelte-Imports.
 *
 * Gerechnet wird ausschließlich mit Datums-Strings `YYYY-MM-DD` (UTC, keine Zeitzonen). Die Uhrzeiten
 * eines Vorkommens sind die der Serie (bzw. eines Overrides); hier geht es nur um Tage.
 *
 * Semantik (angelehnt an RFC 5545):
 *   - Das erste Vorkommen ist `startsOn`; bei `weekly` mit `byWeekday` zählt der Start nur, wenn sein
 *     Wochentag enthalten ist (sonst beginnt die Serie mit dem nächsten passenden Tag).
 *   - `interval`: jeder N-te Tag / jede N-te Woche (Woche ab Montag der Startwoche) / Monat / Jahr.
 *   - `monthly`/`yearly` `day`: gleicher Tag im Monat; Monate ohne diesen Tag fallen aus (31., 29.02.).
 *     `nth-weekday`: n-ter Wochentag wie beim Start (n = 1–4, 5. → fällt in Monaten ohne 5. aus);
 *     `last-weekday`: letzter Wochentag wie beim Start.
 *   - `end.count` zählt Vorkommen ab dem Start (Ausnahmen/Absagen zählen mit).
 */
import type { EventDates, RecurrenceRule } from './schemas';

export interface Occurrence {
	/** Ursprüngliches Datum (Schlüssel für Ausnahmen) */
	date: string;
	startsOn: string;
	/** Bei mehrtägigen Serien: verschoben um die Dauer der Serie, sonst wie Serie (`null` bleibt `null`) */
	endsOn: string | null;
}

const DAY_MS = 86_400_000;
/** Obergrenze für Monatsschritte (monthly/yearly), schützt vor Endlosschleifen bei seltenen Treffern */
const MAX_MONTH_STEPS = 20_000;

const WEEKDAY_NAMES = [
	'Montag',
	'Dienstag',
	'Mittwoch',
	'Donnerstag',
	'Freitag',
	'Samstag',
	'Sonntag'
] as const;
const MONTH_NAMES = [
	'Januar',
	'Februar',
	'März',
	'April',
	'Mai',
	'Juni',
	'Juli',
	'August',
	'September',
	'Oktober',
	'November',
	'Dezember'
] as const;

// ---------------------------------------------------------------------------------------------
// Tagesnummern (Tage seit 1970-01-01, UTC)

function parts(date: string): [number, number, number] {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
	if (!m) throw new Error(`Ungültiges Datum: ${date}`);
	return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function toDayNum(date: string): number {
	const [y, mo, d] = parts(date);
	return Math.round(Date.UTC(y, mo - 1, d) / DAY_MS);
}

function fromDayNum(n: number): string {
	return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

/** ISO-Wochentag einer Tagesnummer (1970-01-01 war ein Donnerstag) */
function weekdayOf(n: number): number {
	return ((((n + 3) % 7) + 7) % 7) + 1;
}

function daysInMonth(y: number, mo: number): number {
	return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

function pad(n: number): string {
	return String(n).padStart(2, '0');
}

/** Ganze Tage zwischen zwei Daten (`b - a`) */
export function daysBetween(a: string, b: string): number {
	return toDayNum(b) - toDayNum(a);
}

/** Datum + n Tage */
export function addDays(date: string, n: number): string {
	return fromDayNum(toDayNum(date) + n);
}

/** ISO-Wochentag 1 = Mo … 7 = So */
export function isoWeekday(date: string): number {
	return weekdayOf(toDayNum(date));
}

/** Nächstes Datum ≥ `fromDate` mit diesem ISO-Wochentag */
export function nextWeekday(fromDate: string, weekday: number): string {
	const n = toDayNum(fromDate);
	return fromDayNum(n + ((((weekday - weekdayOf(n)) % 7) + 7) % 7));
}

// ---------------------------------------------------------------------------------------------
// Kandidaten erzeugen

function weekdaysOf(rule: RecurrenceRule, startsOn: string): number[] {
	return rule.byWeekday && rule.byWeekday.length
		? [...rule.byWeekday].sort((a, b) => a - b)
		: [isoWeekday(startsOn)];
}

function intervalOf(rule: RecurrenceRule): number {
	return Math.max(1, Math.floor(rule.interval || 1));
}

/**
 * Tagesnummer des Vorkommens im Monat (`y`, `mo` 1–12) nach Modus, oder `null`, wenn es ausfällt.
 * `day`/`wd`/`nth` stammen aus dem Startdatum.
 */
function dayInMonth(
	y: number,
	mo: number,
	mode: 'day' | 'nth-weekday' | 'last-weekday',
	day: number,
	wd: number,
	nth: number
): number | null {
	const dim = daysInMonth(y, mo);
	if (mode === 'day') {
		return day <= dim ? Math.round(Date.UTC(y, mo - 1, day) / DAY_MS) : null;
	}
	const first = Math.round(Date.UTC(y, mo - 1, 1) / DAY_MS);
	const firstWd = first + ((((wd - weekdayOf(first)) % 7) + 7) % 7);
	if (mode === 'nth-weekday') {
		const n = firstWd + (nth - 1) * 7;
		return n - first < dim ? n : null;
	}
	const last = first + dim - 1;
	return last - ((((weekdayOf(last) - wd) % 7) + 7) % 7);
}

/**
 * Alle Vorkommen (Tagesnummern) ≥ max(Start, `lower`) aufsteigend, ohne Endebedingung.
 * Springt für ferne `lower` direkt zum ersten Kandidaten.
 */
function* candidates(startsOn: string, rule: RecurrenceRule, lower: number): Generator<number> {
	const s = toDayNum(startsOn);
	const lo = Math.max(s, lower);
	const interval = intervalOf(rule);

	if (rule.freq === 'daily') {
		const k = Math.max(0, Math.ceil((lo - s) / interval));
		for (let n = s + k * interval; ; n += interval) yield n;
	}

	if (rule.freq === 'weekly') {
		const wds = weekdaysOf(rule, startsOn);
		const monday0 = s - (weekdayOf(s) - 1);
		const w = Math.max(0, Math.floor((lo - monday0) / 7));
		for (let week = Math.ceil(w / interval) * interval; ; week += interval) {
			for (const wd of wds) {
				const n = monday0 + week * 7 + wd - 1;
				if (n >= lo) yield n;
			}
		}
	}

	// monthly / yearly
	const step = rule.freq === 'yearly' ? 12 * interval : interval;
	const mode = rule.monthlyMode ?? 'day';
	const [sy, smo, sd] = parts(startsOn);
	const wd = weekdayOf(s);
	const nth = Math.ceil(sd / 7);
	const m0 = sy * 12 + (smo - 1);
	const [ly, lmo] = parts(fromDayNum(lo));
	const diff = ly * 12 + (lmo - 1) - m0;
	let k = Math.max(0, Math.floor(diff / step) * step);
	for (let i = 0; i < MAX_MONTH_STEPS; i++, k += step) {
		if (k === 0) {
			// Der Start ist immer das erste Vorkommen
			if (s >= lo) yield s;
			continue;
		}
		const mi = m0 + k;
		const n = dayInMonth(Math.floor(mi / 12), (mi % 12) + 1, mode, sd, wd, nth);
		if (n !== null && n >= lo) yield n;
	}
}

/** Erste `count` Vorkommen (nur für `end.count`, count ≤ 500) */
function countedOccurrences(startsOn: string, rule: RecurrenceRule, count: number): number[] {
	const out: number[] = [];
	if (count <= 0) return out;
	for (const n of candidates(startsOn, rule, toDayNum(startsOn))) {
		out.push(n);
		if (out.length >= count) break;
	}
	return out;
}

// ---------------------------------------------------------------------------------------------
// Öffentliche Funktionen

/**
 * Kleinster möglicher Abstand zweier Vorkommen in Tagen (z. B. weekly Di+Do → 2, monthly → 28,
 * yearly → 365). Für die Prüfung „Dauer < Abstand“.
 */
export function minGapDays(rule: RecurrenceRule, startsOn: string): number {
	const interval = intervalOf(rule);
	switch (rule.freq) {
		case 'daily':
			return interval;
		case 'weekly': {
			const wds = weekdaysOf(rule, startsOn);
			const cycle = interval * 7;
			if (wds.length < 2) return cycle;
			let min = wds[0]! + cycle - wds[wds.length - 1]!;
			for (let i = 1; i < wds.length; i++) min = Math.min(min, wds[i]! - wds[i - 1]!);
			return min;
		}
		case 'monthly':
			return 28 * interval;
		case 'yearly':
			// Wochentag-Modi verschieben sich: 2. Sonntag im Mai kann 364 Tage später liegen
			return ((rule.monthlyMode ?? 'day') === 'day' ? 365 : 364) * interval;
	}
}

/**
 * Vorkommen, die den Zeitraum [`from`, `to`] berühren (Überlappung mit mehrtägigen Vorkommen),
 * aufsteigend, höchstens `max`. `from`/`to` inklusive.
 */
export function expandOccurrences(
	start: EventDates,
	rule: RecurrenceRule,
	from: string,
	to: string,
	max: number
): Occurrence[] {
	const limit = Math.floor(max);
	if (!(limit > 0) || to < from) return [];
	const duration = start.endsOn ? Math.max(0, daysBetween(start.startsOn, start.endsOn)) : 0;
	const lower = Math.max(toDayNum(start.startsOn), toDayNum(from) - duration);
	let upper = toDayNum(to);
	if (rule.end.type === 'until') upper = Math.min(upper, toDayNum(rule.end.date));
	if (upper < lower) return [];

	const out: Occurrence[] = [];
	const push = (n: number) => {
		const date = fromDayNum(n);
		out.push({
			date,
			startsOn: date,
			endsOn: start.endsOn === null ? null : fromDayNum(n + duration)
		});
	};

	if (rule.end.type === 'count') {
		for (const n of countedOccurrences(start.startsOn, rule, rule.end.count)) {
			if (n > upper || out.length >= limit) break;
			if (n >= lower) push(n);
		}
		return out;
	}

	for (const n of candidates(start.startsOn, rule, lower)) {
		if (n > upper || out.length >= limit) break;
		push(n);
	}
	return out;
}

/** Ist `date` ein (ursprüngliches) Vorkommensdatum der Serie? */
export function isOccurrence(start: EventDates, rule: RecurrenceRule, date: string): boolean {
	const n = toDayNum(date);
	if (n < toDayNum(start.startsOn)) return false;
	if (rule.end.type === 'until' && date > rule.end.date) return false;
	if (rule.end.type === 'count') {
		return countedOccurrences(start.startsOn, rule, rule.end.count).includes(n);
	}
	for (const c of candidates(start.startsOn, rule, n)) return c === n;
	return false;
}

/** Letztes Vorkommensdatum (Startdatum) oder `null` bei offener Serie */
export function lastOccurrence(start: EventDates, rule: RecurrenceRule): string | null {
	if (rule.end.type === 'never') return null;
	if (rule.end.type === 'count') {
		const list = countedOccurrences(start.startsOn, rule, rule.end.count);
		const last = list[list.length - 1];
		return last === undefined ? null : fromDayNum(last);
	}
	// until: rückwärts in wachsenden Fenstern suchen (Lücken bei 31./29.02./5. Wochentag)
	const s = toDayNum(start.startsOn);
	const until = toDayNum(rule.end.date);
	if (until < s) return null;
	for (let window = 400; ; window *= 2) {
		const lower = Math.max(s, until - window);
		let last: number | null = null;
		for (const n of candidates(start.startsOn, rule, lower)) {
			if (n > until) break;
			last = n;
		}
		if (last !== null) return fromDayNum(last);
		if (lower <= s) return null;
	}
}

function joinGerman(items: string[]): string {
	if (items.length <= 1) return items.join('');
	return `${items.slice(0, -1).join(', ')} und ${items[items.length - 1]}`;
}

/**
 * Deutsche Beschreibung, z. B. „Jeden Dienstag“, „Alle 2 Wochen am Dienstag und Donnerstag“,
 * „Jeden 1. Samstag im Monat“, „Jeden letzten Freitag im Monat“, „Jährlich am 24.12.“,
 * mit Ende „, bis 31.12.2026“ bzw. „, 10-mal“.
 */
export function describeRecurrence(rule: RecurrenceRule, startsOn: string): string {
	const interval = intervalOf(rule);
	const [, mo, d] = parts(startsOn);
	const wdName = WEEKDAY_NAMES[isoWeekday(startsOn) - 1]!;
	const nth = Math.ceil(d / 7);
	const mode = rule.monthlyMode ?? 'day';
	let text: string;

	switch (rule.freq) {
		case 'daily':
			text = interval === 1 ? 'Täglich' : `Alle ${interval} Tage`;
			break;
		case 'weekly': {
			const days = joinGerman(weekdaysOf(rule, startsOn).map((w) => WEEKDAY_NAMES[w - 1]!));
			text = interval === 1 ? `Jeden ${days}` : `Alle ${interval} Wochen am ${days}`;
			break;
		}
		case 'monthly': {
			if (mode === 'day') {
				text = interval === 1 ? `Monatlich am ${d}.` : `Alle ${interval} Monate am ${d}.`;
			} else {
				const which = mode === 'nth-weekday' ? `${nth}.` : 'letzten';
				text =
					interval === 1
						? `Jeden ${which} ${wdName} im Monat`
						: `Alle ${interval} Monate am ${which} ${wdName}`;
			}
			break;
		}
		case 'yearly': {
			const prefix = interval === 1 ? 'Jährlich' : `Alle ${interval} Jahre`;
			const monthName = MONTH_NAMES[mo - 1]!;
			if (mode === 'day') text = `${prefix} am ${pad(d)}.${pad(mo)}.`;
			else if (mode === 'nth-weekday') text = `${prefix} am ${nth}. ${wdName} im ${monthName}`;
			else text = `${prefix} am letzten ${wdName} im ${monthName}`;
			break;
		}
	}

	if (rule.end.type === 'until') {
		const [uy, umo, ud] = parts(rule.end.date);
		text += `, bis ${pad(ud)}.${pad(umo)}.${uy}`;
	} else if (rule.end.type === 'count') {
		text += `, ${rule.end.count}-mal`;
	}
	return text;
}
