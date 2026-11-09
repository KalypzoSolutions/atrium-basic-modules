import { describe, expect, it } from 'vitest';
import {
	addDays,
	daysBetween,
	describeRecurrence,
	expandOccurrences,
	isOccurrence,
	isoWeekday,
	lastOccurrence,
	minGapDays,
	nextWeekday
} from '$modules/events/recurrence';
import { recurrenceRule, type EventDates, type RecurrenceRuleInput } from '$modules/events/schemas';

// Kalender 2026 zum Nachrechnen: 01.01. Do, 01.02. So, 01.03. So, 01.04. Mi, 01.05. Fr, 01.06. Mo,
// 01.07. Mi, 01.10. Do, 01.11. So, 01.12. Di.

const rule = (r: RecurrenceRuleInput) => recurrenceRule.parse(r);
const day = (startsOn: string, endsOn: string | null = null): EventDates => ({
	startsOn,
	startsTime: null,
	endsOn,
	endsTime: null
});
const dates = (
	start: EventDates,
	r: RecurrenceRuleInput,
	from: string,
	to: string,
	max = 2000
): string[] => expandOccurrences(start, rule(r), from, to, max).map((o) => o.date);

describe('Datums-Helfer', () => {
	it('daysBetween / addDays über Monats-, Jahres- und Schaltjahresgrenzen', () => {
		expect(daysBetween('2026-02-28', '2026-03-01')).toBe(1);
		expect(daysBetween('2024-02-28', '2024-03-01')).toBe(2);
		expect(daysBetween('2026-11-10', '2026-11-03')).toBe(-7);
		expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
		expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
		expect(addDays('2026-03-28', 2)).toBe('2026-03-30'); // Zeitumstellung egal (UTC)
	});

	it('isoWeekday / nextWeekday', () => {
		expect(isoWeekday('2026-11-01')).toBe(7); // Sonntag
		expect(isoWeekday('2026-11-02')).toBe(1); // Montag
		expect(isoWeekday('1900-01-01')).toBe(1); // Montag
		expect(nextWeekday('2026-11-03', 2)).toBe('2026-11-03'); // Di bleibt
		expect(nextWeekday('2026-11-04', 2)).toBe('2026-11-10');
		expect(nextWeekday('2026-11-07', 7)).toBe('2026-11-08');
	});
});

