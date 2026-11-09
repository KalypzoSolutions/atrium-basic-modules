/**
 * PDF-Export der Termine (Terminliste, Monatskalender, Jahresplan) – reine Aufbereitung ohne Datenbank (Server, Tests).
 *
 * - Eingabe sind bereits sichtbare, expandierte Vorkommen (`EventItem`) und optional Aktionen (`CalendarAction`),
 *   vereinheitlicht als `ExportEntry`.
 * - Terminliste: normale PDF-Blöcke (`heading` + `table` je Monat).
 * - Monatskalender und Jahresplan: je ein `richText`-Block mit einer Tabelle. Der Core bereinigt das HTML
 *   (`sanitizeDocumentHtml`): erlaubt sind nur `color`, `background-color`, `font-size`, `text-align` und `width`;
 *   gleich hohe Zellen entstehen deshalb über aufgefüllte Zeilen statt über `height`. Texte immer per `escapeHtml`.
 */
import { escapeHtml } from '$lib/sdk/server';
import type { PdfBlock } from '$lib/sdk/types';
import type { CalendarAction } from './peer-contracts';
import { addDays, daysBetween, isoWeekday } from './recurrence';
import { formatEventTime } from './format';
import type { EventItem, ExportLayout } from './schemas';

export interface ExportEntry {
	key: string;
	kind: 'event' | 'action';
	title: string;
	location: string | null;
	description: string | null;
	startsOn: string;
	startsTime: string | null;
	endsOn: string | null;
	endsTime: string | null;
	/** `#rrggbb` oder `null` (dann neutrale Farbe) */
	color: string | null;
	groups: string[];
	tags: string[];
	recurring: boolean;
}

/** Farbe für Termine ohne eigene Farbe bzw. für Aktionen */
export const DEFAULT_COLOR = '#64748b';
export const ACTION_COLOR = '#7c3aed';

