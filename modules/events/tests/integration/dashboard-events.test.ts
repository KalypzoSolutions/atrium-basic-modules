/**
 * Übersicht (`/dashboard`, „Diese Woche“): Quelle `events.dashboard.agenda` über
 * `collectDashboardFeed` – Sichtbarkeit (Freigabe vs. ohne), Serien je Vorkommen im Zeitraum
 * (abgesagtes fehlt, geändertes mit neuem Titel), mehrtägige Überlappung, Uhrzeiten und Link.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { getDb, schema } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin, createUser } from '$testing';
import { createRole } from '$testing';
import { registerModule } from '$testing';
import { disableModule, enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { resetAllForTests } from '$testing';
import { collectDashboardFeed } from '$testing';
import eventsModule from '$modules/events/module';
import eventsUi from '$modules/events/ui';
import type { EventDetail } from '$modules/events/schemas';
import type { RequestContext } from '$lib/sdk/types';

const ROOT = 'http://localhost:5173/api/v1/modules/events';
// Woche Mo 02.11. – So 08.11.2026
const TODAY = '2026-11-04';
let close: () => Promise<void>;
let adminId = '';
let adminKey = '';
const userIds: Record<string, string> = {};

async function call<T>(method: string, path: string, json?: unknown, status = 200): Promise<T> {
	resetAllForTests();
	const headers = new Headers({ authorization: `Bearer ${adminKey}` });
	if (json !== undefined) headers.set('content-type', 'application/json');
	const url = new URL(`${ROOT}${path}`);
	const res = await handleApiRequest({
		request: new Request(url, {
			method,
			headers,
			body: json === undefined ? undefined : JSON.stringify(json)
		}),
		url,
		ip: '127.0.0.1'
	});
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.data as T;
}

const ctxOf = async (id: string): Promise<RequestContext> => (await contextForUser(id))!.ctx;
const agendaOf = async (who: string) =>
	(await collectDashboardFeed(await ctxOf(userIds[who] ?? who), { today: TODAY })).agenda.filter(
		(a) => a.moduleId === 'events'
	);
const shareTo = (who: string) => [{ type: 'user', id: userIds[who], level: 'read' }];

let shared: EventDetail;
let hidden: EventDetail;
let series: EventDetail;
let multi: EventDetail;

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
	adminId = u!.id;
	await enableModule(await ctxOf(adminId), 'events');
	const admin = await ctxOf(adminId);
	adminKey = (await createApiKey(admin, { name: 'a', scopes: [...admin.permissions] })).key;
	const role = await createRole(admin, { name: 'Leser', permissions: ['events.event.view'] });
	for (const name of ['leser', 'fremd']) {
		userIds[name] = await createUser(admin, {
			name,
			email: `${name}@example.test`,
			password: 'dashboard-password-1234',
			roleIds: [role]
		});
	}

	shared = await call<EventDetail>(
		'POST',
		'/events',
		{
			title: 'Elternabend',
			location: 'Gemeindehaus',
			startsOn: '2026-11-04',
			startsTime: '18:00',
			endsOn: '2026-11-04',
			endsTime: '20:00',
			shares: shareTo('leser')
		},
		201
	);
	hidden = await call<EventDetail>(
		'POST',
		'/events',
		{ title: 'Leitungsrunde', startsOn: '2026-11-05' },
		201
	);
	series = await call<EventDetail>(
		'POST',
		'/events',
		{
			title: 'Morgenkreis',
			startsOn: '2026-11-01',
			startsTime: '08:00',
			recurrence: { freq: 'daily', end: { type: 'count', count: 10 } },
			shares: shareTo('leser')
		},
		201
	);
	await call('PUT', `/events/${series.id}/occurrences/2026-11-03`, { cancelled: true });
	await call('PUT', `/events/${series.id}/occurrences/2026-11-05`, {
		override: { title: 'Morgenkreis draußen' }
	});
	multi = await call<EventDetail>(
		'POST',
		'/events',
		{
			title: 'Herbstlager',
			startsOn: '2026-10-30',
			startsTime: '16:00',
			endsOn: '2026-11-02',
			endsTime: '12:00',
			shares: shareTo('leser')
		},
		201
	);
	// Liegt komplett vor der Woche
	await call(
		'POST',
		'/events',
		{ title: 'Alt', startsOn: '2026-10-20', endsOn: '2026-10-25', shares: shareTo('leser') },
		201
	);
});
afterAll(async () => {
	await close();
});

describe('events: Übersicht „Diese Woche“', () => {
	it('Kachel „Nächste Termine“ ist standardmäßig ausgeblendet', () => {
		expect(eventsUi.dashboardWidgets?.find((w) => w.id === 'upcoming')?.defaultHidden).toBe(true);
	});

	it('einmaliger Termin mit Uhrzeit, Ort als Zusatz und Deep-Link', async () => {
		const items = await agendaOf('leser');
		const e = items.find((a) => a.id === shared.id);
		expect(e).toMatchObject({
			kind: 'event',
			title: 'Elternabend',
			date: '2026-11-04',
			endDate: null,
			startTime: '18:00',
			endTime: '20:00',
			detail: 'Gemeindehaus',
			href: `/modules/events?month=2026-11&event=${shared.id}`
		});
	});

	it('nur sichtbare Termine: ohne Freigabe fehlt der Termin, Eigentümer*in sieht ihn', async () => {
		expect((await agendaOf('leser')).some((a) => a.id === hidden.id)).toBe(false);
		expect(await agendaOf('fremd')).toEqual([]);
		expect((await agendaOf(adminId)).some((a) => a.id === hidden.id)).toBe(true);
	});

	it('Serie je Vorkommen im Zeitraum, abgesagtes fehlt, geändertes mit neuem Titel', async () => {
		const occ = (await agendaOf('leser')).filter((a) => a.id.startsWith(`${series.id}:`));
		expect(occ.map((a) => a.date)).toEqual([
			'2026-11-02',
			'2026-11-04',
			'2026-11-05',
			'2026-11-06',
			'2026-11-07',
			'2026-11-08'
		]);
		expect(occ.find((a) => a.date === '2026-11-05')?.title).toBe('Morgenkreis draußen');
		expect(occ.find((a) => a.date === '2026-11-02')).toMatchObject({
			title: 'Morgenkreis',
			startTime: '08:00',
			endTime: null,
			href: `/modules/events?month=2026-11&event=${series.id}&occurrence=2026-11-02`
		});
	});

	it('mehrtägiger Termin, der in die Woche hineinragt, erscheint mit Enddatum', async () => {
		const items = await agendaOf('leser');
		expect(items.find((a) => a.id === multi.id)).toMatchObject({
			date: '2026-10-30',
			endDate: '2026-11-02',
			startTime: '16:00',
			endTime: null
		});
		expect(items.some((a) => a.title === 'Alt')).toBe(false);
	});

	it('Modul deaktiviert → keine Einträge', async () => {
		await disableModule(await ctxOf(adminId), 'events');
		expect(await agendaOf('leser')).toEqual([]);
		await enableModule(await ctxOf(adminId), 'events');
	});
});
