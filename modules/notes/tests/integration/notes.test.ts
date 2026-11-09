/**
 * Modul `notes`: Anlegen (Markdown), Seitenbaum mit Tiefe, Zugriffsmatrix (Eigentümer*in, Freigabe read/edit vererbt,
 * Rolle, view-all, edit-all, fremd → 404), Verschieben, Papierkorb, Freigaben inkl. geerbter,
 * Yjs-Konvergenz zweier Clients über `/updates` + `/state`, SSE (`hello`, `update`, `revoked`), Verdichtung,
 * Versionen, Bilder, Suche, Audit ohne Inhalte, Konto löschen, Modul aus.
 *
 * Läuft ohne die optionalen Module `members` und `actions` (liegen in ep-intern-modules) und prüft, dass
 * Gruppen-/Mitglieds-Freigaben und Aktionen dann sauber abgelehnt werden. Gruppenfreigaben und Notizen an
 * Aktionen testet ep-intern-modules in `modules/_integration/tests/integration/notes-groups-actions.test.ts`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
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
import { disableModule, enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { resetAllForTests } from '$testing';
import { listAudit } from '$testing';
import { core } from '$testing';
import notesModule from '$modules/notes/module';
import { hub } from '$modules/notes/live';
import { flushAllForTests, resetDocsForTests } from '$modules/notes/doc.service';
import { onUserDeleted } from '$modules/notes/privacy';
import { purgeExpiredTrash } from '$modules/notes/trash.service';
import { purgeUnusedAssets } from '$modules/notes/assets.service';
import { runAutoVersions } from '$modules/notes/versions.service';
import { notesSearch } from '$modules/notes/search';
import { noteRefsService } from '$modules/notes/refs.service';
import {
	DEFAULT_USER_PREFS,
	MAX_DEPTH,
	YDOC_FIELD,
	type LiveEvent,
	type NoteAsset,
	type NoteDetail,
	type NoteNode,
	type NoteRoots,
	type NoteSearchHit,
	type NoteShares,
	type NoteVersion,
	type NoteVersionDetail,
	type TrashItem,
	type UpdateResult,
	type UserPrefs
} from '$modules/notes/schemas';
import type { RequestContext } from '$lib/sdk/types';

const ROOT = 'http://localhost:5173/api/v1/modules';
const keys: Record<string, string> = {};
const userIds: Record<string, string> = {};
let admin: RequestContext;
let close: () => Promise<void>;

interface Res<T = unknown> {
	status: number;
	body: { data?: T; error?: { code: string; details?: unknown } };
}

async function raw(
	who: string,
	method: string,
	path: string,
	init: { body?: BodyInit; type?: string; signal?: AbortSignal; moduleId?: string } = {}
): Promise<Response> {
	resetAllForTests();
	const headers = new Headers({ authorization: `Bearer ${keys[who]}` });
	if (init.type) headers.set('content-type', init.type);
	const url = new URL(`${ROOT}/${init.moduleId ?? 'notes'}${path}`);
	return handleApiRequest({
		request: new Request(url, { method, headers, body: init.body, signal: init.signal }),
		url,
		ip: '127.0.0.1'
	});
}

async function call<T = unknown>(
	who: string,
	method: string,
	path: string,
	json?: unknown,
	moduleId = 'notes'
): Promise<Res<T>> {
	const res = await raw(who, method, path, {
		body: json === undefined ? undefined : JSON.stringify(json),
		type: json === undefined ? undefined : 'application/json',
		moduleId
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

/** Live-Verbindung öffnen und Ereignisse mitschreiben */
async function openLive(who: string, noteId: string, client: string) {
	const ac = new AbortController();
	const res = await raw(who, 'GET', `/notes/${noteId}/live?client=${client}&awarenessId=7`, {
		signal: ac.signal
	});
	const events: LiveEvent[] = [];
	let ended = false;
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
			ended = true;
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
	return { status: res.status, events, waitFor, isEnded: () => ended, close: () => ac.abort() };
}

/** Yjs-Client: lädt den Zustand, sammelt eigene Änderungen */
async function yClient(who: string, noteId: string) {
	const doc = new Y.Doc();
	const res = await raw(who, 'GET', `/notes/${noteId}/state`);
	expect(res.status).toBe(200);
	expect(res.headers.get('content-type')).toBe('application/octet-stream');
	Y.applyUpdate(doc, new Uint8Array(await res.arrayBuffer()), 'remote');
	const pending: Uint8Array[] = [];
	doc.on('update', (u: Uint8Array, origin: unknown) => {
		if (origin !== 'remote') pending.push(u);
	});
	return {
		doc,
		level: res.headers.get('x-note-level'),
		addParagraph(text: string) {
			const p = new Y.XmlElement('paragraph');
			const t = new Y.XmlText();
			t.insert(0, text);
			p.insert(0, [t]);
			doc.getXmlFragment(YDOC_FIELD).push([p]);
		},
		take(): Uint8Array {
			const merged = Y.mergeUpdates(pending.splice(0));
			return merged;
		}
	};
}