describe('expandOccurrences – Rhythmen', () => {
	it('täglich und alle 3 Tage', () => {
		expect(dates(day('2026-11-03'), { freq: 'daily' }, '2026-11-01', '2026-11-05')).toEqual([
			'2026-11-03',
			'2026-11-04',
			'2026-11-05'
		]);
		expect(
			dates(day('2026-11-03'), { freq: 'daily', interval: 3 }, '2026-11-01', '2026-11-12')
		).toEqual(['2026-11-03', '2026-11-06', '2026-11-09', '2026-11-12']);
	});

	it('wöchentlich am Wochentag des Starts (03.11.2026 = Dienstag)', () => {
		expect(dates(day('2026-11-03'), { freq: 'weekly' }, '2026-11-01', '2026-11-30')).toEqual([
			'2026-11-03',
			'2026-11-10',
			'2026-11-17',
			'2026-11-24'
		]);
	});

	it('alle 2 Wochen Di+Do: Wochen ab Mo 02.11. → Woche 0, 2, 4', () => {
		expect(
			dates(
				day('2026-11-03'),
				{ freq: 'weekly', interval: 2, byWeekday: [4, 2] },
				'2026-11-01',
				'2026-12-03'
			)
		).toEqual(['2026-11-03', '2026-11-05', '2026-11-17', '2026-11-19', '2026-12-01', '2026-12-03']);
	});

	it('Start nicht in byWeekday: Mi 04.11. mit Di+Do beginnt am Do 05.11.', () => {
		const start = day('2026-11-04');
		const r: RecurrenceRuleInput = { freq: 'weekly', byWeekday: [2, 4] };
		expect(dates(start, r, '2026-11-01', '2026-11-12')).toEqual([
			'2026-11-05',
			'2026-11-10',
			'2026-11-12'
		]);
		expect(isOccurrence(start, rule(r), '2026-11-04')).toBe(false);
	});

	it('Wochenzählung ab Montag der Startwoche: So 01.11., alle 2 Wochen montags', () => {
		// Startwoche beginnt Mo 26.10. (vor dem Start, fällt weg) → Woche 2 = Mo 09.11., Woche 4 = 23.11.
		expect(
			dates(
				day('2026-11-01'),
				{ freq: 'weekly', interval: 2, byWeekday: [1] },
				'2026-10-01',
				'2026-11-30'
			)
		).toEqual(['2026-11-09', '2026-11-23']);
	});

	it('monatlich am 15. mit Anzahl', () => {
		expect(
			dates(
				day('2026-01-15'),
				{ freq: 'monthly', end: { type: 'count', count: 3 } },
				'2026-01-01',
				'2026-12-31'
			)
		).toEqual(['2026-01-15', '2026-02-15', '2026-03-15']);
	});

	it('monatlich am 31.: Monate ohne 31. fallen aus', () => {
		expect(dates(day('2026-01-31'), { freq: 'monthly' }, '2026-01-01', '2026-08-31')).toEqual([
			'2026-01-31',
			'2026-03-31',
			'2026-05-31',
			'2026-07-31',
			'2026-08-31'
		]);
	});

	it('alle 2 Monate am 31.: Jan, Mrz, Mai, Jul (Sep/Nov haben keinen 31.), dann Jan', () => {
		expect(
			dates(day('2026-01-31'), { freq: 'monthly', interval: 2 }, '2026-01-01', '2027-01-31')
		).toEqual(['2026-01-31', '2026-03-31', '2026-05-31', '2026-07-31', '2027-01-31']);
	});

	it('jährlich am 29.02.: nur in Schaltjahren', () => {
		expect(dates(day('2024-02-29'), { freq: 'yearly' }, '2024-01-01', '2032-12-31')).toEqual([
			'2024-02-29',
			'2028-02-29',
			'2032-02-29'
		]);
	});

	it('jährlich am 24.12.', () => {
		expect(dates(day('2026-12-24'), { freq: 'yearly' }, '2026-01-01', '2028-12-31')).toEqual([
			'2026-12-24',
			'2027-12-24',
			'2028-12-24'
		]);
	});

	it('n-ter Wochentag: 1. Samstag (07.11.2026) → 05.12., 02.01.2027', () => {
		expect(
			dates(
				day('2026-11-07'),
				{ freq: 'monthly', monthlyMode: 'nth-weekday' },
				'2026-11-01',
				'2027-01-31'
			)
		).toEqual(['2026-11-07', '2026-12-05', '2027-01-02']);
	});

	it('5. Donnerstag (29.01.2026) fällt in Monaten ohne 5. Donnerstag aus', () => {
		// Feb: Do 5/12/19/26, Mrz: 5–26, Apr: 2–30 ✓, Mai: 7–28, Jun: 4–25, Jul: 2–30 ✓
		expect(
			dates(
				day('2026-01-29'),
				{ freq: 'monthly', monthlyMode: 'nth-weekday' },
				'2026-01-01',
				'2026-07-31'
			)
		).toEqual(['2026-01-29', '2026-04-30', '2026-07-30']);
	});

	it('letzter Freitag (30.10.2026) → 27.11., 25.12.', () => {
		// 30.11. ist Mo → Fr 27.11.; 31.12. ist Do → Fr 25.12.
		expect(
			dates(
				day('2026-10-30'),
				{ freq: 'monthly', monthlyMode: 'last-weekday' },
				'2026-10-01',
				'2026-12-31'
			)
		).toEqual(['2026-10-30', '2026-11-27', '2026-12-25']);
	});

	it('jährlich am 2. Sonntag im Mai (Muttertag)', () => {
		// 01.05.2027 Sa → So 02., 09.; 01.05.2028 Mo → So 07., 14.
		expect(
			dates(
				day('2026-05-10'),
				{ freq: 'yearly', monthlyMode: 'nth-weekday' },
				'2026-01-01',
				'2028-12-31'
			)
		).toEqual(['2026-05-10', '2027-05-09', '2028-05-14']);
	});

	it('jährlich am letzten Sonntag im Oktober', () => {
		// 31.10.2027 So; 31.10.2028 Di → So 29.10.
		expect(
			dates(
				day('2026-10-25'),
				{ freq: 'yearly', monthlyMode: 'last-weekday' },
				'2026-01-01',
				'2028-12-31'
			)
		).toEqual(['2026-10-25', '2027-10-31', '2028-10-29']);
	});
});

