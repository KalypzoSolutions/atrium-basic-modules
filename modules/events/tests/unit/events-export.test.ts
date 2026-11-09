import { describe, expect, it } from 'vitest';
import { sanitizeDocumentHtml } from '$lib/sdk/server';
import {
	calendarBlocks,
	exportFileName,
	exportTitle,
	listBlocks,
	monthCalendarHtml,
	monthWeeks,
	monthsBetween,
	daysInMonth,
	tint,
	yearBlocks,
	yearPlanHtml,
	type ExportEntry
} from '$modules/events/export';
import { exportQuery } from '$modules/events/schemas';

const entry = (over: Partial<ExportEntry>): ExportEntry => ({
	key: over.key ?? over.title ?? 'x',
	kind: 'event',
	title: 'Termin',
	location: null,
	description: null,
	startsOn: '2026-10-10',
	startsTime: null,
	endsOn: null,
	endsTime: null,
	color: null,
	groups: [],
	tags: [],
	recurring: false,
	...over
});

describe('Datum', () => {
	it('monthsBetween über den Jahreswechsel', () => {
		expect(monthsBetween('2026-11-15', '2027-02-01')).toEqual([
			'2026-11',
			'2026-12',
			'2027-01',
			'2027-02'
		]);
		expect(monthsBetween('2026-10-01', '2026-10-31')).toEqual(['2026-10']);
	});

	it('daysInMonth mit Schaltjahr', () => {
		expect(daysInMonth('2028-02')).toBe(29);
		expect(daysInMonth('2027-02')).toBe(28);
		expect(daysInMonth('2026-04')).toBe(30);
	});

	it('monthWeeks: Wochen Mo–So inkl. Randtage', () => {
		// Februar 2027 beginnt Montag und endet Sonntag → genau 4 Wochen
		expect(monthWeeks('2027-02')).toHaveLength(4);
		const nov = monthWeeks('2026-11'); // 01.11.2026 ist ein Sonntag
		expect(nov[0]![0]).toBe('2026-10-26');
		expect(nov[0]![6]).toBe('2026-11-01');
		expect(nov).toHaveLength(6);
	});
});

describe('Titel und Dateiname', () => {
	it('erkennt Monat, Jahr und freien Zeitraum', () => {
		expect(exportTitle('list', '2026-11-01', '2026-11-30')).toBe('Termine November 2026');
		expect(exportTitle('year', '2027-01-01', '2027-12-31')).toBe('Jahresplan 2027');
		expect(exportTitle('calendar', '2026-08-01', '2027-07-31')).toBe(
			'Monatskalender 01.08.2026 – 31.07.2027'
		);
		expect(exportFileName('year', '2027-01-01', '2027-12-31')).toBe('jahresplan-2027.pdf');
		expect(exportFileName('list', '2026-11-01', '2026-11-30')).toBe('termine-2026-11.pdf');
		expect(exportFileName('calendar', '2026-08-01', '2027-07-31')).toBe(
			'monatskalender-2026-08-01_2027-07-31.pdf'
		);
	});
});

describe('tint', () => {
	it('mischt mit Weiß, ungültig → Standardfarbe', () => {
		expect(tint('#000000', 0.5)).toBe('#808080');
		expect(tint('#ffffff')).toBe('#ffffff');
		expect(tint('rot')).toBe(tint('#64748b'));
	});
});

describe('Schema', () => {
	const ok = (q: Record<string, string>) => exportQuery.safeParse(q).success;
	it('Zeitraum höchstens 400 Tage, Ende nicht vor Beginn', () => {
		expect(ok({ layout: 'year', from: '2026-08-01', to: '2027-07-31' })).toBe(true);
		expect(ok({ layout: 'year', from: '2026-01-01', to: '2027-02-04' })).toBe(true); // 400 Tage
		expect(ok({ layout: 'year', from: '2026-01-01', to: '2027-02-05' })).toBe(false); // 401 Tage
		expect(ok({ layout: 'list', from: '2026-10-02', to: '2026-10-01' })).toBe(false);
		expect(ok({ layout: 'list', from: '2026-02-30', to: '2026-03-01' })).toBe(false);
	});
	it('Wahrheitswerte als Text', () => {
		const q = exportQuery.parse({
			layout: 'list',
			from: '2026-10-01',
			to: '2026-10-31',
			includeActions: 'false',
			letterhead: '1'
		});
		expect(q.includeActions).toBe(false);
		expect(q.letterhead).toBe(true);
		expect(q.withDescription).toBeUndefined();
	});
});

