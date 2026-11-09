/**
 * Modul `files` – Link-Arten (`view` / `upload` / `view-upload`), wieder abrufbare Link-URL und
 * öffentlicher Upload (`POST /public/links/:token/upload`, Multipart, ohne Login).
 * Storage über `tests/helpers/fake-storage.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { fakeObjects, installFakeStorage, uninstallFakeStorage } from '$testing';
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
import { setSetting } from '$testing';
import { listAudit } from '$testing';
import filesModule from '$modules/files/module';
import {
	MAX_PUBLIC_UPLOAD_FILES,
	type FileNode,
	type FolderListing,
	type PublicLinkInfo,
	type PublicUploadResult,
	type ShareLink
} from '$modules/files/schemas';
import type { RequestContext } from '$lib/sdk/types';

const ROOT = 'http://localhost:5173/api/v1/modules/files';
const PW = 'a-long-enough-pw';
const keys: Record<string, string> = {};
const ids: Record<string, string> = {};
let close: () => Promise<void>;
let admin: RequestContext;

const ctxOf = async (id: string) => (await contextForUser(id))!.ctx;

interface Res {
	status: number;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	body: any;
}

async function send(
	who: string | null,
	method: string,
	path: string,
	init: { headers?: Record<string, string>; body?: BodyInit } = {}
): Promise<Res> {
	resetAllForTests();
	const headers = new Headers(init.headers ?? {});
	if (who) headers.set('authorization', `Bearer ${keys[who]}`);
	const url = new URL(ROOT + path);
	const res = await handleApiRequest({
		request: new Request(url, { method, headers, body: init.body }),
		url,
		ip: '127.0.0.1'
	});
	const text = await res.text();
	let body: unknown = text;
	try {
		body = JSON.parse(text);
	} catch {
		/* Rohinhalt (Datei) */
	}
	return { status: res.status, body };
}

const call = (who: string | null, method: string, path: string, json?: unknown) =>
	send(
		who,
		method,
		path,
		json === undefined
			? {}
			: { headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) }
	);

function ok<T>(res: Res, status = 200): T {
	expect(res.status, JSON.stringify(res.body)).toBe(status);
	return res.body.data as T;
}

function fail(res: Res, status: number, code?: string) {
	expect(res.status, JSON.stringify(res.body)).toBe(status);
	if (code) expect(res.body.error?.code).toBe(code);
}

interface PubFile {
	name: string;
	size?: number;
	text?: string;
	type?: string;
}

/** Öffentlicher Upload: Formular vorab serialisieren (Router verlangt Content-Length) */
async function pubUpload(token: string, files: PubFile[], fields: Record<string, string> = {}) {
	const form = new FormData();
	for (const [k, v] of Object.entries(fields)) form.set(k, v);
	for (const f of files) {
		const bytes =
			f.text !== undefined
				? new TextEncoder().encode(f.text)
				: new Uint8Array(f.size ?? 10).fill(65);
		form.append('file', new File([bytes as BlobPart], f.name, { type: f.type ?? 'text/plain' }));
	}
	const r = new Response(form);
	const buf = new Uint8Array(await r.arrayBuffer());
	return send(null, 'POST', `/public/links/${token}/upload`, {
		headers: {
			'content-type': r.headers.get('content-type')!,
			'content-length': String(buf.byteLength)
		},
		body: buf
	});
}

/** Interner Upload (für Vorbelegung) */
async function upload(who: string, parent: string, name: string, text: string) {
	const form = new FormData();
	form.set(
		'file',
		new File([new TextEncoder().encode(text) as BlobPart], name, { type: 'text/plain' })
	);
	const r = new Response(form);
	const buf = new Uint8Array(await r.arrayBuffer());
	return send(who, 'POST', `/nodes/${parent}/upload`, {
		headers: {
			'content-type': r.headers.get('content-type')!,
			'content-length': String(buf.byteLength)
		},
		body: buf
	});
}