describe('expandOccurrences – Ende, Fenster, Grenzen', () => {
	it('until ist inklusive, never läuft bis zum Fensterende', () => {
		const start = day('2026-11-03');
		expect(
			dates(
				start,
				{ freq: 'weekly', end: { type: 'until', date: '2026-11-17' } },
				'2026-11-01',
				'2026-12-31'
			)
		).toEqual(['2026-11-03', '2026-11-10', '2026-11-17']);
		expect(dates(start, { freq: 'weekly' }, '2026-11-01', '2026-12-31')).toHaveLength(9);
	});

	it('count zählt ab dem Start, auch wenn das Fenster später beginnt', () => {
		// 10 Tage ab 01.11. → 01.–10.11.; Fenster ab 08.11. → 08., 09., 10.
		expect(
			dates(
				day('2026-11-01'),
				{ freq: 'daily', end: { type: 'count', count: 10 } },
				'2026-11-08',
				'2026-12-31'
			)
		).toEqual(['2026-11-08', '2026-11-09', '2026-11-10']);
	});

	it('mehrtägige Vorkommen: Überlappung am Fensterrand, endsOn verschoben', () => {
		const start = day('2026-11-06', '2026-11-08'); // Fr–So
		const r = rule({ freq: 'weekly' });
		expect(expandOccurrences(start, r, '2026-11-15', '2026-11-15', 10)).toEqual([
			{ date: '2026-11-13', startsOn: '2026-11-13', endsOn: '2026-11-15' }
		]);
		expect(expandOccurrences(start, r, '2026-11-16', '2026-11-19', 10)).toEqual([]);
		expect(expandOccurrences(start, r, '2026-11-19', '2026-11-20', 10)).toEqual([
			{ date: '2026-11-20', startsOn: '2026-11-20', endsOn: '2026-11-22' }
		]);
	});

	it('endsOn null bleibt null; Fenster vor dem Start bzw. to < from → leer', () => {
		const occ = expandOccurrences(
			day('2026-11-03'),
			rule({ freq: 'daily' }),
			'2026-11-03',
			'2026-11-03',
			5
		);
		expect(occ).toEqual([{ date: '2026-11-03', startsOn: '2026-11-03', endsOn: null }]);
		expect(dates(day('2026-11-03'), { freq: 'daily' }, '2026-10-01', '2026-11-02')).toEqual([]);
		expect(dates(day('2026-11-03'), { freq: 'daily' }, '2026-11-10', '2026-11-05')).toEqual([]);
	});

	it('max begrenzt die Anzahl', () => {
		expect(dates(day('2026-01-01'), { freq: 'daily' }, '2026-01-01', '2026-12-31', 5)).toEqual([
			'2026-01-01',
			'2026-01-02',
			'2026-01-03',
			'2026-01-04',
			'2026-01-05'
		]);
		expect(dates(day('2026-01-01'), { freq: 'daily' }, '2026-01-01', '2026-12-31', 0)).toEqual([]);
	});

	it('offene Serie ab 1900 mit fernem from ist schnell (< 50 ms)', () => {
		const t0 = performance.now();
		// 1900-01-01 ist Montag
		expect(dates(day('1900-01-01'), { freq: 'daily' }, '2026-11-01', '2026-11-03')).toEqual([
			'2026-11-01',
			'2026-11-02',
			'2026-11-03'
		]);
		expect(
			dates(
				day('1900-01-01'),
				{ freq: 'weekly', interval: 2, byWeekday: [2] },
				'2026-11-01',
				'2026-11-30'
			)
		).toHaveLength(2);
		expect(dates(day('1900-01-15'), { freq: 'monthly' }, '2026-11-01', '2026-12-31')).toEqual([
			'2026-11-15',
			'2026-12-15'
		]);
		expect(dates(day('1900-12-24'), { freq: 'yearly' }, '2026-01-01', '2026-12-31')).toEqual([
			'2026-12-24'
		]);
		expect(performance.now() - t0).toBeLessThan(50);
	});

	it('alle 2 Wochen ab 1900: Wochenparität stimmt', () => {
		// Di 1900-01-02 liegt in Woche 0 (ab Mo 1900-01-01); Wochenindex eines späteren Dienstags =
		// Tagesabstand / 7, Vorkommen genau bei geradem Index.
		const start = day('1900-01-02');
		const r = rule({ freq: 'weekly', interval: 2 });
		const weeks = daysBetween('1900-01-02', '2026-11-03') / 7; // ganzzahlig, da beide Dienstag
		expect(Number.isInteger(weeks)).toBe(true);
		expect(isOccurrence(start, r, '2026-11-03')).toBe(weeks % 2 === 0);
		expect(isOccurrence(start, r, '2026-11-10')).toBe(weeks % 2 === 1);
	});
});

