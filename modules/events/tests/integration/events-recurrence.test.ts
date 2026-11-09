import { beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin, createUser } from '$testing';
import { createRole } from '$testing';
import { registerModule } from '$testing';
import { enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { resetAllForTests } from '$testing';
import { listAudit } from '$testing';
import { getDb, schema } from '$testing';
import { core } from '$testing';
import eventsModule from '$modules/events/module';
import type { EventDetail, EventList, WebsiteEvent } from '$modules/events/schemas';

const BASE = '/modules/events';
const keys: Record<string, string> = {};

interface Res<T> {
	status: number;
	body: { data?: T; error?: { code: string; message: string; details?: unknown } };
}

async function call<T = unknown>(
	who: string,
	method: string,
	path: string,
	json?: unknown
): Promise<Res<T>> {
	resetAllForTests();
	const headers = new Headers({ authorization: `Bearer ${keys[who]}` });
	if (json !== undefined) headers.set('content-type', 'application/json');
	const url = new URL(`http://localhost:5173/api/v1${BASE}${path}`);
	const res = await handleApiRequest({
		request: new Request(url, {
			method,
			headers,
			body: json === undefined ? undefined : JSON.stringify(json)
		}),
		url,
		ip: '127.0.0.1'
	});
	return { status: res.status, body: await res.json() };
}

function ok<T>(res: Res<T>, status = 200): T {
	expect(res.status, JSON.stringify(res.body)).toBe(status);
	return res.body.data as T;
}

const paths = (res: Res<unknown>): string[] => {
	const d = res.body.error?.details;
	return Array.isArray(d) ? d.map((x: { path?: unknown[] }) => (x.path ?? []).join('.')) : [];
};

async function ctxOf(userId: string) {
	const r = await contextForUser(userId);
	if (!r) throw new Error('Kontext nicht auflösbar');
	return r.ctx;
}

function addDays(iso: string, n: number): string {
	const d = new Date(`${iso}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + n);
	return d.toISOString().slice(0, 10);
}

async function dbRows(query: ReturnType<typeof sql>) {
	return core.database.forModule('events').transaction(async (tx) => {
		const res = (await tx.execute(query)) as unknown as { rows: Record<string, unknown>[] };
		return res.rows;
	});
}

const exceptionCount = async (id: string) =>
	Number(
		(await dbRows(sql`SELECT count(*)::int AS n FROM event_exceptions WHERE event_id = ${id}`))[0]!
			.n
	);

const until = async (id: string) =>
	(
		await dbRows(
			sql`SELECT to_char(recurrence_until, 'YYYY-MM-DD') AS u FROM events WHERE id = ${id}`
		)
	)[0]!.u ?? null;

/** Dienstags-Serie ab 05.01.2027, 17:00–18:30, für alle sichtbar und auf der Website */
const seriesBody = (over: Record<string, unknown> = {}) => ({
	title: 'Gruppenstunde',
	description: 'Basteln',
	location: 'Heim',
	startsOn: '2027-01-05',
	startsTime: '17:00',
	endsOn: '2027-01-05',
	endsTime: '18:30',
	tags: ['Heim'],
	groupIds: ['stamm'],
	shares: [{ type: 'everyone', id: '*', level: 'read' }],
	onWebsite: true,
	recurrence: { freq: 'weekly', interval: 1, byWeekday: [2], end: { type: 'never' } },
	...over
});

let series: string;
let single: string;
const JAN = '/events?from=2027-01-01&to=2027-01-31';

beforeAll(async () => {
	await useTestDatabase();
	registerCoreApi();
	registerModule(eventsModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', 'correct-horse-battery');
	const [u] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	let admin = await ctxOf(u!.id);
	await enableModule(admin, 'events');
	admin = await ctxOf(u!.id);
	keys.admin = (
		await createApiKey(admin, {
			name: 'admin',
			scopes: [
				'events.event.view',
				'events.event.create',
				'events.event.edit-all',
				'events.event.publish'
			]
		})
	).key;
	keys.web = (await createApiKey(admin, { name: 'web', scopes: ['events.website.read'] })).key;
	const perms = ['core.api.manage', 'events.event.view'];
	const roleId = await createRole(admin, { name: 'leser', permissions: perms });
	const readerId = await createUser(admin, {
		name: 'Leser Test',
		email: 'reader@example.test',
		password: 'a-long-enough-pw',
		roleIds: [roleId]
	});
	keys.reader = (await createApiKey(await ctxOf(readerId), { name: 'reader', scopes: perms })).key;

	series = ok<EventDetail>(await call('admin', 'POST', '/events', seriesBody()), 201).id;
	single = ok<EventDetail>(
		await call('admin', 'POST', '/events', {
			...seriesBody({ title: 'Elternabend', startsOn: '2027-01-13', endsOn: null }),
			endsTime: null,
			recurrence: null
		}),
		201
	).id;
});

describe('Serien: Liste', () => {
	it('expandiert eine wöchentliche Serie im Monat (Schlüssel, Felder, Sortierung)', async () => {
		const list = ok<EventList>(await call('admin', 'GET', JAN));
		expect(list.total).toBe(5);
		expect(list.items.map((i) => i.key)).toEqual([
			`${series}:2027-01-05`,
			`${series}:2027-01-12`,
			single,
			`${series}:2027-01-19`,
			`${series}:2027-01-26`
		]);
		const occ = list.items[1]!;
		expect(occ).toMatchObject({
			id: series,
			occurrenceDate: '2027-01-12',
			startsOn: '2027-01-12',
			endsOn: '2027-01-12',
			startsTime: '17:00',
			endsTime: '18:30',
			isException: false
		});
		expect(occ.recurrence?.freq).toBe('weekly');
		const one = list.items[2]!;
		expect(one).toMatchObject({ occurrenceDate: null, recurrence: null, isException: false });
	});

	it('speichert recurrence_until (never → NULL, count/until → letztes Vorkommen)', async () => {
		expect(await until(series)).toBeNull();
		const counted = ok<EventDetail>(
			await call(
				'admin',
				'POST',
				'/events',
				seriesBody({
					title: 'Dreimal',
					onWebsite: false,
					recurrence: { freq: 'weekly', byWeekday: [2], end: { type: 'count', count: 3 } }
				})
			),
			201
		);
		expect(await until(counted.id)).toBe('2027-01-19');
		const bounded = ok<EventDetail>(
			await call(
				'admin',
				'POST',
				'/events',
				seriesBody({
					title: 'Bis Ende Januar',
					onWebsite: false,
					recurrence: { freq: 'weekly', end: { type: 'until', date: '2027-01-31' } }
				})
			),
			201
		);
		expect(await until(bounded.id)).toBe('2027-01-26');
		// außerhalb des Serienendes keine Vorkommen
		const feb = ok<EventList>(
			await call('admin', 'GET', '/events?from=2027-02-01&to=2027-02-28&search=Dreimal')
		);
		expect(feb.total).toBe(0);
		for (const id of [counted.id, bounded.id]) {
			ok(await call('admin', 'DELETE', `/events/${id}`));
		}
	});

	it('begrenzt offene Abfragen ohne `to` auf OPEN_WINDOW_DAYS', async () => {
		const from = '2027-01-01';
		const list = ok<EventList>(await call('admin', 'GET', `/events?from=${from}&limit=500`));
		let tuesdays = 0;
		for (let d = '2027-01-05'; d <= addDays(from, 366); d = addDays(d, 7)) tuesdays++;
		expect(list.total).toBe(tuesdays + 1);
		const last = list.items.at(-1)!;
		expect(last.startsOn <= addDays(from, 366)).toBe(true);
	});

	it('paginiert über Vorkommen', async () => {
		const page = ok<EventList>(await call('admin', 'GET', `${JAN}&limit=2&offset=2`));
		expect(page.total).toBe(5);
		expect(page.items.map((i) => i.occurrenceDate)).toEqual([null, '2027-01-19']);
	});
});

describe('Serien: Vorkommen absagen und ändern', () => {
	it('Absage entfernt das Vorkommen aus der Liste', async () => {
		const detail = ok<EventDetail>(
			await call('admin', 'PUT', `/events/${series}/occurrences/2027-01-12`, { cancelled: true })
		);
		expect(detail.occurrenceDate).toBe('2027-01-12');
		expect(detail.cancelledDates).toEqual(['2027-01-12']);
		expect(detail.isException).toBe(true);
		const list = ok<EventList>(await call('admin', 'GET', JAN));
		expect(list.items.map((i) => i.occurrenceDate)).not.toContain('2027-01-12');
		expect(list.total).toBe(4);
	});

	it('Override (Titel, Zeit, verschobenes Datum) erscheint geändert', async () => {
		const detail = ok<EventDetail>(
			await call('admin', 'PUT', `/events/${series}/occurrences/2027-01-19`, {
				override: { title: 'Sondertreffen', startsOn: '2027-01-20', startsTime: '15:00' }
			})
		);
		expect(detail).toMatchObject({
			title: 'Sondertreffen',
			startsOn: '2027-01-20',
			endsOn: '2027-01-20',
			startsTime: '15:00',
			endsTime: '18:30',
			isException: true,
			exceptionDates: ['2027-01-19'],
			cancelledDates: ['2027-01-12']
		});
		expect(detail.series).toEqual({
			startsOn: '2027-01-05',
			startsTime: '17:00',
			endsOn: '2027-01-05',
			endsTime: '18:30',
			title: 'Gruppenstunde',
			description: 'Basteln',
			location: 'Heim'
		});
		expect(detail.override).toEqual({
			title: 'Sondertreffen',
			startsOn: '2027-01-20',
			startsTime: '15:00'
		});
		const list = ok<EventList>(await call('admin', 'GET', JAN));
		const moved = list.items.find((i) => i.key === `${series}:2027-01-19`)!;
		expect(moved).toMatchObject({
			title: 'Sondertreffen',
			startsOn: '2027-01-20',
			isException: true
		});
		expect(list.items.map((i) => i.startsOn)).toEqual([
			'2027-01-05',
			'2027-01-13',
			'2027-01-20',
			'2027-01-26'
		]);
		// Suche findet den Override-Titel
		const found = ok<EventList>(await call('admin', 'GET', `${JAN}&search=sondertreff`));
		expect(found.items.map((i) => i.key)).toEqual([`${series}:2027-01-19`]);
	});

	it('Detail mit occurrence; ohne occurrence ein Vorkommen der Serie', async () => {
		const d = ok<EventDetail>(
			await call('admin', 'GET', `/events/${series}?occurrence=2027-01-19`)
		);
		expect(d.title).toBe('Sondertreffen');
		const def = ok<EventDetail>(await call('admin', 'GET', `/events/${series}`));
		expect(def.occurrenceDate).toBe('2027-01-05');
		expect(def.key).toBe(`${series}:2027-01-05`);
		// kein Vorkommen bzw. einmaliger Termin mit occurrence → 404
		expect((await call('admin', 'GET', `/events/${series}?occurrence=2027-01-13`)).status).toBe(
			404
		);
		expect((await call('admin', 'GET', `/events/${single}?occurrence=2027-01-13`)).status).toBe(
			404
		);
		const s = ok<EventDetail>(await call('admin', 'GET', `/events/${single}`));
		expect(s).toMatchObject({
			key: single,
			occurrenceDate: null,
			series: null,
			override: null,
			cancelledDates: [],
			exceptionDates: []
		});
	});

	it('Lesende sehen abgesagte Vorkommen nicht und keine Ausnahme-Daten', async () => {
		const list = ok<EventList>(await call('reader', 'GET', JAN));
		expect(list.items.map((i) => i.occurrenceDate)).not.toContain('2027-01-12');
		expect((await call('reader', 'GET', `/events/${series}?occurrence=2027-01-12`)).status).toBe(
			404
		);
		const d = ok<EventDetail>(
			await call('reader', 'GET', `/events/${series}?occurrence=2027-01-19`)
		);
		expect(d.title).toBe('Sondertreffen');
		expect(d.cancelledDates).toEqual([]);
		expect(d.exceptionDates).toEqual([]);
		expect(d.override).toBeNull();
		expect(d.series?.title).toBe('Gruppenstunde');
		// Bearbeitende sehen das abgesagte Vorkommen
		const c = ok<EventDetail>(
			await call('admin', 'GET', `/events/${series}?occurrence=2027-01-12`)
		);
		expect(c.cancelledDates).toContain('2027-01-12');
	});

	it('Fehlerfälle: 404 kein Vorkommen, 422 ungültiger Override, 403 nur Lesen, 400 kein Serientermin', async () => {
		const notOcc = await call('admin', 'PUT', `/events/${series}/occurrences/2027-01-13`, {
			cancelled: true
		});
		expect(notOcc.status).toBe(404);
		expect(notOcc.body.error?.code).toBe('not_found');

		const bad = await call('admin', 'PUT', `/events/${series}/occurrences/2027-01-26`, {
			override: { endsOn: '2027-01-20' }
		});
		expect(bad.status).toBe(422);
		expect(paths(bad)).toContain('override.endsOn');
		const badTime = await call('admin', 'PUT', `/events/${series}/occurrences/2027-01-26`, {
			override: { endsTime: '16:00' }
		});
		expect(badTime.status).toBe(422);
		expect(paths(badTime)).toContain('override.endsTime');

		const ro = await call('reader', 'PUT', `/events/${series}/occurrences/2027-01-26`, {
			cancelled: true
		});
		expect(ro.status).toBe(403);
		expect(
			(await call('reader', 'DELETE', `/events/${series}/occurrences/2027-01-12`)).status
		).toBe(403);

		const noSeries = await call('admin', 'PUT', `/events/${single}/occurrences/2027-01-13`, {
			cancelled: true
		});
		expect(noSeries.status).toBe(400);
		expect(
			(await call('admin', 'PUT', `/events/${series}/occurrences/2027-02-30`, { cancelled: true }))
				.status
		).toBe(422);
		expect(await exceptionCount(series)).toBe(2);
	});

	it('cancelled=false ohne Override löscht die Ausnahme; DELETE setzt zurück', async () => {
		ok(await call('admin', 'PUT', `/events/${series}/occurrences/2027-01-26`, { cancelled: true }));
		expect(await exceptionCount(series)).toBe(3);
		const cleared = ok<EventDetail>(
			await call('admin', 'PUT', `/events/${series}/occurrences/2027-01-26`, {
				cancelled: false,
				override: null
			})
		);
		expect(cleared.isException).toBe(false);
		expect(await exceptionCount(series)).toBe(2);
		ok(await call('admin', 'PUT', `/events/${series}/occurrences/2027-01-26`, { cancelled: true }));
		const reset = ok<EventDetail>(
			await call('admin', 'DELETE', `/events/${series}/occurrences/2027-01-26`)
		);
		expect(reset.isException).toBe(false);
		expect(reset.cancelledDates).toEqual(['2027-01-12']);
		expect(await exceptionCount(series)).toBe(2);
	});
});

describe('Serien: Website', () => {
	it('liefert Vorkommen mit recurring/occurrenceDate, ohne abgesagte, mit Override', async () => {
		const items = ok<WebsiteEvent[]>(
			await call('web', 'GET', '/website/events?from=2027-01-01&to=2027-01-31')
		);
		expect(items.map((i) => [i.id, i.occurrenceDate, i.recurring])).toEqual([
			[series, '2027-01-05', true],
			[single, null, false],
			[series, '2027-01-19', true],
			[series, '2027-01-26', true]
		]);
		expect(items[2]).toMatchObject({ title: 'Sondertreffen', startsOn: '2027-01-20' });
		const raw = JSON.stringify(items);
		expect(raw).not.toContain('meeting');
		expect(raw).not.toContain('cancelled');
		const limited = ok<WebsiteEvent[]>(
			await call('web', 'GET', '/website/events?from=2027-01-01&limit=3')
		);
		expect(limited).toHaveLength(3);
	});
});

describe('Serien: Ändern der Serie', () => {
	it('entfernt verwaiste Ausnahmen bei anderem Wochentag und alle ohne Serie', async () => {
		// Di + Do: Dienstags-Ausnahmen bleiben gültig
		ok(
			await call(
				'admin',
				'PUT',
				`/events/${series}`,
				seriesBody({ recurrence: { freq: 'weekly', byWeekday: [2, 4] } })
			)
		);
		expect(await exceptionCount(series)).toBe(2);
		// nur Donnerstag: beide Dienstags-Ausnahmen verwaist
		ok(
			await call(
				'admin',
				'PUT',
				`/events/${series}`,
				seriesBody({ startsOn: '2027-01-07', endsOn: '2027-01-07', recurrence: { freq: 'weekly' } })
			)
		);
		expect(await exceptionCount(series)).toBe(0);
		const thu = ok<EventList>(await call('admin', 'GET', `${JAN}&search=Gruppenstunde`));
		expect(thu.items.map((i) => i.occurrenceDate)).toEqual([
			'2027-01-07',
			'2027-01-14',
			'2027-01-21',
			'2027-01-28'
		]);
		ok(await call('admin', 'PUT', `/events/${series}/occurrences/2027-01-14`, { cancelled: true }));
		expect(await exceptionCount(series)).toBe(1);
		const plain = ok<EventDetail>(
			await call(
				'admin',
				'PUT',
				`/events/${series}`,
				seriesBody({ startsOn: '2027-01-07', endsOn: '2027-01-07', recurrence: null })
			)
		);
		expect(await exceptionCount(series)).toBe(0);
		expect(await until(series)).toBeNull();
		expect(plain).toMatchObject({ recurrence: null, occurrenceDate: null, series: null });
	});
});

describe('Serien: Audit', () => {
	it('protokolliert Vorkommen-Änderungen ohne Inhalte', async () => {
		const { rows } = await listAudit({ action: 'events.event.occurrence', limit: 100 });
		const updated = rows.filter((r) => r.action === 'events.event.occurrence_updated');
		const reset = rows.filter((r) => r.action === 'events.event.occurrence_reset');
		expect(updated.length).toBeGreaterThanOrEqual(4);
		expect(reset.length).toBe(1);
		expect(updated.every((r) => r.target === series)).toBe(true);
		const withOverride = updated.find((r) => (r.metadata as { fields?: number }).fields === 3);
		expect(withOverride?.metadata).toEqual({ cancelled: false, fields: 3 });
		const raw = JSON.stringify(rows.map((r) => r.metadata));
		expect(raw).not.toContain('Sondertreffen');
		expect(raw).not.toContain('15:00');
	});
});
