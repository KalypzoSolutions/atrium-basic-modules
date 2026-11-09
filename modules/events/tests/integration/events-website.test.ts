/**
 * Website-Endpunkte und Meta-Endpunkte von `events` ohne das optionale Modul `members`: nur der Stamm ist als
 * Gruppe bekannt, Zuordnungen zu (alten) `members`-Gruppen fehlen in `groups`/`groupIds`. Gruppen aus `members`
 * (Filter `group=<id>`, Gruppennamen, Principal-Suche, `/groups` mit/ohne `members`) prüft
 * `ep-intern-modules/modules/_integration/tests/integration/events-website.test.ts`.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { getDb, schema } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin, createUser } from '$testing';
import { createRole } from '$testing';
import { registerModule } from '$testing';
import { enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { resetAllForTests } from '$testing';
import { core } from '$testing';
import eventsModule from '$modules/events/module';
import { todayBerlin } from '$modules/events/website.endpoints';
import { DEFAULT_STAMM_NAME } from '$modules/events/schemas';
import { websiteEventPageSchema, websiteEventSchema } from '$modules/events/website.schemas';
import type { RequestContext } from '$lib/sdk/types';

const BASE = 'http://localhost:5173/api/v1/modules/events';
const ctxOf = async (id: string) => (await contextForUser(id))!.ctx;

let admin: RequestContext;
let adminKey: string;
let websiteKey: string;
let noScopeKey: string;
let editorKey: string;

async function get(path: string, key: string) {
	return send('GET', path, key);
}

async function send(method: string, path: string, key: string, json?: unknown) {
	resetAllForTests();
	const url = new URL(`${BASE}${path}`);
	const headers = new Headers({ authorization: `Bearer ${key}` });
	if (json !== undefined) headers.set('content-type', 'application/json');
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

function addDays(iso: string, days: number): string {
	const d = new Date(`${iso}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
}

interface Seed {
	title: string;
	startsOn: string;
	startsAt?: string | null;
	endsOn?: string | null;
	onWebsite: boolean;
	tags?: string[];
	groups?: string[];
}

async function insertEvent(e: Seed): Promise<string> {
	const id = crypto.randomUUID();
	await core.database.forModule('events').transaction(async (tx) => {
		await tx.execute(sql`
			INSERT INTO events (id, title, description, location, color, starts_on, starts_at, ends_on,
				ends_at, on_website, owner_id, created_by)
			VALUES (${id}, ${e.title}, 'Beschreibung', 'Heim', '#2563eb', ${e.startsOn}::date,
				${e.startsAt ?? null}, ${e.endsOn ?? null}::date, null, ${e.onWebsite}, 'owner-1', 'owner-1')
		`);
		for (const [i, tag] of (e.tags ?? []).entries()) {
			await tx.execute(
				sql`INSERT INTO event_tags (event_id, tag, position) VALUES (${id}, ${tag}, ${i})`
			);
		}
		for (const g of e.groups ?? []) {
			await tx.execute(sql`INSERT INTO event_groups (event_id, group_id) VALUES (${id}, ${g})`);
		}
		await tx.execute(
			sql`INSERT INTO event_shares (event_id, principal_type, principal_id, level)
				VALUES (${id}, 'everyone', '*', 'read')`
		);
	});
	return id;
}

const today = todayBerlin();
/** Gruppe aus einem (hier nicht installierten) `members` – nur als alte Zuordnung in `event_groups` */
const staleGroupId = crypto.randomUUID();

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
	admin = await ctxOf(u!.id);
	await enableModule(admin, 'events');
	admin = await ctxOf(u!.id);
	adminKey = (await createApiKey(admin, { name: 'admin', scopes: ['events.event.view'] })).key;
	editorKey = (
		await createApiKey(admin, {
			name: 'editor',
			scopes: [
				'events.event.view',
				'events.event.create',
				'events.event.edit-all',
				'events.event.publish'
			]
		})
	).key;

	const roleId = await createRole(admin, {
		name: 'Website',
		permissions: ['events.website.read', 'core.api.manage']
	});
	const webUserId = await createUser(admin, {
		name: 'Website',
		email: 'website@example.test',
		password: 'correct-horse-battery-2',
		roleIds: [roleId]
	});
	const web = await ctxOf(webUserId);
	websiteKey = (await createApiKey(web, { name: 'web', scopes: ['events.website.read'] })).key;
	noScopeKey = (await createApiKey(web, { name: 'kein', scopes: ['core.api.manage'] })).key;
});