describe('Terminliste', () => {
	it('je Monat Überschrift und Tabelle, mehrtägig und Serie gekennzeichnet', () => {
		const blocks = listBlocks(
			[
				entry({
					title: 'B',
					startsOn: '2026-11-03',
					startsTime: '17:00',
					endsTime: '18:30',
					recurring: true
				}),
				entry({ title: 'Lager', startsOn: '2026-09-28', endsOn: '2026-10-02', kind: 'action' }),
				entry({ title: 'A', startsOn: '2026-10-10', startsTime: '15:00', groups: ['Wölflinge'] })
			],
			{ from: '2026-10-01', to: '2026-11-30', withDescription: false }
		);
		expect(blocks.map((b) => b.type)).toEqual(['heading', 'table', 'heading', 'table']);
		expect(blocks[0]).toMatchObject({ text: 'Oktober 2026' });
		const oct = blocks[1] as { rows: string[][]; columns: string[] };
		expect(oct.columns).not.toContain('Beschreibung');
		// Lager beginnt vor dem Zeitraum und steht im ersten Monat
		expect(oct.rows[0]).toEqual(['Mo 28.09. – Fr 02.10.', '', 'Lager (Aktion)', '', 'Aktion']);
		expect(oct.rows[1]).toEqual(['Sa 10.10.', 'ab 15:00', 'A', '', 'Wölflinge']);
		const nov = blocks[3] as { rows: string[][] };
		expect(nov.rows[0]!.slice(0, 3)).toEqual(['Di 03.11.', '17:00 – 18:30', 'B (Serie)']);
	});

	it('leer → keine Blöcke', () => {
		expect(listBlocks([], { from: '2026-10-01', to: '2026-10-31', withDescription: true })).toEqual(
			[]
		);
	});
});

describe('Monatskalender', () => {
	it('mehrtägig an jedem Tag, Zellen gleich hoch aufgefüllt, Text maskiert', () => {
		const html = monthCalendarHtml(
			'2026-10',
			[
				entry({
					title: '<b>Fahrt</b>',
					startsOn: '2026-10-23',
					endsOn: '2026-10-25',
					color: '#ff0000'
				}),
				entry({ title: 'Treffen', startsOn: '2026-10-23', startsTime: '18:00' })
			],
			{ minLines: 3 }
		);
		expect(html).toContain('&lt;b&gt;Fahrt&lt;/b&gt;');
		expect(html).toContain('… &lt;b&gt;Fahrt');
		expect(html).toContain('<strong>18:00</strong> Treffen');
		expect(html).not.toContain('<b>Fahrt');
		// 5 Wochen (Oktober 2026: Do 01. bis Sa 31.)
		expect(html.match(/<tr>/g)).toHaveLength(6);
		// jede Zelle hat dieselbe Zahl Zeilen (Tageszahl + 3)
		const cells = html.split('<td').slice(1);
		for (const c of cells) expect(c.split('<br>').length).toBe(4);
	});

	it('überlebt die Bereinigung des Core unverändert (nur erlaubte Styles)', () => {
		const html = monthCalendarHtml('2026-10', [entry({ color: '#2563eb' })], { minLines: 2 });
		expect(sanitizeDocumentHtml(html).replace(/\s/g, '')).toBe(html.replace(/\s/g, ''));
	});

	it('je Monat ein Seitenumbruch', () => {
		const blocks = calendarBlocks([], '2026-10-01', '2026-12-31', { minLines: 2 });
		expect(blocks.filter((b) => b.type === 'pageBreak')).toHaveLength(2);
	});
});

describe('Jahresplan', () => {
	const months = monthsBetween('2026-01-01', '2026-12-31');

	it('31 Zeilen, fehlende Tage leer, Titel am ersten Tag und gekürzt', () => {
		const html = yearPlanHtml(
			months,
			[
				entry({
					title: 'Sommerlager im Harz mit allen',
					startsOn: '2026-07-30',
					endsOn: '2026-08-03',
					color: '#16a34a'
				})
			],
			{ monthsPerPage: 12, cellChars: 12 }
		);
		expect(html.match(/<tr>/g)).toHaveLength(32);
		expect(html).toContain('Januar');
		expect(html).toContain('Sommerla…');
		// am 01.08. erscheint der Titel erneut (Fortsetzung im neuen Monat)
		expect(html.match(/Sommerla…/g)).toHaveLength(2);
		const tinted = tint('#16a34a');
		expect(html.split(tinted).length - 1).toBe(5);
		expect(sanitizeDocumentHtml(html).replace(/\s/g, '')).toBe(html.replace(/\s/g, ''));
	});

	it('Monate über Jahresgrenze mit Jahr; mehr als 12 Monate → zweite Seite', () => {
		const html = yearPlanHtml(['2026-12', '2027-01'], [], { monthsPerPage: 12, cellChars: 18 });
		expect(html).toContain('Dez 26');
		expect(html).toContain('Jan 27');
		const blocks = yearBlocks([], '2026-08-01', '2027-08-31', { monthsPerPage: 12, cellChars: 18 });
		expect(blocks.map((b) => b.type)).toEqual(['richText', 'pageBreak', 'richText']);
		const half = yearBlocks([], '2026-01-01', '2026-12-31', { monthsPerPage: 6, cellChars: 20 });
		expect(half.filter((b) => b.type === 'richText')).toHaveLength(2);
	});
});
