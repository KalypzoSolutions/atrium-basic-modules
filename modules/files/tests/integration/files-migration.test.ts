/**
 * Modul `files` – Migration 0003 (Stamm-Bereich auflösen): Daten im Zustand „vor 0003“ (`space = 'shared'`)
 * werden eingefügt, danach läuft das SQL von 0003 erneut im Modulschema. Erwartung: alles `personal`,
 * Teilbaum gehört der Person, die die Stamm-Wurzel angelegt hat, genau eine `everyone:*`-Lesefreigabe je
 * Stamm-Wurzel, Namenskonflikte mit „(Stamm …)“ aufgelöst, idempotent.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import { splitSqlStatements } from '$testing';
import { core } from '$testing';
import filesModule from '$modules/files/module';
import m0003 from '$modules/files/migrations/0003_single_view_upload_links.sql?raw';
import { ROOT_LABEL, type FileNode, type FolderListing } from '$modules/files/schemas';
import type { RequestContext } from '$lib/sdk/types';

const ROOT = 'http://localhost:5173/api/v1/modules/files';
const PW = 'a-long-enough-pw';
const keys: Record<string, string> = {};
const ids: Record<string, string> = {};
let close: () => Promise<void>;
let admin: RequestContext;

const ctxOf = async (id: string) => (await contextForUser(id))!.ctx;
const mdb = () => core.database.forModule('files');

interface Res {
	status: number;
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	body: any;
}

async function call(who: string, method: string, path: string, json?: unknown): Promise<Res> {
	resetAllForTests();
	const headers = new Headers({ authorization: `Bearer ${keys[who]}` });
	if (json !== undefined) headers.set('content-type', 'application/json');
	const url = new URL(ROOT + path);
	const res = await handleApiRequest({
		request: new Request(url, {
			method,
			headers,
			body: json === undefined ? undefined : JSON.stringify(json)
		}),
		url,
		ip: '127.0.0.1'
	});
	const text = await res.text();
	let body: unknown = text;
	try {
		body = JSON.parse(text);
	} catch {
		/* roh */
	}
	return { status: res.status, body };
}

function ok<T>(res: Res, status = 200): T {
	expect(res.status, JSON.stringify(res.body)).toBe(status);
	return res.body.data as T;
}

async function upload(who: string, parent: string, name: string) {
	const form = new FormData();
	form.set(
		'file',
		new File([new Uint8Array(4).fill(65) as BlobPart], name, { type: 'text/plain' })
	);
	const r = new Response(form);
	const buf = new Uint8Array(await r.arrayBuffer());
	resetAllForTests();
	const url = new URL(`${ROOT}/nodes/${parent}/upload`);
	const res = await handleApiRequest({
		request: new Request(url, {
			method: 'POST',
			headers: {
				authorization: `Bearer ${keys[who]}`,
				'content-type': r.headers.get('content-type')!,
				'content-length': String(buf.byteLength)
			},
			body: buf
		}),
		url,
		ip: '127.0.0.1'
	});
	return { status: res.status, body: await res.json() } as Res;
}

type Row = Record<string, unknown>;
const rowsOf = (r: unknown) => (r as { rows: Row[] }).rows;

async function runMigration() {
	await mdb().transaction(async (tx) => {
		for (const stmt of splitSqlStatements(m0003)) await tx.execute(sql.raw(stmt));
	});
}

async function snapshot() {
	return mdb().transaction(async (tx) => ({
		nodes: rowsOf(
			await tx.execute(
				sql`SELECT id, parent_id, space, owner_id, name, created_by, deleted_at, trash_root
					FROM nodes ORDER BY id`
			)
		),
		shares: rowsOf(
			await tx.execute(
				sql`SELECT node_id, principal_type, principal_id, level, created_by
					FROM node_shares ORDER BY node_id, principal_type, principal_id`
			)
		),
		links: rowsOf(
			await tx.execute(sql`SELECT id, node_id, mode, token_enc FROM share_links ORDER BY id`)
		)
	}));
}

