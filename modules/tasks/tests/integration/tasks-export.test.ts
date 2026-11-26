/**
 * Export von Aufgaben (`POST /boards/:id/export`, `/tasks/:id/export`, `/my/tasks/export`): Formate PDF, PNG
 * (eine Seite → PNG, mehrere → ZIP, zu viele → 422), HTML, CSV, Markdown; Gruppierung, gefilterte Aufgaben,
 * erledigte ausblenden, ausführlich mit Unteraufgaben; Sichtbarkeit wie beim Lesen (Zuweisung reicht, Fremde 404,
 * ohne Recht 403); Texte maskiert, CSV mit Formelschutz; Audit ohne Inhalte.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { unzipSync } from 'fflate';
import { PDFDocument } from 'pdf-lib';
import { setTodayForTests } from '$lib/sdk/dates';
import type { RequestContext } from '$lib/sdk/types';
import tasksModule from '$modules/tasks/module';
import type { BoardDetail, TaskDetail } from '$modules/tasks/schemas';
import {
	bootstrapAdmin,
	contextForUser,
	createApiKey,
	createRole,
	createUser,
	enableModule,
	getDb,
	handleApiRequest,
	listAudit,
	registerCoreApi,
	registerModule,
	resetAllForTests,
	schema,
	setPdfRendererForTests,
	syncModules,
	useTestDatabase
} from '$testing';

const ROOT = 'http://localhost:5173/api/v1/modules/tasks';
const keys: Record<string, string> = {};
const userIds: Record<string, string> = {};
let admin: RequestContext;
let close: () => Promise<void>;
/** HTML, das der PDF-Renderer zuletzt bekommen hat */
let pdfHtml = '';
/** Seitenzahl des Ersatz-PDFs */
let pdfPages = 1;

async function request(who: string, method: string, path: string, json?: unknown) {
	resetAllForTests();
	const headers = new Headers({ authorization: `Bearer ${keys[who]}` });
	if (json !== undefined) headers.set('content-type', 'application/json');
	const url = new URL(`${ROOT}${path}`);
	return handleApiRequest({
		request: new Request(url, {
			method,
			headers,
			body: json === undefined ? undefined : JSON.stringify(json)
		}),
		url,
		ip: '127.0.0.1'
	});
}

async function data<T>(who: string, method: string, path: string, json?: unknown): Promise<T> {
	const res = await request(who, method, path, json);
	const body = await res.json();
	expect(res.status, JSON.stringify(body)).toBeLessThan(300);
	return body.data as T;
}

async function download(who: string, path: string, json: unknown) {
	const res = await request(who, 'POST', path, json);
	if (res.status !== 200) throw new Error(`${res.status} ${await res.text()}`);
	return {
		type: res.headers.get('content-type') ?? '',
		disposition: res.headers.get('content-disposition') ?? '',
		bytes: new Uint8Array(await res.arrayBuffer())
	};
}
const text = (b: Uint8Array) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(b);

const ctxOf = async (id: string) => (await contextForUser(id))!.ctx;

async function addUser(who: string, roleId: string) {
	userIds[who] = await createUser(admin, {
		name: `Person ${who}`,
		email: `${who}@example.test`,
		password: 'a-long-enough-pw',
		roleIds: [roleId]
	});
	const ctx = await ctxOf(userIds[who]!);
	keys[who] = (await createApiKey(ctx, { name: who, scopes: [...ctx.permissions] })).key;
}

let boardId: string;
let taskId: string;
let otherId: string;
let doneId: string;