const folder = async (who: string, name: string, parentId: string | null = null) =>
	ok<FileNode>(await call(who, 'POST', '/folders', { parentId, name }), 201).id;

const link = (
	who: string,
	nodeId: string,
	mode?: string,
	password: string | null = null
): Promise<Res> =>
	call(who, 'POST', `/nodes/${nodeId}/links`, {
		expiresOn: null,
		password,
		...(mode ? { mode } : {})
	});

const tokenOf = (l: ShareLink) => String(l.url).split('/').pop()!;

async function q(query: ReturnType<typeof sql>) {
	return (await getDb().execute(query)).rows as Record<string, unknown>[];
}

const childrenOf = (parentId: string) =>
	q(
		sql`SELECT id, name, owner_id, created_by, uploaded_by_name, uploaded_via_link, size_bytes
			FROM mod_files.nodes WHERE parent_id = ${parentId} AND deleted_at IS NULL ORDER BY name`
	);

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
	admin = await ctxOf(u!.id);
	await enableModule(admin, 'files');
	admin = await ctxOf(u!.id);
	await installFakeStorage(admin);
	const role = await createRole(admin, {
		name: 'Nutzer',
		permissions: ['files.file.view', 'files.link.create', 'core.api.manage']
	});
	for (const n of ['owner', 'other']) {
		ids[n] = await createUser(admin, {
			name: n === 'owner' ? 'Olivia Owner' : 'Otto Other',
			email: `${n}@example.test`,
			password: PW,
			roleIds: [role]
		});
		const c = await ctxOf(ids[n]!);
		keys[n] = (await createApiKey(c, { name: 'k', scopes: [...c.permissions] })).key;
	}
});

afterAll(async () => {
	uninstallFakeStorage();
	await close?.();
});

// ---------------------------------------------------------------------------
// Link-Arten und URL
// ---------------------------------------------------------------------------

describe('Link-Arten und wieder abrufbare URL', () => {
	let box: string;
	let file: string;

	beforeAll(async () => {
		box = await folder('owner', 'Link-Arten');
		file = ok<FileNode>(await upload('owner', box, 'datei.txt', 'Inhalt'), 201).id;
	});

	it('Standard `view`; `upload`/`view-upload` für Ordner, nicht für Dateien (422)', async () => {
		expect(ok<ShareLink>(await link('owner', box), 201).mode).toBe('view');
		expect(ok<ShareLink>(await link('owner', box, 'upload'), 201).mode).toBe('upload');
		expect(ok<ShareLink>(await link('owner', box, 'view-upload'), 201).mode).toBe('view-upload');
		fail(await link('owner', file, 'upload'), 422, 'validation_failed');
		fail(await link('owner', file, 'view-upload'), 422, 'validation_failed');
		expect(ok<ShareLink>(await link('owner', file, 'view'), 201).mode).toBe('view');
		fail(await link('owner', box, 'edit'), 422, 'validation_failed');
	});

	it('`GET /nodes/:id/links` liefert die URL mehrfach (gleich), sie funktioniert', async () => {
		const created = ok<ShareLink>(await link('owner', box, 'view'), 201);
		expect(created.url).toMatch(/\/p\/files\/link\/[A-Za-z0-9_-]{20,}$/);
		const a = ok<ShareLink[]>(await call('owner', 'GET', `/nodes/${box}/links`));
		const b = ok<ShareLink[]>(await call('owner', 'GET', `/nodes/${box}/links`));
		const fromA = a.find((l) => l.id === created.id)!;
		const fromB = b.find((l) => l.id === created.id)!;
		expect(fromA.url).toBe(created.url);
		expect(fromB.url).toBe(created.url);
		expect(a.every((l) => typeof l.url === 'string' && l.url.length > 0)).toBe(true);
		const t = tokenOf(fromB);
		const info = ok<PublicLinkInfo>(await call(null, 'GET', `/public/links/${t}`));
		expect(info).toMatchObject({ name: 'Link-Arten', kind: 'folder', mode: 'view', upload: null });
		const list = ok<{ items: { name: string }[] }>(
			await call(null, 'GET', `/public/links/${t}/nodes`)
		);
		expect(list.items.map((i) => i.name)).toEqual(['datei.txt']);
		// Token nicht im Klartext gespeichert
		const rows = await q(sql`SELECT * FROM mod_files.share_links WHERE id = ${created.id}`);
		expect(JSON.stringify(rows)).not.toContain(t);
	});

	it('alte Links ohne `token_enc` → `url: null`, funktionieren aber weiter', async () => {
		const old = ok<ShareLink>(await link('owner', box), 201);
		await q(sql`UPDATE mod_files.share_links SET token_enc = NULL WHERE id = ${old.id}`);
		const list = ok<ShareLink[]>(await call('owner', 'GET', `/nodes/${box}/links`));
		expect(list.find((l) => l.id === old.id)!.url).toBeNull();
		ok(await call(null, 'GET', `/public/links/${tokenOf(old)}`));
		// widerrufen liefert ebenfalls `url: null`
		const rev = ok<ShareLink>(await call('owner', 'DELETE', `/links/${old.id}`));
		expect(rev.url).toBeNull();
		expect(rev.active).toBe(false);
	});

	it('Fremde sehen keine Links (404)', async () => {
		fail(await call('other', 'GET', `/nodes/${box}/links`), 404);
		fail(await link('other', box, 'upload'), 404);
	});
});

