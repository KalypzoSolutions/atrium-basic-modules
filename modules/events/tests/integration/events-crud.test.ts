import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin, createUser } from '$testing';
import { createRole } from '$testing';
import { registerModule } from '$testing';
import { enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { getDb, schema } from '$testing';
import eventsModule from '$modules/events/module';
import type { EventDetail, EventList } from '$modules/events/schemas';

const BASE = '/modules/events';
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

const as = (who: string, path: string, init: Parameters<typeof api>[1] = {}) =>
	api(`${BASE}${path}`, { token: keys[who], ...init });

async function data<T>(res: Response, status = 200): Promise<T> {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.data as T;
}

async function ctxOf(userId: string) {
	const r = await contextForUser(userId);
	if (!r) throw new Error('Kontext nicht auflösbar');
	return r.ctx;
}

const body = (over: Record<string, unknown> = {}) => ({
	title: 'Gruppenstunde',
	description: 'Basteln',
	location: 'Heim',
	startsOn: '2026-11-03',
	startsTime: '17:00',
	endsOn: null,
	endsTime: null,
	tags: ['Basteln', 'basteln', 'Heim'],
	groupIds: ['stamm'],
	shares: [],
	onWebsite: false,
	...over
});

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
			scopes: ['events.event.view', 'events.event.create', 'events.event.edit-all']
		})
	).key;
	const perms = ['core.api.manage', 'events.event.view'];
	const roleId = await createRole(admin, { name: 'viewer', permissions: perms });
	const strangerId = await createUser(admin, {
		name: 'Fremd Test',
		email: 'stranger@example.test',
		password: 'a-long-enough-pw',
		roleIds: [roleId]
	});
	keys.stranger = (
		await createApiKey(await ctxOf(strangerId), { name: 'stranger', scopes: perms })
	).key;
});

describe('Termine: CRUD', () => {
	let id: string;

	it('legt an, liest, ändert und löscht', async () => {
		const created = await data<EventDetail>(
			await as('admin', '/events', { method: 'POST', json: body() }),
			201
		);
		id = created.id;
		expect(created.tags).toEqual(['Basteln', 'Heim']);
		expect(created.groups.map((g) => g.id)).toEqual(['stamm']);
		expect(created.access).toEqual({ level: 'edit', isOwner: true });
		expect(created.owner?.name).toBeTruthy();

		const read = await data<EventDetail>(await as('admin', `/events/${id}`));
		expect(read.title).toBe('Gruppenstunde');
		expect(read.startsOn).toBe('2026-11-03');

		const list = await data<EventList>(
			await as('admin', '/events?from=2026-11-01&to=2026-11-30&tag=HEIM')
		);
		expect(list.total).toBe(1);
		const outside = await data<EventList>(await as('admin', '/events?from=2026-12-01'));
		expect(outside.total).toBe(0);

		const updated = await data<EventDetail>(
			await as('admin', `/events/${id}`, {
				method: 'PUT',
				json: body({ title: 'Neu', tags: ['X'], groupIds: [] })
			})
		);
		expect(updated.title).toBe('Neu');
		expect(updated.tags).toEqual(['X']);
		expect(updated.groups).toEqual([]);

		const bad = await as('admin', '/events', {
			method: 'POST',
			json: body({ groupIds: ['gibt-es-nicht'] })
		});
		expect(bad.status).toBe(422);
	});

	it('Fremde ohne Freigabe sehen nichts (404); Freigabe an everyone macht sichtbar', async () => {
		expect((await as('stranger', `/events/${id}`)).status).toBe(404);
		expect((await data<EventList>(await as('stranger', '/events'))).total).toBe(0);
		expect((await as('stranger', '/events', { method: 'POST', json: body() })).status).toBe(403);

		const shared = await data<EventDetail>(
			await as('admin', `/events/${id}`, {
				method: 'PUT',
				json: body({ shares: [{ type: 'everyone', id: '*', level: 'read' }] })
			})
		);
		expect(shared.shares).toHaveLength(1);

		const seen = await data<EventDetail>(await as('stranger', `/events/${id}`));
		expect(seen.access.level).toBe('read');
		expect(seen.shares).toEqual([]);
		expect((await data<EventList>(await as('stranger', '/events'))).total).toBe(1);
		expect((await as('stranger', `/events/${id}`, { method: 'PUT', json: body() })).status).toBe(
			403
		);
		expect((await as('stranger', `/events/${id}`, { method: 'DELETE' })).status).toBe(403);

		await data(await as('admin', `/events/${id}`, { method: 'DELETE' }));
		expect((await as('admin', `/events/${id}`)).status).toBe(404);
	});
});