function postUpdate(who: string, noteId: string, client: string, bytes: Uint8Array) {
	return raw(who, 'POST', `/notes/${noteId}/updates?client=${client}`, {
		body: bytes as BodyInit,
		type: 'application/octet-stream'
	});
}

/** Inhalt einer Notiz als JSON-Text (frisch über `/state`) */
async function contentOf(who: string, noteId: string): Promise<string> {
	const res = await raw(who, 'GET', `/notes/${noteId}/state`);
	const doc = new Y.Doc();
	Y.applyUpdate(doc, new Uint8Array(await res.arrayBuffer()));
	return JSON.stringify(yXmlFragmentToProsemirrorJSON(doc.getXmlFragment(YDOC_FIELD)));
}

async function png(width = 300, height = 200): Promise<Uint8Array> {
	return new Uint8Array(
		await sharp({ create: { width, height, channels: 3, background: '#2266aa' } })
			.png()
			.toBuffer()
	);
}

const notesSql = <T>(query: ReturnType<typeof sql>) =>
	core.database
		.forModule('notes')
		.transaction(async (tx) => (await tx.execute(query)) as unknown as { rows: T[] })
		.then((r) => r.rows);

let parentRole: string;
let rootId: string;
let childId: string;
let grandId: string;

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
	keys.admin = (
		await createApiKey(admin, {
			name: 'admin',
			scopes: [...notesModule.manifest.permissions]
		})
	).key;

	const base = ['core.api.manage', 'notes.note.view'];
	const planner = await createRole(admin, {
		name: 'Planung',
		permissions: [...base, 'notes.note.create']
	});
	const viewer = await createRole(admin, { name: 'Mitlesen', permissions: base });
	// eigene Rolle für `parent`: Freigabe an eine Rolle statt (wie in ep-intern-modules) an eine Gruppe
	parentRole = await createRole(admin, { name: 'Eltern', permissions: base });
	const viewAll = await createRole(admin, {
		name: 'Alles lesen',
		permissions: [...base, 'notes.note.view-all']
	});
	const editAll = await createRole(admin, {
		name: 'Alles bearbeiten',
		permissions: [...base, 'notes.note.edit-all']
	});
	const without = await createRole(admin, {
		name: 'Ohne Notizen',
		permissions: ['core.api.manage']
	});
	await addUser('owner', planner);
	await addUser('other', planner);
	await addUser('helper', viewer);
	await addUser('parent', parentRole);
	await addUser('stranger', viewer);
	await addUser('viewall', viewAll);
	await addUser('editall', editAll);
	await addUser('outsider', without);
});

afterEach(() => {
	hub.closeAll();
});

afterAll(async () => {
	hub.closeAll();
	await resetDocsForTests();
	await close?.();
});

describe('Anlegen und Seitenbaum', () => {
	it('legt eine Notiz mit Markdown an', async () => {
		const note = ok<NoteDetail>(
			await call('owner', 'POST', '/notes', {
				title: 'Sommerlager',
				icon: 'tent',
				color: '#16A34A',
				markdown: '# Packliste\n\n- Schlafsack\n- **Isomatte**'
			}),
			201
		);
		rootId = note.id;
		expect(note).toMatchObject({
			title: 'Sommerlager',
			icon: 'tent',
			color: '#16a34a',
			parentId: null,
			level: 'edit',
			isOwner: true,
			canShare: true,
			canCreateChild: true,
			breadcrumbs: [],
			ownerId: userIds.owner
		});
		expect(note.owner?.name).toBe('Person owner');
		expect(note.sizeBytes).toBeGreaterThan(0);
		const text = await contentOf('owner', rootId);
		expect(text).toContain('Packliste');
		expect(text).toContain('Isomatte');
	});

	it('prüft Icon und Recht zum Anlegen', async () => {
		fail(
			await call('owner', 'POST', '/notes', { title: 'X', icon: 'gibt-es-nicht-xyz' }),
			422,
			'validation_failed'
		);
		fail(await call('helper', 'POST', '/notes', { title: 'X' }), 403, 'forbidden');
		expect((await call('outsider', 'GET', '/notes/roots')).status).toBe(403);
	});

	it('legt Unterseiten an (Eigentum der Wurzel) und begrenzt die Tiefe', async () => {
		childId = ok<NoteDetail>(
			await call('owner', 'POST', '/notes', { title: 'Programm', parentId: rootId }),
			201
		).id;
		grandId = ok<NoteDetail>(
			await call('owner', 'POST', '/notes', { title: 'Tag 1', parentId: childId }),
			201
		).id;
		const grand = ok<NoteDetail>(await call('owner', 'GET', `/notes/${grandId}`));
		expect(grand.breadcrumbs.map((b) => b.title)).toEqual(['Sommerlager', 'Programm']);
		const kids = ok<NoteNode[]>(await call('owner', 'GET', `/notes/${rootId}/children`));
		expect(kids.map((k) => k.title)).toEqual(['Programm']);
		expect(kids[0]!.hasChildren).toBe(true);

		let parent = ok<NoteDetail>(await call('owner', 'POST', '/notes', { title: 'Tief 1' }), 201).id;
		for (let d = 2; d <= MAX_DEPTH; d++) {
			parent = ok<NoteDetail>(
				await call('owner', 'POST', '/notes', { title: `Tief ${d}`, parentId: parent }),
				201
			).id;
		}
		fail(
			await call('owner', 'POST', '/notes', { title: 'Zu tief', parentId: parent }),
			422,
			'validation_failed'
		);
	});
});

