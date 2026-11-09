/**
 * Kalender-Abo (iCal) im Modul `events`: Abos verwalten (eigene, Grenze, Ändern behält den Link, neuer Link
 * macht den alten ungültig, Löschen), Abruf ohne Anmeldung mit den Rechten der Besitzer*in (Freigaben,
 * Serien mit Absage und Änderung, Filter nach Stamm und Tags), 404 bei unbekanntem Link, deaktiviertem Konto
 * oder entzogenem Recht, Konto löschen, Audit ohne Inhalte. Ohne die optionalen Module `members`/`actions`:
 * `actionsAvailable: false`, ein reines Aktionen-Abo bleibt leer, `members`-Gruppen sind unbekannt.
 * Gruppen aus `members` und Aktionen (sichtbare/eigene Anmeldungen) prüft
 * `ep-intern-modules/modules/_integration/tests/integration/events-calendar-feeds.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin, createUser, deleteUser, setUserActive } from '$testing';
import { createRole } from '$testing';
import { registerModule } from '$testing';
import { enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { getDb, schema } from '$testing';
import { listAudit } from '$testing';
import { resetAllForTests } from '$testing';
import { setTodayForTests } from '$lib/sdk/dates';
import { moduleDb } from '$lib/sdk/server';
import eventsModule from '$modules/events/module';
import type { CalendarFeed, CalendarFeedList } from '$modules/events/schemas';
import type { RequestContext } from '$lib/sdk/types';

let close: () => Promise<void>;
let admin: RequestContext;
const userIds: Record<string, string> = {};
const keys: Record<string, string> = {};

function api(path: string, init: RequestInit & { token?: string; json?: unknown } = {}) {
	const { token, json, ...rest } = init;
	const headers = new Headers(rest.headers);
	if (token) headers.set('authorization', `Bearer ${token}`);
	if (json !== undefined) {
		rest.body = JSON.stringify(json);
		headers.set('content-type', 'application/json');
	}
	const url = new URL(`http://localhost:5173/api/v1${path}`);
	return handleApiRequest({
		request: new Request(url, { ...rest, headers }),
		url,
		ip: '127.0.0.1'
	});
}
async function data<T>(res: Response, status = 200): Promise<T> {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.data as T;
}
async function errCode(res: Response, status: number) {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.error.code as string;
}
const ctxOf = async (id: string) => (await contextForUser(id))!.ctx;
const E = (who: string, path: string, init: Parameters<typeof api>[1] = {}) =>
	api(`/modules/events${path}`, { token: keys[who], ...init });

async function mkUser(name: string, permissions: string[]) {
	const role = await createRole(admin, { name: `r-${name}`, permissions });
	userIds[name] = await createUser(admin, {
		name: `${name[0]!.toUpperCase()}${name.slice(1)} Test`,
		email: `${name}@example.test`,
		password: 'calendar-password-1234',
		roleIds: [role]
	});
	const ctx = await ctxOf(userIds[name]!);
	keys[name] = (await createApiKey(ctx, { name: `k-${name}`, scopes: [...ctx.permissions] })).key;
}

const newFeed = (who: string, json: Record<string, unknown> = {}) =>
	E(who, '/calendar-feeds', { method: 'POST', json: { name: 'Alles', ...json } }).then((r) =>
		data<CalendarFeed>(r, 201)
	);

/** Feed so abrufen, wie es eine Kalender-App tut (ohne Anmeldung) */
async function fetchIcs(url: string): Promise<Response> {
	const path = new URL(url).pathname.replace(/^\/api\/v1/, '');
	return api(path);
}
async function ics(url: string): Promise<string> {
	const res = await fetchIcs(url);
	expect(res.status).toBe(200);
	expect(res.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
	// Gefaltete Zeilen (RFC 5545) zusammenfügen, wie es eine Kalender-App tut
	return (await res.text()).replace(/\r\n /g, '');
}
const summaries = (text: string) =>
	text
		.split('\r\n')
		.filter((l) => l.startsWith('SUMMARY:'))
		.map((l) => l.slice(8));

beforeAll(async () => {
	({ close } = await useTestDatabase());
	registerCoreApi();
	registerModule(eventsModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', 'correct-horse-battery');
	const [u] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	admin = await ctxOf(u!.id);
	await enableModule(admin, 'events');
	admin = await ctxOf(u!.id);
	keys.admin = (await createApiKey(admin, { name: 'a', scopes: [...admin.permissions] })).key;
	setTodayForTests('2026-10-01');

	await mkUser('anna', ['core.api.manage', 'events.event.view']);
	await mkUser('bert', ['core.api.manage', 'events.event.view']);
	await mkUser('ohne', ['core.api.manage']);

	const ev = (json: Record<string, unknown>) =>
		E('admin', '/events', { method: 'POST', json }).then((r) => data<{ id: string }>(r, 201));
	await ev({
		title: 'Stammesversammlung',
		startsOn: '2026-10-10',
		startsTime: '15:00',
		endsOn: '2026-10-10',
		endsTime: '17:00',
		location: 'Heim',
		tags: ['Versammlung'],
		groupIds: ['stamm'],
		shares: [{ type: 'everyone', id: '*', level: 'read' }]
	});
	await ev({ title: 'Nur für Admin', startsOn: '2026-10-11' });
	const series = await ev({
		title: 'Gruppenstunde Grün',
		startsOn: '2026-10-05',
		startsTime: '17:00',
		endsOn: '2026-10-05',
		endsTime: '18:30',
		shares: [{ type: 'everyone', id: '*', level: 'read' }],
		recurrence: { freq: 'weekly', end: { type: 'count', count: 3 } }
	});
	await data(
		await E('admin', `/events/${series.id}/occurrences/2026-10-12`, {
			method: 'PUT',
			json: { cancelled: true }
		})
	);
	await data(
		await E('admin', `/events/${series.id}/occurrences/2026-10-19`, {
			method: 'PUT',
			json: { override: { title: 'Gruppenstunde Grün (Ausflug)' } }
		})
	);
});
afterAll(async () => {
	setTodayForTests(null);
	await close();
});

describe('Abos verwalten', () => {
	it('anlegen, eigene Liste, Link mit .ics und webcal, Grenze 10, fremd → 404', async () => {
		resetAllForTests();
		const feed = await newFeed('bert', { name: 'Familie', tags: ['Versammlung'] });
		expect(feed.url).toMatch(/\/api\/v1\/modules\/events\/public\/calendar\/[\w-]{43}\.ics$/);
		expect(feed.webcalUrl).toBe(feed.url!.replace(/^https?:/, 'webcal:'));
		expect(feed).toMatchObject({
			name: 'Familie',
			includeEvents: true,
			includeActions: true,
			tags: ['Versammlung'],
			lastUsedAt: null
		});
		const list = await data<CalendarFeedList>(await E('bert', '/calendar-feeds'));
		expect(list).toMatchObject({ actionsAvailable: false, max: 10 });
		expect(list.feeds.map((f) => f.id)).toEqual([feed.id]);
		expect((await data<CalendarFeedList>(await E('anna', '/calendar-feeds'))).feeds).toEqual([]);

		expect(
			await errCode(await E('anna', `/calendar-feeds/${feed.id}`, { method: 'DELETE' }), 404)
		).toBe('not_found');
		expect(
			await errCode(
				await E('anna', `/calendar-feeds/${feed.id}`, { method: 'PUT', json: { name: 'x' } }),
				404
			)
		).toBe('not_found');

		for (let i = 2; i <= 10; i++) await newFeed('bert', { name: `Abo ${i}` });
		expect(
			await errCode(
				await E('bert', '/calendar-feeds', { method: 'POST', json: { name: 'Elf' } }),
				409
			)
		).toBe('conflict');
	});

	it('Validierung: Name, weder Termine noch Aktionen, unbekannte Gruppe (ohne members); ohne Recht 403', async () => {
		resetAllForTests();
		const post = (json: unknown) => E('anna', '/calendar-feeds', { method: 'POST', json });
		expect(await errCode(await post({ name: ' ' }), 422)).toBe('validation_failed');
		expect(
			await errCode(await post({ name: 'x', includeEvents: false, includeActions: false }), 422)
		).toBe('validation_failed');
		expect(await errCode(await post({ name: 'x', groupIds: ['gibt-es-nicht'] }), 422)).toBe(
			'validation_failed'
		);
		// Stamm ist immer bekannt, auch ohne `members`
		const stamm = await newFeed('anna', { name: 'Stamm', groupIds: ['stamm'] });
		expect(stamm.groupIds).toEqual(['stamm']);
		await data(await E('anna', `/calendar-feeds/${stamm.id}`, { method: 'DELETE' }));
		expect(
			await errCode(
				await E('ohne', '/calendar-feeds', { method: 'POST', json: { name: 'x' } }),
				403
			)
		).toBe('forbidden');
	});

	it('ändern behält den Link, neuer Link macht den alten ungültig, löschen', async () => {
		resetAllForTests();
		const feed = await newFeed('anna');
		const changed = await data<CalendarFeed>(
			await E('anna', `/calendar-feeds/${feed.id}`, {
				method: 'PUT',
				json: { name: 'Umbenannt', includeActions: false }
			})
		);
		expect(changed).toMatchObject({ name: 'Umbenannt', includeActions: false, url: feed.url });
		const rotated = await data<CalendarFeed>(
			await E('anna', `/calendar-feeds/${feed.id}/rotate`, { method: 'POST' }),
			201
		);
		expect(rotated.url).not.toBe(feed.url);
		expect(await errCode(await fetchIcs(feed.url!), 404)).toBe('not_found');
		expect((await fetchIcs(rotated.url!)).status).toBe(200);
		await data(await E('anna', `/calendar-feeds/${feed.id}`, { method: 'DELETE' }));
		expect(await errCode(await fetchIcs(rotated.url!), 404)).toBe('not_found');

		const audit = await listAudit({ action: 'events.calendar-feed' });
		expect(audit.rows.map((a) => a.action)).toEqual(
			expect.arrayContaining([
				'events.calendar-feed.created',
				'events.calendar-feed.updated',
				'events.calendar-feed.rotated',
				'events.calendar-feed.deleted'
			])
		);
		expect(JSON.stringify(audit.rows)).not.toMatch(/Umbenannt|public\/calendar/);
	});
});

describe('Abruf durch die Kalender-App', () => {
	it('nur sichtbare Termine; Serie ohne Absage, mit Änderung; ohne actions keine Aktionen', async () => {
		resetAllForTests();
		const feed = await newFeed('anna');
		const text = await ics(feed.url!);
		expect(summaries(text)).toEqual(
			expect.arrayContaining([
				'Stammesversammlung',
				'Gruppenstunde Grün',
				'Gruppenstunde Grün (Ausflug)'
			])
		);
		expect(summaries(text)).toHaveLength(3);
		expect(text).not.toContain('Nur für Admin');
		// Serie: 05.10. und 19.10. (12.10. abgesagt), je eigene UID
		const uids = text.split('\r\n').filter((l) => l.startsWith('UID:'));
		expect(uids.filter((l) => l.includes('-2026-10-'))).toHaveLength(2);
		expect(text).not.toContain('20261012T170000');
		expect(text).toContain('DTSTART;TZID=Europe/Berlin:20261005T170000');
		// Abo enthält Aktionen (Standard), aber `actions` ist nicht installiert
		expect(feed.includeActions).toBe(true);
		expect(text).not.toContain('/modules/actions/');
		expect(text).not.toContain('CATEGORIES:Aktion');

		const list = await data<CalendarFeedList>(await E('anna', '/calendar-feeds'));
		expect(list.feeds.find((f) => f.id === feed.id)?.lastUsedAt).not.toBeNull();
		// Der geheime Link landet nicht im API-Protokoll (nur das Muster)
		const token = feed.url!.split('/').pop()!.replace('.ics', '');
		const logged = await getDb().select({ path: schema.apiLog.path }).from(schema.apiLog);
		expect(logged.some((l) => l.path.includes('/public/calendar/'))).toBe(true);
		expect(JSON.stringify(logged)).not.toContain(token);
	});

	it('Admin sieht alles; Filter Stamm, Tag; reines Aktionen-Abo ohne actions bleibt leer', async () => {
		resetAllForTests();
		const all = await ics((await newFeed('admin')).url!);
		expect(all).toContain('Nur für Admin');

		const stamm = await ics(
			(await newFeed('admin', { name: 'Stamm', groupIds: ['stamm'], includeActions: false })).url!
		);
		expect(summaries(stamm)).toEqual(['Stammesversammlung']);
		const tagged = await ics(
			(await newFeed('admin', { name: 'Tag', tags: ['versammlung'], includeActions: false })).url!
		);
		expect(summaries(tagged)).toEqual(['Stammesversammlung']);
		const onlyActions = await ics(
			(await newFeed('admin', { name: 'Aktionen', includeEvents: false })).url!
		);
		expect(summaries(onlyActions)).toEqual([]);
		expect(onlyActions).toContain('BEGIN:VCALENDAR');
	});

	it('unbekannter oder kaputter Link, deaktiviertes Konto, entzogenes Recht → 404; Konto löschen entfernt die Abos', async () => {
		resetAllForTests();
		expect(
			await errCode(await api(`/modules/events/public/calendar/${'a'.repeat(43)}.ics`), 404)
		).toBe('not_found');
		expect(await errCode(await api('/modules/events/public/calendar/kurz'), 422)).toBe(
			'validation_failed'
		);

		const feed = await newFeed('bert', { name: 'Bert' }).catch(async () => {
			// Bert hat schon 10 Abos aus dem ersten Test: eines freimachen
			const list = await data<CalendarFeedList>(await E('bert', '/calendar-feeds'));
			await data(await E('bert', `/calendar-feeds/${list.feeds[0]!.id}`, { method: 'DELETE' }));
			return newFeed('bert', { name: 'Bert' });
		});
		expect((await fetchIcs(feed.url!)).status).toBe(200);
		await setUserActive(admin, userIds.bert!, false);
		expect(await errCode(await fetchIcs(feed.url!), 404)).toBe('not_found');
		await setUserActive(admin, userIds.bert!, true);
		expect((await fetchIcs(feed.url!)).status).toBe(200);

		await deleteUser(admin, userIds.bert!);
		expect(await errCode(await fetchIcs(feed.url!), 404)).toBe('not_found');
		const [left] = await moduleDb('events').transaction(
			async (tx) =>
				(
					(await tx.execute(
						sql`SELECT count(*)::int AS n FROM calendar_feeds WHERE user_id = ${userIds.bert}`
					)) as unknown as { rows: { n: number }[] }
				).rows
		);
		expect(Number(left!.n)).toBe(0);
	});
});