describe('GET /website/events', () => {
	let future: string;
	let running: string;
	let later: string;

	beforeAll(async () => {
		later = await insertEvent({
			title: 'Sommerlager',
			startsOn: addDays(today, 30),
			endsOn: addDays(today, 37),
			onWebsite: true,
			tags: ['Lager', 'Sommer'],
			groups: ['stamm', staleGroupId]
		});
		future = await insertEvent({
			title: 'Gruppenstunde',
			startsOn: addDays(today, 3),
			startsAt: '17:00',
			onWebsite: true,
			tags: ['Gruppenstunde'],
			groups: [staleGroupId]
		});
		running = await insertEvent({
			title: 'Laufende Fahrt',
			startsOn: addDays(today, -2),
			endsOn: addDays(today, 1),
			onWebsite: true
		});
		await insertEvent({ title: 'Vorbei', startsOn: addDays(today, -10), onWebsite: true });
		await insertEvent({ title: 'Intern', startsOn: addDays(today, 5), onWebsite: false });
	});

	it('liefert nur Website-Termine ab heute, sortiert, nur öffentliche Felder (ohne members nur Stamm)', async () => {
		const { status, body } = await get('/website/events', websiteKey);
		expect(status, JSON.stringify(body)).toBe(200);
		// Vertrag (#48): strikt gegen das exportierte Website-Schema
		websiteEventSchema.array().parse(body.data);
		const items = body.data as Record<string, unknown>[];
		expect(items.map((e) => e.id)).toEqual([running, future, later]);
		for (const item of items) {
			expect(Object.keys(item).sort()).toEqual(
				[
					'color',
					'description',
					'endsOn',
					'endsTime',
					'groupIds',
					'groups',
					'id',
					'location',
					'occurrenceDate',
					'recurring',
					'startsOn',
					'startsTime',
					'tags',
					'title'
				].sort()
			);
		}
		const summer = items[2]!;
		expect(summer.tags).toEqual(['Lager', 'Sommer']);
		// unbekannte (members-)Gruppe fehlt in beiden Feldern
		expect(summer.groups).toEqual([DEFAULT_STAMM_NAME]);
		expect(summer.groupIds).toEqual(['stamm']);
		expect(items[1]!.groups).toEqual([]);
		expect(items[1]!.groupIds).toEqual([]);
		expect(items[0]!.groupIds).toEqual([]);
		expect(summer.endsOn).toBe(addDays(today, 37));
		expect(items[1]!.startsTime).toBe('17:00');
		expect(items[1]!.endsOn).toBeNull();
	});

	it('filtert nach Tag (ohne Groß-/Kleinschreibung), Zeitraum und Limit', async () => {
		const byTag = await get('/website/events?tag=lager', websiteKey);
		expect(byTag.body.data.map((e: { id: string }) => e.id)).toEqual([later]);

		const range = await get(
			`/website/events?from=${addDays(today, -20)}&to=${addDays(today, 4)}`,
			websiteKey
		);
		expect(range.body.data.map((e: { title: string }) => e.title)).toEqual([
			'Vorbei',
			'Laufende Fahrt',
			'Gruppenstunde'
		]);

		const limited = await get('/website/events?limit=1', websiteKey);
		expect(limited.body.data).toHaveLength(1);

		const bad = await get(`/website/events?from=${today}&to=${addDays(today, -1)}`, websiteKey);
		expect(bad.status).toBe(422);
	});

	it('Key ohne Scope events.website.read → 403', async () => {
		const { status, body } = await get('/website/events', noScopeKey);
		expect(status).toBe(403);
		expect(body.error.code).toBe('forbidden');
	});

	it('Website-Key darf keine internen Endpoints nutzen', async () => {
		const { status } = await get('/groups', websiteKey);
		expect(status).toBe(403);
	});
});

