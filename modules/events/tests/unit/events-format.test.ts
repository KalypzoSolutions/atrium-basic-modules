import { describe, expect, it } from 'vitest';
import {
	formatEventDate,
	formatEventRange,
	formatEventTime,
	isAllDay
} from '$modules/events/format';

const base = { startsOn: '2026-10-24', startsTime: null, endsOn: null, endsTime: null };

describe('events/format', () => {
	it('formatiert ein Datum mit Wochentag', () => {
		expect(formatEventDate('2026-10-24')).toBe('Sa, 24.10.2026');
		expect(formatEventDate('2026-10-25')).toBe('So, 25.10.2026');
		expect(formatEventDate('2024-02-29')).toBe('Do, 29.02.2024');
		expect(formatEventDate('kaputt')).toBe('kaputt');
	});

	it('kürzt Uhrzeiten auf HH:MM', () => {
		expect(formatEventTime('10:00:00')).toBe('10:00');
		expect(formatEventTime('09:30')).toBe('09:30');
		expect(formatEventTime(null)).toBe('');
		expect(formatEventTime('x')).toBe('');
	});

	it('erkennt ganztägige Termine', () => {
		expect(isAllDay(base)).toBe(true);
		expect(isAllDay({ ...base, startsTime: '10:00' })).toBe(false);
		expect(isAllDay({ ...base, endsTime: '10:00' })).toBe(false);
	});

	it('ein Tag ohne Uhrzeit', () => {
		expect(formatEventRange(base)).toBe('Sa, 24.10.2026');
		expect(formatEventRange({ ...base, endsOn: '2026-10-24' })).toBe('Sa, 24.10.2026');
	});

	it('ein Tag mit Uhrzeiten', () => {
		expect(formatEventRange({ ...base, startsTime: '10:00' })).toBe('Sa, 24.10.2026, 10:00');
		expect(
			formatEventRange({ ...base, startsTime: '10:00', endsOn: '2026-10-24', endsTime: '14:00' })
		).toBe('Sa, 24.10.2026, 10:00 – 14:00');
		expect(formatEventRange({ ...base, endsOn: '2026-10-24', endsTime: '14:00' })).toBe(
			'Sa, 24.10.2026, bis 14:00'
		);
	});

	it('mehrtägig mit und ohne Uhrzeit', () => {
		expect(
			formatEventRange({
				startsOn: '2026-10-24',
				startsTime: '10:00:00',
				endsOn: '2026-10-25',
				endsTime: '14:00:00'
			})
		).toBe('Sa, 24.10.2026, 10:00 – So, 25.10.2026, 14:00');
		expect(formatEventRange({ ...base, endsOn: '2026-10-25' })).toBe(
			'Sa, 24.10.2026 – So, 25.10.2026'
		);
		expect(formatEventRange({ ...base, startsTime: '18:00', endsOn: '2026-10-25' })).toBe(
			'Sa, 24.10.2026, 18:00 – So, 25.10.2026'
		);
	});
});
