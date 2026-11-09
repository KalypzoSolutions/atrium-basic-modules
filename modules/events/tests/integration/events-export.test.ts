/**
 * PDF-Export der Termine (`GET /events/export.pdf`): gleiche Sichtbarkeit wie die Terminliste (Freigaben, Serien je
 * Vorkommen mit Absage und Änderung), Filter nach Stamm/Tag, drei Ausführungen, Briefkopf wählbar, Prüfung des
 * Zeitraums, Recht, Audit ohne Inhalte, Texte maskiert. Ohne das optionale Modul `actions`: keine Aktionen,
 * `actionsAvailable: false`. Aktionen im Export prüft
 * `ep-intern-modules/modules/_integration/tests/integration/events-export.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
	bootstrapAdmin,
	contextForUser,
	createApiKey,
	createRole,
	createUser,
	enableModule,
	getDb,
	handleApiRequest,
	listAudit,
	registerCoreApi,
	registerModule,
	schema,
	setPdfRendererForTests,
	syncModules,
	useTestDatabase
} from '$testing';
import { setTodayForTests } from '$lib/sdk/dates';
import eventsModule from '$modules/events/module';
import type { ExportOptions } from '$modules/events/schemas';
import type { RequestContext } from '$lib/sdk/types';

let close: () => Promise<void>;
let admin: RequestContext;
const userIds: Record<string, string> = {};
const keys: Record<string, string> = {};
let html = '';
let renderOptions: { landscape?: boolean } = {};

function api(path: string, token?: string) {
	const headers = new Headers();
	if (token) headers.set('authorization', `Bearer ${token}`);
	const url = new URL(`http://localhost:5173/api/v1${path}`);
	return handleApiRequest({ request: new Request(url, { headers }), url, ip: '127.0.0.1' });
}
async function post<T>(path: string, json: unknown, method = 'POST'): Promise<T> {
	const url = new URL(`http://localhost:5173/api/v1${path}`);
	const res = await handleApiRequest({
		request: new Request(url, {
			method,
			headers: { authorization: `Bearer ${keys.admin}`, 'content-type': 'application/json' },
			body: JSON.stringify(json)
		}),
		url,
		ip: '127.0.0.1'
	});
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBeLessThan(300);
	return body.data as T;
}
async function errCode(res: Response, status: number) {
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBe(status);
	return body.error.code as string;
}
const ctxOf = async (id: string) => (await contextForUser(id))!.ctx;

/** Export abrufen; liefert das an den PDF-Renderer übergebene HTML */
async function exportHtml(who: string, query: Record<string, string>): Promise<string> {
	html = '';
	const res = await api(
		`/modules/events/events/export.pdf?${new URLSearchParams(query)}`,
		keys[who]
	);
	if (res.status !== 200) throw new Error(`${res.status} ${await res.text()}`);
	expect(res.headers.get('content-type')).toBe('application/pdf');
	return html;
}

async function mkUser(name: string, permissions: string[]) {
	const role = await createRole(admin, { name: `r-${name}`, permissions });
	userIds[name] = await createUser(admin, {
		name: `${name[0]!.toUpperCase()}${name.slice(1)} Test`,
		email: `${name}@example.test`,
		password: 'export-password-1234',
		roleIds: [role]
	});
	const ctx = await ctxOf(userIds[name]!);
	keys[name] = (await createApiKey(ctx, { name: `k-${name}`, scopes: [...ctx.permissions] })).key;
}

const OCT = { from: '2026-10-01', to: '2026-10-31' };

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
	setPdfRendererForTests(async (h, o) => {
		html = h;
		renderOptions = o;
		return new TextEncoder().encode('%PDF-fake');
	});

	await mkUser('anna', ['core.api.manage', 'events.event.view']);
	await mkUser('ohne', ['core.api.manage']);

	const ev = (json: Record<string, unknown>) =>
		post<{ id: string }>('/modules/events/events', json);
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
	await ev({
		title: '<script>alert(1)</script>',
		startsOn: '2026-10-28',
		shares: [{ type: 'everyone', id: '*', level: 'read' }]
	});
	const series = await ev({
		title: 'Gruppenstunde',
		startsOn: '2026-10-05',
		startsTime: '17:00',
		endsOn: '2026-10-05',
		endsTime: '18:30',
		shares: [{ type: 'everyone', id: '*', level: 'read' }],
		recurrence: { freq: 'weekly', end: { type: 'count', count: 3 } }
	});
	await post(
		`/modules/events/events/${series.id}/occurrences/2026-10-12`,
		{ cancelled: true },
		'PUT'
	);
	await post(
		`/modules/events/events/${series.id}/occurrences/2026-10-19`,
		{ override: { title: 'Gruppenstunde Ausflug' } },
		'PUT'
	);
});
afterAll(async () => {
	setTodayForTests(null);
	setPdfRendererForTests(undefined);
	await close();
});

