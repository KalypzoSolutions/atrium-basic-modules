/**
 * iCalendar (RFC 5545) für das Kalender-Abo – rein, ohne Core-Zugriffe (Server, Tests).
 *
 * - Zeiten in `Europe/Berlin` (`TZID` + mitgelieferte `VTIMEZONE`), ganztägige Termine als `VALUE=DATE`
 *   mit exklusivem Ende (Tag danach).
 * - Serien werden **nicht** als `RRULE` geschrieben, sondern je Vorkommen als eigenes `VEVENT` (stabile UID
 *   aus Termin-ID + ursprünglichem Datum). So stimmen Absagen und einzeln geänderte Termine in jedem Kalender.
 * - Text maskiert (`\\ ; , \n`), Zeilen nach 75 Bytes gefaltet (UTF-8-sicher), Zeilenende CRLF.
 */
import { addDays } from './recurrence';

export interface IcsEvent {
	/** Weltweit eindeutig und stabil (Kalender aktualisieren darüber) */
	uid: string;
	title: string;
	description?: string | null;
	location?: string | null;
	url?: string | null;
	categories?: string[];
	/** JJJJ-MM-TT */
	startsOn: string;
	/** HH:MM oder `null` = ganztägig */
	startsTime: string | null;
	endsOn: string | null;
	endsTime: string | null;
	/** ISO-Zeitstempel der letzten Änderung */
	updatedAt?: string | null;
}

export interface IcsCalendar {
	name: string;
	description?: string | null;
	events: IcsEvent[];
	/** Zeitpunkt der Erzeugung (DTSTAMP) */
	now?: Date;
}

const TZID = 'Europe/Berlin';

const VTIMEZONE = [
	'BEGIN:VTIMEZONE',
	`TZID:${TZID}`,
	'BEGIN:DAYLIGHT',
	'TZOFFSETFROM:+0100',
	'TZOFFSETTO:+0200',
	'TZNAME:CEST',
	'DTSTART:19700329T020000',
	'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
	'END:DAYLIGHT',
	'BEGIN:STANDARD',
	'TZOFFSETFROM:+0200',
	'TZOFFSETTO:+0100',
	'TZNAME:CET',
	'DTSTART:19701025T030000',
	'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
	'END:STANDARD',
	'END:VTIMEZONE'
];

/** Text-Wert maskieren (RFC 5545 3.3.11); Steuerzeichen außer Zeilenumbruch entfallen */
export function escapeText(value: string): string {
	return (
		value
			.replace(/\r\n?/g, '\n')
			// eslint-disable-next-line no-control-regex
			.replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '')
			.replace(/\\/g, '\\\\')
			.replace(/;/g, '\\;')
			.replace(/,/g, '\\,')
			.replace(/\n/g, '\\n')
	);
}

/** Zeile nach höchstens 75 Bytes falten (Folgezeilen beginnen mit einem Leerzeichen), ohne UTF-8-Zeichen zu teilen */
export function foldLine(line: string): string {
	const enc = new TextEncoder();
	if (enc.encode(line).length <= 75) return line;
	const parts: string[] = [];
	let current = '';
	let bytes = 0;
	let limit = 75;
	for (const ch of line) {
		const n = enc.encode(ch).length;
		if (bytes + n > limit) {
			parts.push(current);
			current = '';
			bytes = 0;
			limit = 74; // Folgezeilen: ein Byte für das führende Leerzeichen
		}
		current += ch;
		bytes += n;
	}
	parts.push(current);
	return parts.join('\r\n ');
}

const compactDate = (iso: string) => iso.replace(/-/g, '');
const localDateTime = (date: string, time: string) =>
	`${compactDate(date)}T${time.replace(':', '')}00`;

/** UTC-Zeitstempel `20261024T120000Z` */
export function utcStamp(d: Date): string {
	return d
		.toISOString()
		.replace(/[-:]/g, '')
		.replace(/\.\d{3}Z$/, 'Z');
}

