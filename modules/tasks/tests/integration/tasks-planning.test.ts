/**
 * Modul `tasks` v1.1 (Aufgaben 2.0): Phasen (CRUD, Reihenfolge, Grenzen, Zugriff), Zeitraum und Meilensteine,
 * Abhängigkeiten (Kreise, fremde Boards), Vorlagen (mitgeliefert, eigene, Bezugsdatum ohne Aktion),
 * Daten verschieben ohne Aktion, Meilensteine im Kalender-Abo (events), Reset-Tabellen, Audit – ohne `members`/`actions`.
 * Vorlagen mit Aktionsbeginn/-ende und Mitverschieben nach geänderter Aktion prüft ep-intern-modules
 * `modules/_integration/tests/integration/tasks-planning-actions.test.ts`.
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
import { listAudit } from '$testing';
import { core } from '$testing';
import { setTodayForTests } from '$lib/sdk/dates';
import eventsModule from '$modules/events/module';
import tasksModule from '$modules/tasks/module';
import { resetAreas } from '$modules/tasks/privacy';
import type { CalendarFeed } from '$modules/events/schemas';
import type { BoardDetail, MyTask, TaskDetail, TemplateSummary } from '$modules/tasks/schemas';
import type { RequestContext } from '$lib/sdk/types';

const ROOT = 'http://localhost:5173/api/v1/modules';
const keys: Record<string, string> = {};
const userIds: Record<string, string> = {};
let admin: RequestContext;
let close: () => Promise<void>;

interface Res<T = unknown> {
	status: number;
	body: { data?: T; error?: { code: string; details?: { path?: unknown[] }[] } };
}

async function call<T = unknown>(
	who: string,
	method: string,
	path: string,
	json?: unknown,
	moduleId = 'tasks'
): Promise<Res<T>> {
	resetAllForTests();
	const headers = new Headers({ authorization: `Bearer ${keys[who]}` });
	if (json !== undefined) headers.set('content-type', 'application/json');
	const url = new URL(`${ROOT}/${moduleId}${path}`);
	const res = await handleApiRequest({
		request: new Request(url, {
			method,
			headers,
			body: json === undefined ? undefined : JSON.stringify(json)
		}),
		url,
		ip: '127.0.0.1'
	});
	return { status: res.status, body: await res.json() };
}

function ok<T>(res: Res<T>, status = 200): T {
	expect(res.status, JSON.stringify(res.body)).toBe(status);
	return res.body.data as T;
}

function issuePaths(res: Res): string[] {
	expect(res.status, JSON.stringify(res.body)).toBe(422);
	return (res.body.error?.details ?? []).map((d) => (d.path ?? []).join('.'));
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

let boardId: string;
let detail: BoardDetail;

beforeAll(async () => {
	setTodayForTests('2027-01-10');
	({ close } = await useTestDatabase());
	registerCoreApi();
	registerModule(eventsModule);
	registerModule(tasksModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', 'correct-horse-battery');
	const [u] = await getDb()
		.select()
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	admin = await ctxOf(u!.id);
	for (const id of ['events', 'tasks']) await enableModule(admin, id);
	admin = await ctxOf(u!.id);

	const base = ['core.api.manage', 'tasks.board.view', 'events.event.view'];
	const planner = await createRole(admin, {
		name: 'Planung',
		permissions: [...base, 'tasks.board.create']
	});
	const viewer = await createRole(admin, { name: 'Mitmachen', permissions: base });
	await addUser('owner', planner);
	await addUser('other', planner);
	await addUser('reader', viewer);
	await addUser('stranger', viewer);
});

afterAll(async () => {
	setTodayForTests(null);
	await close?.();
});

describe('Phasen', () => {
	it('anlegen, ändern, sortieren; Ende vor Beginn → 422; Lesende 403, Fremde 404', async () => {
		detail = ok<BoardDetail>(await call('owner', 'POST', '/boards', { name: 'Pfingstlager' }), 201);
		boardId = detail.id;
		expect(detail.phases).toEqual([]);
		expect(detail.defaultView).toBe('board');
		expect(detail.anchorOn).toBeNull();

		detail = ok<BoardDetail>(
			await call('owner', 'POST', `/boards/${boardId}/phases`, {
				name: 'Planung',
				color: '#7C3AED',
				startsOn: '2027-01-01',
				endsOn: '2027-02-15'
			}),
			201
		);
		detail = ok<BoardDetail>(
			await call('owner', 'POST', `/boards/${boardId}/phases`, {
				name: 'Anmeldung',
				startsOn: '2027-03-01'
			}),
			201
		);
		expect(detail.phases.map((p) => [p.name, p.color, p.startsOn, p.endsOn, p.position])).toEqual([
			['Planung', '#7c3aed', '2027-01-01', '2027-02-15', 0],
			['Anmeldung', null, '2027-03-01', null, 1]
		]);
		expect(detail.currentPhase?.name).toBe('Planung');

		expect(
			issuePaths(
				await call('owner', 'POST', `/boards/${boardId}/phases`, {
					name: 'Falsch',
					startsOn: '2027-05-02',
					endsOn: '2027-05-01'
				})
			)
		).toContain('endsOn');
		const [planung, anmeldung] = detail.phases;
		// PATCH prüft gegen den gespeicherten Beginn
		expect(
			issuePaths(
				await call('owner', 'PATCH', `/boards/${boardId}/phases/${planung!.id}`, {
					endsOn: '2026-12-01'
				})
			)
		).toEqual(['endsOn']);
		detail = ok<BoardDetail>(
			await call('owner', 'PATCH', `/boards/${boardId}/phases/${anmeldung!.id}`, {
				endsOn: '2027-03-15',
				color: '#d97706'
			})
		);
		expect(detail.phases[1]).toMatchObject({ endsOn: '2027-03-15', color: '#d97706' });

		detail = ok<BoardDetail>(
			await call('owner', 'PUT', `/boards/${boardId}/phases/order`, {
				ids: [anmeldung!.id, planung!.id]
			})
		);
		expect(detail.phases.map((p) => p.name)).toEqual(['Anmeldung', 'Planung']);
		expect(
			issuePaths(
				await call('owner', 'PUT', `/boards/${boardId}/phases/order`, { ids: [planung!.id] })
			)
		).toEqual(['ids']);

		ok(
			await call('owner', 'PUT', `/boards/${boardId}/shares`, {
				shares: [{ type: 'user', id: userIds.reader, level: 'read' }]
			})
		);
		expect((await call('reader', 'POST', `/boards/${boardId}/phases`, { name: 'x' })).status).toBe(
			403
		);
		expect(
			(await call('stranger', 'POST', `/boards/${boardId}/phases`, { name: 'x' })).status
		).toBe(404);
	});

	it('höchstens 20 Phasen je Board (409)', async () => {
		const b = ok<BoardDetail>(
			await call('owner', 'POST', '/boards', { name: 'Viele Phasen' }),
			201
		);
		for (let i = 0; i < 20; i++) {
			expect(
				(await call('owner', 'POST', `/boards/${b.id}/phases`, { name: `P${i}` })).status
			).toBe(201);
		}
		expect((await call('owner', 'POST', `/boards/${b.id}/phases`, { name: 'P20' })).status).toBe(
			409
		);
	});
});

describe('Zeitraum und Meilensteine', () => {
	let taskId: string;

	it('Aufgabe mit Phase und Zeitraum; Regeln für Beginn und Meilenstein (422)', async () => {
		const phase = detail.phases.find((p) => p.name === 'Planung')!;
		const task = ok<TaskDetail>(
			await call('owner', 'POST', `/boards/${boardId}/tasks`, {
				title: 'Zeltplatz anfragen',
				phaseId: phase.id,
				startsOn: '2027-01-05',
				dueOn: '2027-01-20'
			}),
			201
		);
		taskId = task.id;
		expect(task).toMatchObject({
			phaseId: phase.id,
			startsOn: '2027-01-05',
			dueOn: '2027-01-20',
			isMilestone: false,
			blockedBy: [],
			openBlockers: 0
		});

		expect(
			issuePaths(
				await call('owner', 'POST', `/boards/${boardId}/tasks`, {
					title: 'Falsch',
					startsOn: '2027-02-01',
					dueOn: '2027-01-01'
				})
			)
		).toEqual(['startsOn']);
		expect(
			issuePaths(
				await call('owner', 'POST', `/boards/${boardId}/tasks`, {
					title: 'Meilenstein ohne Datum',
					isMilestone: true
				})
			)
		).toEqual(['dueOn']);
		// Phase eines anderen Boards
		const other = ok<BoardDetail>(await call('owner', 'POST', '/boards', { name: 'Anderes' }), 201);
		const otherPhase = ok<BoardDetail>(
			await call('owner', 'POST', `/boards/${other.id}/phases`, { name: 'Fremd' }),
			201
		).phases[0]!;
		expect(
			issuePaths(
				await call('owner', 'POST', `/boards/${boardId}/tasks`, {
					title: 'x',
					phaseId: otherPhase.id
				})
			)
		).toEqual(['phaseId']);
		expect(
			issuePaths(await call('owner', 'PATCH', `/tasks/${taskId}`, { phaseId: otherPhase.id }))
		).toEqual(['phaseId']);
		// PATCH prüft gegen den gespeicherten Beginn
		expect(
			issuePaths(await call('owner', 'PATCH', `/tasks/${taskId}`, { dueOn: '2027-01-01' }))
		).toEqual(['startsOn']);
	});

	it('wird eine Aufgabe zum Meilenstein, entfällt der Beginn', async () => {
		const t = ok<TaskDetail>(
			await call('owner', 'PATCH', `/tasks/${taskId}`, { isMilestone: true })
		);
		expect(t).toMatchObject({ isMilestone: true, startsOn: null, dueOn: '2027-01-20' });
		expect(
			issuePaths(await call('owner', 'PATCH', `/tasks/${taskId}`, { startsOn: '2027-01-02' }))
		).toEqual(['startsOn']);
		const boards = ok<{ items: BoardDetail[] }>(await call('owner', 'GET', '/boards'));
		expect(boards.items.find((b) => b.id === boardId)?.nextMilestone).toMatchObject({
			id: taskId,
			dueOn: '2027-01-20'
		});
	});

	it('Phase löschen lässt die Aufgaben ohne Phase; „Meine Aufgaben“ mit Phase', async () => {
		const phase = detail.phases.find((p) => p.name === 'Planung')!;
		const anmeldung = detail.phases.find((p) => p.name === 'Anmeldung')!;
		ok(
			await call('owner', 'PATCH', `/tasks/${taskId}`, {
				phaseId: anmeldung.id,
				assigneeIds: [userIds.owner]
			})
		);
		const mine = ok<MyTask[]>(await call('owner', 'GET', '/my/tasks'));
		expect(mine.find((m) => m.id === taskId)).toMatchObject({
			isMilestone: true,
			phase: { id: anmeldung.id, name: 'Anmeldung' }
		});
		detail = ok<BoardDetail>(
			await call('owner', 'DELETE', `/boards/${boardId}/phases/${anmeldung.id}`)
		);
		expect(detail.phases.map((p) => [p.name, p.position])).toEqual([['Planung', 0]]);
		expect(detail.tasks.find((t) => t.id === taskId)?.phaseId).toBeNull();
		expect(
			(await call('owner', 'DELETE', `/boards/${boardId}/phases/${anmeldung.id}`)).status
		).toBe(404);
		expect(phase.id).toBeTruthy();
	});
});

describe('Abhängigkeiten', () => {
	it('Vorgänger setzen, Kreise und fremde Aufgaben → 422, offene Vorgänger zählen', async () => {
		const mk = async (title: string) =>
			ok<TaskDetail>(await call('owner', 'POST', `/boards/${boardId}/tasks`, { title }), 201).id;
		const a = await mk('A');
		const b = await mk('B');
		const c = await mk('C');
		const t = ok<TaskDetail>(await call('owner', 'PUT', `/tasks/${b}/dependencies`, { ids: [a] }));
		expect(t).toMatchObject({ blockedBy: [a], openBlockers: 1 });
		ok(await call('owner', 'PUT', `/tasks/${c}/dependencies`, { ids: [b] }));
		expect(
			issuePaths(await call('owner', 'PUT', `/tasks/${a}/dependencies`, { ids: [c] }))
		).toEqual(['ids']);
		expect(
			issuePaths(await call('owner', 'PUT', `/tasks/${a}/dependencies`, { ids: [a] }))
		).toEqual(['ids.0']);
		const foreign = ok<TaskDetail>(
			await call(
				'owner',
				'POST',
				`/boards/${ok<BoardDetail>(await call('owner', 'POST', '/boards', { name: 'F' }), 201).id}/tasks`,
				{ title: 'Fremd' }
			),
			201
		).id;
		expect(
			issuePaths(await call('owner', 'PUT', `/tasks/${a}/dependencies`, { ids: [foreign] }))
		).toEqual(['ids.0']);
		expect((await call('reader', 'PUT', `/tasks/${a}/dependencies`, { ids: [] })).status).toBe(403);

		const done = detail.columns.find((col) => col.isDone)!;
		ok(await call('owner', 'POST', `/tasks/${a}/move`, { columnId: done.id, position: 0 }), 201);
		detail = ok<BoardDetail>(await call('owner', 'GET', `/boards/${boardId}`));
		expect(detail.tasks.find((x) => x.id === b)).toMatchObject({ blockedBy: [a], openBlockers: 0 });
		// Löschen räumt Kanten auf
		ok(await call('owner', 'DELETE', `/tasks/${a}`));
		detail = ok<BoardDetail>(await call('owner', 'GET', `/boards/${boardId}`));
		expect(detail.tasks.find((x) => x.id === b)?.blockedBy).toEqual([]);
	});
});

describe('Vorlagen und Verschieben (ohne Aktion)', () => {
	let campBoard: BoardDetail;
	let ownTemplate: TemplateSummary;

	it('liefert die mitgelieferten Vorlagen; nur mit Anlege-Recht', async () => {
		const list = ok<TemplateSummary[]>(await call('owner', 'GET', '/templates'));
		expect(list.map((t) => t.id)).toEqual(['builtin:fahrt', 'builtin:tagesaktion']);
		expect(list[0]).toMatchObject({ builtin: true, canDelete: false });
		expect(list[0]!.phases.map((p) => p.name)).toEqual([
			'Planung',
			'Anmeldung',
			'Vorbereitung',
			'Lager',
			'Nachbereitung'
		]);
		expect((await call('reader', 'GET', '/templates')).status).toBe(403);
	});

	it('Board aus Vorlage mit Bezugsdatum: eintägig, Daten relativ zum Bezugsdatum', async () => {
		campBoard = ok<BoardDetail>(
			await call('owner', 'POST', '/boards', {
				name: 'Pfingstlager 2027',
				templateId: 'builtin:fahrt',
				anchorOn: '2027-05-14'
			}),
			201
		);
		expect(campBoard.anchorOn).toBe('2027-05-14');
		expect(campBoard.action).toBeNull();
		expect(campBoard.actionStartsOn).toBeNull();
		expect(campBoard.actionShift).toBeNull();
		expect(campBoard.columns.map((c) => c.name)).toEqual(['Offen', 'In Arbeit', 'Erledigt']);
		// ohne Aktion = eintägig: Ende = Bezugsdatum
		const lager = campBoard.phases.find((p) => p.name === 'Lager')!;
		expect([lager.startsOn, lager.endsOn]).toEqual(['2027-05-14', '2027-05-14']);
		const nach = campBoard.phases.find((p) => p.name === 'Nachbereitung')!;
		expect([nach.startsOn, nach.endsOn]).toEqual(['2027-05-15', '2027-06-25']);
		const schluss = campBoard.tasks.find((t) => t.title === 'Anmeldeschluss')!;
		expect(schluss).toMatchObject({ isMilestone: true, dueOn: '2027-03-15', startsOn: null });
		expect(schluss.phaseId).toBe(campBoard.phases.find((p) => p.name === 'Anmeldung')!.id);
		const zelt = campBoard.tasks.find((t) => t.title === 'Zeltplatz oder Haus anfragen')!;
		expect(zelt.checklist).toEqual({ done: 0, total: 3 });
		expect(
			issuePaths(
				await call('owner', 'POST', '/boards', { name: 'x', templateId: 'builtin:gibtsnicht' })
			)
		).toEqual(['templateId']);
		// ohne Bezugsdatum und ohne Aktion: heute
		const today = ok<BoardDetail>(
			await call('owner', 'POST', '/boards', { name: 'Heute', templateId: 'builtin:tagesaktion' }),
			201
		);
		expect(today.anchorOn).toBe('2027-01-10');
	});

	it('Board als eigene Vorlage speichern, nur für sich sichtbar, auf neues Datum anwenden', async () => {
		ownTemplate = ok<TemplateSummary>(
			await call('owner', 'POST', `/boards/${campBoard.id}/template`, { name: 'Unser Lager' }),
			201
		);
		expect(ownTemplate).toMatchObject({ builtin: false, canDelete: true, taskCount: 14 });
		expect(
			ok<TemplateSummary[]>(await call('other', 'GET', '/templates')).some(
				(t) => t.id === ownTemplate.id
			)
		).toBe(false);
		expect(
			issuePaths(
				await call('other', 'POST', '/boards', { name: 'Kopie', templateId: ownTemplate.id })
			)
		).toEqual(['templateId']);

		const copy = ok<BoardDetail>(
			await call('owner', 'POST', '/boards', {
				name: 'Pfingstlager 2028',
				templateId: ownTemplate.id,
				anchorOn: '2028-06-02'
			}),
			201
		);
		expect(copy.anchorOn).toBe('2028-06-02');
		expect(copy.phases.find((p) => p.name === 'Nachbereitung')?.startsOn).toBe('2028-06-03');
		expect(copy.tasks.find((t) => t.title === 'Anmeldeschluss')?.dueOn).toBe('2028-04-03');

		expect((await call('other', 'DELETE', `/templates/${ownTemplate.id}`)).status).toBe(404);
		ok(await call('owner', 'DELETE', `/templates/${ownTemplate.id}`));
		expect((await call('owner', 'GET', '/templates')).body.data).toHaveLength(2);
	});

	it('Daten verschieben ohne Aktion: alles mitverschieben oder mit apply: false nur das Bezugsdatum', async () => {
		let b = ok<BoardDetail>(
			await call('owner', 'POST', `/boards/${campBoard.id}/shift`, { days: 7 }),
			201
		);
		expect(b.actionShift).toBeNull();
		expect(b.anchorOn).toBe('2027-05-21');
		expect(b.tasks.find((t) => t.title === 'Anmeldeschluss')?.dueOn).toBe('2027-03-22');
		expect(b.phases.find((p) => p.name === 'Lager')?.startsOn).toBe('2027-05-21');

		b = ok<BoardDetail>(
			await call('owner', 'POST', `/boards/${campBoard.id}/shift`, { days: -1, apply: false }),
			201
		);
		expect(b.actionShift).toBeNull();
		expect(b.tasks.find((t) => t.title === 'Anmeldeschluss')?.dueOn).toBe('2027-03-22');
		expect(
			(await call('reader', 'POST', `/boards/${campBoard.id}/shift`, { days: 1 })).status
		).toBe(404);
		expect(
			(await call('stranger', 'POST', `/boards/${campBoard.id}/shift`, { days: 1 })).status
		).toBe(404);
	});

	it('Board an eine Aktion hängen ohne installiertes actions → 422', async () => {
		expect(
			issuePaths(
				await call('owner', 'POST', '/boards', {
					name: 'Mit Aktion',
					actionId: crypto.randomUUID(),
					templateId: 'builtin:fahrt'
				})
			)
		).toEqual(['actionId']);
	});

	it('Meilensteine im Kalender-Abo nur mit Schalter am Board', async () => {
		const schluss = campBoard.tasks.find((t) => t.title === 'Anmeldeschluss')!;
		const feed = ok<CalendarFeed>(
			await call(
				'owner',
				'POST',
				'/calendar-feeds',
				{ name: 'Alles', includeTasks: true },
				'events'
			),
			201
		);
		expect(feed.includeTasks).toBe(true);
		const fetchIcs = async () => {
			const url = new URL(feed.url!);
			const res = await handleApiRequest({ request: new Request(url), url, ip: '127.0.0.1' });
			expect(res.status).toBe(200);
			return (await res.text()).replace(/\r\n /g, '');
		};
		expect(await fetchIcs()).not.toContain('Anmeldeschluss');
		const b = ok<BoardDetail>(
			await call('owner', 'PATCH', `/boards/${campBoard.id}`, {
				calendarMilestones: true,
				defaultView: 'timeline'
			})
		);
		expect(b).toMatchObject({ calendarMilestones: true, defaultView: 'timeline' });
		const text = await fetchIcs();
		expect(text).toContain('SUMMARY:◆ Anmeldeschluss');
		expect(text).toContain(`milestone-${schluss.id}@tasks.`);
		expect(text).toContain('DTSTART;VALUE=DATE:20270322');
	});
});

describe('Reset, Audit', () => {
	it('Reset-Bereiche decken alle Tabellen des Moduls ab', async () => {
		const res = await core.database
			.forModule('tasks')
			.transaction((tx) =>
				tx.execute(
					sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'mod_tasks'`
				)
			);
		const rows = (Array.isArray(res) ? res : (res as { rows: Record<string, unknown>[] }).rows) as {
			table_name: string;
		}[];
		const covered = new Set(resetAreas!.flatMap((a) => a.tables));
		expect(rows.map((r) => r.table_name).filter((t) => !covered.has(t))).toEqual([]);
	});

	it('Audit ohne Inhalte', async () => {
		const { rows: audit } = await listAudit({ action: 'tasks.', limit: 500 });
		const items = audit.filter((e) => /^tasks\.(phase|template|board\.shifted)/.test(e.action));
		expect(new Set(items.map((e) => e.action))).toEqual(
			new Set([
				'tasks.phase.created',
				'tasks.phase.updated',
				'tasks.phase.reordered',
				'tasks.phase.deleted',
				'tasks.template.created',
				'tasks.template.deleted',
				'tasks.board.shifted'
			])
		);
		const text = JSON.stringify(items);
		expect(text).not.toContain('Planung');
		expect(text).not.toContain('Unser Lager');
	});
});
