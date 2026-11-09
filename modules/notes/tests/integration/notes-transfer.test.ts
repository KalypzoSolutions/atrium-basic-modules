/**
 * Modul `notes`: Export (md, zip, html, docx, pdf – mit Unterseiten, Bildern, Einbettungen) und Import (.md, .zip mit
 * Bildern, Unterseiten aus Ordnern), Zugriff (fremd → 404, ohne Anlegen-Recht → 403), manipulierte Archive → 422, Audit.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { useTestDatabase } from '$testing';
import { installFakeStorage } from '$testing';
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
import { listAudit } from '$testing';
import { setPdfRendererForTests } from '$testing';
import { core } from '$testing';
import { rowsOf } from '$lib/sdk/server';
import notesModule from '$modules/notes/module';
import whiteboardModule from '$modules/whiteboard/module';
import { resetDocsForTests } from '$modules/notes/doc.service';
import type { NoteDetail, NoteNode } from '$modules/notes/schemas';
import type { RequestContext } from '$lib/sdk/types';

const ROOT = 'http://localhost:5173/api/v1/modules';
const keys: Record<string, string> = {};
let admin: RequestContext;
let close: () => Promise<void>;
let pdfHtml = '';

interface Res<T = unknown> {
	status: number;
	body: { data?: T; error?: { code: string; details?: unknown } };
}

async function raw(
	who: string,
	method: string,
	path: string,
	init: { body?: BodyInit; json?: boolean; moduleId?: string } = {}
): Promise<Response> {
	resetAllForTests();
	const headers = new Headers({ authorization: `Bearer ${keys[who]}` });
	if (init.json) headers.set('content-type', 'application/json');
	const url = new URL(`${ROOT}/${init.moduleId ?? 'notes'}${path}`);
	return handleApiRequest({
		request: new Request(url, { method, headers, body: init.body }),
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
		json: json !== undefined,
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
	const ctx = await ctxOf(id);
	keys[who] = (await createApiKey(ctx, { name: who, scopes: [...ctx.permissions] })).key;
}

async function png(width = 120, height = 80): Promise<Uint8Array> {
	return new Uint8Array(
		await sharp({ create: { width, height, channels: 3, background: '#2266aa' } })
			.png()
			.toBuffer()
	);
}

async function importFile(
	who: string,
	bytes: Uint8Array | string,
	name: string,
	parentId?: string
): Promise<Res<{ id: string }>> {
	const fd = new FormData();
	fd.set('file', new File([bytes as BlobPart], name, { type: 'application/octet-stream' }));
	if (parentId) fd.set('parentId', parentId);
	const res = await raw(who, 'POST', '/notes/import', { body: fd });
	return { status: res.status, body: await res.json() };
}

const exportUrl = (id: string, format: string, extra = '') =>
	`/notes/${id}/export?format=${format}${extra}`;

let boardId: string;
let rootId: string;
let childId: string;
let zipRootId: string;

beforeAll(async () => {
	({ close } = await useTestDatabase());
	registerCoreApi();
	registerModule(notesModule);
	registerModule(whiteboardModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', 'correct-horse-battery');
	const [u] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	admin = await ctxOf(u!.id);
	for (const id of ['notes', 'whiteboard']) await enableModule(admin, id);
	admin = await ctxOf(u!.id);
	await installFakeStorage(admin);
	setPdfRendererForTests(async (html) => {
		pdfHtml = html;
		return new Uint8Array(Buffer.from('%PDF-1.4 test'));
	});
	const writer = await createRole(admin, {
		name: 'Schreiben',
		permissions: [
			'core.api.manage',
			'notes.note.view',
			'notes.note.create',
			'whiteboard.board.view',
			'whiteboard.board.create'
		]
	});
	const reader = await createRole(admin, {
		name: 'Lesen',
		permissions: ['core.api.manage', 'notes.note.view']
	});
	await addUser('owner', writer);
	await addUser('other', writer);
	await addUser('reader', reader);

	boardId = ok<{ id: string }>(
		await call('owner', 'POST', '/boards', { name: 'Lagerplan' }, 'whiteboard'),
		201
	).id;
});

afterAll(async () => {
	setPdfRendererForTests(undefined);
	await resetDocsForTests();
	await close?.();
});

describe('Export', () => {
	it('legt Notiz mit Unterseite und Einbettung an', async () => {
		const root = ok<NoteDetail>(
			await call('owner', 'POST', '/notes', {
				title: 'Lager <2026>',
				markdown: [
					'Text mit **fett** und [Link](https://example.org)',
					'',
					'- [x] erledigt',
					'',
					'| A | B |',
					'|---|---|',
					'| 1 | 2 |',
					'',
					`:::embed {module="whiteboard" kind="board" refId="${boardId}" height="480"} :::`,
					'',
					'Ende'
				].join('\n')
			}),
			201
		);
		rootId = root.id;
		childId = ok<NoteDetail>(
			await call('owner', 'POST', '/notes', {
				title: 'Planung',
				parentId: rootId,
				markdown: 'Unterseite mit Inhalt'
			}),
			201
		).id;
	});

	it('Markdown: Titel, Unterseiten, Einbettung als absoluter Link', async () => {
		const res = await raw('owner', 'GET', exportUrl(rootId, 'md', '&subpages=1'));
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
		expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
		expect(res.headers.get('content-disposition')).toContain('.md');
		const md = await res.text();
		expect(md).toContain('# Lager <2026>');
		expect(md).toContain('**fett**');
		expect(md).toContain('# Planung');
		expect(md).toContain('Unterseite mit Inhalt');
		expect(md).toMatch(
			new RegExp(`\\[Whiteboard: Lagerplan\\]\\(https?://[^)]+/modules/whiteboard/${boardId}\\)`)
		);
		// ohne Unterseiten
		const only = await (await raw('owner', 'GET', exportUrl(rootId, 'md'))).text();
		expect(only).not.toContain('Planung');
	});

	it('HTML: Download mit CSP, alles escaped', async () => {
		const res = await raw('owner', 'GET', exportUrl(rootId, 'html', '&subpages=1'));
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
		expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
		expect(res.headers.get('content-security-policy')).toContain('sandbox');
		const html = await res.text();
		expect(html).toContain('<title>Lager &lt;2026&gt;</title>');
		expect(html).toContain('<strong>fett</strong>');
		expect(html).toContain('task-item checked');
		expect(html).toContain('<table>');
		expect(html).toContain('Whiteboard: Lagerplan');
		expect(html).not.toContain('<script');
	});

	it('Word: gültige .docx', async () => {
		const res = await raw('owner', 'GET', exportUrl(rootId, 'docx', '&subpages=1'));
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe(
			'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
		);
		const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
		const xml = strFromU8(files['word/document.xml']!);
		expect(xml).toContain('Planung');
		expect(xml).toContain('☑');
	});

	it('PDF: richText-Block, Briefkopf wählbar', async () => {
		const res = await raw('owner', 'GET', exportUrl(rootId, 'pdf', '&subpages=1&letterhead=1'));
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('application/pdf');
		expect(pdfHtml).toContain('class="rich-text"');
		expect(pdfHtml).toContain('<strong>fett</strong>');
		expect(pdfHtml).toContain('<h1>Planung</h1>');
		expect(pdfHtml).toContain('page-break');
		const plain = await raw('owner', 'GET', exportUrl(rootId, 'pdf'));
		expect(plain.status).toBe(200);
		expect(pdfHtml).not.toContain('Planung');
	});

	it('fremd → 404, ungültiges Format → 422', async () => {
		fail(await call('other', 'GET', exportUrl(rootId, 'md')), 404, 'not_found');
		fail(await call('owner', 'GET', exportUrl(rootId, 'exe')), 422, 'validation_failed');
	});
});

describe('Import', () => {
	it('.md ohne Oberseite: Titel aus H1', async () => {
		const { id } = ok(
			await importFile('owner', '# Packliste\n\n- Zelt\n- Schlafsack', 'liste.md'),
			201
		);
		const detail = ok<NoteDetail>(await call('owner', 'GET', `/notes/${id}`));
		expect(detail.title).toBe('Packliste');
		const md = await (await raw('owner', 'GET', exportUrl(id, 'md'))).text();
		expect(md).toContain('Schlafsack');
		expect(md.match(/Packliste/g)).toHaveLength(1);
	});

	it('ohne Anlegen-Recht 403, fremde Oberseite 404, eigene Oberseite → Unterseite', async () => {
		fail(await importFile('reader', 'x', 'a.md'), 403, 'forbidden');
		fail(await importFile('other', 'x', 'a.md', rootId), 404, 'not_found');
		fail(await importFile('owner', 'x', 'a.exe'), 422, 'validation_failed');
		const { id } = ok(
			await importFile('owner', 'Nur Text', 'Notizen vom Treffen.txt', rootId),
			201
		);
		const children = ok<NoteNode[]>(await call('owner', 'GET', `/notes/${rootId}/children`));
		const hit = children.find((c) => c.id === id);
		expect(hit?.title).toBe('Notizen vom Treffen');
		expect(hit?.ownerId).toBe(children.find((c) => c.id === childId)?.ownerId);
	});

	it('.zip: Ordner → Unterseiten, Bilder aus dem Archiv, externe nicht', async () => {
		const zip = zipSync({
			'Lager.md': strToU8(
				'# Lager\n\n![Zelt](bilder/zelt.png)\n\n![Extern](https://evil.test/x.png)'
			),
			'Lager/Planung.md': strToU8('# Planung\n\n![Wieder](../bilder/zelt.png)'),
			'Lager/Küche/Rezepte.md': strToU8('Nudeln'),
			'bilder/zelt.png': await png(),
			'bilder/kaputt.png': strToU8('kein Bild')
		});
		const { id } = ok(await importFile('owner', zip, 'export.zip'), 201);
		zipRootId = id;
		const root = ok<NoteDetail>(await call('owner', 'GET', `/notes/${id}`));
		expect(root.title).toBe('Lager');
		const children = ok<NoteNode[]>(await call('owner', 'GET', `/notes/${id}/children`));
		expect(children.map((c) => c.title)).toEqual(['Küche', 'Planung']);
		const kitchen = children.find((c) => c.title === 'Küche')!;
		const grand = ok<NoteNode[]>(await call('owner', 'GET', `/notes/${kitchen.id}/children`));
		expect(grand.map((c) => c.title)).toEqual(['Rezepte']);

		const rows = await core.database
			.forModule('notes')
			.transaction((tx) => rowsOf(tx, sql`SELECT note_id, paths FROM note_assets`));
		// je Seite ein eigenes Asset (gleiche Datei in zwei Seiten)
		expect(rows).toHaveLength(2);
		expect(JSON.stringify(rows)).toContain(`notes/${id}/`);

		// Rundreise: ZIP-Export enthält das Bild und verlinkt es relativ
		const res = await raw('owner', 'GET', exportUrl(id, 'zip', '&subpages=1'));
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('application/zip');
		const files = unzipSync(new Uint8Array(await res.arrayBuffer()));
		const names = Object.keys(files);
		expect(names).toContain('Lager.md');
		expect(names).toContain('Lager/Planung.md');
		expect(names).toContain('Lager/Küche/Rezepte.md');
		const images = names.filter((n) => n.startsWith('bilder/'));
		expect(images.length).toBe(2);
		const lager = strFromU8(files['Lager.md']!);
		expect(lager).toMatch(/!\[Zelt\]\(bilder\/1-.+\.webp\)/);
		expect(lager).not.toContain('evil.test');
		expect(lager).toContain('Bild: Extern');
		expect(strFromU8(files['Lager/Planung.md']!)).toMatch(/\(\.\.\/bilder\/2-.+\.webp\)/);

		// PDF bettet Bilder als data-URL ein
		await raw('owner', 'GET', exportUrl(id, 'pdf', '&subpages=1'));
		expect(pdfHtml).toContain('data:image/webp;base64,');
		// .md verlinkt Bilder in die App
		const md = await (await raw('owner', 'GET', exportUrl(id, 'md'))).text();
		expect(md).toMatch(
			/\[Bild: Zelt\]\(https?:\/\/[^)]+\/api\/v1\/modules\/notes\/assets\/[0-9a-f-]{36}\/web\)/
		);
	});

	it('mehrere oberste Seiten → Hülle mit Archivnamen', async () => {
		const zip = zipSync({ 'A.md': strToU8('a'), 'B.md': strToU8('b') });
		const { id } = ok(await importFile('owner', zip, 'Sammlung.zip'), 201);
		expect(ok<NoteDetail>(await call('owner', 'GET', `/notes/${id}`)).title).toBe('Sammlung');
		const children = ok<NoteNode[]>(await call('owner', 'GET', `/notes/${id}/children`));
		expect(children.map((c) => c.title)).toEqual(['A', 'B']);
	});

	it('manipuliertes ZIP (../, absolut, kaputt, zu tief) → 422', async () => {
		fail(
			await importFile('owner', zipSync({ '../boese.md': strToU8('x') }), 'x.zip'),
			422,
			'validation_failed'
		);
		fail(
			await importFile('owner', zipSync({ '/etc/boese.md': strToU8('x') }), 'x.zip'),
			422,
			'validation_failed'
		);
		fail(await importFile('owner', strToU8('PK kaputt'), 'x.zip'), 422, 'validation_failed');
		fail(
			await importFile('owner', zipSync({ 'bild.png': await png() }), 'x.zip'),
			422,
			'validation_failed'
		);
		const deep = Array.from({ length: 11 }, (_, i) => `e${i}`).join('/');
		fail(
			await importFile('owner', zipSync({ [`${deep}.md`]: strToU8('x') }), 'x.zip'),
			422,
			'validation_failed'
		);
	});

	it('Audit ohne Inhalte', async () => {
		const exported = await listAudit({ action: 'notes.note.exported', limit: 50 });
		expect(exported.rows.length).toBeGreaterThan(0);
		const imported = await listAudit({ action: 'notes.note.imported', limit: 50 });
		const entry = imported.rows.find((e) => e.target === zipRootId);
		expect(entry?.metadata).toMatchObject({ pages: 4, images: 2, zip: true });
		expect(JSON.stringify(imported.rows)).not.toContain('Nudeln');
	});
});
