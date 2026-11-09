import { describe, expect, it } from 'vitest';
import {
	MAX_TAGS,
	MAX_TAG_LENGTH,
	eventInput,
	isRealDate,
	listQuery,
	normalizeTag,
	normalizeTags,
	websiteQuery
} from '$modules/events/schemas';

const base = { title: 'Gruppenstunde', startsOn: '2026-11-03' };

function issues(input: unknown) {
	const r = eventInput.safeParse(input);
	expect(r.success, 'erwartet: ungültig').toBe(false);
	return r.success ? [] : r.error.issues;
}
const paths = (input: unknown) => issues(input).map((i) => i.path.join('.'));

function ok(input: unknown) {
	const r = eventInput.safeParse(input);
	if (!r.success) throw new Error(JSON.stringify(r.error.issues));
	return r.data;
}

describe('isRealDate / normalizeTag', () => {
	it('prüft echte Kalenderdaten', () => {
		expect(isRealDate('2026-02-28')).toBe(true);
		expect(isRealDate('2028-02-29')).toBe(true);
		expect(isRealDate('2026-02-29')).toBe(false);
		expect(isRealDate('2026-02-30')).toBe(false);
		expect(isRealDate('2026-13-01')).toBe(false);
		expect(isRealDate('26-01-01')).toBe(false);
	});

	it('normalisiert Tags', () => {
		expect(normalizeTag('  Sommer   Lager ')).toBe('Sommer Lager');
		expect(normalizeTags(['A', 'a', ' b ', '', 'B', 'c'])).toEqual(['A', 'b', 'c']);
	});
});

