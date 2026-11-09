/**
 * Modul `whiteboard`: Anlegen, Zugriffsmatrix (Eigentümer*in, Rollen-/Benutzer-Freigabe, fremd → 404),
 * Änderungen mit Versionen/Grabsteinen, Live-Stream (SSE) mit Nachholen, Anwesenheit und Rechteentzug,
 * ohne `members`/`actions` (Gruppen-Freigabe 422, Aktionen nicht verfügbar), Dateien (Bild/PDF),
 * Versionsverlauf, Export → Import, PDF-Export, Karten je Betrachter*in, Aufräum-Job, Audit ohne Inhalte,
 * Konto löschen, Modul aus.
 *
 * Fälle mit `members`/`actions` (Gruppen-Freigabe, mehrere Boards je Aktion, Aktions-Karten) liegen in
 * `ep-intern-modules` unter `modules/_integration/tests/integration/whiteboard-actions.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';
import { unzipSync, strFromU8, zipSync, strToU8 } from 'fflate';
import { useTestDatabase } from '$testing';
import { installFakeStorage } from '$testing';
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
import { listAudit } from '$testing';
import { setPdfRendererForTests } from '$testing';
import { core } from '$testing';
import tasksModule from '$modules/tasks/module';
import whiteboardModule from '$modules/whiteboard/module';
import { closeAllStreamsForTests } from '$modules/whiteboard/live';
import { onUserDeleted } from '$modules/whiteboard/privacy';
import { runAutoSnapshots, runCleanup } from '$modules/whiteboard/snapshots.service';
import type {
	Asset,
	BoardDetail,
	BoardList,
	LiveEvent,
	OpsResult,
	RefCard,
	Snapshot,
	UserPrefs
} from '$modules/whiteboard/schemas';
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
	body?: BodyInit,
	json = false,
	moduleId = 'whiteboard',
	signal?: AbortSignal
): Promise<Response> {
	resetAllForTests();
	const headers = new Headers({ authorization: `Bearer ${keys[who]}` });
	if (json) headers.set('content-type', 'application/json');
	const url = new URL(`${ROOT}/${moduleId}${path}`);
	return handleApiRequest({
		request: new Request(url, { method, headers, body, signal }),
		url,
		ip: '127.0.0.1'
	});
}

async function call<T = unknown>(
	who: string,
	method: string,
	path: string,
	json?: unknown,
	moduleId = 'whiteboard'
): Promise<Res<T>> {
	const res = await raw(
		who,
		method,
		path,
		json === undefined ? undefined : JSON.stringify(json),
		json !== undefined,
		moduleId
	);
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
async function openLive(who: string, boardId: string, client: string, since?: number) {
	const ac = new AbortController();
	const res = await raw(
		who,
		'GET',
		`/boards/${boardId}/live?client=${client}${since === undefined ? '' : `&since=${since}`}`,
		undefined,
		false,
		'whiteboard',
		ac.signal
	);
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
	return {
		status: res.status,
		events,
		waitFor,
		isEnded: () => ended,
		close: () => ac.abort()
	};
}

function shapeOp(id = crypto.randomUUID(), text = 'Idee', x = 10) {
	return {
		id,
		type: 'shape' as const,
		z: 1,
		data: { kind: 'note', x, y: 20, w: 160, h: 120, text, fill: '#fff59d' }
	};
}

async function png(width = 300, height = 200): Promise<Uint8Array> {
	return new Uint8Array(
		await sharp({ create: { width, height, channels: 3, background: '#2266aa' } })
			.png()
			.toBuffer()
	);
}

function form(bytes: Uint8Array | string, name: string, type: string) {
	const fd = new FormData();
	fd.set('file', new File([bytes as BlobPart], name, { type }));
	return fd;
}

/** Rolle nur der Person `parent` – Ersatz für die Gruppen-Freigabe ohne `members` */
let parentRole: string;
let boardId: string;
let seq = 0;