describe('Website: Gruppenfilter und Detail', () => {
	let weekly: string;
	let past: string;
	let single: string;
	let hidden: string;

	/** Termin über die API anlegen (Serien, Ausnahmen wie im echten Betrieb) */
	async function create(over: Record<string, unknown>): Promise<string> {
		const res = await send('POST', '/events', editorKey, {
			title: 'Termin',
			description: null,
			location: 'Heim',
			color: null,
			startsOn: today,
			startsTime: null,
			endsOn: null,
			endsTime: null,
			tags: [],
			groupIds: [],
			shares: [],
			onWebsite: true,
			recurrence: null,
			...over
		});
		expect(res.status, JSON.stringify(res.body)).toBe(201);
		return res.body.data.id as string;
	}

	beforeAll(async () => {
		// wöchentlich, offen, Start vor zwei Wochen am heutigen Wochentag → heute ist ein Vorkommen
		weekly = await create({
			title: 'Gruppenstunde Falke',
			startsOn: addDays(today, -14),
			startsTime: '16:30',
			endsOn: addDays(today, -14),
			endsTime: '18:00',
			recurrence: { freq: 'weekly', interval: 1, end: { type: 'never' } }
		});
		// abgeschlossene Serie in der Vergangenheit (3 Vorkommen im Wochenabstand)
		past = await create({
			title: 'Vergangene Reihe',
			startsOn: addDays(today, -60),
			recurrence: { freq: 'weekly', interval: 1, end: { type: 'count', count: 3 } }
		});
		single = await create({
			title: 'Stammesversammlung',
			startsOn: addDays(today, 9),
			groupIds: ['stamm']
		});
		hidden = await create({ title: 'Nur intern', startsOn: addDays(today, 9), onWebsite: false });
	});

	it('ohne members: Gruppe beim Anlegen unbekannt → 422', async () => {
		const res = await send('POST', '/events', editorKey, {
			title: 'Mit Gruppe',
			startsOn: today,
			groupIds: [staleGroupId],
			shares: []
		});
		expect(res.status, JSON.stringify(res.body)).toBe(422);
		expect(res.body.error.code).toBe('validation_failed');
	});

	it('group=stamm liefert die Termine des ganzen Stamms', async () => {
		const { status, body } = await get('/website/events?group=stamm', websiteKey);
		expect(status).toBe(200);
		const items = body.data as { id: string; title: string; groupIds: string[] }[];
		expect(items.map((i) => i.title).sort()).toEqual(['Sommerlager', 'Stammesversammlung']);
		for (const item of items) expect(item.groupIds[0]).toBe('stamm');
	});

	it('ungültige Gruppe → 422, unbekannte Gruppe → leere Liste', async () => {
		const bad = await get('/website/events?group=woelflinge', websiteKey);
		expect(bad.status).toBe(422);
		expect(bad.body.error.code).toBe('validation_failed');
		const unknown = await get(`/website/events?group=${crypto.randomUUID()}`, websiteKey);
		expect(unknown.status).toBe(200);
		expect(unknown.body.data).toEqual([]);
	});

	it('Detail: einmaliger Termin mit öffentlichen Feldern', async () => {
		const { status, body } = await get(`/website/events/${single}`, websiteKey);
		expect(status, JSON.stringify(body)).toBe(200);
		websiteEventSchema.parse(body.data);
		expect(body.data).toEqual({
			id: single,
			title: 'Stammesversammlung',
			description: null,
			location: 'Heim',
			color: null,
			startsOn: addDays(today, 9),
			startsTime: null,
			endsOn: null,
			endsTime: null,
			tags: [],
			groups: [DEFAULT_STAMM_NAME],
			groupIds: ['stamm'],
			recurring: false,
			occurrenceDate: null
		});
		// einmaliger Termin mit `occurrence` → 404
		const occ = await get(`/website/events/${single}?occurrence=${addDays(today, 9)}`, websiteKey);
		expect(occ.status).toBe(404);
	});

	it('Detail: nicht auf der Website, unbekannt oder ungültige ID', async () => {
		const notOnWeb = await get(`/website/events/${hidden}`, websiteKey);
		expect(notOnWeb.status).toBe(404);
		expect(notOnWeb.body.error.code).toBe('not_found');
		const unknown = await get(`/website/events/${crypto.randomUUID()}`, websiteKey);
		expect(unknown.status).toBe(404);
		const bad = await get('/website/events/kein-uuid', websiteKey);
		expect(bad.status).toBe(422);
	});

	it('Detail einer Serie: ohne occurrence nächstes Vorkommen ab heute, sonst das letzte', async () => {
		const next = await get(`/website/events/${weekly}`, websiteKey);
		expect(next.status, JSON.stringify(next.body)).toBe(200);
		expect(next.body.data).toMatchObject({
			id: weekly,
			recurring: true,
			occurrenceDate: today,
			startsOn: today,
			startsTime: '16:30',
			endsTime: '18:00',
			groupIds: []
		});

		const last = await get(`/website/events/${past}`, websiteKey);
		expect(last.status).toBe(200);
		expect(last.body.data).toMatchObject({
			recurring: true,
			occurrenceDate: addDays(today, -46),
			startsOn: addDays(today, -46)
		});
	});

	it('Detail mit occurrence: Änderungen angewendet, abgesagt/kein Vorkommen → 404', async () => {
		const moved = addDays(today, 7);
		const ov = await send('PUT', `/events/${weekly}/occurrences/${moved}`, editorKey, {
			override: { title: 'Gruppenstunde draußen', location: 'Bürgerpark', startsTime: '15:00' }
		});
		expect(ov.status, JSON.stringify(ov.body)).toBe(200);
		const detail = await get(`/website/events/${weekly}?occurrence=${moved}`, websiteKey);
		expect(detail.status).toBe(200);
		expect(detail.body.data).toMatchObject({
			title: 'Gruppenstunde draußen',
			location: 'Bürgerpark',
			startsTime: '15:00',
			occurrenceDate: moved,
			startsOn: moved
		});

		const noOcc = await get(
			`/website/events/${weekly}?occurrence=${addDays(today, 1)}`,
			websiteKey
		);
		expect(noOcc.status).toBe(404);

		// heutiges Vorkommen absagen → 404; ohne occurrence kommt das nächste (geänderte) Vorkommen
		const cancel = await send('PUT', `/events/${weekly}/occurrences/${today}`, editorKey, {
			cancelled: true
		});
		expect(cancel.status, JSON.stringify(cancel.body)).toBe(200);
		const cancelled = await get(`/website/events/${weekly}?occurrence=${today}`, websiteKey);
		expect(cancelled.status).toBe(404);
		const next = await get(`/website/events/${weekly}`, websiteKey);
		expect(next.body.data).toMatchObject({
			occurrenceDate: moved,
			title: 'Gruppenstunde draußen'
		});
		// abgesagtes Vorkommen fehlt auch in der Liste
		const list = await get(`/website/events?from=${today}&to=${today}`, websiteKey);
		expect(
			list.body.data.filter((e: { id: string; occurrenceDate: string }) => e.id === weekly)
		).toEqual([]);
	});

	it('Detail: Scope-only-Key darf, Key ohne Scope nicht; Website-Key nicht auf /events/:id', async () => {
		expect((await get(`/website/events/${single}`, websiteKey)).status).toBe(200);
		const noScope = await get(`/website/events/${single}`, noScopeKey);
		expect(noScope.status).toBe(403);
		expect(noScope.body.error.code).toBe('forbidden');
		expect((await get(`/events/${single}`, websiteKey)).status).toBe(403);
	});
});

