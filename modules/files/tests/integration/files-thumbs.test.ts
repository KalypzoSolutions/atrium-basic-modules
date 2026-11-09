/**
 * Modul `files` v1.3.0: Vorschaubilder für PDFs (erste Seite über `core.pdf.renderPage`), kaputte PDFs ohne
 * Vorschau, Nachziehen für den Bestand (Job `files.thumbs-backfill`, Migration 0005) – je Datei genau ein Versuch.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { useTestDatabase } from '$testing';
import { installFakeStorage, uninstallFakeStorage } from '$testing';
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
import { renderPdfPage } from '$testing';
import filesModule from '$modules/files/module';
import { runBackfill } from '$modules/files/thumbs.service';
import type { FileNode } from '$modules/files/schemas';
import type { RequestContext } from '$lib/sdk/types';

const ROOT = 'http://localhost:5173/api/v1/modules/files';
const PW = 'a-long-enough-pw';
let key = '';
let close: () => Promise<void>;
let admin: RequestContext;

async function send(method: string, path: string, init: RequestInit = {}) {
	resetAllForTests();
	const url = new URL(ROOT + path);
	const headers = new Headers(init.headers);
	headers.set('authorization', `Bearer ${key}`);
	return handleApiRequest({
		request: new Request(url, { ...init, method, headers }),
		url,
		ip: '127.0.0.1'
	});
}

async function upload(name: string, bytes: Uint8Array, type: string): Promise<FileNode> {
	const form = new FormData();
	form.set('file', new File([new Uint8Array(bytes)], name, { type }));
	const r = new Response(form);
	const buf = new Uint8Array(await r.arrayBuffer());
	const res = await send('POST', '/nodes/root/upload', {
		headers: {
			'content-type': r.headers.get('content-type')!,
			'content-length': String(buf.byteLength)
		},
		body: buf
	});
	expect(res.status).toBe(201);
	return ((await res.json()) as { data: FileNode }).data;
}

async function node(id: string): Promise<FileNode> {
	const res = await send('GET', `/nodes/${id}`);
	expect(res.status).toBe(200);
	return ((await res.json()) as { data: FileNode }).data;
}

async function samplePdf(pages = 1): Promise<Uint8Array> {
	const doc = await PDFDocument.create();
	const font = await doc.embedFont(StandardFonts.Helvetica);
	for (let i = 0; i < pages; i++) {
		doc.addPage([595, 842]).drawText(`Seite ${i + 1}`, { x: 50, y: 780, size: 30, font });
	}
	return doc.save();
}

/** Vorschau-Zustand zurücksetzen, als stamme die Datei aus der Zeit vor Migration 0005 */
async function makeLegacy(id: string) {
	await getDb().execute(
		sql`UPDATE mod_files.nodes SET thumb_path = NULL, thumb_attempted_at = NULL WHERE id = ${id}`
	);
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
	admin = (await contextForUser(u!.id))!.ctx;
	await enableModule(admin, 'files');
	admin = (await contextForUser(u!.id))!.ctx;
	await installFakeStorage(admin);
	const role = await createRole(admin, {
		name: 'Dateien Basis',
		permissions: ['files.file.view', 'core.api.manage']
	});
	const id = await createUser(admin, {
		name: 'Ute',
		email: 'ute@example.test',
		password: PW,
		roleIds: [role]
	});
	const c = (await contextForUser(id))!.ctx;
	key = (await createApiKey(c, { name: 'k', scopes: [...c.permissions] })).key;
});

afterAll(async () => {
	uninstallFakeStorage();
	await close?.();
});

describe('core.pdf.renderPage', () => {
	it('rendert die erste Seite als PNG in der gewünschten Größe', async () => {
		const out = await renderPdfPage(await samplePdf(3), { maxEdge: 200 });
		expect(out.pageCount).toBe(3);
		expect(Math.max(out.width, out.height)).toBe(200);
		expect([...out.png.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
	});

	it('lehnt Nicht-PDFs und fehlende Seiten ab', async () => {
		await expect(renderPdfPage(new TextEncoder().encode('hallo'))).rejects.toMatchObject({
			code: 'validation_failed'
		});
		await expect(renderPdfPage(await samplePdf(1), { page: 2 })).rejects.toMatchObject({
			code: 'not_found'
		});
	});
});

describe('PDF-Vorschau beim Upload', () => {
	it('legt ein WebP-Vorschaubild der ersten Seite an', async () => {
		const n = await upload('Plan.pdf', await samplePdf(2), 'application/pdf');
		expect(n.hasThumb).toBe(true);
		const res = await send('GET', `/nodes/${n.id}/thumb`);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toBe('image/webp');
		const bytes = new Uint8Array(await res.arrayBuffer());
		expect(new TextDecoder().decode(bytes.subarray(8, 12))).toBe('WEBP');
	});

	it('kaputtes PDF: Upload klappt, nur ohne Vorschau', async () => {
		const n = await upload(
			'Kaputt.pdf',
			new TextEncoder().encode('%PDF-1.7\nkein echtes PDF'),
			'application/pdf'
		);
		expect(n.hasThumb).toBe(false);
		expect((await send('GET', `/nodes/${n.id}/thumb`)).status).toBe(404);
	});
});

describe('Job files.thumbs-backfill', () => {
	it('erzeugt fehlende Vorschauen für den Bestand genau einmal', async () => {
		const pdf = await upload('Alt.pdf', await samplePdf(), 'application/pdf');
		const broken = await upload(
			'AltKaputt.pdf',
			new TextEncoder().encode('%PDF-1.4\nnichts'),
			'application/pdf'
		);
		const text = await upload('Notiz.txt', new TextEncoder().encode('Hallo'), 'text/plain');
		for (const id of [pdf.id, broken.id, text.id]) await makeLegacy(id);
		expect((await node(pdf.id)).hasThumb).toBe(false);

		const first = await runBackfill();
		expect(first).toMatchObject({ created: 1, failed: 1, stopped: false });
		expect((await node(pdf.id)).hasThumb).toBe(true);
		expect((await node(broken.id)).hasThumb).toBe(false);

		// zweiter Lauf: nichts mehr offen (auch das kaputte PDF und die Textdatei nicht)
		expect(await runBackfill()).toMatchObject({ created: 0, failed: 0, skipped: 0 });
	});

	it('neue Uploads gelten als versucht', async () => {
		await upload('Neu.pdf', await samplePdf(), 'application/pdf');
		expect(await runBackfill()).toMatchObject({ created: 0, failed: 0 });
	});
});
