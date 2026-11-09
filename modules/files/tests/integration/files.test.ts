/**
 * Modul `files` (Dateien) über die REST-API (`handleApiRequest`): Meta, Ordner, Upload (Fake-Storage),
 * Inhalt/Thumbnail, Liste (eine Ansicht „Dateien“: eigene + freigegebene Einträge), Umbenennen, Verschieben,
 * Stamm-Freigabe (`everyone:*`), Suche, Papierkorb inkl. Job, Zugriff, Audit, Modul deaktiviert. Testbilder werden mit sharp erzeugt.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, like, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { useTestDatabase } from '$testing';
import { fakeFileRows, fakeObjects, installFakeStorage, uninstallFakeStorage } from '$testing';
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
import { setSetting } from '$testing';
import { runJobNow } from '$testing';
import { core } from '$testing';
import filesModule from '$modules/files/module';
import {
	MAX_DEPTH,
	ROOT_LABEL,
	type FileNode,
	type FolderListing,
	type TrashItem
} from '$modules/files/schemas';
import type { RequestContext } from '$lib/sdk/types';
import { todayBerlin } from '$lib/sdk/dates';

const ROOT = 'http://localhost:5173/api/v1/modules/files';
const PW = 'a-long-enough-pw';
const keys: Record<string, string> = {};
const ids: Record<string, string> = {};
let close: () => Promise<void>;
let admin: RequestContext;
let adminId: string;

const ctxOf = async (id: string) => (await contextForUser(id))!.ctx;

interface Res {
	status: number;
	headers: Headers;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	body: any;
}

async function send(who: string | null, method: string, path: string, init: RequestInit = {}) {
	resetAllForTests();
	const url = new URL(ROOT + path);
	const headers = new Headers(init.headers);
	if (who) headers.set('authorization', `Bearer ${keys[who]}`);
	const res = await handleApiRequest({
		request: new Request(url, { ...init, method, headers }),
		url,
		ip: '127.0.0.1'
	});
	const text = await res.text();
	let body: unknown = text;
	try {
		body = JSON.parse(text);
	} catch {
		/* roher Inhalt */
	}
	return { status: res.status, headers: res.headers, body } as Res;
}

const api = (who: string | null, method: string, path: string, data?: unknown) =>
	send(who, method, path, {
		headers: data === undefined ? {} : { 'content-type': 'application/json' },
		body: data === undefined ? undefined : JSON.stringify(data)
	});

interface UploadOpts {
	relativePath?: string;
	conflict?: 'rename' | 'replace';
	type?: string;
	bytes?: Uint8Array;
	size?: number;
	withLength?: boolean;
}

async function upload(who: string, parent: string, name: string, o: UploadOpts = {}) {
	const form = new FormData();
	if (o.relativePath !== undefined) form.set('relativePath', o.relativePath);
	if (o.conflict) form.set('conflict', o.conflict);
	const bytes = o.bytes ?? new Uint8Array(o.size ?? 10).fill(65);
	form.set('file', new File([bytes as BlobPart], name, { type: o.type ?? 'text/plain' }));
	const r = new Response(form);
	const buf = new Uint8Array(await r.arrayBuffer());
	const headers: Record<string, string> = { 'content-type': r.headers.get('content-type')! };
	if (o.withLength !== false) headers['content-length'] = String(buf.byteLength);
	return send(who, 'POST', `/nodes/${parent}/upload`, { headers, body: buf });
}

const folder = async (who: string, parentId: string | null, name: string) =>
	api(who, 'POST', '/folders', { parentId, name });

const list = async (who: string, parent?: string) =>
	api(who, 'GET', `/nodes${parent ? `?parent=${parent}` : ''}`);

const names = (l: FolderListing) => l.items.map((i) => i.name);

/** Storage-Pfade (Modul `files`) eines Knotens, deren Objekt im Fake-S3 noch existiert */
const objectsOf = (nodeId: string) =>
	[...fakeFileRows.values()]
		.filter((r) => r.moduleId === 'files' && r.path.startsWith(`${nodeId}/`))
		.filter((r) => fakeObjects.has(r.objectKey))
		.map((r) => r.path);

async function pngBytes(): Promise<Uint8Array> {
	const buf = await sharp({
		create: { width: 64, height: 48, channels: 3, background: { r: 200, g: 50, b: 50 } }
	})
		.png()
		.toBuffer();
	return new Uint8Array(buf);
}

