import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { contextForUser, systemContext } from '$testing';
import { bootstrapAdmin, createUser } from '$testing';
import { createRole } from '$testing';
import { registerModule } from '$testing';
import { enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { getDb, schema } from '$testing';
import eventsModule from '$modules/events/module';
import { describeEventRefs, searchEventRefs, websiteEventRefs } from '$modules/events/refs.service';
import type { EventRefsService } from '$modules/events/contract';
import type { EventDetail } from '$modules/events/schemas';
import type { RequestContext } from '$lib/sdk/types';

const users: Record<string, string> = {};
const ids: Record<string, string> = {};
let aliceKey = '';

async function ctxOf(userId: string): Promise<RequestContext> {
	const r = await contextForUser(userId);
	if (!r) throw new Error('Kontext nicht auflösbar');
	return r.ctx;
}

async function createEvent(over: Record<string, unknown>): Promise<string> {
	const url = new URL('http://localhost:5173/api/v1/modules/events/events');
	const res = await handleApiRequest({
		request: new Request(url, {
			method: 'POST',
			headers: { authorization: `Bearer ${aliceKey}`, 'content-type': 'application/json' },
			body: JSON.stringify({
				title: 'Termin',
				description: null,
				location: null,
				startsOn: '2026-11-03',
				startsTime: null,
				endsOn: null,
				endsTime: null,
				tags: [],
				groupIds: [],
				shares: [],
				onWebsite: false,
				...over
			})
		}),
		url,
		ip: '127.0.0.1'
	});
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(201);
	return (body.data as EventDetail).id;
}

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

	const mk = async (name: string, permissions: string[]) => {
		const roleId = await createRole(admin, { name: `r-${name}`, permissions });
		users[name] = await createUser(admin, {
			name: `${name} Test`,
			email: `${name}@example.test`,
			password: 'a-long-enough-pw',
			roleIds: [roleId]
		});
	};
	await mk('alice', [
		'core.api.manage',
		'events.event.view',
		'events.event.create',
		'events.event.publish'
	]);
	await mk('bob', ['events.event.view']);
	await mk('carol', ['events.event.view', 'events.event.view-all']);
	await mk('dave', ['events.website.read']);

	aliceKey = (
		await createApiKey(await ctxOf(users.alice!), {
			name: 'alice',
			scopes: ['events.event.view', 'events.event.create', 'events.event.publish']
		})
	).key;

	ids.privat = await createEvent({ title: 'Privat 100%', startsOn: '2026-10-01' });
	ids.geteilt = await createEvent({
		title: 'Geteilt_Treffen',
		startsOn: '2026-12-01',
		endsOn: '2026-12-02',
		color: '#aabbcc',
		shares: [{ type: 'user', id: users.bob!, level: 'read' }]
	});
	ids.serie = await createEvent({
		title: 'Gruppenstunde',
		startsOn: '2027-01-05',
		onWebsite: true,
		recurrence: { freq: 'weekly', interval: 1, byWeekday: [2], end: { type: 'never' } }
	});
});

describe('EventRefsService', () => {
	it('Eigentümerin sieht eigene Termine, neueste zuerst, mit Feldern', async () => {
		const refs = await searchEventRefs(await ctxOf(users.alice!));
		expect(refs.map((r) => r.id)).toEqual([ids.serie, ids.geteilt, ids.privat]);
		expect(refs[0]).toEqual({
			id: ids.serie,
			title: 'Gruppenstunde',
			startsOn: '2027-01-05',
			endsOn: null,
			color: null,
			recurring: true,
			onWebsite: true
		});
		expect(refs[1]).toMatchObject({
			startsOn: '2026-12-01',
			endsOn: '2026-12-02',
			color: '#aabbcc',
			recurring: false,
			onWebsite: false
		});
	});

	it('Freigabe macht sichtbar, fremde Termine fehlen', async () => {
		const bob = await ctxOf(users.bob!);
		expect((await searchEventRefs(bob)).map((r) => r.id)).toEqual([ids.geteilt]);
		const desc = await describeEventRefs(bob, [ids.privat!, ids.geteilt!, ids.serie!]);
		expect(desc.map((r) => r.id)).toEqual([ids.geteilt]);
	});

	it('view-all sieht alles', async () => {
		const carol = await ctxOf(users.carol!);
		expect(await searchEventRefs(carol)).toHaveLength(3);
	});

	it('ohne events.event.view leer statt Fehler', async () => {
		const dave = await ctxOf(users.dave!);
		expect(await searchEventRefs(dave)).toEqual([]);
		expect(await describeEventRefs(dave, [ids.serie!])).toEqual([]);
	});

	it('System sieht alles', async () => {
		const sys = systemContext();
		expect(await searchEventRefs(sys)).toHaveLength(3);
		expect(await describeEventRefs(sys, [ids.privat!])).toHaveLength(1);
	});

	it('Suche ILIKE mit maskierten Platzhaltern und limit', async () => {
		const alice = await ctxOf(users.alice!);
		expect((await searchEventRefs(alice, { search: 'gruppen' })).map((r) => r.id)).toEqual([
			ids.serie
		]);
		expect((await searchEventRefs(alice, { search: '100%' })).map((r) => r.id)).toEqual([
			ids.privat
		]);
		// `%` und `_` sind keine Platzhalter
		expect(await searchEventRefs(alice, { search: '%' })).toHaveLength(1);
		expect((await searchEventRefs(alice, { search: '_' })).map((r) => r.id)).toEqual([ids.geteilt]);
		expect(await searchEventRefs(alice, { search: 'Pri_at' })).toEqual([]);
		expect(await searchEventRefs(alice, { limit: 1 })).toHaveLength(1);
		expect(await searchEventRefs(alice, { limit: 0 })).toHaveLength(1);
		expect(await searchEventRefs(alice, { limit: 999 })).toHaveLength(3);
	});

	it('describe in Reihenfolge der IDs, unbekannte fehlen, leere Liste', async () => {
		const alice = await ctxOf(users.alice!);
		const order = [ids.privat!, crypto.randomUUID(), ids.serie!, ids.geteilt!];
		expect((await describeEventRefs(alice, order)).map((r) => r.id)).toEqual([
			ids.privat,
			ids.serie,
			ids.geteilt
		]);
		expect(await describeEventRefs(alice, [])).toEqual([]);
	});

	it('websiteEventRefs liefert nur Website-Termine, ohne Rechteprüfung', async () => {
		const refs = await websiteEventRefs([ids.privat!, ids.serie!, ids.geteilt!]);
		expect(refs.map((r) => r.id)).toEqual([ids.serie]);
		expect(refs[0]!.recurring).toBe(true);
		expect(await websiteEventRefs([])).toEqual([]);
	});

	it('wird über `provides` angeboten', () => {
		const svc = eventsModule.provides as unknown as EventRefsService;
		expect(svc.searchEventRefs).toBe(searchEventRefs);
		expect(svc.describeEventRefs).toBe(describeEventRefs);
		expect(svc.websiteEventRefs).toBe(websiteEventRefs);
	});
});
