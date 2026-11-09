/**
 * Modul `files`: `GET /recent` (Dashboard „Zuletzt geändert“) – nur eigene und freigegebene Dateien
 * (direkt, vererbt, Stamm), keine Ordner, kein Papierkorb, neueste zuerst, `limit`, Zugriff, Modul aus.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { installFakeStorage, uninstallFakeStorage } from '$testing';
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
import { core } from '$testing';
import filesModule from '$modules/files/module';
import type { RecentFile } from '$modules/files/schemas';
import type { RequestContext } from '$lib/sdk/types';

const ROOT = 'http://localhost:5173/api/v1/modules/files';
const PW = 'a-long-enough-pw';
const keys: Record<string, string> = {};
const ids: Record<string, string> = {};
const nodes: Record<string, string> = {};
let close: () => Promise<void>;
let admin: RequestContext;

const ctxOf = async (id: string) => (await contextForUser(id))!.ctx;

interface Res {
	status: number;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	body: any;
}

async function send(who: string, method: string, path: string, init: RequestInit = {}) {
	resetAllForTests();
	const url = new URL(ROOT + path);
	const headers = new Headers(init.headers);
	headers.set('authorization', `Bearer ${keys[who]}`);
	const res = await handleApiRequest({
		request: new Request(url, { ...init, method, headers }),
		url,
		ip: '127.0.0.1'
	});
	return { status: res.status, body: await res.json() } as Res;
}

const api = (who: string, method: string, path: string, data?: unknown) =>
	send(who, method, path, {
		headers: data === undefined ? {} : { 'content-type': 'application/json' },
		body: data === undefined ? undefined : JSON.stringify(data)
	});

async function upload(who: string, parent: string, name: string): Promise<string> {
	const form = new FormData();
	form.set('file', new File([new Uint8Array(10).fill(65)], name, { type: 'text/plain' }));
	const r = new Response(form);
	const buf = new Uint8Array(await r.arrayBuffer());
	const res = await send(who, 'POST', `/nodes/${parent}/upload`, {
		headers: {
			'content-type': r.headers.get('content-type')!,
			'content-length': String(buf.byteLength)
		},
		body: buf
	});
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.data.id as string;
}

async function folder(who: string, parentId: string | null, name: string): Promise<string> {
	const res = await api(who, 'POST', '/folders', { parentId, name });
	expect(res.status, JSON.stringify(res.body)).toBe(201);
	return res.body.data.id as string;
}

async function share(who: string, nodeId: string, shares: unknown[]) {
	const res = await api(who, 'PUT', `/nodes/${nodeId}/shares`, { shares });
	expect(res.status, JSON.stringify(res.body)).toBe(200);
}

/** Änderungszeit fest setzen (Sortierung deterministisch) */
async function touch(nodeId: string, iso: string) {
	await core.database.forModule('files').transaction(async (tx) => {
		await tx.execute(sql`UPDATE nodes SET updated_at = ${iso}::timestamptz WHERE id = ${nodeId}`);
	});
}