describe('Zugriff', () => {
	it('Fremde sehen nichts', async () => {
		fail(await call('stranger', 'GET', `/notes/${rootId}`), 404, 'not_found');
		fail(await call('stranger', 'GET', `/notes/${childId}`), 404, 'not_found');
		const roots = ok<NoteRoots>(await call('stranger', 'GET', '/notes/roots'));
		expect(roots).toEqual({ own: [], shared: [], actions: [], canCreate: false });
		fail(await call('stranger', 'PATCH', `/notes/${rootId}`, { title: 'Weg' }), 404, 'not_found');
	});

	it('Freigabe auf der Wurzel vererbt sich; Lesen ohne Änderungen', async () => {
		const shares = ok<NoteShares>(
			await call('owner', 'PUT', `/notes/${rootId}/shares`, {
				shares: [
					{ type: 'user', id: userIds.helper, level: 'read' },
					{ type: 'role', id: parentRole, level: 'read' }
				]
			})
		);
		expect(shares.shares).toHaveLength(2);
		expect(shares.canManage).toBe(true);
		const child = ok<NoteDetail>(await call('helper', 'GET', `/notes/${childId}`));
		expect(child).toMatchObject({ level: 'read', isOwner: false, canShare: false });
		expect(child.canCreateChild).toBe(false);
		fail(await call('helper', 'PATCH', `/notes/${childId}`, { title: 'Weg' }), 403, 'forbidden');
		const seen = ok<NoteDetail>(await call('parent', 'GET', `/notes/${grandId}`));
		expect(seen.level).toBe('read');
		const state = await raw('helper', 'GET', `/notes/${childId}/state`);
		expect(state.headers.get('x-note-level')).toBe('read');
		fail(
			await call('owner', 'PUT', `/notes/${rootId}/shares`, {
				shares: [{ type: 'user', id: userIds.owner, level: 'edit' }]
			}),
			422,
			'validation_failed'
		);
	});

	it('Wurzeln: geteilte Seite erscheint nur oben, nicht ihre Unterseiten', async () => {
		ok(
			await call('owner', 'PUT', `/notes/${childId}/shares`, {
				shares: [{ type: 'user', id: userIds.helper, level: 'edit' }]
			})
		);
		const roots = ok<NoteRoots>(await call('helper', 'GET', '/notes/roots'));
		expect(roots.shared.map((n) => n.id)).toEqual([rootId]);
		expect(roots.own).toEqual([]);
		const own = ok<NoteRoots>(await call('owner', 'GET', '/notes/roots'));
		expect(own.own.map((n) => n.title)).toEqual(['Sommerlager', 'Tief 1']);
		expect(own.own[0]!.shared).toBe(true);
		expect(own.canCreate).toBe(true);
	});

	it('Bearbeiten-Freigabe auf Unterseite: bearbeiten ja, teilen/löschen nein; geerbte Freigaben sichtbar', async () => {
		const child = ok<NoteDetail>(
			await call('helper', 'PATCH', `/notes/${childId}`, { title: 'Programm (Entwurf)' })
		);
		expect(child.level).toBe('edit');
		const grand = ok<NoteDetail>(await call('helper', 'GET', `/notes/${grandId}`));
		expect(grand.level).toBe('edit');
		fail(await call('helper', 'DELETE', `/notes/${childId}`), 403, 'forbidden');
		fail(await call('helper', 'PUT', `/notes/${childId}/shares`, { shares: [] }), 403, 'forbidden');
		const shares = ok<NoteShares>(await call('helper', 'GET', `/notes/${grandId}/shares`));
		expect(shares.shares).toEqual([]);
		expect(shares.canManage).toBe(false);
		expect(shares.inherited.map((s) => [s.type, s.fromTitle, s.level]).sort()).toEqual(
			[
				['role', 'Sommerlager', 'read'],
				['user', 'Programm (Entwurf)', 'edit'],
				['user', 'Sommerlager', 'read']
			].sort()
		);
		expect(shares.owner?.id).toBe(userIds.owner);
	});

	it('view-all liest, edit-all bearbeitet und teilt', async () => {
		const v = ok<NoteDetail>(await call('viewall', 'GET', `/notes/${rootId}`));
		expect(v).toMatchObject({ level: 'read', canShare: false });
		const e = ok<NoteDetail>(await call('editall', 'GET', `/notes/${rootId}`));
		expect(e).toMatchObject({ level: 'edit', canShare: true, isOwner: false });
	});

	it('Freigabe-Ziele nur für Teilende', async () => {
		fail(await call('stranger', 'GET', '/principals?search=Eltern'), 403, 'forbidden');
		const found = ok<{ type: string; id: string }[]>(
			await call('owner', 'GET', '/principals?search=Eltern')
		);
		expect(found.some((p) => p.type === 'role' && p.id === parentRole)).toBe(true);
		const people = ok<{ type: string; id: string }[]>(
			await call('owner', 'GET', '/principals?search=Person')
		);
		expect(people.some((p) => p.type === 'user' && p.id === userIds.helper)).toBe(true);
	});

	it('ohne members: keine Gruppen/Mitglieder in der Suche, Freigabe an sie → 422', async () => {
		const found = ok<{ type: string }[]>(await call('owner', 'GET', '/principals?search=Sippe'));
		expect(found.filter((p) => p.type === 'group' || p.type === 'member')).toEqual([]);
		for (const type of ['group', 'member']) {
			fail(
				await call('owner', 'PUT', `/notes/${rootId}/shares`, {
					shares: [{ type, id: crypto.randomUUID(), level: 'read' }]
				}),
				422,
				'validation_failed'
			);
		}
		// bestehende Freigaben bleiben unverändert
		const shares = ok<NoteShares>(await call('owner', 'GET', `/notes/${rootId}/shares`));
		expect(shares.shares.map((x) => x.type).sort()).toEqual(['role', 'user']);
	});
});

