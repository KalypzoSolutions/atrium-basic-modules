/**
 * Modul `files` v1.2.0: Ordner-Aussehen (`POST /nodes/style`, Icon aus der Icon-Bibliothek + Farbe) und
 * Speicherkontingent je Person (`GET/PUT /quotas/:userId`, wirksam bei Upload, Meta, Link-Upload),
 * Ordnergröße im DTO, Aufräumen beim Löschen des Kontos, Audit ohne Werte.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { installFakeStorage, uninstallFakeStorage } from '$testing';
import { getDb, schema } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin, createUser, deleteUser } from '$testing';
import { createRole } from '$testing';
import { registerModule } from '$testing';
import { enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { handleApiRequest } from '$testing';
import { createApiKey } from '$testing';
import { resetAllForTests } from '$testing';
import { core } from '$testing';
import filesModule from '$modules/files/module';
import type { FileNode, FolderListing, UserQuota } from '$modules/files/schemas';
import type { RequestContext } from '$lib/sdk/types';
import { sql } from 'drizzle-orm';

const ROOT = 'http://localhost:5173/api/v1/modules/files';
const PW = 'a-long-enough-pw';
const MB = 1024 * 1024;
const keys: Record<string, string> = {};
const ids: Record<string, string> = {};
let close: () => Promise<void>;
let admin: RequestContext;
let adminId: string;

const ctxOf = async (id: string) => (await contextForUser(id))!.ctx;

interface Res {
	status: number;
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
	return { status: res.status, body } as Res;
}

const api = (who: string | null, method: string, path: string, data?: unknown) =>
	send(who, method, path, {
		headers: data === undefined ? {} : { 'content-type': 'application/json' },
		body: data === undefined ? undefined : JSON.stringify(data)
	});

async function upload(who: string, parent: string, name: string, size: number) {
	const form = new FormData();
	form.set('file', new File([new Uint8Array(size).fill(65)], name, { type: 'text/plain' }));
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

const folder = async (who: string, parentId: string | null, name: string) =>
	(await api(who, 'POST', '/folders', { parentId, name })).body.data as FileNode;

const style = (who: string, body: unknown) => api(who, 'POST', '/nodes/style', body);

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

	const basic = await createRole(admin, {
		name: 'Dateien Basis',
		permissions: ['files.file.view', 'core.api.manage']
	});
	const quotaAdmin = await createRole(admin, {
		name: 'Kontingente',
		permissions: ['files.file.view', 'files.quota.manage', 'core.api.manage']
	});
	for (const [n, role] of [
		['u1', basic],
		['u2', basic],
		['u3', basic],
		['qa', quotaAdmin]
	] as const) {
		ids[n] = await createUser(admin, {
			name: n.toUpperCase(),
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

describe('Ordner-Aussehen', () => {
	it('setzt Icon und Farbe, liefert sie im DTO und setzt einzeln zurück', async () => {
		const f = await folder('u1', null, 'Sommerlager');
		expect(f.icon).toBeNull();
		expect(f.color).toBeNull();

		const r = await style('u1', { ids: [f.id], icon: 'tent', color: '#16A34A' });
		expect(r.status).toBe(201);
		expect(r.body.data).toEqual({ affected: 1 });
		let node = (await api('u1', 'GET', `/nodes/${f.id}`)).body.data as FileNode;
		expect(node.icon).toBe('tent');
		expect(node.color).toBe('#16a34a'); // klein gespeichert

		// nur Farbe ändern: Icon bleibt
		await style('u1', { ids: [f.id], color: '#2563eb' });
		node = (await api('u1', 'GET', `/nodes/${f.id}`)).body.data as FileNode;
		expect(node).toMatchObject({ icon: 'tent', color: '#2563eb' });

		// Icon zurücksetzen
		await style('u1', { ids: [f.id], icon: null });
		node = (await api('u1', 'GET', `/nodes/${f.id}`)).body.data as FileNode;
		expect(node).toMatchObject({ icon: null, color: '#2563eb' });
	});

	it('Farbe für mehrere Ordner auf einmal', async () => {
		const a = await folder('u1', null, 'A');
		const b = await folder('u1', null, 'B');
		const r = await style('u1', { ids: [a.id, b.id], color: '#dc2626' });
		expect(r.body.data.affected).toBe(2);
		const l = (await api('u1', 'GET', '/nodes')).body.data as FolderListing;
		expect(l.items.filter((i) => i.color === '#dc2626').map((i) => i.name)).toEqual(['A', 'B']);
	});

	it('Validierung: unbekanntes Icon, falsches Format, Datei, leere Änderung → 422', async () => {
		const f = await folder('u1', null, 'Validierung');
		const unknown = await style('u1', { ids: [f.id], icon: 'gibt-es-nicht-xyz' });
		expect(unknown.status).toBe(422);
		expect(unknown.body.error.details[0].path).toEqual(['icon']);
		expect((await style('u1', { ids: [f.id], icon: 'Tent!' })).status).toBe(422);
		expect((await style('u1', { ids: [f.id], color: 'red' })).status).toBe(422);
		expect((await style('u1', { ids: [f.id] })).status).toBe(422);

		const file = await upload('u1', f.id, 'notiz.txt', 10);
		expect(file.status).toBe(201);
		const onFile = await style('u1', { ids: [file.body.data.id], color: '#16a34a' });
		expect(onFile.status).toBe(422);
	});

	it('Zugriff: fremd → 404, nur Lesen → 403, Bearbeiten-Freigabe → erlaubt', async () => {
		const priv = await folder('u1', null, 'Privat');
		expect((await style('u2', { ids: [priv.id], color: '#16a34a' })).status).toBe(404);

		const read = await folder('u1', null, 'Lesen');
		await api('u1', 'PUT', `/nodes/${read.id}/shares`, {
			shares: [{ type: 'user', id: ids.u2, level: 'read' }]
		});
		const r = await style('u2', { ids: [read.id], color: '#16a34a' });
		expect(r.status).toBe(403);
		expect(r.body.error.code).toBe('forbidden');

		const edit = await folder('u1', null, 'Bearbeiten');
		await api('u1', 'PUT', `/nodes/${edit.id}/shares`, {
			shares: [{ type: 'user', id: ids.u2, level: 'edit' }]
		});
		expect((await style('u2', { ids: [edit.id], icon: 'compass' })).status).toBe(201);
		// gilt für alle: Eigentümer*in sieht dasselbe Aussehen
		const own = (await api('u1', 'GET', `/nodes/${edit.id}`)).body.data as FileNode;
		expect(own.icon).toBe('compass');
	});

	it('öffentlicher Link zeigt Icon und Farbe von Unterordnern', async () => {
		const top = await folder('u1', null, 'Geteilt');
		const sub = await folder('u1', top.id, 'Fotos');
		await style('u1', { ids: [sub.id], icon: 'camera', color: '#7c3aed' });
		// Link anlegen braucht `files.link.create` – als Admin für den Ordner von u1 (manage-all)
		keys.admin = (await createApiKey(admin, { name: 'a', scopes: [...admin.permissions] })).key;
		const link = await api('admin', 'POST', `/nodes/${top.id}/links`, {
			expiresOn: null,
			password: null,
			mode: 'view'
		});
		expect(link.status).toBe(201);
		const token = String(link.body.data.url).split('/').pop()!;
		const pub = await api(null, 'GET', `/public/links/${token}/nodes`);
		expect(pub.status).toBe(200);
		expect(pub.body.data.items[0]).toMatchObject({
			name: 'Fotos',
			icon: 'camera',
			color: '#7c3aed'
		});
	});

	it('Audit ohne Icon-Namen und Farbwerte', async () => {
		const rows = await getDb()
			.select({ action: schema.auditLog.action, metadata: schema.auditLog.metadata })
			.from(schema.auditLog)
			.where(like(schema.auditLog.action, 'files.node.styled'));
		expect(rows.length).toBeGreaterThan(0);
		const text = JSON.stringify(rows.map((r) => r.metadata));
		expect(text).not.toContain('tent');
		expect(text).not.toContain('#16a34a');
		expect(rows[0]!.metadata).toMatchObject({ count: expect.any(Number) });
	});
});

describe('Ordnergröße', () => {
	it('summiert den Teilbaum ohne Papierkorb', async () => {
		const top = await folder('u3', null, 'Groesse');
		const sub = await folder('u3', top.id, 'Unter');
		await upload('u3', top.id, 'a.txt', 100);
		const b = await upload('u3', sub.id, 'b.txt', 50);
		let l = (await api('u3', 'GET', '/nodes')).body.data as FolderListing;
		expect(l.items.find((i) => i.id === top.id)).toMatchObject({ childCount: 2, folderBytes: 150 });
		await api('u3', 'POST', '/nodes/trash', { ids: [b.body.data.id] });
		l = (await api('u3', 'GET', '/nodes')).body.data as FolderListing;
		expect(l.items.find((i) => i.id === top.id)?.folderBytes).toBe(100);
	});
});

describe('Kontingent je Person', () => {
	it('ohne files.quota.manage → 403', async () => {
		const r = await api('u1', 'GET', `/quotas/${ids.u2}`);
		expect(r.status).toBe(403);
		expect((await api('u1', 'PUT', `/quotas/${ids.u2}`, { mode: 'unlimited' })).status).toBe(403);
	});

	it('Standard: 1 GB aus den Einstellungen', async () => {
		const r = await api('qa', 'GET', `/quotas/${ids.u2}`);
		expect(r.status).toBe(200);
		expect(r.body.data).toEqual({
			userId: ids.u2!,
			mode: 'default',
			customMb: null,
			defaultBytes: 1024 * MB,
			limitBytes: 1024 * MB,
			usedBytes: 0
		} satisfies UserQuota);
	});

	it('eigenes Limit gilt für Upload und Meta; Unbegrenzt; zurück auf Standard', async () => {
		const set = await api('qa', 'PUT', `/quotas/${ids.u2}`, { mode: 'custom', mb: 1 });
		expect(set.status).toBe(200);
		expect(set.body.data).toMatchObject({ mode: 'custom', customMb: 1, limitBytes: MB });

		const meta = await api('u2', 'GET', '/meta');
		expect(meta.body.data.quota).toEqual({ usedBytes: 0, limitBytes: MB });

		const f = await folder('u2', null, 'Voll');
		expect((await upload('u2', f.id, 'klein.txt', 600 * 1024)).status).toBe(201);
		const full = await upload('u2', f.id, 'zu-gross.txt', 600 * 1024);
		expect(full.status).toBe(413);
		expect(full.body.error.message).toContain('Speicherplatz');

		const unl = await api('qa', 'PUT', `/quotas/${ids.u2}`, { mode: 'unlimited' });
		expect(unl.body.data).toMatchObject({ mode: 'unlimited', customMb: null, limitBytes: null });
		expect((await upload('u2', f.id, 'jetzt-ok.txt', 600 * 1024)).status).toBe(201);
		expect((await api('u2', 'GET', '/meta')).body.data.quota.limitBytes).toBeNull();

		const def = await api('qa', 'PUT', `/quotas/${ids.u2}`, { mode: 'default' });
		expect(def.body.data).toMatchObject({ mode: 'default', limitBytes: 1024 * MB });
		// zwei erfolgreiche Uploads à 600 KB
		expect(def.body.data.usedBytes).toBe(1200 * 1024);
	});

	it('Validierung: custom ohne/mit ungültigem Wert → 422', async () => {
		expect((await api('qa', 'PUT', `/quotas/${ids.u2}`, { mode: 'custom' })).status).toBe(422);
		expect((await api('qa', 'PUT', `/quotas/${ids.u2}`, { mode: 'custom', mb: 0 })).status).toBe(
			422
		);
		expect((await api('qa', 'PUT', `/quotas/${ids.u2}`, { mode: 'custom', mb: 1.5 })).status).toBe(
			422
		);
		expect((await api('qa', 'PUT', `/quotas/${ids.u2}`, { mode: 'mehr' })).status).toBe(422);
	});

	it('Audit mit Modus, Löschen des Kontos entfernt das Kontingent', async () => {
		await api('qa', 'PUT', `/quotas/${ids.u3}`, { mode: 'custom', mb: 5 });
		const audit = await getDb()
			.select({ metadata: schema.auditLog.metadata, target: schema.auditLog.target })
			.from(schema.auditLog)
			.where(eq(schema.auditLog.action, 'files.quota.updated'));
		expect(audit.at(-1)).toMatchObject({ target: ids.u3, metadata: { mode: 'custom', mb: 5 } });

		await deleteUser(admin, ids.u3!);
		const left = await core.database
			.forModule('files')
			.transaction((tx) =>
				tx.execute(sql`SELECT count(*)::int AS n FROM user_quotas WHERE user_id = ${ids.u3}`)
			);
		expect(Number((left.rows[0] as { n: number }).n)).toBe(0);
	});
});
