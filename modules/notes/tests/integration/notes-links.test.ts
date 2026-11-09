/**
 * Modul `notes`: öffentliche Links – Anlegen/Auflisten/Widerrufen (Rechte), Info mit Seitenbaum (Unterseiten, Papierkorb),
 * Ansehen vs. Bearbeiten (Gast-Updates als JSON), Seiten außerhalb des Links, Bilder über den Link, Passwort mit
 * Fehlversuchssperre, Live als Gast (Name, Anwesenheit nur mit eigenem Geheimnis), Widerruf schließt Verbindungen,
 * deaktivierte Eigentümer*in, Audit ohne Passwort/Inhalt.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import * as Y from 'yjs';
import { yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap';
import { useTestDatabase } from '$testing';
import { installFakeStorage } from '$testing';
import { getDb, schema } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin, createUser, setUserActive } from '$testing';
import { createRole } from '$testing';
import { registerModule } from '$testing';
import { enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { resetAllForTests } from '$testing';
import { listAudit } from '$testing';
import notesModule from '$modules/notes/module';
import { hub } from '$modules/notes/live';
import { resetDocsForTests } from '$modules/notes/doc.service';
import { clearGuestCache } from '$modules/notes/links.endpoints';
import { ownerCacheClearForTests } from '$modules/notes/links.service';
import {
	YDOC_FIELD,
	type LiveEvent,
	type NoteAsset,
	type NoteDetail,
	type NoteLink,
	type PublicLinkInfo
} from '$modules/notes/schemas';
import type { RequestContext } from '$lib/sdk/types';

const ROOT = 'http://localhost:5173/api/v1/modules/notes';
const keys: Record<string, string> = {};
const userIds: Record<string, string> = {};
let admin: RequestContext;
let close: () => Promise<void>;

interface Res<T = unknown> {
	status: number;
	body: { data?: T; error?: { code: string; details?: unknown } };
}

async function raw(
	who: string | null,
	method: string,
	path: string,
	init: { body?: BodyInit; type?: string; signal?: AbortSignal } = {}
): Promise<Response> {
	resetAllForTests();
	const headers = new Headers();
	if (who) headers.set('authorization', `Bearer ${keys[who]}`);
	if (init.type) headers.set('content-type', init.type);
	const url = new URL(`${ROOT}${path}`);
	return handleApiRequest({
		request: new Request(url, { method, headers, body: init.body, signal: init.signal }),
		url,
		ip: '127.0.0.9'
	});
}

async function call<T = unknown>(
	who: string | null,
	method: string,
	path: string,
	json?: unknown
): Promise<Res<T>> {
	const res = await raw(who, method, path, {
		body: json === undefined ? undefined : JSON.stringify(json),
		type: json === undefined ? undefined : 'application/json'
	});
	return { status: res.status, body: await res.json() };
}

function ok<T>(res: Res<T>, status = 200): T {
	expect(res.status, JSON.stringify(res.body)).toBe(status);
	return res.body.data as T;
}

function fail(res: Res, status: number, code: string) {
	expect(res.status, JSON.stringify(res.body)).toBe(status);
	expect(res.body.error?.code).toBe(code);
}

const ctxOf = async (id: string) => (await contextForUser(id))!.ctx;

async function addUser(who: string, roleId: string) {
	const id = await createUser(admin, {
		name: `Person ${who}`,
		email: `${who}@example.test`,
		password: 'a-long-enough-pw',
		roleIds: [roleId]
	});
	userIds[who] = id;
	const ctx = await ctxOf(id);
	keys[who] = (await createApiKey(ctx, { name: who, scopes: [...ctx.permissions] })).key;
}

const tokenOf = (link: NoteLink) => link.url!.split('/').pop()!;

async function createLink(
	noteId: string,
	input: { level?: 'read' | 'edit'; expiresOn?: string | null; password?: string | null } = {}
) {
	return ok<NoteLink>(await call('owner', 'POST', `/notes/${noteId}/links`, input), 201);
}

/** Gast-Zustand einer Seite als Y.Doc */
async function guestDoc(token: string, noteId: string, t?: string) {
	const res = await raw(
		null,
		'GET',
		`/public/links/${token}/notes/${noteId}/state${t ? `?t=${encodeURIComponent(t)}` : ''}`
	);
	return res;
}