describe('Meta-Endpoints', () => {
	it('GET /tags: häufigste zuerst, case-insensitiv zusammengefasst, Teilsuche', async () => {
		await insertEvent({ title: 'A', startsOn: today, onWebsite: false, tags: ['lager'] });
		await insertEvent({ title: 'B', startsOn: today, onWebsite: false, tags: ['LAGER', 'Ab_c'] });
		const all = await get('/tags', adminKey);
		expect(all.status).toBe(200);
		const tags = all.body.data as string[];
		expect(tags[0]!.toLowerCase()).toBe('lager');
		expect(tags.filter((t) => t.toLowerCase() === 'lager')).toHaveLength(1);
		expect(tags).toEqual(expect.arrayContaining(['Sommer', 'Gruppenstunde', 'Ab_c']));

		const search = await get('/tags?search=OMM', adminKey);
		expect(search.body.data).toEqual(['Sommer']);
		// `_` ist kein Platzhalter
		const literal = await get('/tags?search=b_', adminKey);
		expect(literal.body.data).toEqual(['Ab_c']);
	});

	it('GET /settings/stamm liefert den Stammesnamen', async () => {
		const { status, body } = await get('/settings/stamm', adminKey);
		expect(status).toBe(200);
		expect(body.data).toEqual({ name: DEFAULT_STAMM_NAME });
	});

	it('GET /principals sucht Stamm, Rollen und Konten (ohne members keine Gruppen)', async () => {
		const stamm = await get('/principals?search=Stamm', adminKey);
		expect(stamm.status, JSON.stringify(stamm.body)).toBe(200);
		expect(stamm.body.data).toEqual(
			expect.arrayContaining([expect.objectContaining({ type: 'everyone', id: '*' })])
		);
		const { status, body } = await get('/principals?search=Website', adminKey);
		expect(status, JSON.stringify(body)).toBe(200);
		const types = (body.data as { type: string }[]).map((p) => p.type);
		expect(types).toEqual(expect.arrayContaining(['role', 'user']));
		expect(types).not.toContain('group');
		expect(types).not.toContain('member');
		const short = await get('/principals?search=a', adminKey);
		expect(short.status).toBe(422);
	});

	it('GET /groups: ohne members nur der Stamm; Website-Gruppennamen nur Stamm', async () => {
		const res = await get('/groups', adminKey);
		expect(res.status).toBe(200);
		expect(res.body.data).toEqual([
			{
				id: 'stamm',
				name: DEFAULT_STAMM_NAME,
				color: null,
				meetingWeekday: null,
				meetingTime: null,
				meetingEndTime: null,
				meetingPlace: null
			}
		]);
		const web = await get('/website/events?tag=lager', websiteKey);
		expect(web.body.data[0].groups).toEqual([DEFAULT_STAMM_NAME]);
	});
});

