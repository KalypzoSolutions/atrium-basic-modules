/**
 * Modul `files` – Freigaben an Principals (eine Ansicht: Freigegebenes erscheint in der Wurzel „Dateien“),
 * Sicherheitsregeln, öffentliche Links (Ansehen), Reset. Upload-Links: `files-upload-link.test.ts`.
 * Storage über `tests/helpers/fake-storage.ts`; Testbild mit sharp (für Thumbnails).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { useTestDatabase } from '$testing';
import { installFakeStorage, uninstallFakeStorage } from '$testing';
import { getDb, schema } from '$testing';
import { contextForUser, systemContext } from '$testing';
import { bootstrapAdmin, createUser } from '$testing';
import { createRole } from '$testing';
import { registerModule } from '$testing';
import { enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { resetAllForTests } from '$testing';
import { listAudit } from '$testing';
import { core } from '$testing';
import { RESET_CONFIRM_WORD, executeReset, exportResetData, previewReset } from '$testing';
import filesModule from '$modules/files/module';
import { unlockLink } from '$modules/files/links.service';
import {
	MAX_LINKS_PER_NODE,
	MAX_UNLOCK_FAILURES,
	ROOT_LABEL,
	type FileNode,
	type FolderListing,
	type NodeShares,
	type ShareLink
} from '$modules/files/schemas';
import type { RequestContext } from '$lib/sdk/types';

const ROOT = 'http://localhost:5173/api/v1/modules/files';
const PW = 'a-long-enough-pw';
const keys: Record<string, string> = {};
const ids: Record<string, string> = {};
let close: () => Promise<void>;
let admin: RequestContext;
let adminId: string;
let teamRoleId: string;

interface Res {
	status: number;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	body: any;
}

const ctxOf = async (id: string) => (await contextForUser(id))!.ctx;

async function raw(
	who: string | null,
	method: string,
	path: string,
	body?: BodyInit,
	json = false
) {
	resetAllForTests();
	const headers = new Headers();
	if (who) headers.set('authorization', `Bearer ${keys[who]}`);
	if (json) headers.set('content-type', 'application/json');
	const url = new URL(ROOT + path);
	return handleApiRequest({
		request: new Request(url, { method, headers, body }),
		url,
		ip: '127.0.0.1'
	});
}

async function call(
	who: string | null,
	method: string,
	path: string,
	json?: unknown
): Promise<Res> {
	const res = await raw(
		who,
		method,
		path,
		json === undefined ? undefined : JSON.stringify(json),
		json !== undefined
	);
	const text = await res.text();
	let body: unknown = text;
	try {
		body = JSON.parse(text);
	} catch {
		/* Rohinhalt (Datei) */
	}
	return { status: res.status, body };
}

function ok<T>(res: Res, status = 200): T {
	expect(res.status, JSON.stringify(res.body)).toBe(status);
	return res.body.data as T;
}

function fail(res: Res, status: number, code?: string) {
	expect(res.status, JSON.stringify(res.body)).toBe(status);
	if (code) expect(res.body.error?.code).toBe(code);
}

const paths = (r: Res): string[] =>
	((r.body.error?.details ?? []) as { path?: unknown[] }[]).map((d) => (d.path ?? []).join('.'));

async function folder(who: string, name: string, parentId: string | null = null) {
	return ok<FileNode>(await call(who, 'POST', '/folders', { parentId, name }), 201).id;
}