// IDs der Daten „vor 0003“
const n = {
	annaPersonal: crypto.randomUUID(),
	annaStamm: crypto.randomUUID(),
	child: crypto.randomUUID(),
	grandFile: crypto.randomUUID(),
	benStamm: crypto.randomUUID(),
	benChild: crypto.randomUUID(),
	deleted: crypto.randomUUID(),
	deletedChild: crypto.randomUUID(),
	link: crypto.randomUUID()
};

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
	// Modul aktivieren → 0001–0003 laufen auf leerem Schema
	await enableModule(admin, 'files');
	admin = await ctxOf(u!.id);
	const role = await createRole(admin, {
		name: 'Nutzer',
		permissions: ['files.file.view', 'core.api.manage']
	});
	for (const [k, name] of [
		['anna', 'Anna'],
		['ben', 'Ben'],
		['carla', 'Carla']
	] as const) {
		ids[k] = await createUser(admin, {
			name,
			email: `${k}@example.test`,
			password: PW,
			roleIds: [role]
		});
		const c = await ctxOf(ids[k]!);
		keys[k] = (await createApiKey(c, { name: 'k', scopes: [...c.permissions] })).key;
	}

	const { anna, ben, carla } = ids as Record<'anna' | 'ben' | 'carla', string>;
	// Zustand „vor 0003“ (Spalte `space` mit CHECK personal|shared gibt es weiterhin)
	await mdb().transaction(async (tx) => {
		const node = (
			id: string,
			parent: string | null,
			kind: 'folder' | 'file',
			space: 'personal' | 'shared',
			owner: string,
			name: string
		) =>
			tx.execute(
				sql`INSERT INTO nodes (id, parent_id, kind, space, owner_id, name, created_by, storage_path, size_bytes, content_type)
					VALUES (${id}, ${parent}, ${kind}, ${space}, ${owner}, ${name}, ${owner},
						${kind === 'file' ? `${id}/content` : null}, ${kind === 'file' ? 4 : null},
						${kind === 'file' ? 'text/plain' : null})`
			);
		// Anna: eigene Wurzel „Material“ + Stamm-Wurzel „Material“ (Namenskonflikt)
		await node(n.annaPersonal, null, 'folder', 'personal', anna, 'Material');
		await node(n.annaStamm, null, 'folder', 'shared', anna, 'Material');
		// Kind von Carla, Enkel-Datei von Ben im Stamm-Baum von Anna
		await node(n.child, n.annaStamm, 'folder', 'shared', carla, 'Zelte');
		await node(n.grandFile, n.child, 'file', 'shared', ben, 'liste.txt');
		// Ben: eigene Stamm-Wurzel mit Kind von Anna
		await node(n.benStamm, null, 'folder', 'shared', ben, 'Fahrten');
		await node(n.benChild, n.benStamm, 'folder', 'shared', anna, 'Sommer');
		// gelöschte Stamm-Wurzel von Ben (gleicher Name wie Annas Stamm-Wurzel, im Papierkorb erlaubt)
		// (Annas „Material“ kurz umbenennen, damit der Unique-Index das Anlegen erlaubt)
		await tx.execute(sql`UPDATE nodes SET name = 'tmp' WHERE id = ${n.annaStamm}`);
		await node(n.deleted, null, 'folder', 'shared', ben, 'Material');
		await node(n.deletedChild, n.deleted, 'folder', 'shared', carla, 'Alt');
		await tx.execute(
			sql`UPDATE nodes SET deleted_at = now(), deleted_by = ${ben}
				WHERE id IN (${n.deleted}, ${n.deletedChild})`
		);
		await tx.execute(sql`UPDATE nodes SET trash_root = true WHERE id = ${n.deleted}`);
		await tx.execute(sql`UPDATE nodes SET name = 'Material' WHERE id = ${n.annaStamm}`);
		// Alter Link (vor 0003: ohne mode/token_enc)
		await tx.execute(
			sql`INSERT INTO share_links (id, node_id, token_hash, created_by)
				VALUES (${n.link}, ${n.annaStamm}, ${'hash-' + n.link}, ${anna})`
		);
	});
	await runMigration();
});

afterAll(async () => {
	await close?.();
});