describe('Website: Paging (#48)', () => {
	const FROM = '2030-01-01';
	const TO = '2030-06-30';
	const q = `from=${FROM}&to=${TO}&tag=paging`;

	beforeAll(async () => {
		// zwei tägliche Serien à 125 → 250 Vorkommen im Halbjahr (mehr als das Limit von 200)
		for (const title of ['Serie A', 'Serie B']) {
			const res = await send('POST', '/events', editorKey, {
				title,
				description: null,
				location: null,
				color: null,
				startsOn: FROM,
				startsTime: null,
				endsOn: null,
				endsTime: null,
				tags: ['Paging'],
				groupIds: [],
				shares: [],
				onWebsite: true,
				recurrence: { freq: 'daily', interval: 1, end: { type: 'count', count: 125 } }
			});
			expect(res.status, JSON.stringify(res.body)).toBe(201);
		}
	});

	it('ohne paged: Array wie bisher (gekappt auf limit), offset verschiebt', async () => {
		const first = await get(`/website/events?${q}&limit=200`, websiteKey);
		expect(first.status).toBe(200);
		expect(Array.isArray(first.body.data)).toBe(true);
		expect(first.body.data).toHaveLength(200);
		const rest = await get(`/website/events?${q}&limit=200&offset=200`, websiteKey);
		expect(rest.body.data).toHaveLength(50);
	});

	it('paged=1: alle 250 Vorkommen über Seiten, total/hasMore, ohne Lücken und Dubletten', async () => {
		const keys: string[] = [];
		let offset = 0;
		let pages = 0;
		for (;;) {
			const { status, body } = await get(
				`/website/events?${q}&limit=200&offset=${offset}&paged=1`,
				websiteKey
			);
			expect(status, JSON.stringify(body)).toBe(200);
			const page = websiteEventPageSchema.parse(body.data);
			expect(page.total).toBe(250);
			expect(page.offset).toBe(offset);
			expect(page.limit).toBe(200);
			keys.push(...page.items.map((e) => `${e.id}~${e.occurrenceDate}`));
			pages++;
			if (!page.hasMore) break;
			offset += page.items.length;
		}
		expect(pages).toBe(2);
		expect(keys).toHaveLength(250);
		expect(new Set(keys).size).toBe(250);
	});

	it('paged=0 bzw. ungültiges Flag / negativer offset', async () => {
		const plain = await get(`/website/events?${q}&limit=5&paged=0`, websiteKey);
		expect(Array.isArray(plain.body.data)).toBe(true);
		expect((await get(`/website/events?${q}&paged=ja`, websiteKey)).status).toBe(422);
		expect((await get(`/website/events?${q}&offset=-1`, websiteKey)).status).toBe(422);
		const beyond = await get(`/website/events?${q}&offset=1000&paged=1`, websiteKey);
		expect(beyond.body.data).toMatchObject({ items: [], total: 250, hasMore: false });
	});
});
