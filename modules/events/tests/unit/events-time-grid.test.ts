import { describe, expect, it } from 'vitest';
import type { CalendarItem } from '$lib/components/layout/month-calendar';
import {
	allDayItems,
	blockTimes,
	hourRange,
	isTimed,
	isoWeek,
	layoutDay,
	minutesOf,
	startOfWeek,
	weekDays
} from '$modules/events/time-grid';

const D = '2026-11-11'; // Mittwoch

function item(id: string, over: Partial<CalendarItem> = {}): CalendarItem {
	return { id, title: id, startsOn: D, ...over };
}

describe('Woche', () => {
	it('beginnt am Montag, auch über Monats- und Jahresgrenzen', () => {
		expect(startOfWeek('2026-11-11')).toBe('2026-11-09');
		expect(startOfWeek('2026-11-09')).toBe('2026-11-09');
		expect(startOfWeek('2026-11-15')).toBe('2026-11-09'); // Sonntag
		expect(startOfWeek('2027-01-01')).toBe('2026-12-28');
		expect(weekDays('2026-11-01')).toEqual([
			'2026-10-26',
			'2026-10-27',
			'2026-10-28',
			'2026-10-29',
			'2026-10-30',
			'2026-10-31',
			'2026-11-01'
		]);
	});

	it('Kalenderwoche nach ISO 8601', () => {
		expect(isoWeek('2026-11-11')).toBe(46);
		expect(isoWeek('2026-01-01')).toBe(1); // Donnerstag
		expect(isoWeek('2027-01-01')).toBe(53); // Freitag → KW 53 von 2026
		expect(isoWeek('2027-01-04')).toBe(1);
		expect(isoWeek('2024-12-30')).toBe(1); // KW 1/2025
	});
});

describe('Zeiten', () => {
	it('minutesOf', () => {
		expect(minutesOf('00:00')).toBe(0);
		expect(minutesOf('18:30')).toBe(1110);
		expect(minutesOf('23:59')).toBe(1439);
		expect(minutesOf('18:30:00')).toBe(1110);
		expect(minutesOf('24:00')).toBeNull();
		expect(minutesOf('')).toBeNull();
		expect(minutesOf(null)).toBeNull();
	});

	it('Ende fehlt oder liegt vor dem Beginn → eine Stunde, höchstens bis Mitternacht', () => {
		expect(blockTimes(item('a', { startsTime: '18:00', endsTime: '20:00' }))).toEqual({
			start: 1080,
			end: 1200
		});
		expect(blockTimes(item('b', { startsTime: '18:00' }))).toEqual({ start: 1080, end: 1140 });
		expect(blockTimes(item('c', { startsTime: '18:00', endsTime: '17:00' }))).toEqual({
			start: 1080,
			end: 1140
		});
		expect(blockTimes(item('d', { startsTime: '23:30' }))).toEqual({ start: 1410, end: 1440 });
		expect(blockTimes(item('e'))).toBeNull();
	});

	it('mit Uhrzeit im Raster nur eintägige Termine mit Startuhrzeit', () => {
		expect(isTimed(item('a', { startsTime: '10:00' }))).toBe(true);
		expect(isTimed(item('b'))).toBe(false);
		expect(isTimed(item('c', { startsTime: '18:00', endsOn: '2026-11-13' }))).toBe(false);
		const all = allDayItems([
			item('a', { startsTime: '10:00' }),
			item('b'),
			item('c', { startsTime: '18:00', endsOn: '2026-11-13' })
		]);
		expect(all.map((i) => i.id)).toEqual(['b', 'c']);
	});
});

describe('layoutDay', () => {
	it('nicht überlappende Termine bekommen die volle Breite', () => {
		const blocks = layoutDay(
			[
				item('a', { startsTime: '10:00', endsTime: '11:00' }),
				item('b', { startsTime: '11:00', endsTime: '12:00' })
			],
			D
		);
		expect(blocks.map((b) => [b.item.id, b.col, b.cols])).toEqual([
			['a', 0, 1],
			['b', 0, 1]
		]);
	});

	it('Überlappungen teilen sich die Breite, freie Spalten werden wiederverwendet', () => {
		// a 10–12, b 10:30–11:00, c 11:00–13:00 (b frei → c in Spalte 1), d 13–14 eigene Gruppe
		const blocks = layoutDay(
			[
				item('c', { startsTime: '11:00', endsTime: '13:00' }),
				item('a', { startsTime: '10:00', endsTime: '12:00' }),
				item('b', { startsTime: '10:30', endsTime: '11:00' }),
				item('d', { startsTime: '13:00', endsTime: '14:00' })
			],
			D
		);
		expect(blocks.map((b) => [b.item.id, b.col, b.cols])).toEqual([
			['a', 0, 2],
			['b', 1, 2],
			['c', 1, 2],
			['d', 0, 1]
		]);
	});

	it('drei gleichzeitige Termine → drei Spalten; andere Tage und Ganztägiges fehlen', () => {
		const blocks = layoutDay(
			[
				item('a', { startsTime: '09:00', endsTime: '10:00' }),
				item('b', { startsTime: '09:00', endsTime: '10:00' }),
				item('c', { startsTime: '09:15' }),
				item('x', { startsOn: '2026-11-12', startsTime: '09:00' }),
				item('y')
			],
			D
		);
		expect(blocks.map((b) => [b.item.id, b.col, b.cols])).toEqual([
			['a', 0, 3],
			['b', 1, 3],
			['c', 2, 3]
		]);
	});
});

describe('hourRange', () => {
	it('Standard 8–20 Uhr, erweitert auf frühe und späte Termine', () => {
		expect(hourRange([], [D])).toEqual({ from: 8, to: 20 });
		expect(
			hourRange(
				[
					item('a', { startsTime: '06:30', endsTime: '07:00' }),
					item('b', { startsOn: '2026-11-12', startsTime: '21:00', endsTime: '22:15' })
				],
				weekDays(D)
			)
		).toEqual({ from: 6, to: 23 });
		// Termine außerhalb der Tage zählen nicht
		expect(hourRange([item('a', { startsTime: '05:00' })], ['2026-11-12'])).toEqual({
			from: 8,
			to: 20
		});
		expect(hourRange([item('a', { startsTime: '23:30' })], [D])).toEqual({ from: 8, to: 24 });
	});
});
