/**
 * iCalendar-Ausgabe des Kalender-Abos (`events/ical.ts`): Maskierung, Zeilenfaltung (UTF-8-sicher,
 * 75 Bytes), DTSTART/DTEND für ganztägige, mehrtägige und Termine ohne Ende, Kalenderrahmen.
 */
import { describe, expect, it } from 'vitest';
import {
	buildCalendar,
	escapeText,
	eventTimes,
	foldLine,
	utcStamp,
	type IcsEvent
} from '$modules/events/ical';

const ev = (over: Partial<IcsEvent> = {}): IcsEvent => ({
	uid: 'a@x',
	title: 'Gruppenstunde',
	startsOn: '2026-10-29',
	startsTime: null,
	endsOn: null,
	endsTime: null,
	...over
});

describe('escapeText und foldLine', () => {
	it('maskiert Backslash, Semikolon, Komma, Zeilenumbrüche; entfernt Steuerzeichen', () => {
		expect(escapeText('a\\b;c,d\r\ne\nf\u0007g')).toBe('a\\\\b\\;c\\,d\\ne\\nfg');
	});

	it('faltet nach 75 Bytes, Folgezeilen mit Leerzeichen, ohne UTF-8-Zeichen zu teilen', () => {
		const line = `SUMMARY:${'ä'.repeat(60)}`;
		const folded = foldLine(line);
		const parts = folded.split('\r\n');
		expect(parts.length).toBeGreaterThan(1);
		for (const [i, p] of parts.entries()) {
			expect(new TextEncoder().encode(p).length).toBeLessThanOrEqual(75);
			if (i > 0) expect(p.startsWith(' ')).toBe(true);
		}
		expect(parts.map((p, i) => (i ? p.slice(1) : p)).join('')).toBe(line);
		expect(foldLine('KURZ:x')).toBe('KURZ:x');
	});

	it('utcStamp', () => {
		expect(utcStamp(new Date('2026-10-24T12:34:56.789Z'))).toBe('20261024T123456Z');
	});
});

describe('eventTimes', () => {
	it('ganztägig: Ende exklusiv (Tag danach), mehrtägig bis nach dem letzten Tag', () => {
		expect(eventTimes(ev())).toEqual({
			start: 'DTSTART;VALUE=DATE:20261029',
			end: 'DTEND;VALUE=DATE:20261030'
		});
		expect(eventTimes(ev({ endsOn: '2026-11-01' })).end).toBe('DTEND;VALUE=DATE:20261102');
	});

	it('mit Uhrzeit in Europe/Berlin; ohne Ende eine Stunde; Tagesüberlauf', () => {
		expect(
			eventTimes(ev({ startsTime: '17:00', endsOn: '2026-10-29', endsTime: '18:30' }))
		).toEqual({
			start: 'DTSTART;TZID=Europe/Berlin:20261029T170000',
			end: 'DTEND;TZID=Europe/Berlin:20261029T183000'
		});
		expect(eventTimes(ev({ startsTime: '17:00' })).end).toBe(
			'DTEND;TZID=Europe/Berlin:20261029T180000'
		);
		expect(eventTimes(ev({ startsTime: '23:30' })).end).toBe(
			'DTEND;TZID=Europe/Berlin:20261030T003000'
		);
	});

	it('mehrtägig ohne Enduhrzeit: bis Mitternacht nach dem letzten Tag; Ende vor Beginn → eine Stunde', () => {
		expect(eventTimes(ev({ startsTime: '17:00', endsOn: '2026-11-01' })).end).toBe(
			'DTEND;TZID=Europe/Berlin:20261102T000000'
		);
		expect(
			eventTimes(ev({ startsTime: '17:00', endsOn: '2026-10-29', endsTime: '16:00' })).end
		).toBe('DTEND;TZID=Europe/Berlin:20261029T180000');
	});
});

describe('buildCalendar', () => {
	it('Rahmen, Zeitzone, Felder, CRLF', () => {
		const ics = buildCalendar({
			name: 'Stamm, Termine',
			description: 'Abo',
			now: new Date('2026-10-24T10:00:00Z'),
			events: [
				ev({
					uid: 'e1-2026-10-29@events.x',
					title: 'Treffen; mit Komma, bitte',
					location: 'Heim',
					description: 'Zeile 1\nZeile 2',
					url: 'https://intern.example/modules/events?event=e1',
					categories: ['Wölflinge', 'A,B'],
					startsTime: '17:00',
					updatedAt: '2026-10-20T08:00:00.000Z'
				})
			]
		});
		expect(ics.endsWith('\r\n')).toBe(true);
		expect(ics.split('\r\n').every((l) => !l.includes('\n'))).toBe(true);
		for (const line of [
			'BEGIN:VCALENDAR',
			'VERSION:2.0',
			'METHOD:PUBLISH',
			'X-WR-CALNAME:Stamm\\, Termine',
			'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
			'TZID:Europe/Berlin',
			'BEGIN:VEVENT',
			'UID:e1-2026-10-29@events.x',
			'DTSTAMP:20261024T100000Z',
			'DTSTART;TZID=Europe/Berlin:20261029T170000',
			'SUMMARY:Treffen\\; mit Komma\\, bitte',
			'LOCATION:Heim',
			'DESCRIPTION:Zeile 1\\nZeile 2',
			'URL:https://intern.example/modules/events?event=e1',
			'CATEGORIES:Wölflinge,A\\,B',
			'LAST-MODIFIED:20261020T080000Z',
			'END:VEVENT',
			'END:VCALENDAR'
		]) {
			expect(ics.split('\r\n'), line).toContain(line);
		}
	});

	it('leerer Kalender ist gültig; Titel fehlt → Platzhalter', () => {
		const empty = buildCalendar({ name: 'Leer', events: [] });
		expect(empty).toContain('BEGIN:VCALENDAR');
		expect(empty).not.toContain('BEGIN:VEVENT');
		expect(buildCalendar({ name: 'x', events: [ev({ title: '' })] })).toContain(
			'SUMMARY:(ohne Titel)'
		);
	});
});