function paragraphUpdate(base: Uint8Array, text: string): Uint8Array {
	const doc = new Y.Doc();
	Y.applyUpdate(doc, base);
	const before = Y.encodeStateVector(doc);
	const p = new Y.XmlElement('paragraph');
	const t = new Y.XmlText();
	t.insert(0, text);
	p.insert(0, [t]);
	doc.getXmlFragment(YDOC_FIELD).push([p]);
	return Y.encodeStateAsUpdate(doc, before);
}

async function contentOf(noteId: string): Promise<string> {
	const res = await raw('owner', 'GET', `/notes/${noteId}/state`);
	const doc = new Y.Doc();
	Y.applyUpdate(doc, new Uint8Array(await res.arrayBuffer()));
	return JSON.stringify(yXmlFragmentToProsemirrorJSON(doc.getXmlFragment(YDOC_FIELD)));
}

/** SSE lesen (wie in `notes.test.ts`) */
async function openLive(who: string | null, path: string) {
	const ac = new AbortController();
	const res = await raw(who, 'GET', path, { signal: ac.signal });
	const events: LiveEvent[] = [];
	if (res.status === 200 && res.body) {
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buf = '';
		void (async () => {
			try {
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					buf += decoder.decode(value, { stream: true });
					let i: number;
					while ((i = buf.indexOf('\n\n')) >= 0) {
						const chunk = buf.slice(0, i);
						buf = buf.slice(i + 2);
						for (const line of chunk.split('\n')) {
							if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)) as LiveEvent);
						}
					}
				}
			} catch {
				// abgebrochen
			}
		})();
	}
	const waitFor = <T extends LiveEvent['type']>(
		type: T,
		pred: (e: Extract<LiveEvent, { type: T }>) => boolean = () => true
	) =>
		vi.waitFor(
			() => {
				const hit = events.find(
					(e): e is Extract<LiveEvent, { type: T }> =>
						e.type === type && pred(e as Extract<LiveEvent, { type: T }>)
				);
				expect(
					hit,
					`Ereignis ${type} – bisher: ${events.map((e) => e.type).join(',')}`
				).toBeTruthy();
				return hit!;
			},
			{ timeout: 3000 }
		);
	return { status: res.status, events, waitFor, close: () => ac.abort() };
}

let rootId: string;
let childId: string;
let grandId: string;
let otherId: string;