beforeAll(async () => {
	({ close } = await useTestDatabase());
	registerCoreApi();
	registerModule(tasksModule);
	registerModule(whiteboardModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', 'correct-horse-battery');
	const [u] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	admin = await ctxOf(u!.id);
	for (const id of ['tasks', 'whiteboard']) await enableModule(admin, id);
	admin = await ctxOf(u!.id);
	await installFakeStorage(admin);
	keys.admin = (
		await createApiKey(admin, {
			name: 'admin',
			scopes: [...tasksModule.manifest.permissions, ...whiteboardModule.manifest.permissions]
		})
	).key;

	const base = ['core.api.manage', 'whiteboard.board.view'];
	const planner = await createRole(admin, {
		name: 'Planung',
		permissions: [...base, 'whiteboard.board.create', 'tasks.board.view', 'tasks.board.create']
	});
	const viewer = await createRole(admin, {
		name: 'Mitmachen',
		permissions: [...base, 'tasks.board.view']
	});
	parentRole = await createRole(admin, {
		name: 'Eltern',
		permissions: [...base, 'tasks.board.view']
	});
	const without = await createRole(admin, {
		name: 'Ohne Whiteboard',
		permissions: ['core.api.manage']
	});
	await addUser('owner', planner);
	await addUser('parent', parentRole);
	await addUser('helper', viewer);
	await addUser('stranger', viewer);
	await addUser('outsider', without);
});

afterAll(async () => {
	closeAllStreamsForTests();
	setPdfRendererForTests(undefined);
	await close?.();
});

describe('Boards und Zugriff', () => {
	it('legt ein Whiteboard an', async () => {
		const board = ok<BoardDetail>(
			await call('owner', 'POST', '/boards', {
				name: 'Programmideen',
				color: '#16A34A',
				background: 'grid'
			}),
			201
		);
		boardId = board.id;
		expect(board.color).toBe('#16a34a');
		expect(board.background).toBe('grid');
		expect(board.elements).toEqual([]);
		expect(board.seq).toBe(0);
		expect(board.access).toEqual({ level: 'edit', isOwner: true, canShare: true });
	});

	it('ohne Recht kein Anlegen; Fremde sehen nichts', async () => {
		fail(await call('parent', 'POST', '/boards', { name: 'X' }), 403, 'forbidden');
		fail(await call('stranger', 'GET', `/boards/${boardId}`), 404, 'not_found');
		expect(ok<BoardList>(await call('stranger', 'GET', '/boards')).items).toEqual([]);
		expect((await call('outsider', 'GET', '/boards')).status).toBe(403);
		fail(
			await call('stranger', 'POST', `/boards/${boardId}/ops`, {
				client: 'client-stranger',
				ops: [shapeOp()]
			}),
			404,
			'not_found'
		);
	});

	it('ohne `members` keine Gruppen-/Mitglieds-Freigabe (422)', async () => {
		const res = await call('owner', 'PUT', `/boards/${boardId}/shares`, {
			shares: [
				{ type: 'user', id: userIds.helper, level: 'edit' },
				{ type: 'group', id: crypto.randomUUID(), level: 'read' },
				{ type: 'member', id: crypto.randomUUID(), level: 'read' }
			]
		});
		fail(res, 422, 'validation_failed');
		expect(JSON.stringify(res.body.error?.details)).toContain('"shares",1,"id"');
		expect(JSON.stringify(res.body.error?.details)).toContain('"shares",2,"id"');
		expect(
			ok<{ shares: unknown[] }>(await call('owner', 'GET', `/boards/${boardId}/shares`)).shares
		).toEqual([]);
	});

	it('Rollen-Freigabe (lesen) gibt Konten der Rolle Lesezugriff, aber keine Änderungen', async () => {
		ok(
			await call('owner', 'PUT', `/boards/${boardId}/shares`, {
				shares: [
					{ type: 'role', id: parentRole, level: 'read' },
					{ type: 'user', id: userIds.helper, level: 'edit' }
				]
			})
		);
		const seen = ok<BoardDetail>(await call('parent', 'GET', `/boards/${boardId}`));
		expect(seen.access.level).toBe('read');
		fail(
			await call('parent', 'POST', `/boards/${boardId}/ops`, {
				client: 'client-parent',
				ops: [shapeOp()]
			}),
			403,
			'forbidden'
		);
		fail(
			await call('parent', 'PUT', `/boards/${boardId}/shares`, { shares: [] }),
			403,
			'forbidden'
		);
		const helper = ok<BoardDetail>(await call('helper', 'GET', `/boards/${boardId}`));
		expect(helper.access).toEqual({ level: 'edit', isOwner: false, canShare: false });
		fail(await call('helper', 'DELETE', `/boards/${boardId}`), 403, 'forbidden');
	});
});

describe('Änderungen (ops)', () => {
	const noteId = crypto.randomUUID();
	const otherId = crypto.randomUUID();
	const lineId = crypto.randomUUID();

	it('legt Elemente an, zählt Versionen und Änderungsnummer hoch', async () => {
		const res = ok<OpsResult>(
			await call('owner', 'POST', `/boards/${boardId}/ops`, {
				client: 'client-owner-1',
				ops: [
					shapeOp(noteId, 'Lagerfeuer'),
					shapeOp(otherId, 'Geländespiel', 300),
					{
						id: lineId,
						type: 'connector',
						z: 2,
						data: {
							from: { elementId: noteId, x: 90, y: 80 },
							to: { elementId: otherId, x: 380, y: 80 },
							endHead: 'arrow'
						}
					}
				]
			}),
			201
		);
		expect(res.seq).toBe(1);
		expect(res.applied).toHaveLength(3);
		expect(res.applied.every((a) => a.version === 1)).toBe(true);
		const again = ok<OpsResult>(
			await call('helper', 'POST', `/boards/${boardId}/ops`, {
				client: 'client-helper-1',
				ops: [shapeOp(noteId, 'Lagerfeuer mit Stockbrot')]
			}),
			201
		);
		expect(again).toEqual({ seq: 2, applied: [{ id: noteId, version: 2 }] });
		const board = ok<BoardDetail>(await call('owner', 'GET', `/boards/${boardId}`));
		expect(board.seq).toBe(2);
		expect(board.elementCount).toBe(3);
		const note = board.elements.find((e) => e.id === noteId);
		expect(note?.type).toBe('shape');
		expect(note?.data).toMatchObject({
			text: 'Lagerfeuer mit Stockbrot',
			kind: 'note',
			align: 'center'
		});
		expect(board.updatedBy?.id).toBe(userIds.helper);
		seq = board.seq;
	});

	it('prüft Daten je Typ (422 mit Pfad), Links und Dateiverweise', async () => {
		const bad = await call('owner', 'POST', `/boards/${boardId}/ops`, {
			client: 'client-owner-1',
			ops: [{ ...shapeOp(), data: { kind: 'note', x: 0, y: 0, w: 0, h: 10 } }]
		});
		fail(bad, 422, 'validation_failed');
		expect(JSON.stringify(bad.body.error?.details)).toContain('"ops",0,"data","w"');
		fail(
			await call('owner', 'POST', `/boards/${boardId}/ops`, {
				client: 'client-owner-1',
				ops: [
					{
						id: crypto.randomUUID(),
						type: 'link',
						z: 1,
						data: { x: 0, y: 0, w: 200, h: 80, url: 'javascript:alert(1)' }
					}
				]
			}),
			422,
			'validation_failed'
		);
		fail(
			await call('owner', 'POST', `/boards/${boardId}/ops`, {
				client: 'client-owner-1',
				ops: [
					{
						id: crypto.randomUUID(),
						type: 'image',
						z: 1,
						data: { x: 0, y: 0, w: 200, h: 80, assetId: crypto.randomUUID() }
					}
				]
			}),
			422,
			'validation_failed'
		);
		ok(
			await call('owner', 'POST', `/boards/${boardId}/ops`, {
				client: 'client-owner-1',
				ops: [
					{
						id: crypto.randomUUID(),
						type: 'link',
						z: 3,
						data: {
							x: 0,
							y: 300,
							w: 240,
							h: 90,
							url: 'https://example.org/lager',
							title: 'Lagerplatz'
						}
					}
				]
			}),
			201
		);
		const board = ok<BoardDetail>(await call('owner', 'GET', `/boards/${boardId}`));
		seq = board.seq;
	});

	it('Löschen hinterlässt einen Grabstein; erneutes Schreiben stellt wieder her', async () => {
		const del = ok<OpsResult>(
			await call('owner', 'POST', `/boards/${boardId}/ops`, {
				client: 'client-owner-1',
				ops: [{ id: otherId, deleted: true }]
			}),
			201
		);
		expect(del.applied).toEqual([{ id: otherId, version: 2 }]);
		let board = ok<BoardDetail>(await call('owner', 'GET', `/boards/${boardId}`));
		expect(board.elements.map((e) => e.id)).not.toContain(otherId);
		const restored = ok<OpsResult>(
			await call('owner', 'POST', `/boards/${boardId}/ops`, {
				client: 'client-owner-1',
				ops: [shapeOp(otherId, 'Geländespiel', 300)]
			}),
			201
		);
		expect(restored.applied).toEqual([{ id: otherId, version: 3 }]);
		board = ok<BoardDetail>(await call('owner', 'GET', `/boards/${boardId}`));
		expect(board.elements.map((e) => e.id)).toContain(otherId);
		seq = board.seq;
	});
});

describe('Live (SSE)', () => {
	it('verteilt Änderungen und Anwesenheit an andere Verbindungen, nicht an die eigene', async () => {
		const owner = await openLive('owner', boardId, 'client-owner-live', seq);
		expect(owner.status).toBe(200);
		const hello = await owner.waitFor('hello');
		expect(hello).toMatchObject({ seq, level: 'edit', reset: false, peers: [] });

		const helper = await openLive('helper', boardId, 'client-helper-live', seq);
		const helperHello = await helper.waitFor('hello');
		expect(helperHello.peers.map((p) => p.userId)).toEqual([userIds.owner]);
		await owner.waitFor('join', (e) => e.peer.userId === userIds.helper);

		const id = crypto.randomUUID();
		ok(
			await call('helper', 'POST', `/boards/${boardId}/ops`, {
				client: 'client-helper-live',
				ops: [shapeOp(id, 'Neu von Helfer')]
			}),
			201
		);
		const ops = await owner.waitFor('ops', (e) => e.elements.some((el) => el.id === id));
		expect(ops.client).toBe('client-helper-live');
		expect(ops.userId).toBe(userIds.helper);
		expect(ops.elements[0]).toMatchObject({ id, type: 'shape', version: 1, deleted: false });
		expect(helper.events.some((e) => e.type === 'ops')).toBe(false);

		expect(
			ok<{ ok: boolean }>(
				await call('helper', 'POST', `/boards/${boardId}/presence`, {
					client: 'client-helper-live',
					cursor: { x: 50, y: 60 },
					selection: [id]
				}),
				201
			).ok
		).toBe(true);
		const presence = await owner.waitFor('presence');
		expect(presence.peer).toMatchObject({
			userId: userIds.helper,
			name: 'Person helper',
			cursor: { x: 50, y: 60 },
			selection: [id],
			canEdit: true
		});
		// fremde Kennung → nichts verteilt
		expect(
			ok<{ ok: boolean }>(
				await call('stranger', 'POST', `/boards/${boardId}/presence`, {
					client: 'client-helper-live',
					cursor: null
				}),
				201
			).ok
		).toBe(false);

		helper.close();
		await owner.waitFor('leave', (e) => e.client === 'client-helper-live');
		owner.close();
		await vi.waitFor(() => expect(owner.isEnded()).toBe(true));
	});

	it('holt verpasste Änderungen (inkl. Löschungen) über `since` nach', async () => {
		const before = ok<BoardDetail>(await call('owner', 'GET', `/boards/${boardId}`));
		const gone = before.elements.find((e) => e.type === 'link')!.id;
		ok(
			await call('owner', 'POST', `/boards/${boardId}/ops`, {
				client: 'client-owner-1',
				ops: [{ id: gone, deleted: true }]
			}),
			201
		);
		const live = await openLive('parent', boardId, 'client-parent-live', before.seq);
		const hello = await live.waitFor('hello');
		expect(hello.level).toBe('read');
		expect(hello.seq).toBe(before.seq + 1);
		const ops = await live.waitFor('ops');
		expect(ops.elements).toEqual([expect.objectContaining({ id: gone, deleted: true })]);
		live.close();
	});

	it('Rechteentzug schließt die Verbindung (revoked)', async () => {
		const live = await openLive('helper', boardId, 'client-helper-2');
		await live.waitFor('hello');
		ok(
			await call('owner', 'PUT', `/boards/${boardId}/shares`, {
				shares: [{ type: 'role', id: parentRole, level: 'read' }]
			})
		);
		await live.waitFor('revoked');
		await vi.waitFor(() => expect(live.isEnded()).toBe(true));
		fail(await call('helper', 'GET', `/boards/${boardId}`), 404, 'not_found');
	});

	it('Hochstufen meldet `access` an offene Verbindungen', async () => {
		const live = await openLive('parent', boardId, 'client-parent-2');
		await live.waitFor('hello', (e) => e.level === 'read');
		ok(
			await call('owner', 'PUT', `/boards/${boardId}/shares`, {
				shares: [{ type: 'role', id: parentRole, level: 'edit' }]
			})
		);
		await live.waitFor('access', (e) => e.level === 'edit');
		live.close();
	});

	it('Fremde und Personen ohne Recht bekommen keinen Stream', async () => {
		expect((await openLive('stranger', boardId, 'client-stranger')).status).toBe(404);
		expect((await openLive('outsider', boardId, 'client-outsider')).status).toBe(403);
	});
});

describe('Ohne `actions`', () => {
	it('Boards lassen sich nicht an Aktionen hängen; Aktions-Endpunkte und -Karten leer', async () => {
		const actionId = crypto.randomUUID();
		const res = await call('owner', 'POST', '/boards', { name: 'Programm', actionId });
		fail(res, 422, 'validation_failed');
		expect(JSON.stringify(res.body.error?.details)).toContain('actionId');
		fail(
			await call('owner', 'PATCH', `/boards/${boardId}`, { actionId }),
			422,
			'validation_failed'
		);
		fail(await call('owner', 'GET', `/boards/by-action/${actionId}`), 404, 'not_found');
		expect(ok<BoardList>(await call('owner', 'GET', `/boards?actionId=${actionId}`)).total).toBe(0);
		// ohne Aktion weiter möglich (actionId null)
		const plain = ok<BoardDetail>(
			await call('owner', 'POST', '/boards', { name: 'Ohne Aktion', actionId: null }),
			201
		);
		expect(plain.actionName ?? null).toBeNull();
		ok(await call('owner', 'DELETE', `/boards/${plain.id}`));
		expect(ok<RefCard[]>(await call('owner', 'GET', '/refs?type=action&search=Herbst'))).toEqual(
			[]
		);
		const [card] = ok<RefCard[]>(
			await call('owner', 'POST', '/refs/describe', { items: [{ type: 'action', id: actionId }] }),
			201
		);
		expect(card).toMatchObject({ available: false, title: 'Aktion nicht verfügbar' });
	});
});

describe('Dateien, Versionen, Export/Import, PDF', () => {
	let imageAsset: Asset;
	const imageId = crypto.randomUUID();

	it('lädt ein Bild hoch (Varianten ohne Metadaten) und liefert es aus', async () => {
		const res = await raw(
			'owner',
			'POST',
			`/boards/${boardId}/assets`,
			form(await png(), 'karte.png', 'image/png')
		);
		const body = (await res.json()) as Res<Asset>['body'];
		expect(res.status, JSON.stringify(body)).toBe(201);
		imageAsset = body.data!;
		expect(imageAsset).toMatchObject({ kind: 'image', width: 300, height: 200, hasThumb: true });
		const thumb = await raw('parent', 'GET', `/boards/${boardId}/assets/${imageAsset.id}/thumb`);
		expect(thumb.status).toBe(200);
		expect(thumb.headers.get('content-type')).toBe('image/webp');
		fail(
			await call('stranger', 'GET', `/boards/${boardId}/assets/${imageAsset.id}/web`),
			404,
			'not_found'
		);
		ok(
			await call('owner', 'POST', `/boards/${boardId}/ops`, {
				client: 'client-owner-1',
				ops: [
					{
						id: imageId,
						type: 'image',
						z: 5,
						data: { x: 400, y: 400, w: 300, h: 200, assetId: imageAsset.id, alt: 'Karte' }
					}
				]
			}),
			201
		);
	});

	it('lehnt Uploads ohne Bearbeiten-Recht und mit falschem Inhalt ab', async () => {
		const asText = await raw(
			'owner',
			'POST',
			`/boards/${boardId}/assets`,
			form('<html><script>x</script></html>', 'evil.pdf', 'application/pdf')
		);
		expect(asText.status).toBe(422);
		const res = await raw(
			'stranger',
			'POST',
			`/boards/${boardId}/assets`,
			form(await png(), 'a.png', 'image/png')
		);
		expect(res.status).toBe(404);
	});

	it('speichert Versionen und stellt sie wieder her (mit reset an offene Editoren)', async () => {
		ok(await call('owner', 'POST', `/boards/${boardId}/snapshots`, { label: 'Stand 1' }), 201);
		const before = ok<BoardDetail>(await call('owner', 'GET', `/boards/${boardId}`));
		ok(
			await call('owner', 'POST', `/boards/${boardId}/ops`, {
				client: 'client-owner-1',
				ops: before.elements.map((e) => ({ id: e.id, deleted: true as const }))
			}),
			201
		);
		expect(ok<BoardDetail>(await call('owner', 'GET', `/boards/${boardId}`)).elements).toEqual([]);
		const list = ok<Snapshot[]>(await call('parent', 'GET', `/boards/${boardId}/snapshots`));
		const snap = list.find((s) => s.label === 'Stand 1')!;
		expect(snap.elementCount).toBe(before.elements.length);
		const live = await openLive('parent', boardId, 'client-parent-3');
		await live.waitFor('hello');
		ok(await call('owner', 'POST', `/boards/${boardId}/snapshots/${snap.id}/restore`), 201);
		await live.waitFor('reset');
		live.close();
		const after = ok<BoardDetail>(await call('owner', 'GET', `/boards/${boardId}`));
		expect(after.elements.map((e) => e.id).sort()).toEqual(before.elements.map((e) => e.id).sort());
		const labels = ok<Snapshot[]>(await call('owner', 'GET', `/boards/${boardId}/snapshots`)).map(
			(s) => s.label
		);
		expect(labels).toContain('Vor dem Wiederherstellen');
		fail(
			await call('stranger', 'POST', `/boards/${boardId}/snapshots/${snap.id}/restore`),
			404,
			'not_found'
		);
	});

	it('automatische Versionen nur bei Änderungen', async () => {
		expect(await runAutoSnapshots()).toBeGreaterThan(0);
		expect(await runAutoSnapshots()).toBe(0);
	});

	it('Export → Import ergibt ein neues Board mit denselben Elementen und neu gespeicherten Bildern', async () => {
		const source = ok<BoardDetail>(await call('owner', 'GET', `/boards/${boardId}`));
		const res = await raw('parent', 'GET', `/boards/${boardId}/export`);
		expect(res.status).toBe(200);
		expect(res.headers.get('content-disposition')).toContain('.epwhiteboard');
		const zip = new Uint8Array(await res.arrayBuffer());
		const files = unzipSync(zip);
		const doc = JSON.parse(strFromU8(files['board.json']!));
		expect(doc.format).toBe('ep-whiteboard');
		expect(doc.elements).toHaveLength(source.elements.length);
		expect(Object.keys(files)).toContain(`assets/${imageAsset.id}`);

		const fd = form(zip, 'programm.epwhiteboard', 'application/zip');
		fd.set('name', 'Kopie Programmideen');
		const imp = await raw('owner', 'POST', '/boards/import', fd);
		const body = (await imp.json()) as Res<BoardDetail>['body'];
		expect(imp.status, JSON.stringify(body)).toBe(201);
		const copy = body.data!;
		expect(copy.id).not.toBe(boardId);
		expect(copy.name).toBe('Kopie Programmideen');
		expect(copy.access.isOwner).toBe(true);
		expect(copy.elements).toHaveLength(source.elements.length);
		const img = copy.elements.find((e) => e.id === imageId);
		expect(img?.type).toBe('image');
		const newAsset = (img?.data as { assetId: string }).assetId;
		expect(newAsset).not.toBe(imageAsset.id);
		expect(copy.assets.map((a) => a.id)).toEqual([newAsset]);
		fail(await call('parent', 'GET', `/boards/${copy.id}`), 404, 'not_found');
		// ohne Anlegen-Recht kein Import
		expect(
			(
				await raw(
					'parent',
					'POST',
					'/boards/import',
					form(zip, 'x.epwhiteboard', 'application/zip')
				)
			).status
		).toBe(403);
	});

	it('weist manipulierte Archive ab', async () => {
		const evil = zipSync({ 'board.json': strToU8('{}'), '../etc/passwd': strToU8('x') });
		const res = await raw(
			'owner',
			'POST',
			'/boards/import',
			form(evil, 'x.epwhiteboard', 'application/zip')
		);
		expect(res.status).toBe(422);
		const wrong = zipSync({ 'board.json': strToU8(JSON.stringify({ format: 'anders' })) });
		expect(
			(
				await raw(
					'owner',
					'POST',
					'/boards/import',
					form(wrong, 'y.epwhiteboard', 'application/zip')
				)
			).status
		).toBe(422);
	});

	it('PDF aus gerenderten Seiten', async () => {
		let html = '';
		// gültiges PDF mit einer Seite je <section> (Anlagen), sonst einer Seite
		setPdfRendererForTests(async (h) => {
			html += h;
			const doc = await PDFDocument.create();
			const n = Math.max(1, (h.match(/<section/g) ?? []).length);
			for (let i = 0; i < n; i++) doc.addPage();
			return doc.save();
		});
		const fd = new FormData();
		fd.set(
			'page0',
			new File([(await png(800, 400)) as BlobPart], 'seite.png', { type: 'image/png' })
		);
		fd.set('label0', 'Tag 1');
		fd.set(
			'page1',
			new File([(await png(400, 400)) as BlobPart], 'seite.png', { type: 'image/png' })
		);
		const res = await raw('parent', 'POST', `/boards/${boardId}/export.pdf`, fd);
		expect(res.status, res.status === 200 ? '' : await res.text()).toBe(200);
		expect(res.headers.get('content-type')).toBe('application/pdf');
		const pdf = await PDFDocument.load(new Uint8Array(await res.arrayBuffer()));
		expect(pdf.getPageCount()).toBe(3); // Deckblatt + 2 Seiten
		expect(html).toContain('Tag 1');
		expect(html.match(/data:image\/png;base64/g)).toHaveLength(2);
		const empty = await raw('parent', 'POST', `/boards/${boardId}/export.pdf`, new FormData());
		expect(empty.status).toBe(422);
	});
});

describe('Karten aus anderen Modulen', () => {
	it('löst Karten je Betrachter*in auf (kein Zugriff → nicht verfügbar)', async () => {
		const taskBoard = ok<{ id: string }>(
			await call('owner', 'POST', '/boards', { name: 'Aufgaben Lager' }, 'tasks'),
			201
		).id;
		const task = ok<{ id: string }>(
			await call('owner', 'POST', `/boards/${taskBoard}/tasks`, { title: 'Zelte prüfen' }, 'tasks'),
			201
		).id;
		const found = ok<RefCard[]>(await call('owner', 'GET', '/refs?type=task&search=Zelte'));
		expect(found.map((c) => c.title)).toEqual(['Zelte prüfen']);
		const items = [
			{ type: 'task', id: task },
			{ type: 'taskboard', id: taskBoard },
			{ type: 'whiteboard', id: boardId }
		];
		const mine = ok<RefCard[]>(await call('owner', 'POST', '/refs/describe', { items }), 201);
		expect(mine.map((c) => [c.available, c.title])).toEqual([
			[true, 'Zelte prüfen'],
			[true, 'Aufgaben Lager'],
			[true, 'Programmideen']
		]);
		expect(mine[0]!.href).toContain('/modules/tasks/');
		const theirs = ok<RefCard[]>(await call('stranger', 'POST', '/refs/describe', { items }), 201);
		expect(theirs.map((c) => [c.available, c.title])).toEqual([
			[false, 'Aufgabe nicht verfügbar'],
			[false, 'Aufgaben-Board nicht verfügbar'],
			[false, 'Whiteboard nicht verfügbar']
		]);
		expect(JSON.stringify(theirs)).not.toContain('Zelte');
		// Notiz-Karten (`notes` hier nicht registriert/aktiv) → nicht verfügbar statt Fehler
		const note = { type: 'note', id: crypto.randomUUID() };
		const [noteCard] = ok<RefCard[]>(
			await call('owner', 'POST', '/refs/describe', { items: [note] }),
			201
		);
		expect(noteCard).toMatchObject({ available: false, title: 'Notiz nicht verfügbar' });
		expect(ok<RefCard[]>(await call('owner', 'GET', '/refs?type=note&search=Lager'))).toEqual([]);
	});
});

describe('Persönliche Ansicht (Fläche)', () => {
	it('Standard feste weiße Fläche; je Konto speicherbar und getrennt', async () => {
		expect(ok<UserPrefs>(await call('parent', 'GET', '/me/prefs'))).toEqual({
			surface: { mode: 'fixed', color: '#ffffff' }
		});
		const saved = ok<UserPrefs>(
			await call('parent', 'PUT', '/me/prefs', { surface: { mode: 'fixed', color: '#112233' } })
		);
		expect(saved.surface).toEqual({ mode: 'fixed', color: '#112233' });
		ok(await call('parent', 'PUT', '/me/prefs', { surface: { mode: 'theme', color: '#112233' } }));
		expect(ok<UserPrefs>(await call('parent', 'GET', '/me/prefs')).surface.mode).toBe('theme');
		// andere Person unberührt
		expect(ok<UserPrefs>(await call('helper', 'GET', '/me/prefs')).surface.mode).toBe('fixed');
		fail(
			await call('parent', 'PUT', '/me/prefs', { surface: { mode: 'fixed', color: 'weiß' } }),
			422,
			'validation_failed'
		);
		fail(
			await call('parent', 'PUT', '/me/prefs', { surface: { mode: 'bunt' } }),
			422,
			'validation_failed'
		);
		expect((await call('outsider', 'GET', '/me/prefs')).status).toBe(403);
	});
});

describe('Aufräumen, Audit, Konto löschen, Modul aus', () => {
	it('entfernt alte Grabsteine; zu alte `since` verlangen ein Neuladen', async () => {
		const board = ok<BoardDetail>(await call('owner', 'GET', `/boards/${boardId}`));
		const victim = board.elements.find((e) => e.type === 'shape')!.id;
		ok(
			await call('owner', 'POST', `/boards/${boardId}/ops`, {
				client: 'client-owner-1',
				ops: [{ id: victim, deleted: true }]
			}),
			201
		);
		await core.database
			.forModule('whiteboard')
			.transaction((tx) =>
				tx.execute(
					sql`UPDATE elements SET updated_at = now() - interval '40 days' WHERE board_id = ${boardId} AND deleted`
				)
			);
		const { tombstones } = await runCleanup();
		expect(tombstones).toBeGreaterThan(0);
		const live = await openLive('owner', boardId, 'client-owner-old', 1);
		const hello = await live.waitFor('hello');
		expect(hello.reset).toBe(true);
		live.close();
	});

	it('Audit ohne Texte der Elemente', async () => {
		const { rows } = await listAudit({ action: 'whiteboard.', limit: 200 });
		const actions = new Set(rows.map((r) => r.action));
		for (const a of [
			'whiteboard.board.created',
			'whiteboard.board.shared',
			'whiteboard.board.restored',
			'whiteboard.board.exported',
			'whiteboard.board.imported',
			'whiteboard.asset.uploaded',
			'whiteboard.snapshot.created'
		]) {
			expect(actions).toContain(a);
		}
		const text = JSON.stringify(rows.map((r) => r.metadata));
		expect(text).not.toContain('Lagerfeuer');
		expect(text).not.toContain('karte.png');
	});

	it('Konto löschen: Eigentum wandert, Freigaben weg', async () => {
		await core.database
			.forModule('whiteboard')
			.transaction((tx) =>
				onUserDeleted!(tx, { userId: userIds.owner!, transferTo: userIds.helper! })
			);
		const rows = await core.database
			.forModule('whiteboard')
			.transaction((tx) =>
				tx.execute(sql`SELECT owner_id, updated_by FROM boards WHERE id = ${boardId}`)
			);
		const row = (rows as unknown as { rows: { owner_id: string; updated_by: string | null }[] })
			.rows[0]!;
		expect(row.owner_id).toBe(userIds.helper);
		expect(row.updated_by).not.toBe(userIds.owner);
	});

	it('Modul aus → 404', async () => {
		await disableModule(admin, 'whiteboard');
		expect((await call('admin', 'GET', '/boards')).status).toBe(404);
		await enableModule(admin, 'whiteboard');
	});
});