const MONTHS = [
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
const MONTHS_SHORT = [
	'Jan',
	'Feb',
	'Mär',
	'Apr',
	'Mai',
	'Jun',
	'Jul',
	'Aug',
	'Sep',
	'Okt',
	'Nov',
	'Dez'
] as const;
/** ISO-Wochentag 1 = Mo … 7 = So */
const WEEKDAYS = ['', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'] as const;

const esc = escapeHtml;

// --- Eingaben vereinheitlichen ----------------------------------------------------------------

const validColor = (c: string | null | undefined): string | null =>
	c && /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() : null;

export function entryFromEvent(e: EventItem): ExportEntry {
	return {
		key: e.key ?? e.id,
		kind: 'event',
		title: e.title,
		location: e.location ?? e.room?.name ?? null,
		description: e.description,
		startsOn: e.startsOn,
		startsTime: e.startsTime,
		endsOn: e.endsOn,
		endsTime: e.endsTime,
		color: validColor(e.color) ?? validColor(e.groups.find((g) => g.color)?.color),
		groups: e.groups.map((g) => g.name),
		tags: e.tags,
		recurring: !!e.recurrence
	};
}

export function entryFromAction(a: CalendarAction): ExportEntry {
	return {
		key: `action:${a.id}`,
		kind: 'action',
		title: a.name,
		location: a.location,
		description: a.description,
		startsOn: a.startsOn,
		startsTime: a.startsTime,
		endsOn: a.endsOn,
		endsTime: a.endsTime,
		color: ACTION_COLOR,
		groups: [],
		tags: [],
		recurring: false
	};
}

/** Aktionen per Suchtext filtern (Name, Ort – wie die Terminsuche ohne Beschreibung) */
export function matchesActionSearch(a: CalendarAction, search: string | null | undefined): boolean {
	if (!search) return true;
	const q = search.toLocaleLowerCase('de-DE');
	return [a.name, a.location].some((v) => !!v && v.toLocaleLowerCase('de-DE').includes(q));
}

/** Nach Beginn sortieren (Datum, ganztägig zuerst, Uhrzeit, Titel) */
export function compareEntries(a: ExportEntry, b: ExportEntry): number {
	return (
		a.startsOn.localeCompare(b.startsOn) ||
		(a.startsTime ?? '').localeCompare(b.startsTime ?? '') ||
		a.title.localeCompare(b.title, 'de-DE') ||
		a.key.localeCompare(b.key)
	);
}

// --- Datum ------------------------------------------------------------------------------------

const endOf = (e: Pick<ExportEntry, 'startsOn' | 'endsOn'>) =>
	e.endsOn && e.endsOn > e.startsOn ? e.endsOn : e.startsOn;

/** Liegt der Termin (auch mehrtägig) an diesem Tag? */
export const coversDay = (e: ExportEntry, day: string): boolean =>
	e.startsOn <= day && endOf(e) >= day;

/** `JJJJ-MM` aller Monate von `from` bis `to` (einschließlich) */
export function monthsBetween(from: string, to: string): string[] {
	const out: string[] = [];
	let y = Number(from.slice(0, 4));
	let m = Number(from.slice(5, 7));
	const endKey = to.slice(0, 7);
	for (let i = 0; i < 1200; i++) {
		const key = `${y}-${String(m).padStart(2, '0')}`;
		out.push(key);
		if (key >= endKey) break;
		m += 1;
		if (m > 12) {
			m = 1;
			y += 1;
		}
	}
	return out;
}

export function daysInMonth(month: string): number {
	const y = Number(month.slice(0, 4));
	const m = Number(month.slice(5, 7));
	return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

export const monthLabel = (month: string): string =>
	`${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;

/** `JJJJ-MM-TT` → `TT.MM.JJJJ` */
export const dateDe = (iso: string): string =>
	`${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;

/** `JJJJ-MM-TT` → „Sa 24.10.“ */
export const shortDate = (iso: string): string =>
	`${WEEKDAYS[isoWeekday(iso)]} ${iso.slice(8, 10)}.${iso.slice(5, 7)}.`;

/** Wochen (Mo–So) eines Monats als Datumslisten, inkl. Randtage der Nachbarmonate */
export function monthWeeks(month: string): string[][] {
	const first = `${month}-01`;
	const start = addDays(first, 1 - isoWeekday(first));
	const last = `${month}-${String(daysInMonth(month)).padStart(2, '0')}`;
	const weeks: string[][] = [];
	for (let d = start; d <= last; d = addDays(d, 7)) {
		weeks.push(Array.from({ length: 7 }, (_, i) => addDays(d, i)));
	}
	return weeks;
}

// --- Titel ------------------------------------------------------------------------------------

/** Ganzer Kalendermonat bzw. ganzes Kalenderjahr? */
function periodKind(from: string, to: string): 'month' | 'year' | 'range' {
	if (from.endsWith('-01-01') && to === `${from.slice(0, 4)}-12-31`) return 'year';
	const month = from.slice(0, 7);
	if (from.endsWith('-01') && to === `${month}-${String(daysInMonth(month)).padStart(2, '0')}`) {
		return 'month';
	}
	return 'range';
}

export function periodLabel(from: string, to: string): string {
	const kind = periodKind(from, to);
	if (kind === 'year') return from.slice(0, 4);
	if (kind === 'month') return monthLabel(from.slice(0, 7));
	return `${dateDe(from)} – ${dateDe(to)}`;
}

const LAYOUT_TITLES: Record<ExportLayout, string> = {
	list: 'Termine',
	calendar: 'Monatskalender',
	year: 'Jahresplan'
};

/** z. B. „Jahresplan 2027“, „Termine November 2026“, „Monatskalender 01.08.2026 – 31.07.2027“ */
export function exportTitle(layout: ExportLayout, from: string, to: string): string {
	return `${LAYOUT_TITLES[layout]} ${periodLabel(from, to)}`;
}

/** Dateiname ohne Sonderzeichen, z. B. `jahresplan-2027.pdf` */
export function exportFileName(layout: ExportLayout, from: string, to: string): string {
	const kind = periodKind(from, to);
	const period =
		kind === 'year' ? from.slice(0, 4) : kind === 'month' ? from.slice(0, 7) : `${from}_${to}`;
	const base = { list: 'termine', calendar: 'monatskalender', year: 'jahresplan' }[layout];
	return `${base}-${period}.pdf`;
}

// --- Farben -----------------------------------------------------------------------------------

/** Farbe mit Weiß mischen (`amount` 0 = Farbe, 1 = Weiß) → helle Hinterlegung mit dunkler Schrift */
export function tint(color: string | null | undefined, amount = 0.78): string {
	const c = validColor(color) ?? DEFAULT_COLOR;
	const mix = (i: number) => {
		const v = parseInt(c.slice(i, i + 2), 16);
		return Math.round(v + (255 - v) * amount)
			.toString(16)
			.padStart(2, '0');
	};
	return `#${mix(1)}${mix(3)}${mix(5)}`;
}

const WEEKEND_BG = '#f3f4f6';
const OUTSIDE_BG = '#e5e7eb';
const MUTED = '#6b7280';

// --- Terminliste ------------------------------------------------------------------------------

function timeText(e: ExportEntry): string {
	const s = formatEventTime(e.startsTime);
	const t = formatEventTime(e.endsTime);
	if (s && t) return `${s} – ${t}`;
	if (s) return `ab ${s}`;
	if (t) return `bis ${t}`;
	return '';
}

function dateText(e: ExportEntry): string {
	const end = endOf(e);
	return end === e.startsOn
		? shortDate(e.startsOn)
		: `${shortDate(e.startsOn)} – ${shortDate(end)}`;
}

function titleText(e: ExportEntry): string {
	const marks = [e.kind === 'action' ? 'Aktion' : null, e.recurring ? 'Serie' : null].filter(
		Boolean
	);
	return marks.length ? `${e.title} (${marks.join(', ')})` : e.title;
}

export interface ListOptions {
	from: string;
	to: string;
	withDescription: boolean;
}

/**
 * Terminliste: je Monat eine Überschrift und eine Tabelle. Mehrtägige Termine, die vor dem Zeitraum beginnen,
 * stehen im ersten Monat; Monate ohne Termine entfallen.
 */
export function listBlocks(entries: ExportEntry[], o: ListOptions): PdfBlock[] {
	const byMonth = new Map<string, ExportEntry[]>();
	for (const e of [...entries].sort(compareEntries)) {
		const month = (e.startsOn < o.from ? o.from : e.startsOn).slice(0, 7);
		const list = byMonth.get(month) ?? [];
		list.push(e);
		byMonth.set(month, list);
	}
	if (!byMonth.size) return [];
	const columns = ['Datum', 'Zeit', 'Termin', 'Ort', 'Gruppen'];
	const widths = [2.4, 1.6, 3.6, 2.2, 2];
	if (o.withDescription) {
		columns.push('Beschreibung');
		widths.push(4);
	}
	const blocks: PdfBlock[] = [];
	for (const month of monthsBetween(o.from, o.to)) {
		const list = byMonth.get(month);
		if (!list) continue;
		blocks.push({ type: 'heading', level: 2, text: monthLabel(month) });
		blocks.push({
			type: 'table',
			columns,
			widths,
			rows: list.map((e) => {
				const row = [
					dateText(e),
					timeText(e),
					titleText(e),
					e.location ?? '',
					e.kind === 'action' ? 'Aktion' : e.groups.join(', ')
				];
				if (o.withDescription) row.push((e.description ?? '').trim());
				return row;
			})
		});
	}
	return blocks;
}

// --- Monatskalender ---------------------------------------------------------------------------

export interface CalendarOptions {
	/** Mindestzahl Terminzeilen je Tag (füllt leere Wochen auf, damit die Seite gleichmäßig wirkt) */
	minLines: number;
}

const FILLER = '<span style="font-size:7.5pt">&nbsp;</span>';

function calendarLine(e: ExportEntry, day: string): string {
	const time = e.startsOn === day ? formatEventTime(e.startsTime) : '';
	const text = e.startsOn === day ? e.title : `… ${e.title}`;
	return (
		`<span style="font-size:7.5pt;background-color:${tint(e.color)};color:#111827">` +
		`${time ? `<strong>${esc(time)}</strong> ` : ''}${esc(text)}</span>`
	);
}

/** Ein Monat als Tabelle Mo–So (HTML für einen `richText`-Block) */
export function monthCalendarHtml(
	month: string,
	entries: ExportEntry[],
	o: CalendarOptions
): string {
	const sorted = [...entries].sort(compareEntries);
	const head = WEEKDAYS.slice(1)
		.map((d) => `<th style="width:14.28%;text-align:center;font-size:8pt">${d}</th>`)
		.join('');
	const rows = monthWeeks(month).map((week) => {
		const perDay = week.map((day) => sorted.filter((e) => coversDay(e, day)));
		const lines = Math.max(o.minLines, ...perDay.map((l) => l.length));
		const cells = week.map((day, i) => {
			const inMonth = day.startsWith(month);
			const weekend = isoWeekday(day) >= 6;
			const bg = !inMonth ? OUTSIDE_BG : weekend ? WEEKEND_BG : null;
			const num = `<span style="font-size:9pt;color:${inMonth ? '#111827' : MUTED}"><strong>${Number(day.slice(8, 10))}</strong></span>`;
			const items = inMonth ? perDay[i]!.map((e) => calendarLine(e, day)) : [];
			const fill = Array.from({ length: lines - items.length }, () => FILLER);
			const style = `width:14.28%${bg ? `;background-color:${bg}` : ''}`;
			return `<td style="${style}">${[num, ...items, ...fill].join('<br>')}</td>`;
		});
		return `<tr>${cells.join('')}</tr>`;
	});
	return `<table><thead><tr>${head}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

export function calendarBlocks(
	entries: ExportEntry[],
	from: string,
	to: string,
	o: CalendarOptions
): PdfBlock[] {
	const blocks: PdfBlock[] = [];
	monthsBetween(from, to).forEach((month, i) => {
		if (i > 0) blocks.push({ type: 'pageBreak' });
		blocks.push({ type: 'heading', level: 2, text: monthLabel(month) });
		blocks.push({ type: 'richText', html: monthCalendarHtml(month, entries, o) });
	});
	return blocks;
}

// --- Jahresplan -------------------------------------------------------------------------------

export interface YearOptions {
	/** Monatsspalten je Seite (12 = ganzes Jahr quer, 6 = Halbjahr hochkant) */
	monthsPerPage: number;
	/** Zeichen je Zelle (inkl. Wochentag), danach „…“ */
	cellChars: number;
}

function truncate(s: string, max: number): string {
	if (max <= 1) return '…';
	return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

/** Text einer Tageszelle: Titel der an diesem Tag beginnenden (bzw. im Monat zuerst sichtbaren) Termine */
function yearCell(day: string, month: string, entries: ExportEntry[], chars: number): string {
	const covering = entries.filter((e) => coversDay(e, day));
	const firstInMonth = `${month}-01`;
	const labelled = covering.filter(
		(e) => e.startsOn === day || (day === firstInMonth && e.startsOn < firstInMonth)
	);
	const wd = WEEKDAYS[isoWeekday(day)]!;
	const weekend = isoWeekday(day) >= 6;
	const bg = covering.length ? tint(covering[0]!.color) : weekend ? WEEKEND_BG : null;
	const text = truncate(labelled.map((e) => e.title).join(' · '), Math.max(1, chars - 3));
	const style = `font-size:6pt${bg ? `;background-color:${bg}` : ''}`;
	return (
		`<td style="${style}"><span style="color:${MUTED}">${wd}</span>` +
		`${text ? ` ${esc(text)}` : ''}</td>`
	);
}

/** Jahresplan: Zeilen = Tag 1–31, Spalten = Monate (HTML für einen `richText`-Block) */
export function yearPlanHtml(months: string[], entries: ExportEntry[], o: YearOptions): string {
	const sorted = [...entries].sort(compareEntries);
	const spansYears = new Set(months.map((m) => m.slice(0, 4))).size > 1;
	const colWidth = (92 / months.length).toFixed(2);
	const head =
		`<th style="width:8%;font-size:7pt;text-align:center">Tag</th>` +
		months
			.map((m) => {
				const i = Number(m.slice(5, 7)) - 1;
				const label = spansYears ? `${MONTHS_SHORT[i]} ${m.slice(2, 4)}` : MONTHS[i];
				return `<th style="width:${colWidth}%;font-size:7pt;text-align:center">${label}</th>`;
			})
			.join('');
	const rows: string[] = [];
	for (let d = 1; d <= 31; d++) {
		const dd = String(d).padStart(2, '0');
		const cells = months.map((m) =>
			d > daysInMonth(m)
				? `<td style="font-size:6pt;background-color:${OUTSIDE_BG}"></td>`
				: yearCell(`${m}-${dd}`, m, sorted, o.cellChars)
		);
		rows.push(
			`<tr><td style="font-size:6pt;text-align:center"><strong>${d}</strong></td>${cells.join('')}</tr>`
		);
	}
	return `<table><thead><tr>${head}</tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

export function yearBlocks(
	entries: ExportEntry[],
	from: string,
	to: string,
	o: YearOptions
): PdfBlock[] {
	const months = monthsBetween(from, to);
	const blocks: PdfBlock[] = [];
	for (let i = 0; i < months.length; i += o.monthsPerPage) {
		if (i > 0) blocks.push({ type: 'pageBreak' });
		blocks.push({
			type: 'richText',
			html: yearPlanHtml(months.slice(i, i + o.monthsPerPage), entries, o)
		});
	}
	return blocks;
}

/** Zeile unter dem Titel: Filter, Legende, Stand */
export function subtitleText(o: {
	search?: string | null;
	group?: string | null;
	tag?: string | null;
	withActions: boolean;
	today: string;
}): string {
	const parts = [
		o.group ? `Gruppe: ${o.group}` : null,
		o.tag ? `Tag: ${o.tag}` : null,
		o.search ? `Suche: „${o.search}“` : null,
		o.withActions ? 'mit Aktionen' : null,
		`Stand: ${dateDe(o.today)}`
	];
	return parts.filter(Boolean).join(' · ');
}

/** Anzahl Kalendertage im Zeitraum (einschließlich) */
export const periodDays = (from: string, to: string): number => daysBetween(from, to) + 1;