// ---------------------------------------------------------------------------
// Öffentlicher Upload
// ---------------------------------------------------------------------------

describe('Öffentlicher Upload', () => {
	let box: string;
	let sub: string;
	let viewLink: ShareLink;
	let upLink: ShareLink;
	let vuLink: ShareLink;
	let existing: string;

	beforeAll(async () => {
		box = await folder('owner', 'Eingang');
		sub = await folder('owner', 'Unterordner', box);
		existing = ok<FileNode>(await upload('owner', box, 'bericht.txt', 'Original'), 201).id;
		viewLink = ok<ShareLink>(await link('owner', box, 'view'), 201);
		upLink = ok<ShareLink>(await link('owner', box, 'upload'), 201);
		vuLink = ok<ShareLink>(await link('owner', box, 'view-upload'), 201);
	});

	it('`upload`-Link: Info mit Grenzen ohne `node`, Inhalt verborgen (`nodes`/`content` 403)', async () => {
		const t = tokenOf(upLink);
		const info = ok<PublicLinkInfo>(await call(null, 'GET', `/public/links/${t}`));
		expect(info).toMatchObject({
			name: 'Eingang',
			kind: 'folder',
			mode: 'upload',
			needsPassword: false,
			node: null
		});
		expect(info.upload).toMatchObject({ maxFiles: MAX_PUBLIC_UPLOAD_FILES });
		expect(info.upload!.maxFileBytes).toBeGreaterThan(0);
		expect(info.upload!.allowedContentTypes).toContain('text/plain');
		expect(JSON.stringify(info)).not.toContain('bericht.txt');
		fail(await call(null, 'GET', `/public/links/${t}/nodes`), 403, 'forbidden');
		fail(await call(null, 'GET', `/public/links/${t}/nodes?parent=${sub}`), 403);
		fail(await call(null, 'GET', `/public/links/${t}/content/${existing}`), 403, 'forbidden');
		const vInfo = ok<PublicLinkInfo>(await call(null, 'GET', `/public/links/${tokenOf(vuLink)}`));
		expect(vInfo.mode).toBe('view-upload');
		expect(vInfo.upload).not.toBeNull();
	});

	it('mehrere Dateien, Name bereinigt (U+202E raus), Eigentum der Ordner-Eigentümer*in', async () => {
		const rlo = String.fromCodePoint(0x202e);
		const res = ok<PublicUploadResult>(
			await pubUpload(
				tokenOf(upLink),
				[
					{ name: 'foto-a.txt', size: 12 },
					{ name: 'foto-b.txt', size: 8 }
				],
				{ name: `  Max ${rlo}Muster\u0007  ` }
			),
			201
		);
		expect(res.uploaded).toEqual([
			{ name: 'foto-a.txt', sizeBytes: 12 },
			{ name: 'foto-b.txt', sizeBytes: 8 }
		]);
		// Antwort ohne IDs/Eigentümer
		expect(JSON.stringify(res)).not.toContain(ids.owner!);
		const rows = (await childrenOf(box)).filter((r) => String(r.name).startsWith('foto-'));
		expect(rows).toHaveLength(2);
		for (const r of rows) {
			expect(r.owner_id).toBe(ids.owner);
			expect(r.created_by).toBeNull();
			expect(r.uploaded_via_link).toBe(upLink.id);
			expect(String(r.uploaded_by_name)).not.toContain(rlo);
			expect(r.uploaded_by_name).toBe('Max Muster');
		}
		// FileNode zeigt Name + viaLink, `createdBy` leer
		const node = ok<FileNode>(await call('owner', 'GET', `/nodes/${rows[0]!.id}`));
		expect(node).toMatchObject({
			uploadedByName: 'Max Muster',
			viaLink: true,
			createdBy: null,
			ownerId: ids.owner,
			own: true
		});
		const listing = ok<FolderListing>(await call('owner', 'GET', `/nodes?parent=${box}`));
		expect(listing.items.find((i) => i.name === 'foto-a.txt')?.viaLink).toBe(true);
		expect(listing.items.find((i) => i.name === 'bericht.txt')?.viaLink).toBe(false);
	});

	it('Name optional: ohne Name → `uploadedByName` null, `viaLink` true; zu lang → 422', async () => {
		const res = ok<PublicUploadResult>(
			await pubUpload(tokenOf(vuLink), [{ name: 'anonym.txt' }]),
			201
		);
		expect(res.uploaded.map((u) => u.name)).toEqual(['anonym.txt']);
		const row = (await childrenOf(box)).find((r) => r.name === 'anonym.txt')!;
		const node = ok<FileNode>(await call('owner', 'GET', `/nodes/${row.id}`));
		expect(node.uploadedByName).toBeNull();
		expect(node.viaLink).toBe(true);
		// nur Leer-/Steuerzeichen → wie ohne Name
		ok(await pubUpload(tokenOf(vuLink), [{ name: 'leer.txt' }], { name: '   ' }), 201);
		const leer = (await childrenOf(box)).find((r) => r.name === 'leer.txt')!;
		expect(leer.uploaded_by_name).toBeNull();
		fail(
			await pubUpload(tokenOf(vuLink), [{ name: 'lang.txt' }], { name: 'x'.repeat(101) }),
			422,
			'validation_failed'
		);
	});

	it('Namenskonflikt → „(2)“, vorhandene Datei wird nie überschrieben', async () => {
		const res = ok<PublicUploadResult>(
			await pubUpload(tokenOf(upLink), [
				{ name: 'bericht.txt', text: 'Fremd' },
				{ name: 'BERICHT.txt', text: 'Fremd 2' }
			]),
			201
		);
		// Link-Art `upload`: Antwort nennt die angefragten Namen (kein Namens-Orakel über vorhandene Dateien)
		expect(res.uploaded.map((u) => u.name)).toEqual(['bericht.txt', 'BERICHT.txt']);
		const stored = (await childrenOf(box)).map((r) => String(r.name));
		expect(stored).toContain('bericht (2).txt');
		expect(stored).toContain('BERICHT (3).txt');
		expect(stored.filter((n) => n === 'bericht.txt')).toHaveLength(1);
		const orig = await send('owner', 'GET', `/nodes/${existing}/content`);
		expect(orig.status).toBe(200);
		expect(orig.body).toBe('Original');
		// `conflict=replace` gibt es öffentlich nicht (strikte Felder → 422)
		fail(
			await pubUpload(tokenOf(upLink), [{ name: 'bericht.txt' }], { conflict: 'replace' }),
			422,
			'validation_failed'
		);
		expect((await send('owner', 'GET', `/nodes/${existing}/content`)).body).toBe('Original');
	});

	it('Upload landet nur im Link-Ordner (kein Unterordner, Pfadtrenner im Namen bereinigt)', async () => {
		ok(await pubUpload(tokenOf(upLink), [{ name: 'x.txt' }], {}), 201);
		const inSub = await childrenOf(sub);
		expect(inSub).toEqual([]);
		// `relativePath` gibt es öffentlich nicht
		fail(
			await pubUpload(tokenOf(upLink), [{ name: 'y.txt' }], { relativePath: 'Unterordner/y.txt' }),
			422
		);
	});

	it('`view`-Link → Upload 403; `view-upload` sieht hochgeladene Dateien', async () => {
		fail(await pubUpload(tokenOf(viewLink), [{ name: 'nein.txt' }]), 403, 'forbidden');
		expect((await childrenOf(box)).some((r) => r.name === 'nein.txt')).toBe(false);
		const list = ok<{ items: { name: string }[] }>(
			await call(null, 'GET', `/public/links/${tokenOf(vuLink)}/nodes`)
		);
		expect(list.items.map((i) => i.name)).toContain('foto-a.txt');
	});

	it('Datei-Anzahl: ohne Datei 422, mehr als MAX_PUBLIC_UPLOAD_FILES → abgelehnt', async () => {
		fail(await pubUpload(tokenOf(upLink), []), 422, 'validation_failed');
		const many = Array.from({ length: MAX_PUBLIC_UPLOAD_FILES + 1 }, (_, i) => ({
			name: `viele-${i}.txt`
		}));
		const r = await pubUpload(tokenOf(upLink), many);
		// Der Core-Router lehnt mehr als `multipart.maxFiles` schon beim Parsen mit 400 ab
		expect(r.status).toBe(400);
		expect((await childrenOf(box)).some((x) => String(x.name).startsWith('viele-'))).toBe(false);
		// genau MAX ist erlaubt
		const max = Array.from({ length: MAX_PUBLIC_UPLOAD_FILES }, (_, i) => ({
			name: `max-${i}.txt`,
			size: 1
		}));
		expect(
			ok<PublicUploadResult>(await pubUpload(tokenOf(upLink), max), 201).uploaded
		).toHaveLength(MAX_PUBLIC_UPLOAD_FILES);
	});

	it('nicht erlaubter Typ → 422, nichts gespeichert', async () => {
		const before = fakeObjects.size;
		fail(
			await pubUpload(tokenOf(upLink), [{ name: 'tool.exe', type: 'application/x-msdownload' }]),
			422,
			'validation_failed'
		);
		expect(fakeObjects.size).toBe(before);
	});

	it('Kontingent der Ordner-Eigentümer*in → 413, nichts gespeichert', async () => {
		await setSetting(admin, 'files.quota.mb', 1);
		try {
			const before = fakeObjects.size;
			const r = await pubUpload(tokenOf(upLink), [{ name: 'gross.txt', size: 1024 * 1024 }]);
			fail(r, 413, 'payload_too_large');
			expect(fakeObjects.size).toBe(before);
			expect((await childrenOf(box)).some((x) => x.name === 'gross.txt')).toBe(false);
			// Kontingent der anderen Person ist unerheblich (sie hat nichts): trotzdem 413
			const meta = ok<{ quota: { usedBytes: number } }>(await call('other', 'GET', '/meta'));
			expect(meta.quota.usedBytes).toBe(0);
		} finally {
			await setSetting(admin, 'files.quota.mb', 0);
		}
	});

	it('Passwort: ohne `t` 403, mit `t` 201', async () => {
		const pw = ok<ShareLink>(await link('owner', box, 'upload', 'geheim-123'), 201);
		const t = tokenOf(pw);
		expect(ok<PublicLinkInfo>(await call(null, 'GET', `/public/links/${t}`)).needsPassword).toBe(
			true
		);
		fail(await pubUpload(t, [{ name: 'p.txt' }]), 403, 'forbidden');
		fail(await pubUpload(t, [{ name: 'p.txt' }], { t: 'falsch.123.abc' }), 403, 'forbidden');
		const acc = ok<{ accessToken: string }>(
			await call(null, 'POST', `/public/links/${t}/unlock`, { password: 'geheim-123' }),
			201
		).accessToken;
		ok(await pubUpload(t, [{ name: 'p.txt' }], { t: acc }), 201);
		// `t` eines anderen Links gilt nicht
		const other = ok<ShareLink>(await link('owner', box, 'upload', 'anderes-pw-1'), 201);
		fail(await pubUpload(tokenOf(other), [{ name: 'q.txt' }], { t: acc }), 403);
	});

	it('widerrufen, abgelaufen, Ordner im Papierkorb, unbekannt → 404', async () => {
		const rev = ok<ShareLink>(await link('owner', box, 'upload'), 201);
		ok(await call('owner', 'DELETE', `/links/${rev.id}`));
		fail(await pubUpload(tokenOf(rev), [{ name: 'r.txt' }]), 404, 'not_found');

		const exp = ok<ShareLink>(await link('owner', box, 'view-upload'), 201);
		await q(
			sql`UPDATE mod_files.share_links SET expires_on = CURRENT_DATE - 1 WHERE id = ${exp.id}`
		);
		fail(await pubUpload(tokenOf(exp), [{ name: 'e.txt' }]), 404, 'not_found');

		fail(await pubUpload('x'.repeat(43), [{ name: 'u.txt' }]), 404, 'not_found');

		const tmp = await folder('owner', 'Bald weg');
		const tl = ok<ShareLink>(await link('owner', tmp, 'upload'), 201);
		ok(await pubUpload(tokenOf(tl), [{ name: 'vorher.txt' }]), 201);
		ok(await call('owner', 'POST', '/nodes/trash', { ids: [tmp] }), 201);
		fail(await pubUpload(tokenOf(tl), [{ name: 'nachher.txt' }]), 404, 'not_found');
		expect((await childrenOf(tmp)).some((x) => x.name === 'nachher.txt')).toBe(false);
	});

	it('Upload in einen Unterordner-Link gehört ebenfalls der Eigentümer*in', async () => {
		// `other` hat edit auf `box` → Ordner von `other` angelegt, gehört trotzdem `owner`
		ok(
			await call('owner', 'PUT', `/nodes/${box}/shares`, {
				shares: [{ type: 'user', id: ids.other, level: 'edit' }]
			})
		);
		const viaOther = await folder('other', 'Von Other', box);
		const l = ok<ShareLink>(await link('owner', viaOther, 'upload'), 201);
		ok(await pubUpload(tokenOf(l), [{ name: 'z.txt' }]), 201);
		const row = (await childrenOf(viaOther))[0]!;
		expect(row.owner_id).toBe(ids.owner);
	});

	it('Audit `files.link.uploaded` mit Anzahl/Bytes, ohne Namen und Dateinamen', async () => {
		const a = await listAudit({ action: 'files.link.uploaded' });
		const text = JSON.stringify(a);
		expect(text).toContain(upLink.id);
		expect(text).toContain('"count":2');
		for (const secret of ['Max', 'Muster', 'foto-a', 'bericht', 'anonym', tokenOf(upLink)]) {
			expect(text, secret).not.toContain(secret);
		}
	});
});