describe('isOccurrence', () => {
	const start = day('2026-11-03');
	it('weekly Di+Do alle 2 Wochen', () => {
		const r = rule({ freq: 'weekly', interval: 2, byWeekday: [2, 4] });
		expect(isOccurrence(start, r, '2026-11-03')).toBe(true);
		expect(isOccurrence(start, r, '2026-11-05')).toBe(true);
		expect(isOccurrence(start, r, '2026-11-10')).toBe(false);
		expect(isOccurrence(start, r, '2026-11-17')).toBe(true);
		expect(isOccurrence(start, r, '2026-10-27')).toBe(false); // vor dem Start
	});
	it('count und until', () => {
		const counted = rule({ freq: 'daily', end: { type: 'count', count: 3 } });
		expect(isOccurrence(start, counted, '2026-11-05')).toBe(true);
		expect(isOccurrence(start, counted, '2026-11-06')).toBe(false);
		const until = rule({ freq: 'weekly', end: { type: 'until', date: '2026-11-10' } });
		expect(isOccurrence(start, until, '2026-11-10')).toBe(true);
		expect(isOccurrence(start, until, '2026-11-17')).toBe(false);
	});
	it('monatlich am 31. nicht im April', () => {
		const r = rule({ freq: 'monthly' });
		expect(isOccurrence(day('2026-01-31'), r, '2026-04-30')).toBe(false);
		expect(isOccurrence(day('2026-01-31'), r, '2026-05-31')).toBe(true);
	});
});

describe('lastOccurrence', () => {
	const start = day('2026-11-03');
	it('never → null', () => {
		expect(lastOccurrence(start, rule({ freq: 'weekly' }))).toBeNull();
	});
	it('until → letztes ≤ until', () => {
		expect(
			lastOccurrence(start, rule({ freq: 'weekly', end: { type: 'until', date: '2026-11-24' } }))
		).toBe('2026-11-24');
		expect(
			lastOccurrence(start, rule({ freq: 'weekly', end: { type: 'until', date: '2026-11-23' } }))
		).toBe('2026-11-17');
		// 31. bis 30.06. → 31.05.
		expect(
			lastOccurrence(
				day('2026-01-31'),
				rule({ freq: 'monthly', end: { type: 'until', date: '2026-06-30' } })
			)
		).toBe('2026-05-31');
		// 29.02.2024 bis 2031 → 2028 (Lücke > 400 Tage, Fenster wächst)
		expect(
			lastOccurrence(
				day('2024-02-29'),
				rule({ freq: 'yearly', end: { type: 'until', date: '2031-12-31' } })
			)
		).toBe('2028-02-29');
		// täglich über Jahrzehnte
		expect(
			lastOccurrence(
				day('1950-01-01'),
				rule({ freq: 'daily', interval: 7, end: { type: 'until', date: '2026-11-04' } })
			)
		).toBe(addDays('1950-01-01', Math.floor(daysBetween('1950-01-01', '2026-11-04') / 7) * 7));
	});
	it('count → n-tes Vorkommen', () => {
		expect(lastOccurrence(start, rule({ freq: 'weekly', end: { type: 'count', count: 3 } }))).toBe(
			'2026-11-17'
		);
		expect(
			lastOccurrence(
				day('2026-01-29'),
				rule({ freq: 'monthly', monthlyMode: 'nth-weekday', end: { type: 'count', count: 3 } })
			)
		).toBe('2026-07-30');
	});
});