async function upload(
	who: string,
	parentId: string,
	name: string,
	bytes: Uint8Array,
	type: string
) {
	const fd = new FormData();
	fd.set('file', new File([bytes as BlobPart], name, { type }));
	// Upload verlangt `content-length` → Formular vorab serialisieren
	const encoded = new Response(fd);
	const bytesOut = new Uint8Array(await encoded.arrayBuffer());
	resetAllForTests();
	const url = new URL(`${ROOT}/nodes/${parentId}/upload`);
	const res = await handleApiRequest({
		request: new Request(url, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${keys[who]}`,
				'content-type': encoded.headers.get('content-type')!,
				'content-length': String(bytesOut.byteLength)
			},
			body: bytesOut
		}),
		url,
		ip: '127.0.0.1'
	});
	return { status: res.status, body: await res.json() } as Res;
}

async function share(who: string, nodeId: string, shares: unknown[]) {
	return call(who, 'PUT', `/nodes/${nodeId}/shares`, { shares });
}

async function link(who: string, nodeId: string, password: string | null = null) {
	return call(who, 'POST', `/nodes/${nodeId}/links`, { expiresOn: null, password });
}

const tokenOf = (l: ShareLink) => String(l.url).split('/').pop()!;

async function q(query: ReturnType<typeof sql>) {
	return (await getDb().execute(query)).rows as Record<string, unknown>[];
}

const auditText = async (action: string) => JSON.stringify(await listAudit({ action }));

let pngBytes: Uint8Array;

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

	const base = await createRole(admin, {
		name: 'Nutzer',
		permissions: ['files.file.view', 'files.link.create', 'core.api.manage']
	});
	teamRoleId = await createRole(admin, { name: 'Team', permissions: ['files.file.view'] });
	const users: [string, string[]][] = [
		['owner', [base]],
		['reader', [base]],
		['editor', [base]],
		['team', [base, teamRoleId]],
		['stranger', [base]],
		['gone', [base]]
	];
	for (const [n, roles] of users) {
		ids[n] = await createUser(admin, {
			name: n === 'owner' ? 'Olivia Owner' : n.charAt(0).toUpperCase() + n.slice(1),
			email: `${n}@example.test`,
			password: PW,
			roleIds: roles
		});
		const c = await ctxOf(ids[n]!);
		keys[n] = (await createApiKey(c, { name: 'k', scopes: [...c.permissions] })).key;
	}
	pngBytes = new Uint8Array(
		await sharp({ create: { width: 64, height: 48, channels: 3, background: '#3366cc' } })
			.png()
			.toBuffer()
	);
});

afterAll(async () => {
	uninstallFakeStorage();
	await close?.();
});

// ---------------------------------------------------------------------------
// Zugriffsmatrix
// ---------------------------------------------------------------------------

describe('Zugriffsmatrix', () => {
	let projekt: string;
	let unter: string;
	let datei: string;

	beforeAll(async () => {
		projekt = await folder('owner', 'Projekt');
		unter = await folder('owner', 'Unter', projekt);
		datei = ok<FileNode>(
			await upload('owner', unter, 'notiz.txt', new TextEncoder().encode('Hallo'), 'text/plain'),
			201
		).id;
		ok(
			await share('owner', projekt, [
				{ type: 'user', id: ids.reader, level: 'read' },
				{ type: 'user', id: ids.editor, level: 'edit' }
			])
		);
	});

	it('Eigentümer*in edit, Freigabe read/edit, geerbt, fremd 404', async () => {
		expect(ok<FileNode>(await call('owner', 'GET', `/nodes/${projekt}`)).access).toBe('edit');
		expect(ok<FileNode>(await call('reader', 'GET', `/nodes/${projekt}`)).access).toBe('read');
		expect(ok<FileNode>(await call('editor', 'GET', `/nodes/${projekt}`)).access).toBe('edit');
		// geerbt über den Ordner
		expect(ok<FileNode>(await call('reader', 'GET', `/nodes/${unter}`)).access).toBe('read');
		expect(ok<FileNode>(await call('reader', 'GET', `/nodes/${datei}`)).access).toBe('read');
		expect(ok<FileNode>(await call('editor', 'GET', `/nodes/${datei}`)).access).toBe('edit');
		const content = await call('reader', 'GET', `/nodes/${datei}/content`);
		expect(content.status).toBe(200);
		expect(content.body).toBe('Hallo');
		// fremd → 404 (Knoten, Inhalt, Freigaben, Ordnerliste)
		for (const p of [
			`/nodes/${projekt}`,
			`/nodes/${unter}`,
			`/nodes/${datei}`,
			`/nodes/${datei}/content`,
			`/nodes/${projekt}/shares`,
			`/nodes?parent=${unter}`
		]) {
			fail(await call('stranger', 'GET', p), 404, 'not_found');
		}
	});

	it('read darf nicht hochladen/umbenennen/anlegen/löschen (403), edit schon', async () => {
		fail(
			await upload('reader', projekt, 'x.txt', new TextEncoder().encode('x'), 'text/plain'),
			403
		);
		fail(await call('reader', 'PATCH', `/nodes/${unter}`, { name: 'Neu' }), 403, 'forbidden');
		fail(
			await call('reader', 'POST', '/folders', { parentId: projekt, name: 'N' }),
			403,
			'forbidden'
		);
		fail(await call('reader', 'POST', '/nodes/trash', { ids: [datei] }), 403);
		// Fremde bekommen 404 statt 403
		fail(await call('stranger', 'PATCH', `/nodes/${unter}`, { name: 'Neu' }), 404);

		const up = ok<FileNode>(
			await upload(
				'editor',
				projekt,
				'von-editor.txt',
				new TextEncoder().encode('e'),
				'text/plain'
			),
			201
		);
		// Kinder gehören der Eigentümer*in des Ordners
		expect(up.ownerId).toBe(ids.owner);
		expect(
			ok<FileNode>(await call('editor', 'PATCH', `/nodes/${up.id}`, { name: 'e2.txt' })).name
		).toBe('e2.txt');
	});

	it('Stamm (everyone) und Rolle', async () => {
		const stamm = await folder('owner', 'Für alle');
		const team = await folder('owner', 'Nur Team');
		ok(await share('owner', stamm, [{ type: 'everyone', id: '*', level: 'read' }]));
		ok(await share('owner', team, [{ type: 'role', id: teamRoleId, level: 'edit' }]));

		expect(ok<FileNode>(await call('stranger', 'GET', `/nodes/${stamm}`)).access).toBe('read');
		expect(ok<FileNode>(await call('team', 'GET', `/nodes/${stamm}`)).access).toBe('read');
		expect(ok<FileNode>(await call('team', 'GET', `/nodes/${team}`)).access).toBe('edit');
		fail(await call('stranger', 'GET', `/nodes/${team}`), 404);
		fail(await call('reader', 'GET', `/nodes/${team}`), 404);
		const desc = ok<NodeShares>(await call('owner', 'GET', `/nodes/${stamm}/shares`));
		expect(desc.shares[0]).toMatchObject({
			type: 'everyone',
			id: '*',
			name: 'Stamm',
			level: 'read'
		});
	});

	it('Papierkorb-Knoten nicht erreichbar (404)', async () => {
		const tmp = await folder('owner', 'Bald weg', projekt);
		expect((await call('reader', 'GET', `/nodes/${tmp}`)).status).toBe(200);
		const t = await call('owner', 'POST', '/nodes/trash', { ids: [tmp] });
		expect(t.status, JSON.stringify(t.body)).toBeLessThan(300);
		fail(await call('reader', 'GET', `/nodes/${tmp}`), 404);
		fail(await call('editor', 'GET', `/nodes/${tmp}`), 404);
		fail(await call('owner', 'GET', `/nodes/${tmp}`), 404);
		fail(await call('owner', 'GET', `/nodes/${tmp}/shares`), 404);
	});

	it('Wurzel zeigt eigene + oberste freigegebene Knoten (kein /shared-with-me mehr)', async () => {
		fail(await call('reader', 'GET', '/shared-with-me'), 404);
		const root = ok<FolderListing>(await call('reader', 'GET', '/nodes'));
		expect(root.breadcrumbs).toEqual([{ id: null, name: ROOT_LABEL }]);
		const names = root.items.map((n) => n.name);
		expect(names).toContain('Projekt');
		expect(names).toContain('Für alle');
		expect(names).not.toContain('Unter');
		expect(names).not.toContain('notiz.txt');
		expect(names).not.toContain('Nur Team');
		const p = root.items.find((n) => n.id === projekt)!;
		expect(p).toMatchObject({ own: false, stamm: false, access: 'read', canShare: false });
		expect(p.owner).toEqual({ id: ids.owner, name: 'Olivia Owner' });
		expect(root.items.find((n) => n.name === 'Für alle')!.stamm).toBe(true);
		// Eigentümer*in sieht eigene Ordner genau einmal (als eigene)
		const own = ok<FolderListing>(await call('owner', 'GET', '/nodes'));
		const mine = own.items.filter((n) => n.id === projekt);
		expect(mine).toHaveLength(1);
		expect(mine[0]!.own).toBe(true);
		// Freigabe auf Kind UND Eltern → nur der Elternordner in der Wurzel
		ok(await share('owner', unter, [{ type: 'user', id: ids.reader, level: 'edit' }]));
		const again = ok<FolderListing>(await call('reader', 'GET', '/nodes'));
		expect(again.items.map((n) => n.name)).not.toContain('Unter');
		// höchste Stufe gewinnt: im Kind edit
		expect(ok<FileNode>(await call('reader', 'GET', `/nodes/${unter}`)).access).toBe('edit');
		ok(await share('owner', unter, []));
		// Suche findet Freigegebenes, nicht Fremdes
		const s = ok<{ items: (FileNode & { path: string })[] }>(
			await call('reader', 'GET', '/search?q=notiz')
		);
		expect(s.items.map((i) => i.path)).toEqual([`${ROOT_LABEL} / Projekt / Unter`]);
		const none = ok<{ items: unknown[] }>(await call('stranger', 'GET', '/search?q=notiz'));
		expect(none.items).toEqual([]);
	});

	it('Breadcrumbs beginnen bei „Dateien“, ohne private Oberordner', async () => {
		const top = await folder('owner', 'Privat-Oben');
		const freigabe = await folder('owner', 'Freigabe', top);
		const tief = await folder('owner', 'Tief', freigabe);
		ok(await share('owner', freigabe, [{ type: 'user', id: ids.reader, level: 'read' }]));

		const l = ok<FolderListing>(await call('reader', 'GET', `/nodes?parent=${tief}`));
		expect(l.breadcrumbs).toEqual([
			{ id: null, name: ROOT_LABEL },
			{ id: freigabe, name: 'Freigabe' },
			{ id: tief, name: 'Tief' }
		]);
		expect(JSON.stringify(l)).not.toContain('Privat-Oben');
		expect(l.access).toBe('read');

		const own = ok<FolderListing>(await call('owner', 'GET', `/nodes?parent=${tief}`));
		expect(own.breadcrumbs.map((b) => b.name)).toEqual([
			ROOT_LABEL,
			'Privat-Oben',
			'Freigabe',
			'Tief'
		]);
	});

	it('`inherited` nur von zugänglichen Vorfahren', async () => {
		const top = await folder('owner', 'Geheim-Oben');
		const f = await folder('owner', 'Geteilt', top);
		ok(await share('owner', top, [{ type: 'user', id: ids.team, level: 'read' }]));
		ok(await share('owner', f, [{ type: 'user', id: ids.reader, level: 'read' }]));

		const r = ok<NodeShares>(await call('reader', 'GET', `/nodes/${f}/shares`));
		expect(r.inherited).toHaveLength(0);
		expect(JSON.stringify(r)).not.toContain('Geheim-Oben');
		const t = ok<NodeShares>(await call('team', 'GET', `/nodes/${f}/shares`));
		expect(t.inherited).toHaveLength(1);
		expect(t.inherited[0]).toMatchObject({ fromId: top, fromName: 'Geheim-Oben' });
		const o = ok<NodeShares>(await call('owner', 'GET', `/nodes/${f}/shares`));
		expect(o.inherited).toHaveLength(1);
		expect(o.shares).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// Sicherheitsregeln
// ---------------------------------------------------------------------------

describe('Sicherheitsregeln für edit-Freigaben', () => {
	let f: string;
	let sub: string;
	let sub2: string;

	beforeAll(async () => {
		f = await folder('owner', 'Arbeit');
		sub = await folder('owner', 'Sub', f);
		sub2 = await folder('owner', 'Sub2', f);
		ok(await share('owner', f, [{ type: 'user', id: ids.editor, level: 'edit' }]));
	});

	it('kein Verschieben in eigene Ablage (403), innerhalb des Ordners 201', async () => {
		const move = (ids_: string[], targetId: string | null) =>
			call('editor', 'POST', '/nodes/move', { ids: ids_, targetId });
		fail(await move([f], null), 403, 'forbidden');
		fail(await move([sub], null), 403, 'forbidden');
		const own = await folder('editor', 'Editor-Eigen');
		fail(await move([sub], own), 403, 'forbidden');
		// auch nicht in einen an den Stamm freigegebenen Ordner der editor-Person
		const stammEigen = await folder('editor', 'Editor-Stamm');
		ok(await share('editor', stammEigen, [{ type: 'everyone', id: '*', level: 'edit' }]));
		fail(await move([sub], stammEigen), 403, 'forbidden');
		// `space` gibt es nicht mehr
		fail(
			await call('editor', 'POST', '/nodes/move', {
				ids: [sub],
				targetId: sub2,
				space: 'personal'
			}),
			422,
			'validation_failed'
		);

		const inside = ok<{ affected: number }>(await move([sub], sub2), 201);
		expect(inside.affected).toBe(1);
		const after = ok<FileNode>(await call('owner', 'GET', `/nodes/${sub}`));
		expect(after.parentId).toBe(sub2);
		expect(after.ownerId).toBe(ids.owner);
	});

	it('keine Freigaben/Links durch edit-Freigabe (403), `canShare` im DTO', async () => {
		fail(
			await share('editor', f, [{ type: 'everyone', id: '*', level: 'edit' }]),
			403,
			'forbidden'
		);
		fail(await share('editor', sub2, []), 403, 'forbidden');
		fail(await link('editor', f), 403, 'forbidden');
		fail(await call('editor', 'GET', `/nodes/${f}/links`), 403, 'forbidden');
		const own = ok<ShareLink>(await link('owner', f), 201);
		fail(await call('editor', 'DELETE', `/links/${own.id}`), 403, 'forbidden');
		fail(await call('stranger', 'DELETE', `/links/${own.id}`), 404);
		ok(await call('owner', 'DELETE', `/links/${own.id}`));

		const e = ok<FileNode>(await call('editor', 'GET', `/nodes/${f}`));
		expect(e.access).toBe('edit');
		expect(e.canShare).toBe(false);
		expect(ok<FileNode>(await call('owner', 'GET', `/nodes/${f}`)).canShare).toBe(true);
		// Freigaben unverändert
		expect(ok<NodeShares>(await call('owner', 'GET', `/nodes/${f}/shares`)).shares).toHaveLength(1);
	});

	it('Validierung: Duplikat 422 (`shares.1.id`), unbekannte*r Benutzer*in 422', async () => {
		const dup = await share('owner', f, [
			{ type: 'user', id: ids.reader, level: 'read' },
			{ type: 'user', id: ids.reader, level: 'edit' }
		]);
		fail(dup, 422, 'validation_failed');
		expect(paths(dup)).toContain('shares.1.id');
		const unknown = await share('owner', f, [
			{ type: 'user', id: ids.reader, level: 'read' },
			{ type: 'user', id: 'gibt-es-nicht', level: 'read' }
		]);
		fail(unknown, 422, 'validation_failed');
		expect(paths(unknown)).toContain('shares.1.id');
		fail(await share('owner', f, [{ type: 'role', id: 'keine-rolle', level: 'read' }]), 422);
		fail(await share('owner', f, [{ type: 'everyone', id: 'x', level: 'read' }]), 422);
	});

	it('Audit `files.share.updated` ohne personenbezogene Details', async () => {
		const a = await auditText('files.share.updated');
		expect(a).toContain(f);
		expect(a).not.toContain('@example.test');
	});
});

// ---------------------------------------------------------------------------
// Öffentliche Links
// ---------------------------------------------------------------------------

describe('Öffentliche Links', () => {
	let root: string;
	let inner: string;
	let bild: string;
	let outside: string;
	let outsideFile: string;
	let folderLink: ShareLink;
	let token: string;

	beforeAll(async () => {
		root = await folder('owner', 'Öffentlich');
		inner = await folder('owner', 'Innen', root);
		bild = ok<FileNode>(await upload('owner', inner, 'bild.png', pngBytes, 'image/png'), 201).id;
		outside = await folder('owner', 'Draußen');
		outsideFile = ok<FileNode>(
			await upload('owner', outside, 'geheim.txt', new TextEncoder().encode('g'), 'text/plain'),
			201
		).id;
		folderLink = ok<ShareLink>(await link('owner', root), 201);
		token = tokenOf(folderLink);
	});

	it('Anlegen: `url` jederzeit abrufbar, Token nur als Hash + verschlüsselt gespeichert', async () => {
		expect(folderLink.url).toMatch(/\/p\/files\/link\/[A-Za-z0-9_-]{20,}$/);
		expect(folderLink.hasPassword).toBe(false);
		expect(folderLink.active).toBe(true);
		expect(folderLink.mode).toBe('view');
		const rows = await q(sql`SELECT * FROM mod_files.share_links WHERE id = ${folderLink.id}`);
		expect(rows).toHaveLength(1);
		expect(rows[0]!.token_hash).not.toBe(token);
		expect(JSON.stringify(rows)).not.toContain(token);
		const list = ok<ShareLink[]>(await call('owner', 'GET', `/nodes/${root}/links`));
		expect(list.find((l) => l.id === folderLink.id)?.url).toBe(folderLink.url);
		expect(rows[0]!.token_enc).toBeTruthy();
		expect(rows[0]!.mode).toBe('view');
	});

	it('Info, Liste, Inhalt ohne Login; Ausgabe ohne ownerId/createdBy', async () => {
		const info = ok<Record<string, unknown>>(await call(null, 'GET', `/public/links/${token}`));
		expect(info).toMatchObject({
			name: 'Öffentlich',
			kind: 'folder',
			mode: 'view',
			needsPassword: false,
			upload: null,
			node: null
		});
		const list = ok<{ breadcrumbs: unknown[]; items: { id: string; name: string }[] }>(
			await call(null, 'GET', `/public/links/${token}/nodes`)
		);
		expect(list.items.map((i) => i.name)).toEqual(['Innen']);
		const sub = ok<{ breadcrumbs: unknown[]; items: { id: string }[] }>(
			await call(null, 'GET', `/public/links/${token}/nodes?parent=${inner}`)
		);
		expect(sub.breadcrumbs).toEqual([
			{ id: null, name: 'Öffentlich' },
			{ id: inner, name: 'Innen' }
		]);
		expect(sub.items.map((i) => i.id)).toEqual([bild]);
		const all = JSON.stringify([info, list, sub]);
		for (const k of ['ownerId', 'owner_id', 'createdBy', 'created_by', ids.owner!]) {
			expect(all).not.toContain(k);
		}
		const file = await raw(null, 'GET', `/public/links/${token}/content/${bild}`);
		expect(file.status).toBe(200);
		expect((await file.arrayBuffer()).byteLength).toBe(pngBytes.byteLength);
	});

	it('Teilbaum-Grenze: Knoten außerhalb 404', async () => {
		fail(await call(null, 'GET', `/public/links/${token}/nodes?parent=${outside}`), 404);
		fail(await call(null, 'GET', `/public/links/${token}/content/${outsideFile}`), 404);
		fail(await call(null, 'GET', `/public/links/${token}/content/${crypto.randomUUID()}`), 404);
		fail(await call(null, 'GET', `/public/links/${'x'.repeat(43)}`), 404);
	});

	it('`access_count` steigt bei Info/Inhalt, Thumbnails zählen nicht', async () => {
		const count = async () =>
			Number(
				(
					await q(sql`SELECT access_count FROM mod_files.share_links WHERE id = ${folderLink.id}`)
				)[0]!.access_count
			);
		const before = await count();
		ok(await call(null, 'GET', `/public/links/${token}`));
		expect(await count()).toBe(before + 1);
		const thumb = await raw(null, 'GET', `/public/links/${token}/content/${bild}?thumb=1`);
		expect(thumb.status).toBe(200);
		expect(await count()).toBe(before + 1);
		expect((await raw(null, 'GET', `/public/links/${token}/content/${bild}`)).status).toBe(200);
		expect(await count()).toBe(before + 2);
		const listed = ok<ShareLink[]>(await call('owner', 'GET', `/nodes/${root}/links`));
		expect(listed.find((l) => l.id === folderLink.id)?.accessCount).toBe(before + 2);
	});

	it('Datei-Link: Info liefert `node`', async () => {
		const l = ok<ShareLink>(await link('owner', bild), 201);
		const info = ok<{ kind: string; node: { id: string; hasThumb: boolean } | null }>(
			await call(null, 'GET', `/public/links/${tokenOf(l)}`)
		);
		expect(info.kind).toBe('file');
		expect(info.node?.id).toBe(bild);
		expect(info.node?.hasThumb).toBe(true);
	});

	it('abgelaufen, widerrufen, Knoten im Papierkorb → 404', async () => {
		const exp = ok<ShareLink>(await link('owner', inner), 201);
		await q(
			sql`UPDATE mod_files.share_links SET expires_on = CURRENT_DATE - 1 WHERE id = ${exp.id}`
		);
		fail(await call(null, 'GET', `/public/links/${tokenOf(exp)}`), 404, 'not_found');
		fail(await call(null, 'GET', `/public/links/${tokenOf(exp)}/nodes`), 404);
		const listed = ok<ShareLink[]>(await call('owner', 'GET', `/nodes/${inner}/links`));
		expect(listed.find((l) => l.id === exp.id)?.active).toBe(false);

		const rev = ok<ShareLink>(await link('owner', inner), 201);
		ok(await call(null, 'GET', `/public/links/${tokenOf(rev)}`));
		const revoked = ok<ShareLink>(await call('owner', 'DELETE', `/links/${rev.id}`));
		expect(revoked.active).toBe(false);
		expect(revoked.revokedAt).not.toBeNull();
		fail(await call(null, 'GET', `/public/links/${tokenOf(rev)}`), 404, 'not_found');

		const tmp = await folder('owner', 'Wird gelöscht', root);
		const tl = ok<ShareLink>(await link('owner', tmp), 201);
		ok(await call(null, 'GET', `/public/links/${tokenOf(tl)}`));
		expect((await call('owner', 'POST', '/nodes/trash', { ids: [tmp] })).status).toBeLessThan(300);
		fail(await call(null, 'GET', `/public/links/${tokenOf(tl)}`), 404, 'not_found');
		// über den Ordner-Link ebenfalls nicht mehr erreichbar
		fail(await call(null, 'GET', `/public/links/${token}/nodes?parent=${tmp}`), 404);
	});

	it('Passwort: ohne `t` 403, falsch 403, richtig → `t`, fremdes/abgelaufenes `t` ungültig', async () => {
		const pw = ok<ShareLink>(await link('owner', root, 'richtig-123'), 201);
		expect(pw.hasPassword).toBe(true);
		const t = tokenOf(pw);
		const row = await q(sql`SELECT password_hash FROM mod_files.share_links WHERE id = ${pw.id}`);
		expect(String(row[0]!.password_hash)).not.toContain('richtig-123');

		const info = ok<{ needsPassword: boolean; node: unknown }>(
			await call(null, 'GET', `/public/links/${t}`)
		);
		expect(info.needsPassword).toBe(true);
		fail(await call(null, 'GET', `/public/links/${t}/nodes`), 403, 'forbidden');
		fail(await call(null, 'GET', `/public/links/${t}/content/${bild}`), 403, 'forbidden');
		fail(
			await call(null, 'POST', `/public/links/${t}/unlock`, { password: 'falsch-123' }),
			403,
			'forbidden'
		);
		const un = ok<{ accessToken: string; expiresInSec: number }>(
			await call(null, 'POST', `/public/links/${t}/unlock`, { password: 'richtig-123' }),
			201
		);
		const acc = encodeURIComponent(un.accessToken);
		ok(await call(null, 'GET', `/public/links/${t}/nodes?t=${acc}`));
		expect(
			ok<{ needsPassword: boolean }>(await call(null, 'GET', `/public/links/${t}?t=${acc}`))
				.needsPassword
		).toBe(false);

		// `t` eines anderen Links
		const other = ok<ShareLink>(await link('owner', inner, 'anderes-pw-1'), 201);
		const otherAcc = ok<{ accessToken: string }>(
			await call(null, 'POST', `/public/links/${tokenOf(other)}/unlock`, {
				password: 'anderes-pw-1'
			}),
			201
		).accessToken;
		fail(
			await call(null, 'GET', `/public/links/${t}/nodes?t=${encodeURIComponent(otherAcc)}`),
			403
		);
		// gültig signiert, aber abgelaufen
		const past = String(Math.floor(Date.now() / 1000) - 60);
		const sig = core.crypto.forModule('files').hash(`access:${pw.id}.${past}`);
		fail(
			await call(
				null,
				'GET',
				`/public/links/${t}/nodes?t=${encodeURIComponent(`${pw.id}.${past}.${sig}`)}`
			),
			403
		);
		// manipuliertes Ablaufdatum
		const forged = un.accessToken.replace(/\.(\d+)\./, (_m, e) => `.${Number(e) + 99999}.`);
		fail(await call(null, 'GET', `/public/links/${t}/nodes?t=${encodeURIComponent(forged)}`), 403);
	});

	it('Passwort-Datei-Link: Info mit gültigem `t` liefert `node`', async () => {
		const l = ok<ShareLink>(await link('owner', bild, 'datei-pw-12'), 201);
		const t = tokenOf(l);
		expect(ok<{ node: unknown }>(await call(null, 'GET', `/public/links/${t}`)).node).toBeNull();
		const acc = ok<{ accessToken: string }>(
			await call(null, 'POST', `/public/links/${t}/unlock`, { password: 'datei-pw-12' }),
			201
		).accessToken;
		const info = ok<{ needsPassword: boolean; node: { id: string } | null }>(
			await call(null, 'GET', `/public/links/${t}?t=${encodeURIComponent(acc)}`)
		);
		expect(info.needsPassword).toBe(false);
		expect(info.node?.id).toBe(bild);
		expect(
			(await raw(null, 'GET', `/public/links/${t}/content/${bild}?t=${encodeURIComponent(acc)}`))
				.status
		).toBe(200);
	});

	it(`nach ${MAX_UNLOCK_FAILURES} Fehlversuchen 429, auch mit richtigem Passwort`, async () => {
		const target = await folder('owner', 'Sperre');
		const l = ok<ShareLink>(await link('owner', target, 'richtig-123'), 201);
		const t = tokenOf(l);
		for (let i = 0; i < MAX_UNLOCK_FAILURES; i++) {
			fail(
				await call(null, 'POST', `/public/links/${t}/unlock`, { password: 'falsch-12345' }),
				403
			);
		}
		fail(
			await call(null, 'POST', `/public/links/${t}/unlock`, { password: 'falsch-12345' }),
			429,
			'rate_limited'
		);
		fail(
			await call(null, 'POST', `/public/links/${t}/unlock`, { password: 'richtig-123' }),
			429,
			'rate_limited'
		);
	});

	it(`viele parallele Fehlversuche: höchstens ${MAX_UNLOCK_FAILURES} werden geprüft, Rest 429 (#67, 01b-10)`, async () => {
		const target = await folder('owner', 'Parallel-Sperre');
		const l = ok<ShareLink>(await link('owner', target, 'richtig-123'), 201);
		const t = tokenOf(l);
		// Direkt über den Dienst (ohne IP-Rate-Limit des Routers), alle Anfragen gleichzeitig
		const results = await Promise.allSettled(
			Array.from({ length: MAX_UNLOCK_FAILURES * 3 }, () =>
				unlockLink(systemContext('test'), t, 'falsch-12345')
			)
		);
		const codes = results.map((r) =>
			r.status === 'rejected' ? (r.reason as { code?: string }).code : 'ok'
		);
		expect(codes.filter((c) => c === 'forbidden')).toHaveLength(MAX_UNLOCK_FAILURES);
		expect(codes.filter((c) => c === 'rate_limited')).toHaveLength(MAX_UNLOCK_FAILURES * 2);
		await expect(unlockLink(systemContext('test'), t, 'richtig-123')).rejects.toMatchObject({
			code: 'rate_limited'
		});
	});

	it('richtiges Passwort nach einzelnen Fehlversuchen setzt den Zähler zurück', async () => {
		const target = await folder('owner', 'Zähler zurück');
		const l = ok<ShareLink>(await link('owner', target, 'richtig-123'), 201);
		const t = tokenOf(l);
		for (let i = 0; i < MAX_UNLOCK_FAILURES - 1; i++) {
			await expect(unlockLink(systemContext('test'), t, 'falsch-12345')).rejects.toMatchObject({
				code: 'forbidden'
			});
		}
		await expect(unlockLink(systemContext('test'), t, 'richtig-123')).resolves.toHaveProperty(
			'accessToken'
		);
		const [row] = await q(sql`SELECT failed_count FROM mod_files.share_links WHERE id = ${l.id}`);
		expect(Number(row!.failed_count)).toBe(0);
	});

	it('Validierung: Passwort 7 Zeichen 422, Ablauf in der Vergangenheit 422, zu viele Links 409', async () => {
		const target = await folder('owner', 'Viele Links');
		const short = await link('owner', target, '1234567');
		fail(short, 422, 'validation_failed');
		expect(paths(short)).toContain('password');
		ok(await link('owner', target, '12345678'), 201);

		const d = new Date(Date.now() - 3 * 86400_000).toISOString().slice(0, 10);
		const past = await call('owner', 'POST', `/nodes/${target}/links`, {
			expiresOn: d,
			password: null
		});
		fail(past, 422, 'validation_failed');
		expect(paths(past)).toContain('expiresOn');
		fail(
			await call('owner', 'POST', `/nodes/${target}/links`, {
				expiresOn: '2030-02-31',
				password: null
			}),
			422
		);

		for (let i = 1; i < MAX_LINKS_PER_NODE; i++) ok(await link('owner', target), 201);
		fail(await link('owner', target), 409, 'conflict');
		// widerrufene zählen nicht
		const list = ok<ShareLink[]>(await call('owner', 'GET', `/nodes/${target}/links`));
		ok(await call('owner', 'DELETE', `/links/${list[0]!.id}`));
		ok(await link('owner', target), 201);
	});

	it('Audit `files.link.created|revoked|accessed` ohne Token/Passwort', async () => {
		const created = await auditText('files.link.created');
		const revoked = await auditText('files.link.revoked');
		const accessed = await auditText('files.link.accessed');
		expect(created).toContain(folderLink.id);
		expect(revoked).toContain('files.link.revoked');
		expect(accessed).toContain(folderLink.id);
		for (const a of [created, revoked, accessed]) {
			expect(a).not.toContain(token);
			expect(a).not.toContain('richtig-123');
			expect(a).not.toContain('datei-pw-12');
			expect(a).not.toContain('scrypt$');
		}
		// höchstens 1× je Link und Stunde
		const n = (accessed.match(new RegExp(`"target":"${folderLink.id}"`, 'g')) ?? []).length;
		expect(n).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// Reset (zuletzt – verändert Eigentum und leert das Modul)
// ---------------------------------------------------------------------------

describe('Reset', () => {
	it('`resetUsers`: Ablage landet in „Übernommen“, Links widerrufen, Benutzer-Freigaben weg', async () => {
		const alt = await folder('gone', 'Alt');
		const kind = await folder('gone', 'Kind', alt);
		const gl = ok<ShareLink>(await link('gone', alt), 201);
		ok(await share('gone', alt, [{ type: 'user', id: ids.reader, level: 'read' }]));
		ok(await call(null, 'GET', `/public/links/${tokenOf(gl)}`));
		// Gleichnamiger Ordner in der Ablage der behaltenen Person → kein Konflikt
		ok(await call('owner', 'POST', '/folders', { parentId: null, name: 'Alt' }), 201);

		await core.database
			.forModule('files')
			.transaction((tx) => filesModule.resetUsers!(tx, adminId));

		const rows = await q(
			sql`SELECT n.id, n.name, n.owner_id, n.created_by, p.name AS parent_name, p.parent_id AS grand
				FROM mod_files.nodes n LEFT JOIN mod_files.nodes p ON p.id = n.parent_id
				WHERE n.id IN (${alt}, ${kind})`
		);
		const altRow = rows.find((r) => r.id === alt)!;
		expect(String(altRow.parent_name)).toMatch(/^Übernommen( \(\d+\))?$/);
		expect(altRow.grand).toBeNull();
		expect(altRow.owner_id).toBe(adminId);
		expect(altRow.created_by).toBe(adminId);
		expect(rows.find((r) => r.id === kind)!.owner_id).toBe(adminId);
		// ein „Übernommen“-Ordner je früherer Ablage, eindeutig benannt
		const adopted = await q(
			sql`SELECT name FROM mod_files.nodes
				WHERE parent_id IS NULL AND space = 'personal' AND owner_id = ${adminId}
					AND name LIKE 'Übernommen%'`
		);
		expect(new Set(adopted.map((r) => r.name)).size).toBe(adopted.length);
		expect(adopted.length).toBeGreaterThanOrEqual(2);

		const linkRow = await q(sql`SELECT revoked_at FROM mod_files.share_links WHERE id = ${gl.id}`);
		expect(linkRow[0]!.revoked_at).not.toBeNull();
		fail(await call(null, 'GET', `/public/links/${tokenOf(gl)}`), 404);
		// alle Links fremder Ablagen widerrufen
		const open = await q(
			sql`SELECT count(*)::int AS n FROM mod_files.share_links l
				JOIN mod_files.nodes n ON n.id = l.node_id
				WHERE l.revoked_at IS NULL AND n.space = 'personal'`
		);
		expect(Number(open[0]!.n)).toBe(0);
		const userShares = await q(
			sql`SELECT count(*)::int AS n FROM mod_files.node_shares
				WHERE principal_type = 'user' AND principal_id <> ${adminId}`
		);
		expect(Number(userShares[0]!.n)).toBe(0);
		const foreign = await q(
			sql`SELECT count(*)::int AS n FROM mod_files.nodes WHERE owner_id <> ${adminId}`
		);
		expect(Number(foreign[0]!.n)).toBe(0);
	});

	it('Reset-Bereich `files:all` leert alle Tabellen', async () => {
		const before = await q(sql`SELECT count(*)::int AS n FROM mod_files.nodes`);
		expect(Number(before[0]!.n)).toBeGreaterThan(0);
		const p = await previewReset(admin, ['files:all']);
		await exportResetData(admin, {
			token: p.token,
			password: PW,
			backupPassword: 'Reset-Sicherung-2026'
		});
		await executeReset(admin, { token: p.token, confirmWord: RESET_CONFIRM_WORD });
		for (const t of ['nodes', 'node_shares', 'share_links']) {
			const r = await q(sql.raw(`SELECT count(*)::int AS n FROM mod_files.${t}`));
			expect(Number(r[0]!.n), t).toBe(0);
		}
		admin = await ctxOf(adminId);
		const l = ok<FolderListing>(
			await (async () => {
				keys.admin = (await createApiKey(admin, { name: 'a', scopes: ['files.file.view'] })).key;
				return call('admin', 'GET', '/nodes');
			})()
		);
		expect(l.items).toEqual([]);
	});
});