beforeAll(async () => {
	({ close } = await useTestDatabase());
	registerCoreApi();
	registerModule(notesModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', 'correct-horse-battery');
	const [u] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	admin = await ctxOf(u!.id);
	await enableModule(admin, 'notes');
	admin = await ctxOf(u!.id);
	await installFakeStorage(admin);

	const base = ['core.api.manage', 'notes.note.view', 'notes.note.create'];
	const linker = await createRole(admin, {
		name: 'Teilen nach außen',
		permissions: [...base, 'notes.link.create']
	});
	const plain = await createRole(admin, { name: 'Ohne Links', permissions: base });
	await addUser('owner', linker);
	await addUser('nolinks', plain);
	await addUser('helper', linker);

	rootId = ok<NoteDetail>(
		await call('owner', 'POST', '/notes', { title: 'Lagerplanung', markdown: '# Plan\n\nZelte' }),
		201
	).id;
	childId = ok<NoteDetail>(
		await call('owner', 'POST', '/notes', { title: 'Essen', parentId: rootId }),
		201
	).id;
	grandId = ok<NoteDetail>(
		await call('owner', 'POST', '/notes', { title: 'Einkauf', parentId: childId }),
		201
	).id;
	otherId = ok<NoteDetail>(
		await call('owner', 'POST', '/notes', { title: 'Privat', markdown: 'Geheim' }),
		201
	).id;
	// Helfer*in darf die Wurzel bearbeiten (Freigabe), ist aber nicht Eigentümer*in
	ok(
		await call('owner', 'PUT', `/notes/${rootId}/shares`, {
			shares: [{ type: 'user', id: userIds.helper!, level: 'edit' }]
		})
	);
});

afterEach(() => {
	hub.closeAll();
	clearGuestCache();
	ownerCacheClearForTests();
});

afterAll(async () => {
	hub.closeAll();
	await resetDocsForTests();
	await close?.();
});

describe('Verwaltung', () => {
	it('nur Eigentümer*in mit Recht legt Links an; Liste zeigt die Adresse; Ablauf in der Vergangenheit 422', async () => {
		const link = await createLink(rootId, { level: 'read' });
		expect(link.url).toMatch(/\/p\/notes\/link\/[A-Za-z0-9_-]{40,}$/);
		expect(link.active).toBe(true);
		expect(link.hasPassword).toBe(false);

		const list = ok<NoteLink[]>(await call('owner', 'GET', `/notes/${rootId}/links`));
		expect(list.map((l) => l.url)).toContain(link.url);

		// Bearbeiten-Freigabe reicht nicht (sonst ließe sich weiterverteilen)
		fail(
			await call('helper', 'POST', `/notes/${rootId}/links`, { level: 'read' }),
			403,
			'forbidden'
		);
		fail(await call('helper', 'GET', `/notes/${rootId}/links`), 403, 'forbidden');
		// ohne Recht `notes.link.create` auch nicht auf eigenen Notizen
		const own = ok<NoteDetail>(await call('nolinks', 'POST', '/notes', { title: 'Meins' }), 201);
		fail(await call('nolinks', 'POST', `/notes/${own.id}/links`, {}), 403, 'forbidden');
		// fremde Notiz → 404
		fail(await call('nolinks', 'GET', `/notes/${rootId}/links`), 404, 'not_found');

		fail(
			await call('owner', 'POST', `/notes/${rootId}/links`, { expiresOn: '2000-01-01' }),
			422,
			'validation_failed'
		);
		fail(
			await call('owner', 'POST', `/notes/${rootId}/links`, { password: 'kurz' }),
			422,
			'validation_failed'
		);
	});
});

describe('Ansehen', () => {
	it('Info mit Seitenbaum, Zustand der Unterseiten, keine Änderungen, nichts außerhalb', async () => {
		const token = tokenOf(await createLink(rootId, { level: 'read' }));
		const info = ok<PublicLinkInfo>(await call(null, 'GET', `/public/links/${token}`));
		expect(info).toMatchObject({ title: 'Lagerplanung', level: 'read', needsPassword: false });
		expect(info.pages.map((p) => p.title)).toEqual(['Lagerplanung', 'Essen', 'Einkauf']);
		expect(info.pages[0]!.parentId).toBeNull();
		expect(info.pages[2]!.parentId).toBe(childId);

		const res = await guestDoc(token, grandId);
		expect(res.status).toBe(200);
		expect(res.headers.get('x-note-level')).toBe('read');
		const root = await guestDoc(token, rootId);
		const base = new Uint8Array(await root.arrayBuffer());
		const doc = new Y.Doc();
		Y.applyUpdate(doc, base);
		expect(JSON.stringify(yXmlFragmentToProsemirrorJSON(doc.getXmlFragment(YDOC_FIELD)))).toContain(
			'Zelte'
		);

		fail(
			await call(null, 'POST', `/public/links/${token}/notes/${rootId}/updates`, {
				client: 'guest-client-1',
				update: Buffer.from(paragraphUpdate(base, 'Nein')).toString('base64')
			}),
			403,
			'forbidden'
		);
		// Seite außerhalb des Links und unbekannter Link
		expect((await guestDoc(token, otherId)).status).toBe(404);
		fail(await call(null, 'GET', `/public/links/${'x'.repeat(43)}`), 404, 'not_found');

		// Link auf eine Unterseite sieht die Oberseite nicht
		const sub = tokenOf(await createLink(childId, { level: 'read' }));
		const subInfo = ok<PublicLinkInfo>(await call(null, 'GET', `/public/links/${sub}`));
		expect(subInfo.pages.map((p) => p.title)).toEqual(['Essen', 'Einkauf']);
		expect(subInfo.pages[0]!.parentId).toBeNull();
		expect((await guestDoc(sub, rootId)).status).toBe(404);
	});

	it('Bilder nur von Seiten im Link', async () => {
		const token = tokenOf(await createLink(childId, { level: 'read' }));
		const img = new Uint8Array(
			await sharp({ create: { width: 40, height: 30, channels: 3, background: '#2266aa' } })
				.png()
				.toBuffer()
		);
		const upload = async (noteId: string) => {
			const form = new FormData();
			form.set('file', new File([img as BlobPart], 'bild.png', { type: 'image/png' }));
			const res = await raw('owner', 'POST', `/notes/${noteId}/assets`, { body: form });
			expect(res.status).toBe(201);
			return ((await res.json()) as { data: NoteAsset }).data;
		};
		const inside = await upload(grandId);
		const outside = await upload(rootId);
		const got = await raw(null, 'GET', `/public/links/${token}/assets/${inside.id}/web`);
		expect(got.status).toBe(200);
		expect(got.headers.get('content-type')).toContain('image/');
		expect((await raw(null, 'GET', `/public/links/${token}/assets/${outside.id}/web`)).status).toBe(
			404
		);
	});
});

describe('Bearbeiten als Gast', () => {
	it('Updates als JSON landen im Dokument; Live mit Name; Anwesenheit nur mit eigenem Geheimnis', async () => {
		const token = tokenOf(await createLink(rootId, { level: 'edit' }));
		const base = new Uint8Array(await (await guestDoc(token, childId)).arrayBuffer());

		const owner = await openLive('owner', `/notes/${childId}/live?client=owner-live-1`);
		await owner.waitFor('hello');
		const guest = await openLive(
			null,
			`/public/links/${token}/notes/${childId}/live?client=guest-live-1&key=geheimnis-des-tabs-1&name=Mia`
		);
		expect(guest.status).toBe(200);
		const hello = await guest.waitFor('hello');
		expect(hello.level).toBe('edit');
		const join = await owner.waitFor('join', (e) => e.peer.client === 'guest-live-1');
		expect(join.peer.name).toBe('Mia (Gast)');
		expect(join.peer.userId).toMatch(/^guest:/);

		const res = await call<{ ok: boolean }>(
			null,
			'POST',
			`/public/links/${token}/notes/${childId}/updates`,
			{
				client: 'guest-live-1',
				update: Buffer.from(paragraphUpdate(base, 'Nudeln kaufen')).toString('base64')
			}
		);
		ok(res, 201);
		await owner.waitFor('update', (e) => e.client === 'guest-live-1');
		expect(await contentOf(childId)).toContain('Nudeln kaufen');

		// Anwesenheit: fremdes Geheimnis → nicht verteilt
		const update = Buffer.from([0]).toString('base64');
		expect(
			ok<{ ok: boolean }>(
				await call(null, 'POST', `/public/links/${token}/notes/${childId}/awareness`, {
					client: 'guest-live-1',
					key: 'falsches-geheimnis-xyz',
					update
				}),
				201
			).ok
		).toBe(false);
		expect(
			ok<{ ok: boolean }>(
				await call(null, 'POST', `/public/links/${token}/notes/${childId}/awareness`, {
					client: 'guest-live-1',
					key: 'geheimnis-des-tabs-1',
					update
				}),
				201
			).ok
		).toBe(true);
		// Kennung eines anderen Gasts übernehmen → 409
		const hijack = await openLive(
			null,
			`/public/links/${token}/notes/${childId}/live?client=guest-live-1&key=anderes-geheimnis-2`
		);
		expect(hijack.status).toBe(409);
		// Router: öffentlich nur JSON
		const binary = await raw(null, 'POST', `/public/links/${token}/notes/${childId}/updates`, {
			body: new Uint8Array([1, 2]) as BodyInit,
			type: 'application/octet-stream'
		});
		expect(binary.status).toBe(400);
		owner.close();
		guest.close();
	});

	it('Widerruf schließt Gast-Verbindungen sofort; danach 404', async () => {
		const link = await createLink(rootId, { level: 'edit' });
		const token = tokenOf(link);
		const guest = await openLive(
			null,
			`/public/links/${token}/notes/${grandId}/live?client=guest-live-2&key=geheimnis-des-tabs-2`
		);
		await guest.waitFor('hello');
		ok(await call('owner', 'DELETE', `/links/${link.id}`));
		await guest.waitFor('revoked');
		fail(await call(null, 'GET', `/public/links/${token}`), 404, 'not_found');
		expect((await guestDoc(token, grandId)).status).toBe(404);
	});
});

describe('Passwort', () => {
	it('verbirgt Titel und Seiten bis zum Freischalten; Fehlversuche werden gesperrt', async () => {
		const token = tokenOf(await createLink(childId, { level: 'read', password: 'sehr-geheim-1' }));
		const locked = ok<PublicLinkInfo>(await call(null, 'GET', `/public/links/${token}`));
		expect(locked).toMatchObject({ needsPassword: true, title: '', pages: [] });
		fail(
			await call(null, 'GET', `/public/links/${token}/notes/${childId}/state`),
			403,
			'forbidden'
		);
		fail(
			await call(null, 'POST', `/public/links/${token}/unlock`, { password: 'falsch-falsch' }),
			403,
			'forbidden'
		);
		const { accessToken } = ok<{ accessToken: string }>(
			await call(null, 'POST', `/public/links/${token}/unlock`, { password: 'sehr-geheim-1' }),
			201
		);
		const open = ok<PublicLinkInfo>(
			await call(null, 'GET', `/public/links/${token}?t=${encodeURIComponent(accessToken)}`)
		);
		expect(open.title).toBe('Essen');
		expect((await guestDoc(token, grandId, accessToken)).status).toBe(200);

		for (let i = 0; i < 10; i++) {
			await call(null, 'POST', `/public/links/${token}/unlock`, { password: 'falsch-falsch' });
		}
		fail(
			await call(null, 'POST', `/public/links/${token}/unlock`, { password: 'sehr-geheim-1' }),
			429,
			'rate_limited'
		);
	});
});

describe('Gültigkeit und Audit', () => {
	it('Papierkorb und deaktivierte Eigentümer*in sperren den Link; Audit ohne Passwort', async () => {
		const token = tokenOf(
			await createLink(rootId, { level: 'read', password: 'audit-passwort-1' })
		);
		const trash = ok<NoteDetail>(
			await call('owner', 'POST', '/notes', { title: 'Weg damit', parentId: rootId }),
			201
		);
		const t = ok<{ accessToken: string }>(
			await call(null, 'POST', `/public/links/${token}/unlock`, { password: 'audit-passwort-1' }),
			201
		).accessToken;
		expect((await guestDoc(token, trash.id, t)).status).toBe(200);
		ok(await call('owner', 'DELETE', `/notes/${trash.id}`));
		expect((await guestDoc(token, trash.id, t)).status).toBe(404);
		const info = ok<PublicLinkInfo>(
			await call(null, 'GET', `/public/links/${token}?t=${encodeURIComponent(t)}`)
		);
		expect(info.pages.map((p) => p.title)).not.toContain('Weg damit');

		await setUserActive(admin, userIds.owner!, false);
		ownerCacheClearForTests();
		fail(await call(null, 'GET', `/public/links/${token}`), 404, 'not_found');
		await setUserActive(admin, userIds.owner!, true);
		ownerCacheClearForTests();

		const { rows: created } = await listAudit({ action: 'notes.link.created', limit: 50 });
		expect(created.length).toBeGreaterThan(0);
		const text = JSON.stringify(created);
		expect(text).not.toContain('audit-passwort-1');
		expect(text).not.toContain('Lagerplanung');
		const { rows: accessed } = await listAudit({ action: 'notes.link.accessed', limit: 50 });
		expect(accessed.length).toBeGreaterThan(0);
	});
});