describe('minGapDays', () => {
	const tue = '2026-11-03';
	it('je Rhythmus', () => {
		expect(minGapDays(rule({ freq: 'daily', interval: 3 }), tue)).toBe(3);
		expect(minGapDays(rule({ freq: 'weekly' }), tue)).toBe(7);
		expect(minGapDays(rule({ freq: 'weekly', interval: 2 }), tue)).toBe(14);
		// Di+Do: 2 bzw. Umbruch 2+7-4 = 5 → 2
		expect(minGapDays(rule({ freq: 'weekly', byWeekday: [2, 4] }), tue)).toBe(2);
		// Mo+So: 6 bzw. Umbruch 1+7-7 = 1 → 1
		expect(minGapDays(rule({ freq: 'weekly', byWeekday: [1, 7] }), tue)).toBe(1);
		// Mo+Fr alle 2 Wochen: 4 bzw. 1+14-5 = 10 → 4
		expect(minGapDays(rule({ freq: 'weekly', interval: 2, byWeekday: [1, 5] }), tue)).toBe(4);
		expect(minGapDays(rule({ freq: 'monthly', interval: 2 }), tue)).toBe(56);
		expect(minGapDays(rule({ freq: 'yearly' }), tue)).toBe(365);
		// 2. Sonntag im Mai: 10.05.2026 → 09.05.2027 = 364 Tage
		expect(minGapDays(rule({ freq: 'yearly', monthlyMode: 'nth-weekday' }), '2026-05-10')).toBe(
			364
		);
		expect(daysBetween('2026-05-10', '2027-05-09')).toBe(364);
	});
});

describe('describeRecurrence', () => {
	const d = (r: RecurrenceRuleInput, s: string) => describeRecurrence(rule(r), s);
	it('Texte', () => {
		expect(d({ freq: 'daily' }, '2026-11-03')).toBe('Täglich');
		expect(d({ freq: 'daily', interval: 3 }, '2026-11-03')).toBe('Alle 3 Tage');
		expect(d({ freq: 'weekly' }, '2026-11-03')).toBe('Jeden Dienstag');
		expect(d({ freq: 'weekly', byWeekday: [4, 2] }, '2026-11-03')).toBe(
			'Jeden Dienstag und Donnerstag'
		);
		expect(d({ freq: 'weekly', byWeekday: [1, 3, 5] }, '2026-11-03')).toBe(
			'Jeden Montag, Mittwoch und Freitag'
		);
		expect(d({ freq: 'weekly', interval: 2 }, '2026-11-03')).toBe('Alle 2 Wochen am Dienstag');
		expect(d({ freq: 'monthly' }, '2026-11-15')).toBe('Monatlich am 15.');
		expect(d({ freq: 'monthly', interval: 2 }, '2026-11-15')).toBe('Alle 2 Monate am 15.');
		expect(d({ freq: 'monthly', monthlyMode: 'nth-weekday' }, '2026-11-07')).toBe(
			'Jeden 1. Samstag im Monat'
		);
		expect(d({ freq: 'monthly', monthlyMode: 'last-weekday' }, '2026-10-30')).toBe(
			'Jeden letzten Freitag im Monat'
		);
		expect(d({ freq: 'yearly' }, '2026-12-24')).toBe('Jährlich am 24.12.');
		expect(d({ freq: 'yearly', monthlyMode: 'nth-weekday' }, '2026-05-10')).toBe(
			'Jährlich am 2. Sonntag im Mai'
		);
	});
	it('mit Ende', () => {
		expect(d({ freq: 'weekly', end: { type: 'until', date: '2026-12-31' } }, '2026-11-03')).toBe(
			'Jeden Dienstag, bis 31.12.2026'
		);
		expect(d({ freq: 'daily', end: { type: 'count', count: 10 } }, '2026-11-03')).toBe(
			'Täglich, 10-mal'
		);
	});
});