describe('eventInput', () => {
	it('setzt Standardwerte und leert optionale Felder auf null', () => {
		const v = ok({ ...base, description: '  ', location: '', color: null });
		expect(v).toEqual({
			title: 'Gruppenstunde',
			description: null,
			location: null,
			color: null,
			startsOn: '2026-11-03',
			startsTime: null,
			endsOn: null,
			endsTime: null,
			tags: [],
			groupIds: [],
			shares: [],
			onWebsite: false,
			recurrence: null
		});
	});

	it('Serie: Standardwerte, Ende vor Start, Dauer länger als Abstand', () => {
		const v = ok({ ...base, recurrence: { freq: 'weekly' } });
		expect(v.recurrence).toEqual({
			freq: 'weekly',
			interval: 1,
			byWeekday: undefined,
			monthlyMode: undefined,
			end: { type: 'never' }
		});
		expect(
			paths({ ...base, recurrence: { freq: 'weekly', end: { type: 'until', date: '2026-01-01' } } })
		).toContain('recurrence.end.date');
		// täglich, aber 3 Tage lang → überlappt das nächste Vorkommen
		expect(paths({ ...base, endsOn: '2026-11-05', recurrence: { freq: 'daily' } })).toContain(
			'endsOn'
		);
		expect(paths({ ...base, recurrence: { freq: 'daily', byWeekday: [1] } })).toContain(
			'recurrence.byWeekday'
		);
	});

	it('verlangt Titel und Startdatum', () => {
		expect(paths({})).toEqual(expect.arrayContaining(['title', 'startsOn']));
		expect(paths({ ...base, title: '   ' })).toContain('title');
	});

	it('begrenzt die Titel-Länge auf 200 Zeichen', () => {
		expect(ok({ ...base, title: 'x'.repeat(200) }).title).toHaveLength(200);
		expect(paths({ ...base, title: 'x'.repeat(201) })).toContain('title');
		expect(ok({ ...base, title: '  Fahrt  ' }).title).toBe('Fahrt');
	});

	it('normalisiert die Farbe klein und lehnt ungültige ab', () => {
		expect(ok({ ...base, color: '#AbCdEf' }).color).toBe('#abcdef');
		expect(paths({ ...base, color: 'red' })).toContain('color');
		expect(paths({ ...base, color: '#abc' })).toContain('color');
		expect(paths({ ...base, color: '#abcdeg' })).toContain('color');
	});

	it('lehnt ungültige Daten und Uhrzeiten ab', () => {
		expect(paths({ ...base, startsOn: '2026-02-30' })).toContain('startsOn');
		expect(paths({ ...base, startsOn: '03.11.2026' })).toContain('startsOn');
		expect(paths({ ...base, startsTime: '24:00' })).toContain('startsTime');
		expect(paths({ ...base, startsTime: '9:00' })).toContain('startsTime');
		expect(ok({ ...base, startsTime: '23:59' }).startsTime).toBe('23:59');
	});

	it('Ende vor Start ist ungültig', () => {
		expect(paths({ ...base, endsOn: '2026-11-02' })).toContain('endsOn');
		expect(ok({ ...base, endsOn: '2026-11-03' }).endsOn).toBe('2026-11-03');
	});

	it('Endzeit braucht ein Enddatum', () => {
		expect(paths({ ...base, startsTime: '10:00', endsTime: '12:00' })).toContain('endsTime');
	});

	it('am selben Tag darf die Endzeit nicht vor der Startzeit liegen', () => {
		const sameDay = { ...base, endsOn: base.startsOn, startsTime: '18:00' };
		expect(paths({ ...sameDay, endsTime: '17:59' })).toContain('endsTime');
		expect(ok({ ...sameDay, endsTime: '18:00' }).endsTime).toBe('18:00');
		// an einem späteren Tag ist eine frühere Uhrzeit erlaubt
		expect(ok({ ...sameDay, endsOn: '2026-11-04', endsTime: '10:00' }).endsTime).toBe('10:00');
	});

	describe('Tags', () => {
		it('normalisiert und entfernt Duplikate ohne Groß-/Kleinschreibung', () => {
			expect(ok({ ...base, tags: [' Lager ', 'lager', 'Wald  Spiel', 'LAGER'] }).tags).toEqual([
				'Lager',
				'Wald Spiel'
			]);
		});

		it(`erlaubt höchstens ${MAX_TAGS} Tags`, () => {
			const tags = Array.from({ length: MAX_TAGS }, (_, i) => `t${i}`);
			expect(ok({ ...base, tags }).tags).toHaveLength(MAX_TAGS);
			expect(paths({ ...base, tags: [...tags, 'zu viel'] })).toContain('tags');
		});

		it(`erlaubt höchstens ${MAX_TAG_LENGTH} Zeichen je Tag`, () => {
			expect(ok({ ...base, tags: ['x'.repeat(MAX_TAG_LENGTH)] }).tags).toHaveLength(1);
			expect(paths({ ...base, tags: ['x'.repeat(MAX_TAG_LENGTH + 1)] })).toContain('tags.0');
		});

		it('lehnt leere Tags ab', () => {
			expect(paths({ ...base, tags: ['ok', '   '] })).toContain('tags.1');
			expect(paths({ ...base, tags: [''] })).toContain('tags.0');
		});
	});

	it('dedupliziert groupIds', () => {
		expect(ok({ ...base, groupIds: ['stamm', 'g1', 'stamm', 'g1', 'g2'] }).groupIds).toEqual([
			'stamm',
			'g1',
			'g2'
		]);
		expect(paths({ ...base, groupIds: ['a b'] })).toContain('groupIds.0');
	});

	describe('shares', () => {
		it('nimmt gültige Freigaben an', () => {
			const shares = [
				{ type: 'everyone', id: '*', level: 'read' },
				{ type: 'user', id: 'u1', level: 'edit' },
				{ type: 'group', id: 'u1', level: 'read' }
			];
			expect(ok({ ...base, shares }).shares).toEqual(shares);
		});

		it('lehnt doppelte Freigaben ab', () => {
			const shares = [
				{ type: 'user', id: 'u1', level: 'read' },
				{ type: 'user', id: 'u1', level: 'edit' }
			];
			const list = issues({ ...base, shares });
			expect(list.map((i) => i.path.join('.'))).toContain('shares.1');
			expect(list.some((i) => i.message === 'Doppelte Freigabe')).toBe(true);
		});

		it('everyone nur mit ID *', () => {
			expect(paths({ ...base, shares: [{ type: 'everyone', id: 'x', level: 'read' }] })).toContain(
				'shares.0.id'
			);
		});

		it('lehnt ungültige Typen, Stufen und Zusatzfelder ab', () => {
			expect(paths({ ...base, shares: [{ type: 'team', id: 'x', level: 'read' }] })).toContain(
				'shares.0.type'
			);
			expect(paths({ ...base, shares: [{ type: 'user', id: 'x', level: 'admin' }] })).toContain(
				'shares.0.level'
			);
			expect(
				issues({ ...base, shares: [{ type: 'user', id: 'x', level: 'read', extra: 1 }] }).length
			).toBeGreaterThan(0);
		});
	});

	it('ist strikt: unbekannte Felder sind ein Fehler', () => {
		expect(issues({ ...base, ownerId: 'u1' }).some((i) => i.code === 'unrecognized_keys')).toBe(
			true
		);
	});
});

describe('listQuery / websiteQuery', () => {
	it('liefert Standardwerte', () => {
		expect(listQuery.parse({})).toEqual({ limit: 200, offset: 0 });
		expect(websiteQuery.parse({})).toEqual({ limit: 50 });
	});

	it('wandelt Zahlen aus der Query um und prüft Grenzen', () => {
		expect(listQuery.parse({ limit: '10', offset: '5' })).toMatchObject({ limit: 10, offset: 5 });
		expect(listQuery.safeParse({ limit: '501' }).success).toBe(false);
		expect(listQuery.safeParse({ offset: '-1' }).success).toBe(false);
		expect(websiteQuery.safeParse({ limit: '201' }).success).toBe(false);
		expect(websiteQuery.safeParse({ from: '2026-02-30' }).success).toBe(false);
		expect(websiteQuery.parse({ from: '2026-11-01', tag: ' Lager ' })).toEqual({
			from: '2026-11-01',
			tag: 'Lager',
			limit: 50
		});
	});
});