beforeAll(async () => {
	({ close } = await useTestDatabase());
	registerCoreApi();
	registerModule(tasksModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', 'correct-horse-battery');
	const [u] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	admin = await ctxOf(u!.id);
	await enableModule(admin, 'tasks');
	admin = await ctxOf(u!.id);
	setTodayForTests('2026-11-18');
	setPdfRendererForTests(async (html) => {
		pdfHtml = html;
		const doc = await PDFDocument.create();
		for (let i = 0; i < pdfPages; i++) doc.addPage([595, 842]);
		return doc.save();
	});

	const base = ['core.api.manage', 'tasks.board.view'];
	const planner = await createRole(admin, {
		name: 'Planung',
		permissions: [...base, 'tasks.board.create']
	});
	const viewer = await createRole(admin, { name: 'Mitmachen', permissions: base });
	const none = await createRole(admin, { name: 'Ohne', permissions: ['core.api.manage'] });
	await addUser('owner', planner);
	await addUser('helper', viewer);
	await addUser('stranger', viewer);
	await addUser('outsider', none);

	const board = await data<BoardDetail>('owner', 'POST', '/boards', {
		name: 'Sommerlager 2027',
		description: 'Alles für das Lager'
	});
	boardId = board.id;
	const withPhase = await data<BoardDetail>('owner', 'POST', `/boards/${boardId}/phases`, {
		name: 'Vorbereitung',
		color: '#2563eb'
	});
	const phaseId = withPhase.phases[0]!.id;
	const [open, , done] = board.columns;
	taskId = (
		await data<TaskDetail>('owner', 'POST', `/boards/${boardId}/tasks`, {
			columnId: open!.id,
			title: 'Zeltplatz <b>buchen</b>',
			description: 'Anrufen beim Förster.\n\n<script>alert(1)</script>',
			priority: 'high',
			startsOn: '2026-12-01',
			dueOn: '2026-12-15',
			phaseId,
			assigneeIds: [userIds.helper],
			checklist: [
				{ title: 'Angebot einholen', done: true },
				{ title: 'Anzahlung überweisen', assigneeId: userIds.owner, dueOn: '2026-12-20' }
			]
		})
	).id;
	otherId = (
		await data<TaskDetail>('owner', 'POST', `/boards/${boardId}/tasks`, {
			columnId: open!.id,
			title: '=SUMME(1;2)',
			priority: 'low'
		})
	).id;
	doneId = (
		await data<TaskDetail>('owner', 'POST', `/boards/${boardId}/tasks`, {
			columnId: done!.id,
			title: 'Termin festlegen',
			isMilestone: true,
			dueOn: '2026-11-01'
		})
	).id;
});

afterAll(async () => {
	setTodayForTests(null);
	setPdfRendererForTests(undefined);
	await close?.();
});

describe('Board-Export', () => {
	it('HTML: eigenständige Datei als Anhang, Spalten als Abschnitte, Texte maskiert', async () => {
		const res = await download('owner', `/boards/${boardId}/export`, { format: 'html' });
		expect(res.type).toBe('text/html; charset=utf-8');
		expect(res.disposition).toContain('attachment');
		expect(res.disposition).toContain('Sommerlager_2027.html');
		const html = text(res.bytes);
		expect(html).toMatch(/^<!doctype html>/);
		expect(html).toContain('<h1>Sommerlager 2027</h1>');
		expect(html).toContain('Alles für das Lager');
		expect(html).toContain('Zeltplatz &lt;b&gt;buchen&lt;/b&gt;');
		expect(html).not.toContain('<b>buchen');
		// Abschnitte je Spalte mit Anzahl, Phase als Zusatzspalte
		expect(html).toMatch(/Offen <span[^>]*>· 2 Aufgaben/);
		expect(html).toMatch(/Erledigt <span[^>]*>· 1 Aufgabe</);
		expect(html).toContain('<th style="width: ');
		expect(html).toContain('>Phase</th>');
		expect(html).toContain('01.12.2026 – 15.12.2026');
		expect(html).toContain('◆ 01.11.2026');
		expect(html).toContain('<td>1/2</td>');
		expect(html).not.toContain('<script');
	});

	it('ausführlich: Beschreibung und Unteraufgaben als Checkliste', async () => {
		const html = text(
			(await download('owner', `/boards/${boardId}/export`, { format: 'html', detailed: true }))
				.bytes
		);
		expect(html).toContain('Anrufen beim Förster.');
		expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
		expect(html).toContain(
			'<li class="task-item checked"><input type="checkbox" disabled checked><div>Angebot einholen</div>'
		);
		expect(html).toContain('Anzahlung überweisen (Person owner, bis 20.12.2026)');
		expect(html).toContain('Zuständig: Person helper');
	});

	it('CSV: eine Zeile je Aufgabe, Formelschutz, BOM', async () => {
		const res = await download('owner', `/boards/${boardId}/export`, { format: 'csv' });
		expect(res.type).toBe('text/csv; charset=utf-8');
		const csv = text(res.bytes);
		expect(csv.startsWith('﻿Spalte;Phase;Aufgabe;Erledigt;')).toBe(true);
		const lines = csv.trim().split('\r\n');
		expect(lines).toHaveLength(4);
		expect(csv).toContain("'=SUMME(1;2)");
		expect(csv).toContain(
			'Offen;Vorbereitung;Zeltplatz <b>buchen</b>;nein;Hoch;01.12.2026;15.12.2026;nein;Person helper;1;2;'
		);
		expect(csv).toContain('Erledigt;;Termin festlegen;ja;');
	});

	it('Markdown: Checklisten, nach Phasen gruppiert', async () => {
		const res = await download('owner', `/boards/${boardId}/export`, {
			format: 'md',
			groupBy: 'phase'
		});
		expect(res.type).toBe('text/markdown; charset=utf-8');
		const md = text(res.bytes);
		expect(md).toContain('# Sommerlager 2027');
		expect(md).toContain('## Vorbereitung');
		expect(md).toContain('## Ohne Phase');
		expect(md).toContain('- [ ] **Zeltplatz \\<b\\>buchen\\</b\\>**');
		expect(md).toContain('- [x] **Termin festlegen**');
		expect(md).toContain('Spalte: Offen');
	});

	it('nur gefilterte Aufgaben, ohne erledigte, Filter in der Kopfzeile', async () => {
		const md = text(
			(
				await download('owner', `/boards/${boardId}/export`, {
					format: 'md',
					groupBy: 'none',
					includeDone: false,
					taskIds: [taskId, doneId],
					filterLabel: 'Filter: Nur meine'
				})
			).bytes
		);
		expect(md).toContain('Zeltplatz');
		expect(md).not.toContain('SUMME');
		expect(md).not.toContain('Termin festlegen');
		expect(md).toContain('_Filter: Nur meine_');
		expect(md).toContain('_Ohne erledigte Aufgaben_');
		expect(md).toContain('1 Aufgabe');
	});

	it('PDF: Inhalt als richText über den Core, Titel der Vorlage', async () => {
		const res = await download('owner', `/boards/${boardId}/export`, { format: 'pdf' });
		expect(res.type).toBe('application/pdf');
		expect(text(res.bytes.slice(0, 5))).toBe('%PDF-');
		expect(pdfHtml).toContain('Sommerlager 2027');
		expect(pdfHtml).toContain('Zeltplatz &lt;b&gt;buchen&lt;/b&gt;');
		expect(pdfHtml).toContain('<table>');
	});

	it('PNG: eine Seite als Bild, mehrere als ZIP, zu viele → 422', async () => {
		pdfPages = 1;
		const one = await download('owner', `/boards/${boardId}/export`, { format: 'png' });
		expect(one.type).toBe('image/png');
		expect([...one.bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
		expect(one.disposition).toContain('.png');

		pdfPages = 3;
		const many = await download('owner', `/boards/${boardId}/export`, { format: 'png' });
		expect(many.type).toBe('application/zip');
		const files = Object.keys(unzipSync(many.bytes)).sort();
		expect(files).toEqual([
			'Sommerlager_2027-seite-01.png',
			'Sommerlager_2027-seite-02.png',
			'Sommerlager_2027-seite-03.png'
		]);

		pdfPages = 31;
		const res = await request('owner', 'POST', `/boards/${boardId}/export`, { format: 'png' });
		expect(res.status).toBe(422);
		expect(JSON.stringify(await res.json())).toContain('31 Seiten');
		pdfPages = 1;
	});

	it('Zugriff: zugewiesen darf, Fremde 404, ohne Recht 403, falsches Format 422', async () => {
		const res = await download('helper', `/boards/${boardId}/export`, { format: 'csv' });
		expect(text(res.bytes)).toContain('Zeltplatz');
		expect(
			(await request('stranger', 'POST', `/boards/${boardId}/export`, { format: 'csv' })).status
		).toBe(404);
		expect(
			(await request('outsider', 'POST', `/boards/${boardId}/export`, { format: 'csv' })).status
		).toBe(403);
		expect(
			(await request('owner', 'POST', `/boards/${boardId}/export`, { format: 'docx' })).status
		).toBe(422);
		expect(
			(await request('owner', 'POST', `/boards/${boardId}/export`, { format: 'csv', extra: 1 }))
				.status
		).toBe(422);
	});
});

describe('Aufgaben-Export', () => {
	it('eine Aufgabe ausführlich, ohne doppelte Überschrift', async () => {
		const res = await download('helper', `/tasks/${taskId}/export`, { format: 'html' });
		const html = text(res.bytes);
		expect(res.disposition).toContain('Zeltplatz_b_buchen_b.html');
		expect(html).toContain('<h1>Zeltplatz &lt;b&gt;buchen&lt;/b&gt;</h1>');
		expect(html).not.toContain('<h3>');
		expect(html).toContain('Board: Sommerlager 2027');
		expect(html).toContain('Anzahlung überweisen');
		const md = text((await download('helper', `/tasks/${taskId}/export`, { format: 'md' })).bytes);
		expect(md).toContain('- [x] Angebot einholen');
		expect(md).toContain('- [ ] Anzahlung überweisen (Person owner, bis 20.12.2026)');
	});

	it('nicht zugewiesene Aufgabe eines fremden Boards → 404', async () => {
		expect(
			(await request('stranger', 'POST', `/tasks/${otherId}/export`, { format: 'md' })).status
		).toBe(404);
	});
});

describe('Meine Aufgaben', () => {
	it('nur mir zugewiesene, nach Board gruppiert', async () => {
		const helper = text(
			(await download('helper', '/my/tasks/export', { format: 'md', detailed: true })).bytes
		);
		expect(helper).toContain('# Meine Aufgaben');
		expect(helper).toContain('## Sommerlager 2027');
		expect(helper).toContain('Zeltplatz');
		expect(helper).not.toContain('SUMME');
		// über die offene Unteraufgabe zugewiesen
		const owner = text((await download('owner', '/my/tasks/export', { format: 'csv' })).bytes);
		expect(owner).toContain('Zeltplatz');
		const stranger = text((await download('stranger', '/my/tasks/export', { format: 'md' })).bytes);
		expect(stranger).toContain('Keine Aufgaben.');
	});
});

describe('Audit', () => {
	it('protokolliert Format und Anzahl, keine Inhalte', async () => {
		const { rows } = await listAudit({ action: 'tasks.export.created', limit: 100 });
		expect(rows.length).toBeGreaterThan(5);
		const meta = JSON.stringify(rows.map((r) => r.metadata));
		expect(meta).toContain('"scope":"board"');
		expect(meta).toContain('"scope":"task"');
		expect(meta).toContain('"scope":"my"');
		expect(meta).not.toContain('Zeltplatz');
		expect(meta).not.toContain('Sommerlager');
	});
});