/** HH:MM + Minuten → { date, time } (Tagesüberlauf beachtet) */
function plusMinutes(date: string, time: string, minutes: number): { date: string; time: string } {
	const [h, m] = time.split(':').map(Number) as [number, number];
	const total = h * 60 + m + minutes;
	const days = Math.floor(total / 1440);
	const rest = total - days * 1440;
	const hh = String(Math.floor(rest / 60)).padStart(2, '0');
	const mm = String(rest % 60).padStart(2, '0');
	return { date: days ? addDays(date, days) : date, time: `${hh}:${mm}` };
}

/** DTSTART/DTEND eines Termins */
export function eventTimes(e: IcsEvent): { start: string; end: string } {
	if (!e.startsTime) {
		// Ganztägig: Ende exklusiv (Tag nach dem letzten Tag)
		const last = e.endsOn && e.endsOn > e.startsOn ? e.endsOn : e.startsOn;
		return {
			start: `DTSTART;VALUE=DATE:${compactDate(e.startsOn)}`,
			end: `DTEND;VALUE=DATE:${compactDate(addDays(last, 1))}`
		};
	}
	const start = `DTSTART;TZID=${TZID}:${localDateTime(e.startsOn, e.startsTime)}`;
	let endDate: string;
	let endTime: string;
	if (e.endsTime) {
		endDate = e.endsOn ?? e.startsOn;
		endTime = e.endsTime;
	} else if (e.endsOn && e.endsOn > e.startsOn) {
		// Mehrtägig ohne Enduhrzeit: bis zum Ende des letzten Tages
		endDate = addDays(e.endsOn, 1);
		endTime = '00:00';
	} else {
		// Nur Beginn bekannt: eine Stunde
		({ date: endDate, time: endTime } = plusMinutes(e.startsOn, e.startsTime, 60));
	}
	if (`${endDate}T${endTime}` <= `${e.startsOn}T${e.startsTime}`) {
		({ date: endDate, time: endTime } = plusMinutes(e.startsOn, e.startsTime, 60));
	}
	return { start, end: `DTEND;TZID=${TZID}:${localDateTime(endDate, endTime)}` };
}

/** Komplettes `VCALENDAR` als Text (CRLF) */
export function buildCalendar(cal: IcsCalendar): string {
	const stamp = utcStamp(cal.now ?? new Date());
	const lines: string[] = [
		'BEGIN:VCALENDAR',
		'VERSION:2.0',
		'PRODID:-//EP Intern//Kalender-Abo//DE',
		'CALSCALE:GREGORIAN',
		'METHOD:PUBLISH',
		`X-WR-CALNAME:${escapeText(cal.name)}`,
		`X-WR-TIMEZONE:${TZID}`,
		'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
		'X-PUBLISHED-TTL:PT1H',
		...(cal.description ? [`X-WR-CALDESC:${escapeText(cal.description)}`] : []),
		...VTIMEZONE
	];
	for (const e of cal.events) {
		const { start, end } = eventTimes(e);
		lines.push(
			'BEGIN:VEVENT',
			`UID:${escapeText(e.uid)}`,
			`DTSTAMP:${stamp}`,
			start,
			end,
			`SUMMARY:${escapeText(e.title || '(ohne Titel)')}`
		);
		if (e.location) lines.push(`LOCATION:${escapeText(e.location)}`);
		if (e.description) lines.push(`DESCRIPTION:${escapeText(e.description)}`);
		if (e.url) lines.push(`URL:${e.url}`);
		const cats = (e.categories ?? []).map(escapeText).filter(Boolean);
		if (cats.length) lines.push(`CATEGORIES:${cats.join(',')}`);
		if (e.updatedAt) {
			const d = new Date(e.updatedAt);
			if (!Number.isNaN(d.getTime())) lines.push(`LAST-MODIFIED:${utcStamp(d)}`);
		}
		lines.push('END:VEVENT');
	}
	lines.push('END:VCALENDAR');
	return lines.map(foldLine).join('\r\n') + '\r\n';
}