beforeAll(async () => {
	({ close } = await useTestDatabase());
	registerCoreApi();
	registerModule(filesModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', PW);
	const [u] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	adminId = u!.id;
	admin = await ctxOf(adminId);
	await enableModule(admin, 'files');
	admin = await ctxOf(adminId);
	await installFakeStorage(admin);

	const roles = {
		// Dateien + öffentliche Links
		editor: await createRole(admin, {
			name: 'Dateien Links',
			permissions: ['files.file.view', 'files.link.create', 'core.api.manage']
		}),
		// Grundrecht
		reader: await createRole(admin, {
			name: 'Dateien Lesen',
			permissions: ['files.file.view', 'core.api.manage']
		}),
		// Grundrecht
		plain: await createRole(admin, {
			name: 'Dateien Basis',
			permissions: ['files.file.view', 'core.api.manage']
		}),
		// gar kein Modulrecht
		none: await createRole(admin, { name: 'Ohne Dateien', permissions: ['core.api.manage'] })
	};
	const users: [string, string][] = [
		['u1', roles.editor],
		['u2', roles.reader],
		['u3', roles.plain],
		['u4', roles.none]
	];
	for (const [n, role] of users) {
		ids[n] = await createUser(admin, {
			name: n.toUpperCase(),
			email: `${n}@example.test`,
			password: PW,
			roleIds: [role]
		});
		const c = await ctxOf(ids[n]!);
		keys[n] = (await createApiKey(c, { name: 'k', scopes: [...c.permissions] })).key;
	}
	keys.admin = (await createApiKey(admin, { name: 'a', scopes: [...admin.permissions] })).key;
});

afterAll(async () => {
	uninstallFakeStorage();
	await close?.();
});

describe('Meta', () => {
	it('liefert Kontingent, Grenzen und Rechte-Flags je Person', async () => {
		const r1 = await api('u1', 'GET', '/meta');
		expect(r1.status).toBe(200);
		expect(r1.body.data.quota).toEqual({ usedBytes: 0, limitBytes: 1024 * 1024 * 1024 });
		expect(r1.body.data.trashDays).toBe(30);
		expect(r1.body.data.maxFileBytes).toBeGreaterThan(0);
		expect(r1.body.data.allowedContentTypes).toContain('text/plain');
		// keine Stamm-Flags mehr (eine Ansicht)
		expect(r1.body.data.can).toEqual({ linkCreate: true, manageAll: false });
		const r3 = await api('u3', 'GET', '/meta');
		expect(r3.body.data.can).toEqual({ linkCreate: false, manageAll: false });
		expect((await api('admin', 'GET', '/meta')).body.data.can).toEqual({
			linkCreate: true,
			manageAll: true
		});
	});

	it('ohne files.file.view → 403 forbidden', async () => {
		const r = await api('u4', 'GET', '/meta');
		expect(r.status).toBe(403);
		expect(r.body.error.code).toBe('forbidden');
		const l = await list('u4');
		expect(l.status).toBe(403);
	});
});

describe('Ordner', () => {
	it('legt Ordner in der eigenen Wurzel und verschachtelt an', async () => {
		const p = await folder('u1', null, 'Projekte');
		expect(p.status).toBe(201);
		expect(p.body.data).toMatchObject({
			kind: 'folder',
			parentId: null,
			name: 'Projekte',
			ownerId: ids.u1,
			access: 'edit',
			own: true,
			stamm: false,
			canShare: true,
			viaLink: false,
			uploadedByName: null,
			childCount: 0
		});
		expect(p.body.data.owner).toEqual({ id: ids.u1, name: 'U1' });
		expect(p.body.data).not.toHaveProperty('space');
		const sub = await folder('u1', p.body.data.id, 'Sommer');
		expect(sub.status).toBe(201);
		expect(sub.body.data.parentId).toBe(p.body.data.id);
		// `space` gibt es nicht mehr (strikte Eingabe)
		const s = await api('u1', 'POST', '/folders', {
			space: 'shared',
			parentId: null,
			name: 'Stammesordner'
		});
		expect(s.status).toBe(422);
		// gleicher Name bei anderer Person erlaubt
		expect((await folder('u3', null, 'Projekte')).status).toBe(201);
	});

	it('Namenskonflikt (ohne Groß/Klein) → 409 conflict mit Vorschlag', async () => {
		const r = await folder('u1', null, 'projekte');
		expect(r.status).toBe(409);
		expect(r.body.error.code).toBe('conflict');
		expect(r.body.error.message).toBe('Es gibt hier schon „projekte“. Vorschlag: „projekte (2)“');
	});

	it('ungültige Namen → 422', async () => {
		for (const name of ['a/b', 'a\\b', '..', '.', '', '   ', 'x\u0001', 'A‮b', 'x'.repeat(201)]) {
			const r = await folder('u1', null, name);
			expect(r.status, JSON.stringify(name)).toBe(422);
			expect(r.body.error.code).toBe('validation_failed');
		}
	});

	it(`mehr als MAX_DEPTH (${MAX_DEPTH}) Ebenen → 422`, async () => {
		let parent: string | null = null;
		for (let i = 1; i <= MAX_DEPTH; i++) {
			const r = await folder('u3', parent, `Ebene ${i}`);
			expect(r.status, `Ebene ${i}`).toBe(201);
			parent = r.body.data.id;
		}
		const tooDeep = await folder('u3', parent, 'zu tief');
		expect(tooDeep.status).toBe(422);
		expect(tooDeep.body.error.code).toBe('validation_failed');
		expect(JSON.stringify(tooDeep.body.error)).toContain('Ordnerebenen');
	});
});

describe('Upload und Inhalt', () => {
	let fileId: string;

	it('ohne Content-Length → 400 bad_request', async () => {
		const r = await upload('u1', 'root', 'ohne.txt', { withLength: false });
		expect(r.status).toBe(400);
		expect(r.body.error.code).toBe('bad_request');
	});

	it('lädt eine Datei hoch und liefert den Inhalt mit sicheren Headern', async () => {
		const bytes = new TextEncoder().encode('Hallo Welt');
		const r = await upload('u1', 'root', 'Notiz Ä.txt', { bytes });
		expect(r.status).toBe(201);
		expect(r.body.data).toMatchObject({
			kind: 'file',
			name: 'Notiz Ä.txt',
			contentType: 'text/plain',
			sizeBytes: bytes.byteLength,
			hasThumb: false,
			parentId: null
		});
		fileId = r.body.data.id;
		expect(objectsOf(fileId).length).toBe(1);

		const c = await send('u1', 'GET', `/nodes/${fileId}/content`);
		expect(c.status).toBe(200);
		expect(c.body).toBe('Hallo Welt');
		expect(c.headers.get('content-type')).toBe('text/plain; charset=utf-8');
		expect(c.headers.get('content-disposition')).toMatch(/^inline; filename="Notiz A.txt"/);
		expect(c.headers.get('content-disposition')).toContain("filename*=UTF-8''Notiz%20%C3%84.txt");
		expect(c.headers.get('x-content-type-options')).toBe('nosniff');
		expect(c.headers.get('content-security-policy')).toContain('sandbox');

		const d = await send('u1', 'GET', `/nodes/${fileId}/content?download=1`);
		expect(d.headers.get('content-disposition')).toMatch(/^attachment;/);
	});

	it('Namenskonflikt: rename → „Name (2)“, replace → gleiche ID mit neuem Inhalt', async () => {
		const ren = await upload('u1', 'root', 'Notiz Ä.txt', { size: 3 });
		expect(ren.status).toBe(201);
		expect(ren.body.data.name).toBe('Notiz Ä (2).txt');
		expect(ren.body.data.id).not.toBe(fileId);

		const oldObjects = objectsOf(fileId);
		const rep = await upload('u1', 'root', 'notiz ä.txt', { size: 7, conflict: 'replace' });
		expect(rep.status).toBe(201);
		expect(rep.body.data.id).toBe(fileId);
		expect(rep.body.data.sizeBytes).toBe(7);
		// altes Objekt entfernt, neues vorhanden
		const now = objectsOf(fileId);
		expect(now.length).toBe(1);
		expect(now[0]).not.toBe(oldObjects[0]);
	});

	it('Ordner-Upload per relativePath legt Ordner an und verwendet sie wieder', async () => {
		const a = await upload('u1', 'root', 'egal.txt', { relativePath: 'Fotos/2026/a.txt' });
		expect(a.status).toBe(201);
		expect(a.body.data.name).toBe('a.txt');
		const b = await upload('u1', 'root', 'egal.txt', { relativePath: 'fotos/2026/b.txt' });
		expect(b.status).toBe(201);
		expect(b.body.data.parentId).toBe(a.body.data.parentId);
		const root = (await list('u1')).body.data as FolderListing;
		expect(names(root).filter((n) => n.toLowerCase() === 'fotos')).toEqual(['Fotos']);
		const inner = (await list('u1', a.body.data.parentId)).body.data as FolderListing;
		expect(names(inner)).toEqual(['a.txt', 'b.txt']);
		expect(inner.breadcrumbs.map((b) => b.name)).toEqual([ROOT_LABEL, 'Fotos', '2026']);

		const bad = await upload('u1', 'root', 'x.txt', { relativePath: '//' });
		expect(bad.status).toBe(422);
		expect(bad.body.error.code).toBe('validation_failed');
	});

	it('nicht erlaubter Typ → 422, nichts gespeichert', async () => {
		const before = fakeObjects.size;
		const r = await upload('u1', 'root', 'bild.svg', { type: 'image/svg+xml' });
		expect(r.status).toBe(422);
		expect(r.body.error.code).toBe('validation_failed');
		expect(r.body.error.message).toContain('Dateityp nicht erlaubt');
		const exe = await upload('u1', 'root', 'tool.exe', { type: 'application/x-msdownload' });
		expect(exe.status).toBe(422);
		expect(fakeObjects.size).toBe(before);
	});

	it('Word-/Office-Vorlagen und OpenDocument sind erlaubt (auch nur nach Endung)', async () => {
		const cases: [string, string][] = [
			['typ-brief.dotx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.template'],
			['typ-alt.dot', 'application/msword'],
			['typ-tabelle.xltx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.template'],
			['typ-folien.potx', 'application/vnd.openxmlformats-officedocument.presentationml.template'],
			['typ-text.rtf', 'application/rtf'],
			['typ-notiz.odt', 'application/vnd.oasis.opendocument.text'],
			['typ-vorlage.ott', 'application/vnd.oasis.opendocument.text-template']
		];
		for (const [name, expected] of cases) {
			// Browser ohne bekannten Typ → Erkennung über die Endung
			const r = await upload('u1', 'root', name, { type: '' });
			expect(r.status, name).toBe(201);
			expect(r.body.data.contentType).toBe(expected);
		}
		const macro = await upload('u1', 'root', 'typ-makro.docm', {
			type: 'application/vnd.ms-word.document.macroEnabled.12'
		});
		expect(macro.status).toBe(422);
	});

	it('SVG/HTML werden nie inline ausgeliefert (auch wenn erlaubt)', async () => {
		const meta = (await api('u1', 'GET', '/meta')).body.data;
		await setSetting(admin, 'core.storage.allowedContentTypes', [
			...meta.allowedContentTypes,
			'image/svg+xml',
			'text/html'
		]);
		try {
			const svg = await upload('u1', 'root', 'logo.svg', {
				type: 'image/svg+xml',
				bytes: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')
			});
			expect(svg.status).toBe(201);
			const html = await upload('u1', 'root', 'seite.html', {
				type: 'text/html',
				bytes: new TextEncoder().encode('<script>alert(1)</script>')
			});
			expect(html.status).toBe(201);
			for (const id of [svg.body.data.id, html.body.data.id]) {
				const c = await send('u1', 'GET', `/nodes/${id}/content`);
				expect(c.status).toBe(200);
				expect(c.headers.get('content-disposition')).toMatch(/^attachment;/);
				expect(c.headers.get('content-type')).toBe('application/octet-stream');
				expect(c.headers.get('x-content-type-options')).toBe('nosniff');
				expect(c.headers.get('content-security-policy')).toContain('sandbox');
			}
		} finally {
			await setSetting(admin, 'core.storage.allowedContentTypes', []);
		}
	});

	it('Bild bekommt ein Thumbnail (hasThumb, /thumb als WebP)', async () => {
		const r = await upload('u1', 'root', 'foto.png', {
			type: 'image/png',
			bytes: await pngBytes()
		});
		expect(r.status).toBe(201);
		expect(r.body.data.contentType).toBe('image/png');
		expect(r.body.data.hasThumb).toBe(true);
		expect(objectsOf(r.body.data.id).length).toBe(2);
		const t = await send('u1', 'GET', `/nodes/${r.body.data.id}/thumb`);
		expect(t.status).toBe(200);
		expect(t.headers.get('content-type')).toBe('image/webp');
		const c = await send('u1', 'GET', `/nodes/${r.body.data.id}/content`);
		expect(c.headers.get('content-disposition')).toMatch(/^inline;/);
		// Textdatei hat kein Thumbnail
		expect((await send('u1', 'GET', `/nodes/${fileId}/thumb`)).status).toBe(404);
	});

	it('Kontingent überschritten → 413, nichts gespeichert; /meta zeigt Belegung', async () => {
		await setSetting(admin, 'files.quota.mb', 1);
		try {
			const meta = (await api('u3', 'GET', '/meta')).body.data;
			expect(meta.quota.limitBytes).toBe(1024 * 1024);
			const before = fakeObjects.size;
			const r = await upload('u3', 'root', 'gross.txt', { size: 1024 * 1024 + 1 });
			expect(r.status).toBe(413);
			expect(r.body.error.code).toBe('payload_too_large');
			expect(r.body.error.message).toContain('Speicherplatz ist voll');
			expect(fakeObjects.size).toBe(before);
			// Upload in einen freigegebenen Ordner zählt bei der Eigentümer*in (u1 voll → 413 für u3)
			const box = (await folder('u1', null, 'Kontingent-Box')).body.data.id as string;
			expect(
				(
					await api('u1', 'PUT', `/nodes/${box}/shares`, {
						shares: [{ type: 'user', id: ids.u3, level: 'edit' }]
					})
				).status
			).toBe(200);
			const usedU1 = (await api('u1', 'GET', '/meta')).body.data.quota.usedBytes as number;
			const full = await upload('u1', box, 'voll.txt', { size: 1024 * 1024 - usedU1 - 50 });
			expect(full.status).toBe(201);
			const usedU3 = (await api('u3', 'GET', '/meta')).body.data.quota.usedBytes as number;
			const s = await upload('u3', box, 'fremd.txt', { size: 200 });
			expect(s.status).toBe(413);
			const ok = await upload('u3', box, 'klein.txt', { size: 10 });
			expect(ok.status).toBe(201);
			expect(ok.body.data.ownerId).toBe(ids.u1);
			// eigenes Kontingent von u3 unverändert
			expect((await api('u3', 'GET', '/meta')).body.data.quota.usedBytes).toBe(usedU3);
		} finally {
			await setSetting(admin, 'files.quota.mb', 0);
		}
		const meta = (await api('u3', 'GET', '/meta')).body.data;
		expect(meta.quota.limitBytes).toBeNull();
		const used = (await api('u1', 'GET', '/meta')).body.data.quota.usedBytes;
		expect(used).toBeGreaterThan(0);
	});
});

describe('Liste, Umbenennen, Verschieben', () => {
	let projekte: FileNode;
	let ziel: string;

	it('Liste: Ordner zuerst, dann Dateien, je nach Name; Breadcrumbs', async () => {
		const root = (await list('u1')).body.data as FolderListing;
		const kinds = root.items.map((i) => i.kind);
		const firstFile = kinds.indexOf('file');
		expect(firstFile).toBeGreaterThan(0);
		expect(kinds.slice(firstFile).every((k) => k === 'file')).toBe(true);
		const folders = root.items.filter((i) => i.kind === 'folder').map((i) => i.name);
		expect(folders).toEqual([...folders].sort((a, b) => a.localeCompare(b, 'de')));
		expect(root.breadcrumbs).toEqual([{ id: null, name: ROOT_LABEL }]);
		expect(root.access).toBe('edit');
		projekte = root.items.find((i) => i.name === 'Projekte')!;
		expect(projekte.childCount).toBe(1);
		const inner = (await list('u1', projekte.id)).body.data as FolderListing;
		expect(inner.breadcrumbs).toEqual([
			{ id: null, name: ROOT_LABEL },
			{ id: projekte.id, name: 'Projekte' }
		]);
		expect(inner.folder?.id).toBe(projekte.id);
	});

	it('Umbenennen: ok, nur Groß/Klein ok, Konflikt 409, ungültig 422', async () => {
		const a = await folder('u1', projekte.id, 'Alt');
		const b = await folder('u1', projekte.id, 'Belegt');
		const r = await api('u1', 'PATCH', `/nodes/${a.body.data.id}`, { name: 'Neu' });
		expect(r.status).toBe(200);
		expect(r.body.data.name).toBe('Neu');
		const cs = await api('u1', 'PATCH', `/nodes/${a.body.data.id}`, { name: 'NEU' });
		expect(cs.status).toBe(200);
		expect(cs.body.data.name).toBe('NEU');
		const c = await api('u1', 'PATCH', `/nodes/${a.body.data.id}`, { name: 'belegt' });
		expect(c.status).toBe(409);
		expect(c.body.error.code).toBe('conflict');
		expect(c.body.error.message).toContain('Vorschlag: „belegt (2)“');
		const bad = await api('u1', 'PATCH', `/nodes/${b.body.data.id}`, { name: 'x/y' });
		expect(bad.status).toBe(422);
		expect(bad.body.error.code).toBe('validation_failed');
	});

	it('Verschieben: mehrere, in sich selbst 422, Namenskonflikt → automatisch umbenannt', async () => {
		ziel = (await folder('u1', null, 'Ziel')).body.data.id;
		await folder('u1', ziel, 'Doppelt');
		const d = await folder('u1', null, 'Doppelt');
		const f = await upload('u1', 'root', 'mitnehmen.txt');
		const mv = await api('u1', 'POST', '/nodes/move', {
			ids: [d.body.data.id, f.body.data.id],
			targetId: ziel
		});
		expect(mv.status).toBe(201);
		expect(mv.body.data.affected).toBe(2);
		const inner = (await list('u1', ziel)).body.data as FolderListing;
		expect(names(inner)).toEqual(['Doppelt', 'Doppelt (2)', 'mitnehmen.txt']);

		const self = await api('u1', 'POST', '/nodes/move', {
			ids: [ziel],
			targetId: ziel
		});
		expect(self.status).toBe(422);
		expect(self.body.error.code).toBe('validation_failed');
		const child = inner.items[0]!.id;
		const intoChild = await api('u1', 'POST', '/nodes/move', {
			ids: [ziel],
			targetId: child
		});
		expect(intoChild.status).toBe(422);
		expect(intoChild.body.error.code).toBe('validation_failed');
	});

	it('An den Stamm freigeben: erscheint in fremder Wurzel (stamm), Lesen hindert Verschieben', async () => {
		// `space` gibt es nicht mehr (strikte Eingabe)
		const sp = await api('u1', 'POST', '/nodes/move', {
			ids: [ziel],
			targetId: null,
			space: 'shared'
		});
		expect(sp.status).toBe(422);
		const sh = await api('u1', 'PUT', `/nodes/${ziel}/shares`, {
			shares: [{ type: 'everyone', id: '*', level: 'read' }]
		});
		expect(sh.status).toBe(200);
		const node = (await api('u1', 'GET', `/nodes/${ziel}`)).body.data as FileNode;
		expect(node).toMatchObject({ own: true, stamm: true, shared: true });
		const root2 = (await list('u2')).body.data as FolderListing;
		const seen = root2.items.find((i) => i.id === ziel)!;
		expect(seen).toMatchObject({ own: false, stamm: true, access: 'read', canShare: false });
		expect(seen.owner).toEqual({ id: ids.u1, name: 'U1' });
		const inner = (await list('u2', ziel)).body.data as FolderListing;
		expect(inner.breadcrumbs[0]).toEqual({ id: null, name: ROOT_LABEL });
		expect(inner.access).toBe('read');
		expect(inner.items.every((i) => i.stamm && i.access === 'read')).toBe(true);
		// Stamm-Leser darf nicht hinein verschieben
		const own = await folder('u2', null, 'Eigenes');
		const no = await api('u2', 'POST', '/nodes/move', {
			ids: [own.body.data.id],
			targetId: ziel
		});
		expect(no.status).toBe(403);
		expect(no.body.error.code).toBe('forbidden');
		expect((await api('u1', 'PUT', `/nodes/${ziel}/shares`, { shares: [] })).status).toBe(200);
	});
});

describe('Suche', () => {
	it('findet Treffer, behandelt % und _ wörtlich, ignoriert Gelöschte', async () => {
		for (const n of ['100% Spaß', '1000 Spaß', 'a_b Liste', 'axb Liste', 'Weg Liste']) {
			expect((await folder('u3', null, n)).status).toBe(201);
		}
		const s = await api('u3', 'GET', '/search?q=liste');
		expect(s.status).toBe(200);
		expect(
			s.body.data.items
				.map((i: FileNode) => i.name)
				.sort((a: string, b: string) => a.localeCompare(b, 'de'))
		).toEqual(['a_b Liste', 'axb Liste', 'Weg Liste']);
		expect(s.body.data.items[0].path).toBe(ROOT_LABEL);
		const pct = await api('u3', 'GET', `/search?q=${encodeURIComponent('0%')}`);
		expect(pct.body.data.items.map((i: FileNode) => i.name)).toEqual(['100% Spaß']);
		const und = await api('u3', 'GET', '/search?q=a_b');
		expect(und.body.data.items.map((i: FileNode) => i.name)).toEqual(['a_b Liste']);

		const weg = s.body.data.items.find((i: FileNode) => i.name === 'Weg Liste');
		expect((await api('u3', 'POST', '/nodes/trash', { ids: [weg.id] })).status).toBe(201);
		const after = await api('u3', 'GET', '/search?q=liste');
		expect(after.body.data.items.map((i: FileNode) => i.name)).not.toContain('Weg Liste');

		// fremde Ablage taucht nicht auf
		const other = await api('u1', 'GET', '/search?q=liste');
		expect(other.body.data.items).toEqual([]);
		const short = await api('u3', 'GET', '/search?q=a');
		expect(short.status).toBe(422);
	});
});

describe('Papierkorb', () => {
	it('in den Papierkorb, Liste mit purgeOn, Wiederherstellen am Ort', async () => {
		const f = await upload('u3', 'root', 'papier.txt');
		const id = f.body.data.id;
		const t = await api('u3', 'POST', '/nodes/trash', { ids: [id] });
		expect(t.status).toBe(201);
		expect(t.body.data.affected).toBe(1);
		expect((await api('u3', 'GET', `/nodes/${id}`)).status).toBe(404);
		const root = (await list('u3')).body.data as FolderListing;
		expect(names(root)).not.toContain('papier.txt');

		const tr = await api('u3', 'GET', '/trash');
		expect(tr.status).toBe(200);
		const item = (tr.body.data as TrashItem[]).find((i) => i.id === id)!;
		expect(item).toMatchObject({ kind: 'file', name: 'papier.txt', originalPath: ROOT_LABEL });
		// Kalendertag in Europe/Berlin (#32)
		const expected = todayBerlin(new Date(new Date(item.deletedAt).getTime() + 30 * 86_400_000));
		expect(item.purgeOn).toBe(expected);
		// fremde sehen den Eintrag nicht
		const foreign = (await api('u1', 'GET', '/trash')).body.data as TrashItem[];
		expect(foreign.some((i) => i.id === id)).toBe(false);
		expect((await api('u1', 'POST', '/trash/restore', { ids: [id] })).status).toBe(404);

		const r = await api('u3', 'POST', '/trash/restore', { ids: [id] });
		expect(r.status).toBe(201);
		expect(r.body.data.affected).toBe(1);
		const back = (await api('u3', 'GET', `/nodes/${id}`)).body.data as FileNode;
		expect(back.parentId).toBeNull();
		expect(back.name).toBe('papier.txt');
	});

	it('Wiederherstellen: Elternordner weg → Wurzel, Namenskonflikt → umbenannt', async () => {
		const box = (await folder('u3', null, 'Kiste')).body.data.id;
		const f = await upload('u3', box, 'inhalt.txt');
		const id = f.body.data.id;
		await api('u3', 'POST', '/nodes/trash', { ids: [id] });
		await api('u3', 'POST', '/nodes/trash', { ids: [box] });
		// gleicher Name inzwischen an der Wurzel
		expect((await upload('u3', 'root', 'inhalt.txt')).status).toBe(201);
		const r = await api('u3', 'POST', '/trash/restore', { ids: [id] });
		expect(r.status).toBe(201);
		const back = (await api('u3', 'GET', `/nodes/${id}`)).body.data as FileNode;
		expect(back.parentId).toBeNull();
		expect(back.name).toBe('inhalt (2).txt');
		// Kiste bleibt im Papierkorb
		const tr = (await api('u3', 'GET', '/trash')).body.data as TrashItem[];
		expect(tr.some((i) => i.id === box)).toBe(true);
	});

	it('nur Papierkorb-Wurzeln wiederherstellbar/löschbar (sonst 404)', async () => {
		const f = await upload('u3', 'root', 'aktiv.txt');
		const r = await api('u3', 'POST', '/trash/purge', { ids: [f.body.data.id] });
		expect(r.status).toBe(404);
		expect(r.body.error.code).toBe('not_found');
		expect((await api('u3', 'GET', `/nodes/${f.body.data.id}`)).status).toBe(200);
	});

	it('endgültig löschen entfernt Knoten und Storage-Objekte (inkl. Teilbaum)', async () => {
		const box = (await folder('u3', null, 'Endgültig')).body.data.id;
		const a = await upload('u3', box, 'a.png', { type: 'image/png', bytes: await pngBytes() });
		const b = await upload('u3', box, 'b.txt');
		expect(objectsOf(a.body.data.id).length).toBe(2);
		expect(objectsOf(b.body.data.id).length).toBe(1);
		await api('u3', 'POST', '/nodes/trash', { ids: [box] });
		const before = (await api('u3', 'GET', '/meta')).body.data.quota.usedBytes;
		const p = await api('u3', 'POST', '/trash/purge', { ids: [box] });
		expect(p.status).toBe(201);
		expect(p.body.data.affected).toBe(1);
		expect(objectsOf(a.body.data.id)).toEqual([]);
		expect(objectsOf(b.body.data.id)).toEqual([]);
		const tr = (await api('u3', 'GET', '/trash')).body.data as TrashItem[];
		expect(tr.some((i) => i.id === box)).toBe(false);
		const after = (await api('u3', 'GET', '/meta')).body.data.quota.usedBytes;
		expect(after).toBeLessThan(before);
		expect((await api('u3', 'POST', '/trash/restore', { ids: [box] })).status).toBe(404);
	});

	it('Job files.purge-trash löscht nur abgelaufene Einträge', async () => {
		const old = await upload('u3', 'root', 'alt.txt');
		const fresh = await upload('u3', 'root', 'frisch.txt');
		await api('u3', 'POST', '/nodes/trash', { ids: [old.body.data.id, fresh.body.data.id] });
		const oldId = old.body.data.id as string;
		await core.database.forModule('files').transaction(async (tx) => {
			await tx.execute(
				sql`UPDATE nodes SET deleted_at = now() - interval '31 days' WHERE id = ${oldId}`
			);
		});
		await runJobNow(admin, 'files.purge-trash');
		const tr = (await api('u3', 'GET', '/trash')).body.data as TrashItem[];
		expect(tr.some((i) => i.id === oldId)).toBe(false);
		expect(tr.some((i) => i.id === fresh.body.data.id)).toBe(true);
		expect(objectsOf(oldId)).toEqual([]);
		expect(objectsOf(fresh.body.data.id).length).toBe(1);
		const rows = await core.database
			.forModule('files')
			.transaction(
				async (tx) => (await tx.execute(sql`SELECT id FROM nodes WHERE id = ${oldId}`)).rows
			);
		expect(rows).toEqual([]);
	});
});

describe('Zugriff', () => {
	let privateFolder: string;
	let sharedFolder: string;

	beforeAll(async () => {
		privateFolder = (await folder('u1', null, 'Privat')).body.data.id;
		sharedFolder = (await folder('u1', null, 'Stamm Ordner')).body.data.id;
		await upload('u1', sharedFolder, 'liesmich.txt');
		const sh = await api('u1', 'PUT', `/nodes/${sharedFolder}/shares`, {
			shares: [{ type: 'everyone', id: '*', level: 'read' }]
		});
		expect(sh.status).toBe(200);
	});

	it('fremde Ablage → 404 (auch Liste, Inhalt, Umbenennen, Upload)', async () => {
		for (const who of ['u2', 'u3']) {
			expect((await api(who, 'GET', `/nodes/${privateFolder}`)).status).toBe(404);
			const l = await list(who, privateFolder);
			expect(l.status).toBe(404);
			expect(l.body.error.code).toBe('not_found');
			const r = await api(who, 'PATCH', `/nodes/${privateFolder}`, { name: 'x' });
			expect(r.status).toBe(404);
			const up = await upload(who, privateFolder, 'x.txt');
			expect(up.status).toBe(404);
			// privater Ordner taucht nicht in der fremden Wurzel auf
			const root = (await list(who)).body.data as FolderListing;
			expect(root.items.some((i) => i.id === privateFolder)).toBe(false);
		}
		// ?owner= ohne manage-all → 404, mit manage-all → Wurzel der Person
		const o = await api('u3', 'GET', `/nodes?owner=${ids.u1}`);
		expect(o.status).toBe(404);
		const a = await api('admin', 'GET', `/nodes?owner=${ids.u1}`);
		expect(a.status).toBe(200);
		expect(names(a.body.data)).toContain('Privat');
	});

	it('An den Stamm (everyone:*) freigegeben: alle sehen es in ihrer Wurzel, auch ohne Rolle', async () => {
		for (const who of ['u2', 'u3']) {
			const root = (await list(who)).body.data as FolderListing;
			expect(root.breadcrumbs).toEqual([{ id: null, name: ROOT_LABEL }]);
			const item = root.items.find((i) => i.id === sharedFolder)!;
			expect(item).toMatchObject({ name: 'Stamm Ordner', stamm: true, own: false, access: 'read' });
			expect((await api(who, 'GET', `/nodes/${sharedFolder}`)).status).toBe(200);
		}
		// Ohne Modulrecht weiterhin 403
		expect((await list('u4')).status).toBe(403);
	});

	it('Stamm-Freigabe read: nur lesen (Liste/Inhalt ok, Upload/Anlegen/Umbenennen/Löschen 403)', async () => {
		const l = await list('u2', sharedFolder);
		expect(l.status).toBe(200);
		expect(l.body.data.access).toBe('read');
		const file = (l.body.data as FolderListing).items.find((i) => i.name === 'liesmich.txt')!;
		expect(file.access).toBe('read');
		expect(file.stamm).toBe(true);
		expect((await send('u2', 'GET', `/nodes/${file.id}/content`)).status).toBe(200);

		const up = await upload('u2', sharedFolder, 'neu.txt');
		expect(up.status).toBe(403);
		expect(up.body.error.code).toBe('forbidden');
		// `root` ist immer die eigene Wurzel
		const upRoot = await upload('u2', 'root', 'neu.txt');
		expect(upRoot.status).toBe(201);
		expect(upRoot.body.data.ownerId).toBe(ids.u2);
		expect((await folder('u2', sharedFolder, 'Neu')).status).toBe(403);
		expect((await api('u2', 'PATCH', `/nodes/${file.id}`, { name: 'x.txt' })).status).toBe(403);
		const t = await api('u2', 'POST', '/nodes/trash', { ids: [file.id] });
		expect(t.status).toBe(403);
		expect(t.body.error.code).toBe('forbidden');
		// Freigaben/Links verwalten nur die Eigentümer*in
		const fs = await api('u2', 'PUT', `/nodes/${sharedFolder}/shares`, { shares: [] });
		expect(fs.status).toBe(403);
	});
});

describe('Audit', () => {
	it('Einträge vorhanden, ohne Dateinamen und E-Mail-Adressen', async () => {
		const rows = await getDb()
			.select({ action: schema.auditLog.action, metadata: schema.auditLog.metadata })
			.from(schema.auditLog)
			.where(like(schema.auditLog.action, 'files.%'));
		const actions = new Set(rows.map((r) => r.action));
		for (const a of [
			'files.node.created',
			'files.node.uploaded',
			'files.node.renamed',
			'files.node.moved',
			'files.node.trashed',
			'files.node.restored',
			'files.node.purged'
		]) {
			expect(actions, a).toContain(a);
		}
		const meta = JSON.stringify(rows.map((r) => r.metadata));
		for (const secret of [
			'Notiz',
			'papier.txt',
			'inhalt',
			'Projekte',
			'Privat',
			'liesmich',
			'Spaß',
			'@example.test'
		]) {
			expect(meta, secret).not.toContain(secret);
		}
		// Job-Lauf protokolliert
		expect(rows.some((r) => JSON.stringify(r.metadata).includes('"expired":true'))).toBe(true);
	});
});

describe('Modul deaktiviert', () => {
	it('→ 404 module_disabled', async () => {
		await disableModule(admin, 'files');
		const r = await api('u1', 'GET', '/meta');
		expect(r.status).toBe(404);
		expect(r.body.error.code).toBe('module_disabled');
		const up = await upload('u1', 'root', 'spaet.txt');
		expect(up.status).toBe(404);
		expect(up.body.error.code).toBe('module_disabled');
	});
});