async function recent(who: string, query = ''): Promise<RecentFile[]> {
	const res = await api(who, 'GET', `/recent${query}`);
	expect(res.status, JSON.stringify(res.body)).toBe(200);
	return res.body.data as RecentFile[];
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
	admin = await ctxOf(u!.id);
	await enableModule(admin, 'files');
	admin = await ctxOf(u!.id);
	await installFakeStorage(admin);

	const basis = await createRole(admin, {
		name: 'Dateien Basis',
		permissions: ['files.file.view', 'core.api.manage']
	});
	const none = await createRole(admin, { name: 'Ohne Dateien', permissions: ['core.api.manage'] });
	for (const [n, role] of [
		['u1', basis],
		['u2', basis],
		['u3', basis],
		['u4', none]
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
	keys.admin = (await createApiKey(admin, { name: 'a', scopes: [...admin.permissions] })).key;

	// u1: eigene Datei in der Wurzel, geteilter Ordner mit Datei, privater Ordner mit einzeln geteilter Datei,
	// Stamm-Datei, Datei im Papierkorb
	nodes.own = await upload('u1', 'root', 'eigen.txt');
	nodes.shared = await folder('u1', null, 'Geteilt');
	nodes.inShared = await upload('u1', nodes.shared, 'im-ordner.txt');
	nodes.private = await folder('u1', null, 'Privat');
	nodes.single = await upload('u1', nodes.private, 'einzeln.txt');
	nodes.stamm = await upload('u1', 'root', 'stamm.txt');
	nodes.trash = await upload('u1', 'root', 'weg.txt');
	nodes.foreign = await upload('u3', 'root', 'fremd.txt');

	await share('u1', nodes.shared, [{ type: 'user', id: ids.u2, level: 'read' }]);
	await share('u1', nodes.single, [{ type: 'user', id: ids.u2, level: 'read' }]);
	await share('u1', nodes.stamm, [{ type: 'everyone', id: '*', level: 'read' }]);
	const t = await api('u1', 'POST', '/nodes/trash', { ids: [nodes.trash] });
	expect(t.status).toBe(201);

	await touch(nodes.own, '2026-10-01T10:00:00Z');
	await touch(nodes.inShared, '2026-10-02T10:00:00Z');
	await touch(nodes.single, '2026-10-03T10:00:00Z');
	await touch(nodes.stamm, '2026-10-04T10:00:00Z');
	await touch(nodes.trash, '2026-10-05T10:00:00Z');
	await touch(nodes.foreign, '2026-10-06T10:00:00Z');
});

afterAll(async () => {
	uninstallFakeStorage();
	await close?.();
});

describe('GET /recent', () => {
	it('Eigentümer*in: eigene Dateien neueste zuerst, ohne Ordner, ohne Papierkorb, ohne Fremdes', async () => {
		const list = await recent('u1');
		expect(list.map((f) => f.name)).toEqual([
			'stamm.txt',
			'einzeln.txt',
			'im-ordner.txt',
			'eigen.txt'
		]);
		expect(list.every((f) => f.own)).toBe(true);
		const inShared = list.find((f) => f.id === nodes.inShared)!;
		expect(inShared).toMatchObject({
			parentId: nodes.shared,
			mime: 'text/plain',
			size: 10,
			hasThumb: false
		});
		expect(list.find((f) => f.id === nodes.own)!.parentId).toBeNull();
	});

	it('Freigaben: vererbt über Ordner, direkt, Stamm; privater Elternordner wird nicht verlinkt', async () => {
		const list = await recent('u2');
		expect(list.map((f) => f.name)).toEqual(['stamm.txt', 'einzeln.txt', 'im-ordner.txt']);
		expect(list.every((f) => !f.own)).toBe(true);
		expect(list.find((f) => f.id === nodes.inShared)!.parentId).toBe(nodes.shared);
		// Ordner „Privat“ ist für u2 nicht zugänglich → kein Ordner-Link
		expect(list.find((f) => f.id === nodes.single)!.parentId).toBeNull();
	});

	it('nur Stamm-Freigabe und eigene Dateien für andere Personen', async () => {
		const list = await recent('u3');
		expect(list.map((f) => f.name)).toEqual(['fremd.txt', 'stamm.txt']);
		expect(list.map((f) => f.own)).toEqual([true, false]);
	});

	it('manage-all sieht auf dem Dashboard keine fremden privaten Dateien', async () => {
		const list = await recent('admin');
		expect(list.map((f) => f.name)).toEqual(['stamm.txt']);
	});

	it('limit: Standard 8, 1–20, sonst 422', async () => {
		expect(await recent('u1', '?limit=2')).toHaveLength(2);
		expect((await api('u1', 'GET', '/recent?limit=0')).status).toBe(422);
		expect((await api('u1', 'GET', '/recent?limit=21')).status).toBe(422);
	});

	it('ohne files.file.view 403', async () => {
		const res = await api('u4', 'GET', '/recent');
		expect(res.status).toBe(403);
	});

	it('Modul deaktiviert → 404', async () => {
		await disableModule(admin, 'files');
		try {
			const res = await api('u1', 'GET', '/recent');
			expect(res.status).toBe(404);
			expect(res.body.error.code).toBe('module_disabled');
		} finally {
			await enableModule(admin, 'files');
		}
	});
});