describe('Live: Yjs und SSE', () => {
	it('zwei Clients konvergieren über /updates und /state; Leser*innen dürfen nichts schicken', async () => {
		const a = await yClient('owner', childId);
		const b = await yClient('helper', childId);
		expect(a.level).toBe('edit');
		a.addParagraph('Geländespiel am Nachmittag');
		b.addParagraph('Lagerfeuer am Abend');
		const ra = await postUpdate('owner', childId, 'client-owner-a', a.take());
		expect(ra.status).toBe(201);
		expect(((await ra.json()) as { data: UpdateResult }).data.ok).toBe(true);
		const rb = await postUpdate('helper', childId, 'client-helper-b', b.take());
		expect(rb.status).toBe(201);
		const text = await contentOf('owner', childId);
		expect(text).toContain('Geländespiel am Nachmittag');
		expect(text).toContain('Lagerfeuer am Abend');

		// nur fehlende Änderungen über den State-Vector
		const sv = Buffer.from(Y.encodeStateVector(a.doc)).toString('base64');
		const diff = await raw('owner', 'GET', `/notes/${childId}/state?sv=${encodeURIComponent(sv)}`);
		expect(diff.headers.get('x-yjs-state-vector')).toBeTruthy();
		Y.applyUpdate(a.doc, new Uint8Array(await diff.arrayBuffer()), 'remote');
		expect(
			JSON.stringify(yXmlFragmentToProsemirrorJSON(a.doc.getXmlFragment(YDOC_FIELD)))
		).toContain('Lagerfeuer am Abend');

		const reader = await yClient('parent', childId);
		reader.addParagraph('Darf nicht');
		const rr = await postUpdate('parent', childId, 'client-parent', reader.take());
		expect(rr.status).toBe(403);
		const wrongType = await raw(
			'owner',
			'POST',
			`/notes/${childId}/updates?client=client-owner-a`,
			{
				body: JSON.stringify({ x: 1 }),
				type: 'application/json'
			}
		);
		expect(wrongType.status).toBe(400);
		const broken = await postUpdate('owner', childId, 'client-owner-a', new Uint8Array([1, 2, 3]));
		expect(broken.status).toBe(422);
		const foreign = await postUpdate('stranger', childId, 'client-stranger', new Uint8Array([0]));
		expect(foreign.status).toBe(404);
	});

	it('SSE: hello mit Anwesenden, Update und Anwesenheit beim anderen Client', async () => {
		const first = await openLive('owner', childId, 'client-owner-live');
		const hello1 = await first.waitFor('hello');
		expect(hello1).toMatchObject({ level: 'edit', peers: [] });
		const second = await openLive('helper', childId, 'client-helper-live');
		const hello2 = await second.waitFor('hello');
		expect(hello2.peers.map((p) => p.client)).toEqual(['client-owner-live']);
		// fremde Verbindungskennung (steht in `hello`) darf niemand übernehmen
		expect((await openLive('helper', childId, 'client-owner-live')).status).toBe(409);
		expect(first.isEnded()).toBe(false);
		await first.waitFor('join', (e) => e.peer.client === 'client-helper-live');

		const c = await yClient('helper', childId);
		c.addParagraph('Live dazu');
		const update = c.take();
		expect((await postUpdate('helper', childId, 'client-helper-live', update)).status).toBe(201);
		const got = await first.waitFor('update', (e) => e.client === 'client-helper-live');
		expect(Buffer.from(got.update, 'base64').equals(Buffer.from(update))).toBe(true);
		expect(second.events.some((e) => e.type === 'update')).toBe(false);

		expect(
			ok<{ ok: boolean }>(
				await call('owner', 'POST', `/notes/${childId}/awareness`, {
					client: 'client-owner-live',
					update: 'AQID'
				}),
				201
			).ok
		).toBe(true);
		await second.waitFor('awareness', (e) => e.update === 'AQID');
		expect(
			ok<{ ok: boolean }>(
				await call('stranger', 'POST', `/notes/${childId}/awareness`, {
					client: 'client-owner-live',
					update: 'AQID'
				}),
				201
			).ok
		).toBe(false);

		ok(await call('owner', 'PATCH', `/notes/${childId}`, { title: 'Programm' }));
		await second.waitFor('meta', (e) => e.note.title === 'Programm');

		second.close();
		await first.waitFor('leave', (e) => e.client === 'client-helper-live');
		first.close();
	});

	it('Entzug der Freigabe schließt die Verbindung (revoked)', async () => {
		const live = await openLive('helper', grandId, 'client-helper-revoke');
		await live.waitFor('hello', (e) => e.level === 'edit');
		ok(await call('owner', 'PUT', `/notes/${childId}/shares`, { shares: [] }));
		await live.waitFor('access', (e) => e.level === 'read');
		ok(
			await call('owner', 'PUT', `/notes/${rootId}/shares`, {
				shares: [{ type: 'role', id: parentRole, level: 'read' }]
			})
		);
		await live.waitFor('revoked');
		await vi.waitFor(() => expect(live.isEnded()).toBe(true));
		fail(await call('helper', 'GET', `/notes/${grandId}`), 404, 'not_found');
		expect((await openLive('stranger', rootId, 'client-stranger-x')).status).toBe(404);
	});

	it('Neuprüfung löst den Kontext neu auf: deaktiviertes Konto verliert view-all sofort', async () => {
		const live = await openLive('viewall', rootId, 'client-viewall-live');
		await live.waitFor('hello', (e) => e.level === 'read');
		await setUserActive(admin, userIds.viewall!, false);
		await hub.recheck(rootId);
		await live.waitFor('revoked');
		await vi.waitFor(() => expect(live.isEnded()).toBe(true));
		await setUserActive(admin, userIds.viewall!, true);
	});

	it('verdichtet Einzel-Updates ohne Inhaltsverlust', async () => {
		const before = await contentOf('owner', childId);
		await flushAllForTests();
		const left = await notesSql<{ n: number }>(
			sql`SELECT count(*)::int AS n FROM note_updates WHERE note_id = ${childId}`
		);
		expect(Number(left[0]!.n)).toBe(0);
		await resetDocsForTests();
		expect(await contentOf('owner', childId)).toBe(before);
		const [row] = await notesSql<{ content_text: string }>(
			sql`SELECT content_text FROM notes WHERE id = ${childId}`
		);
		expect(row!.content_text).toContain('Live dazu');
	});
});