describe('Migration 0003', () => {
	it('kein `shared` mehr; Teilbaum gehört der Wurzel-Anlegerin', async () => {
		const s = await snapshot();
		expect(s.nodes.filter((r) => r.space !== 'personal')).toEqual([]);
		const byId = new Map(s.nodes.map((r) => [r.id, r]));
		for (const id of [n.annaStamm, n.child, n.grandFile]) {
			expect(byId.get(id)!.owner_id, id).toBe(ids.anna);
		}
		for (const id of [n.benStamm, n.benChild, n.deleted, n.deletedChild]) {
			expect(byId.get(id)!.owner_id, id).toBe(ids.ben);
		}
		// `created_by` bleibt (Herkunft)
		expect(byId.get(n.child)!.created_by).toBe(ids.carla);
		expect(byId.get(n.grandFile)!.created_by).toBe(ids.ben);
		// eigene Wurzel unverändert
		expect(byId.get(n.annaPersonal)).toMatchObject({ name: 'Material', owner_id: ids.anna });
	});

	it('Namenskonflikt mit eigener Wurzel → „Material (Stamm …)“, sonst Name unverändert', async () => {
		const s = await snapshot();
		const byId = new Map(s.nodes.map((r) => [r.id, r]));
		expect(byId.get(n.annaStamm)!.name).toBe(`Material (Stamm ${n.annaStamm.slice(0, 8)})`);
		expect(byId.get(n.benStamm)!.name).toBe('Fahrten');
		expect(byId.get(n.child)!.name).toBe('Zelte');
		// gelöschter Knoten: bleibt im Papierkorb, Name unverändert (kein aktiver Konflikt)
		expect(byId.get(n.deleted)).toMatchObject({ name: 'Material', trash_root: true });
		expect(byId.get(n.deleted)!.deleted_at).not.toBeNull();
		expect(byId.get(n.deletedChild)!.deleted_at).not.toBeNull();
	});

	it('genau eine `everyone:*`-Lesefreigabe je Stamm-Wurzel, keine an Kindern', async () => {
		const s = await snapshot();
		const stamm = s.shares.filter((r) => r.principal_type === 'everyone');
		for (const id of [n.annaStamm, n.benStamm]) {
			const own = stamm.filter((r) => r.node_id === id);
			expect(own, id).toHaveLength(1);
			expect(own[0]).toMatchObject({ principal_id: '*', level: 'read' });
		}
		expect(stamm.find((r) => r.node_id === n.annaStamm)!.created_by).toBe(ids.anna);
		for (const id of [n.child, n.grandFile, n.benChild, n.annaPersonal]) {
			expect(
				s.shares.some((r) => r.node_id === id),
				id
			).toBe(false);
		}
		// alter Link: Art `view`, keine wieder abrufbare URL
		expect(s.links.find((l) => l.id === n.link)).toMatchObject({ mode: 'view', token_enc: null });
	});

	it('andere Person sieht den Ordner in ihrer Wurzel (stamm, read), darf nicht bearbeiten', async () => {
		const root = ok<FolderListing>(await call('carla', 'GET', '/nodes'));
		expect(root.breadcrumbs).toEqual([{ id: null, name: ROOT_LABEL }]);
		const m = root.items.find((i) => i.id === n.annaStamm)!;
		expect(m).toMatchObject({ stamm: true, own: false, access: 'read', canShare: false });
		expect(m.owner).toEqual({ id: ids.anna, name: 'Anna' });
		expect(root.items.some((i) => i.id === n.benStamm)).toBe(true);
		// Papierkorb und eigene Wurzel anderer bleiben verborgen
		expect(root.items.some((i) => i.id === n.deleted)).toBe(false);
		expect(root.items.some((i) => i.id === n.annaPersonal)).toBe(false);

		// Carla hat „Zelte“ angelegt – gehört jetzt Anna, Carla darf es nicht mehr bearbeiten
		const sub = ok<FolderListing>(await call('carla', 'GET', `/nodes?parent=${n.annaStamm}`));
		expect(sub.breadcrumbs.map((b) => b.name)).toEqual([ROOT_LABEL, m.name]);
		expect(sub.items.map((i) => i.id)).toEqual([n.child]);
		expect(sub.items[0]).toMatchObject({ ownerId: ids.anna, stamm: true, access: 'read' });
		const ren = await call('carla', 'PATCH', `/nodes/${n.child}`, { name: 'Neu' });
		expect(ren.status).toBe(403);
		expect(ren.body.error.code).toBe('forbidden');
		expect(
			(await call('carla', 'POST', '/folders', { parentId: n.annaStamm, name: 'X' })).status
		).toBe(403);
		expect((await upload('carla', n.annaStamm, 'x.txt')).status).toBe(403);
		expect((await call('carla', 'POST', '/nodes/trash', { ids: [n.child] })).status).toBe(403);
		expect(
			(await call('carla', 'PUT', `/nodes/${n.annaStamm}/shares`, { shares: [] })).status
		).toBe(403);

		// Eigentümerin hat edit, sieht beide „Material“-Ordner als eigene
		const anna = ok<FolderListing>(await call('anna', 'GET', '/nodes'));
		const mine = anna.items.filter((i) => String(i.name).startsWith('Material'));
		expect(mine.map((i) => i.id).sort()).toEqual([n.annaPersonal, n.annaStamm].sort());
		expect(mine.every((i) => i.own && i.access === 'edit' && i.canShare)).toBe(true);
		expect(ok<FileNode>(await call('anna', 'GET', `/nodes/${n.grandFile}`)).access).toBe('edit');
		// Ben sieht Annas Stamm-Ordner (read), seinen eigenen als eigenen
		const ben = ok<FolderListing>(await call('ben', 'GET', '/nodes'));
		expect(ben.items.find((i) => i.id === n.annaStamm)!.access).toBe('read');
		expect(ben.items.find((i) => i.id === n.benStamm)).toMatchObject({ own: true, stamm: true });
		// Bens gelöschter Stamm-Ordner liegt in seinem Papierkorb
		const trash = ok<{ id: string }[]>(await call('ben', 'GET', '/trash'));
		expect(trash.some((t) => t.id === n.deleted)).toBe(true);
	});

	it('idempotent: zweiter Lauf ändert nichts', async () => {
		const before = await snapshot();
		await runMigration();
		const after = await snapshot();
		expect(after).toEqual(before);
	});
});