describe('Terminliste', () => {
	it('zeigt nur Sichtbares, Serien je Vorkommen (ohne Absage), ohne actions keine Aktionen', async () => {
		const res = await api(
			`/modules/events/events/export.pdf?${new URLSearchParams({ layout: 'list', ...OCT })}`,
			keys.anna
		);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-disposition')).toContain('termine-2026-10.pdf');
		expect(res.headers.get('cache-control')).toBe('private, no-store');
		const h = html;
		expect(h).toContain('Termine Oktober 2026');
		expect(h).toContain('Stammesversammlung');
		expect(h).toContain('Gruppenstunde (Serie)');
		expect(h).toContain('Gruppenstunde Ausflug (Serie)');
		expect(h).toContain('Mo 05.10.');
		expect(h).not.toContain('Mo 12.10.');
		expect(h).not.toContain('Nur für Admin');
		expect(h).not.toContain('(Aktion)');
		expect(h).toContain('Stand: 01.10.2026');
		expect(h).not.toContain('<script>alert(1)</script>');
		expect(h).toContain('&lt;script&gt;');
	});

	it('Filter nach Gruppe (Stamm) und Tag; includeActions ohne actions wirkungslos', async () => {
		const without = await exportHtml('admin', { layout: 'list', ...OCT, includeActions: 'false' });
		expect(without).toContain('Nur für Admin');
		expect(without).not.toContain('(Aktion)');
		const byGroup = await exportHtml('admin', { layout: 'list', ...OCT, groupId: 'stamm' });
		expect(byGroup).toContain('Stammesversammlung');
		expect(byGroup).not.toContain('Gruppenstunde');
		expect(byGroup).toContain('Gruppe: ');
		const byTag = await exportHtml('admin', { layout: 'list', ...OCT, tag: 'Versammlung' });
		expect(byTag).toContain('Stammesversammlung');
		expect(byTag).not.toContain('Gruppenstunde');
		expect(byTag).toContain('Tag: Versammlung');
	});

	it('mit Beschreibungen und leerem Zeitraum', async () => {
		const h = await exportHtml('admin', { layout: 'list', ...OCT, withDescription: 'true' });
		expect(h).toContain('Beschreibung');
		expect(
			await exportHtml('admin', { layout: 'list', from: '2030-01-01', to: '2030-01-31' })
		).toContain('keine Termine');
	});
});

describe('Monatskalender und Jahresplan', () => {
	it('Monatskalender ohne Briefkopf quer, je Monat eine Tabelle Mo–So', async () => {
		const h = await exportHtml('anna', {
			layout: 'calendar',
			from: '2026-10-01',
			to: '2026-11-30'
		});
		expect(renderOptions.landscape).toBe(true);
		expect(h).toContain('Oktober 2026');
		expect(h).toContain('November 2026');
		expect(h).toContain('Stammesversammlung');
		expect(h).toContain('Gruppenstunde Ausflug');
		expect(h).not.toContain('Aktion');
		expect(h).not.toContain('Nur für Admin');
	});

	it('Jahresplan: 12 Monate, gekürzte Titel, Briefkopf hochkant je Halbjahr', async () => {
		const year = { layout: 'year', from: '2026-01-01', to: '2026-12-31' };
		const h = await exportHtml('admin', year);
		expect(renderOptions.landscape).toBe(true);
		for (const m of ['Januar', 'Juni', 'Juli', 'Dezember']) expect(h).toContain(m);
		expect(h).toMatch(/Stammesversam+…/);
		expect(h).toContain('Jahresplan 2026');

		await exportHtml('admin', { ...year, letterhead: 'true' });
		expect(renderOptions.landscape).toBe(false);
	});
});

describe('Prüfung, Recht, Audit', () => {
	it('Zeitraum, Ausführung und unbekannte Parameter → 422', async () => {
		const q = (p: Record<string, string>) =>
			api(`/modules/events/events/export.pdf?${new URLSearchParams(p)}`, keys.admin);
		expect(
			await errCode(await q({ layout: 'list', from: '2026-10-31', to: '2026-10-01' }), 422)
		).toBe('validation_failed');
		expect(
			await errCode(await q({ layout: 'list', from: '2026-01-01', to: '2027-03-01' }), 422)
		).toBe('validation_failed');
		expect(await errCode(await q({ layout: 'poster', ...OCT }), 422)).toBe('validation_failed');
		expect(await errCode(await q({ layout: 'list', ...OCT, x: '1' }), 422)).toBe(
			'validation_failed'
		);
		// Schuljahr (August bis Juli) ist erlaubt
		expect((await q({ layout: 'year', from: '2026-08-01', to: '2027-07-31' })).status).toBe(200);
	});

	it('ohne events.event.view → 403', async () => {
		await errCode(
			await api(
				`/modules/events/events/export.pdf?layout=list&from=2026-10-01&to=2026-10-31`,
				keys.ohne
			),
			403
		);
		await errCode(await api('/modules/events/events/export/options', keys.ohne), 403);
	});

	it('Auswahl meldet: Aktionen nicht verfügbar (actions nicht installiert)', async () => {
		const res = await api('/modules/events/events/export/options', keys.anna);
		const body = (await res.json()) as { data: ExportOptions };
		expect(body.data).toEqual({ actionsAvailable: false, maxDays: 400 });
	});

	it('Audit nur mit Zählern, ohne Titel', async () => {
		await exportHtml('anna', { layout: 'list', ...OCT });
		const audit = await listAudit({ action: 'events.events.exported' });
		expect(audit.rows.length).toBeGreaterThan(0);
		const text = JSON.stringify(audit.rows);
		expect(text).not.toContain('Stammesversammlung');
		expect(text).not.toContain('Gruppenstunde');
		expect(audit.rows[0]!.metadata).toMatchObject({ layout: expect.any(String) });
	});
});