describe('Verschieben und Papierkorb', () => {
	let otherRoot: string;

	it('verhindert Zyklen und Verschieben in fremde Notizen ohne Eigentum', async () => {
		fail(
			await call('owner', 'POST', `/notes/${rootId}/move`, { parentId: grandId, position: 0 }),
			422,
			'validation_failed'
		);
		otherRoot = ok<NoteDetail>(await call('other', 'POST', '/notes', { title: 'Fremd' }), 201).id;
		ok(
			await call('other', 'PUT', `/notes/${otherRoot}/shares`, {
				shares: [{ type: 'user', id: userIds.helper, level: 'edit' }]
			})
		);
		ok(
			await call('owner', 'PUT', `/notes/${rootId}/shares`, {
				shares: [{ type: 'user', id: userIds.helper, level: 'edit' }]
			})
		);
		fail(
			await call('helper', 'POST', `/notes/${grandId}/move`, { parentId: otherRoot, position: 0 }),
			403,
			'forbidden'
		);
		fail(
			await call('helper', 'POST', `/notes/${grandId}/move`, { parentId: null, position: 0 }),
			403,
			'forbidden'
		);
		// innerhalb des eigenen Teilbaums darf eine Bearbeiten-Freigabe umsortieren
		const moved = ok<NoteDetail>(
			await call('helper', 'POST', `/notes/${grandId}/move`, { parentId: rootId, position: 0 }),
			201
		);
		expect(moved.parentId).toBe(rootId);
		const kids = ok<NoteNode[]>(await call('owner', 'GET', `/notes/${rootId}/children`));
		expect(kids.map((k) => [k.title, k.position])).toEqual([
			['Tag 1', 0],
			['Programm', 1]
		]);
		// unter eine anders geteilte Seite (würde den Inhalt weiteren Personen zeigen): nur Eigentümer*in
		const wider = ok<NoteDetail>(
			await call('owner', 'POST', '/notes', { title: 'Für alle', parentId: rootId }),
			201
		).id;
		ok(
			await call('owner', 'PUT', `/notes/${wider}/shares`, {
				shares: [{ type: 'everyone', id: '*', level: 'read' }]
			})
		);
		fail(
			await call('helper', 'POST', `/notes/${grandId}/move`, { parentId: wider, position: 0 }),
			403,
			'forbidden'
		);
		await notesSql(sql`DELETE FROM notes WHERE id = ${wider}`);
	});

	it('Eigentümer*in verschiebt in fremde Notiz → Eigentum wechselt; zurück an die eigene Wurzel', async () => {
		ok(
			await call('other', 'PUT', `/notes/${otherRoot}/shares`, {
				shares: [{ type: 'user', id: userIds.owner, level: 'edit' }]
			})
		);
		const moved = ok<NoteDetail>(
			await call('owner', 'POST', `/notes/${grandId}/move`, { parentId: otherRoot, position: 0 }),
			201
		);
		expect(moved.ownerId).toBe(userIds.other);
		expect(moved.isOwner).toBe(false);
		fail(
			await call('owner', 'POST', `/notes/${grandId}/move`, { parentId: null, position: 0 }),
			403,
			'forbidden'
		);
		const back = ok<NoteDetail>(
			await call('editall', 'POST', `/notes/${grandId}/move`, { parentId: rootId, position: 5 }),
			201
		);
		expect(back.ownerId).toBe(userIds.owner);
		const top = ok<NoteDetail>(
			await call('owner', 'POST', `/notes/${grandId}/move`, { parentId: null, position: 0 }),
			201
		);
		expect(top.parentId).toBeNull();
		const roots = ok<NoteRoots>(await call('owner', 'GET', '/notes/roots'));
		expect(roots.own[0]!.id).toBe(grandId);
		ok(
			await call('owner', 'POST', `/notes/${grandId}/move`, { parentId: rootId, position: 0 }),
			201
		);
	});

	it('Papierkorb: löschen, wiederherstellen, endgültig löschen', async () => {
		const res = ok<{ trashed: number }>(await call('owner', 'DELETE', `/notes/${childId}`));
		expect(res.trashed).toBe(1);
		fail(await call('owner', 'GET', `/notes/${childId}`), 404, 'not_found');
		const trash = ok<TrashItem[]>(await call('owner', 'GET', '/notes/trash'));
		expect(trash.map((t) => [t.id, t.parentTitle])).toEqual([[childId, 'Sommerlager']]);
		expect(trash[0]!.purgeOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(ok<TrashItem[]>(await call('helper', 'GET', '/notes/trash'))).toEqual([]);
		fail(
			await call('helper', 'POST', '/notes/trash/restore', { ids: [childId] }),
			403,
			'forbidden'
		);
		ok(await call('owner', 'POST', '/notes/trash/restore', { ids: [childId] }), 201);
		const back = ok<NoteDetail>(await call('owner', 'GET', `/notes/${childId}`));
		expect(back.parentId).toBe(rootId);

		// Oberseite gelöscht → Wiederherstellen als eigene Wurzel
		const temp = ok<NoteDetail>(
			await call('owner', 'POST', '/notes', { title: 'Wegwerf', parentId: childId }),
			201
		).id;
		ok(await call('owner', 'DELETE', `/notes/${temp}`));
		ok(await call('owner', 'DELETE', `/notes/${childId}`));
		ok(await call('owner', 'POST', '/notes/trash/restore', { ids: [temp] }), 201);
		const alone = ok<NoteDetail>(await call('owner', 'GET', `/notes/${temp}`));
		expect(alone.parentId).toBeNull();
		ok(await call('owner', 'DELETE', `/notes/${temp}`));
		const purged = ok<{ purged: number }>(
			await call('owner', 'POST', '/notes/trash/purge', { ids: [temp] }),
			201
		);
		expect(purged.purged).toBe(1);
		ok(await call('owner', 'POST', '/notes/trash/restore', { ids: [childId] }), 201);
	});

	it('Job löscht abgelaufene Papierkorb-Einträge', async () => {
		const id = ok<NoteDetail>(await call('owner', 'POST', '/notes', { title: 'Alt' }), 201).id;
		ok(await call('owner', 'DELETE', `/notes/${id}`));
		await notesSql(sql`UPDATE notes SET deleted_at = now() - interval '40 days' WHERE id = ${id}`);
		expect(await purgeExpiredTrash()).toBe(1);
		const left = await notesSql(sql`SELECT id FROM notes WHERE id = ${id}`);
		expect(left).toEqual([]);
	});
});

describe('Ohne Modul actions', () => {
	it('Aktionen werden abgelehnt, by-action → 404, keine Aktions-Wurzeln', async () => {
		const actionId = crypto.randomUUID();
		fail(await call('owner', 'POST', '/notes', { title: 'X', actionId }), 422, 'validation_failed');
		fail(await call('owner', 'PATCH', `/notes/${rootId}`, { actionId }), 422, 'validation_failed');
		fail(await call('owner', 'GET', `/notes/by-action/${actionId}`), 404, 'not_found');
		fail(await call('stranger', 'GET', `/notes/by-action/${actionId}`), 404, 'not_found');
		const roots = ok<NoteRoots>(await call('owner', 'GET', '/notes/roots'));
		expect(roots.actions).toEqual([]);
		// Aktion lösen ist auch ohne `actions` möglich (Eigentümer*in), ändert hier nichts
		const freed = ok<NoteDetail>(
			await call('owner', 'PATCH', `/notes/${rootId}`, { actionId: null })
		);
		expect(freed).toMatchObject({ actionId: null, title: 'Sommerlager' });
		fail(await call('helper', 'PATCH', `/notes/${rootId}`, { actionId: null }), 403, 'forbidden');
	});
});

describe('Versionen, Bilder, Suche', () => {
	it('benannte Version, Vorschau, Wiederherstellen, Löschen', async () => {
		const v = ok<NoteVersion>(
			await call('owner', 'POST', `/notes/${rootId}/versions`, { label: 'Stand Juni' }),
			201
		);
		const c = await yClient('owner', rootId);
		c.addParagraph('Spätere Änderung');
		expect((await postUpdate('owner', rootId, 'client-owner-v', c.take())).status).toBe(201);
		expect(await contentOf('owner', rootId)).toContain('Spätere Änderung');

		const detail = ok<NoteVersionDetail>(
			await call('helper', 'GET', `/notes/${rootId}/versions/${v.id}`)
		);
		expect(JSON.stringify(detail.content)).toContain('Packliste');
		expect(JSON.stringify(detail.content)).not.toContain('Spätere Änderung');
		fail(
			await call('viewall', 'POST', `/notes/${rootId}/versions/${v.id}/restore`),
			403,
			'forbidden'
		);
		ok(await call('editall', 'POST', `/notes/${rootId}/versions/${v.id}/restore`), 201);
		const text = await contentOf('owner', rootId);
		expect(text).toContain('Packliste');
		expect(text).not.toContain('Spätere Änderung');

		const list = ok<NoteVersion[]>(await call('owner', 'GET', `/notes/${rootId}/versions`));
		expect(list.map((x) => x.label)).toEqual(['Vor dem Wiederherstellen', 'Stand Juni']);
		fail(await call('helper', 'DELETE', `/notes/${rootId}/versions/${v.id}`), 403, 'forbidden');
		ok(await call('owner', 'DELETE', `/notes/${rootId}/versions/${v.id}`));
		expect(ok<NoteVersion[]>(await call('owner', 'GET', `/notes/${rootId}/versions`))).toHaveLength(
			1
		);
	});

	it('automatische Versionen nur bei Änderungen', async () => {
		const first = await runAutoVersions();
		expect(first).toBeGreaterThan(0);
		expect(await runAutoVersions()).toBe(0);
		const list = ok<NoteVersion[]>(await call('owner', 'GET', `/notes/${rootId}/versions`));
		expect(list.some((x) => x.auto)).toBe(true);
	});

	it('lädt ein Bild hoch und liefert es nur mit Zugriff aus', async () => {
		const fd = new FormData();
		fd.set('file', new File([(await png()) as BlobPart], 'zelt.png', { type: 'image/png' }));
		const res = await raw('owner', 'POST', `/notes/${rootId}/assets`, { body: fd });
		expect(res.status).toBe(201);
		const asset = ((await res.json()) as { data: NoteAsset }).data;
		expect(asset).toMatchObject({ kind: 'image', contentType: 'image/webp', width: 300 });
		const img = await raw('helper', 'GET', `/assets/${asset.id}/web`);
		expect(img.status).toBe(200);
		expect(img.headers.get('content-type')).toBe('image/webp');
		expect((await raw('helper', 'GET', `/assets/${asset.id}/file`)).status).toBe(200);
		expect((await raw('stranger', 'GET', `/assets/${asset.id}/thumb`)).status).toBe(404);
		const fdText = new FormData();
		fdText.set('file', new File(['hallo'], 'a.txt', { type: 'text/plain' }));
		const bad = await raw('owner', 'POST', `/notes/${rootId}/assets`, { body: fdText });
		expect(bad.status).toBe(422);
		fail(
			{
				status: (await raw('viewall', 'POST', `/notes/${rootId}/assets`, { body: fd })).status,
				body: { error: { code: 'forbidden' } }
			},
			403,
			'forbidden'
		);
	});

	it('löscht ungenutzte Bilder erst nach der Frist', async () => {
		const fd = new FormData();
		fd.set('file', new File([(await png()) as BlobPart], 'weg.png', { type: 'image/png' }));
		const res = await raw('owner', 'POST', `/notes/${rootId}/assets`, { body: fd });
		expect(res.status).toBe(201);
		const asset = ((await res.json()) as { data: NoteAsset }).data;
		// zu neu: bleibt (Rückgängig im Editor könnte es zurückholen)
		await purgeUnusedAssets();
		expect((await raw('owner', 'GET', `/assets/${asset.id}/web`)).status).toBe(200);
		await notesSql(
			sql`UPDATE note_assets SET created_at = now() - interval '8 days' WHERE id = ${asset.id}`
		);
		expect(await purgeUnusedAssets()).toBeGreaterThanOrEqual(1);
		expect((await raw('owner', 'GET', `/assets/${asset.id}/web`)).status).toBe(404);
	});

	it('Daten ersetzt (Zurücksetzen/Wiederherstellen): Editoren laden neu', async () => {
		const live = await openLive('owner', rootId, 'client-owner-reset');
		await live.waitFor('hello');
		await flushAllForTests();
		await notesModule.onDataReplaced!();
		await live.waitFor('reset');
		await vi.waitFor(() => expect(live.isEnded()).toBe(true));
		expect((await raw('owner', 'GET', `/notes/${rootId}/state`)).status).toBe(200);
	});

	it('Suche, zuletzt geändert, globale Suche und Dienst für andere Module', async () => {
		await flushAllForTests();
		const hits = ok<NoteSearchHit[]>(await call('helper', 'GET', '/notes/search?q=Lagerfeuer'));
		expect(hits.map((h) => h.id)).toEqual([childId]);
		expect(hits[0]!.path).toBe('Sommerlager');
		expect(hits[0]!.snippet).toContain('Lagerfeuer');
		expect(
			ok<NoteSearchHit[]>(await call('stranger', 'GET', '/notes/search?q=Lagerfeuer'))
		).toEqual([]);
		const byTitle = ok<NoteSearchHit[]>(await call('owner', 'GET', '/notes/search?q=sommer'));
		expect(byTitle[0]!.id).toBe(rootId);

		const recent = ok<NoteNode[]>(await call('helper', 'GET', '/notes/recent?limit=5'));
		expect(recent.length).toBeGreaterThan(0);
		expect(recent.every((n) => typeof n.excerpt === 'string')).toBe(true);
		expect(recent.some((n) => n.id === childId)).toBe(true);

		const helperCtx = await ctxOf(userIds.helper!);
		const global = await notesSearch.run(helperCtx, 'Programm', 5);
		expect(global.map((h) => h.href)).toEqual([`/modules/notes/${childId}`]);
		const refs = await noteRefsService.describeNoteRefs(helperCtx, [childId, crypto.randomUUID()]);
		expect(refs.map((r) => [r.id, r.path])).toEqual([[childId, 'Sommerlager']]);
		const strangerCtx = await ctxOf(userIds.stranger!);
		expect(await noteRefsService.searchNoteRefs(strangerCtx, { search: 'Programm' })).toEqual([]);
		const outsiderCtx = await ctxOf(userIds.outsider!);
		expect(await noteRefsService.searchNoteRefs(outsiderCtx)).toEqual([]);
	});

	it('Audit ohne Inhalte', async () => {
		const { rows } = await listAudit({ action: 'notes.', limit: 300 });
		const actions = new Set(rows.map((r) => r.action));
		for (const a of [
			'notes.note.created',
			'notes.note.updated',
			'notes.note.moved',
			'notes.note.shared',
			'notes.note.trashed',
			'notes.note.restored',
			'notes.note.purged',
			'notes.version.created',
			'notes.version.restored',
			'notes.version.deleted',
			'notes.asset.uploaded'
		]) {
			expect(actions).toContain(a);
		}
		const text = JSON.stringify(rows.map((r) => r.metadata));
		expect(text).not.toContain('Lagerfeuer');
		expect(text).not.toContain('Packliste');
		expect(text).not.toContain('zelt.png');
	});
});

describe('Persönlicher Hintergrund', () => {
	it('Standard wie Theme, speichern je Konto, ungültig 422', async () => {
		expect(ok<UserPrefs>(await call('stranger', 'GET', '/me/prefs'))).toEqual(DEFAULT_USER_PREFS);
		const saved = ok<UserPrefs>(
			await call('stranger', 'PUT', '/me/prefs', { surface: { mode: 'fixed', color: '#FBF6EA' } })
		);
		expect(saved.surface).toEqual({ mode: 'fixed', color: '#fbf6ea' });
		expect(ok<UserPrefs>(await call('stranger', 'GET', '/me/prefs')).surface.color).toBe('#fbf6ea');
		// gilt nur für die eigene Person
		expect(ok<UserPrefs>(await call('other', 'GET', '/me/prefs'))).toEqual(DEFAULT_USER_PREFS);
		const bad = await call('stranger', 'PUT', '/me/prefs', {
			surface: { mode: 'fixed', color: 'red' }
		});
		expect(bad.status).toBe(422);
		const extra = await call('stranger', 'PUT', '/me/prefs', { surface: { mode: 'x' } });
		expect(extra.status).toBe(422);
	});
});

describe('Konto löschen und Modul aus', () => {
	it('private Notizen weg, geteilte bleiben ohne Eigentümer*in', async () => {
		await call('other', 'PUT', '/me/prefs', { surface: { mode: 'fixed', color: '#111827' } });
		const priv = ok<NoteDetail>(await call('other', 'POST', '/notes', { title: 'Privat' }), 201).id;
		const result = await core.database
			.forModule('notes')
			.transaction((tx) => onUserDeleted!(tx, { userId: userIds.other!, transferTo: null }));
		await result?.afterCommit?.();
		expect(await notesSql(sql`SELECT id FROM notes WHERE id = ${priv}`)).toEqual([]);
		const [kept] = await notesSql<{ owner_id: string | null }>(
			sql`SELECT owner_id FROM notes WHERE title = 'Fremd'`
		);
		expect(kept).toEqual({ owner_id: null });
		const shares = await notesSql(
			sql`SELECT 1 FROM note_shares WHERE principal_type = 'user' AND principal_id = ${userIds.other!}`
		);
		expect(shares).toEqual([]);
		expect(await notesSql(sql`SELECT 1 FROM user_prefs WHERE user_id = ${userIds.other!}`)).toEqual(
			[]
		);
	});

	it('Modul aus → 404', async () => {
		await disableModule(admin, 'notes');
		expect((await call('admin', 'GET', '/notes/roots')).status).toBe(404);
		await enableModule(admin, 'notes');
	});
});
