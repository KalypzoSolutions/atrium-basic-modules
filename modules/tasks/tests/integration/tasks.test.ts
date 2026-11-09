/**
 * Modul `tasks` (Aufgaben-Boards) ohne `members`/`actions`: Anlegen mit Standardspalten, Zugriffsmatrix
 * (Eigentümer*in, Freigabe Rolle/Benutzer, Zuweisung, fremd → 404), Aufgaben mit Zuständigen und Unteraufgaben,
 * Verschieben/Erledigt, Spalten, „Meine Aufgaben“, Validierung, Verhalten ohne installiertes `actions`,
 * Audit ohne Inhalte, Konto löschen, Fälligkeits-Job.
 * Gruppen-Freigabe (`members`) und Boards an Aktionen (`actions`) prüft ep-intern-modules
 * `modules/_integration/tests/integration/tasks-actions.test.ts`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
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
import { core } from '$testing';
import { setTodayForTests } from '$lib/sdk/dates';
import tasksModule from '$modules/tasks/module';
import { onUserDeleted } from '$modules/tasks/privacy';
import { sendDueReminders } from '$modules/tasks/notify';
import type { BoardDetail, BoardList, MyTask, TaskDetail } from '$modules/tasks/schemas';
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

let parentRole: string;
let boardId: string;
let taskId: string;
let cols: BoardDetail['columns'];

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
	keys.admin = (
		await createApiKey(admin, {
			name: 'admin',
			scopes: [...tasksModule.manifest.permissions]
		})
	).key;

	const base = ['core.api.manage', 'tasks.board.view'];
	const planner = await createRole(admin, {
		name: 'Planung',
		permissions: [...base, 'tasks.board.create']
	});
	const viewer = await createRole(admin, { name: 'Mitmachen', permissions: base });
	// eigene Rolle, damit die Rollen-Freigabe nur `parent` erreicht (ersetzt die Gruppen-Freigabe aus `members`)
	parentRole = await createRole(admin, { name: 'Eltern', permissions: base });
	const noTasks = await createRole(admin, {
		name: 'Ohne Aufgaben',
		permissions: ['core.api.manage']
	});
	await addUser('owner', planner);
	await addUser('parent', parentRole);
	await addUser('helper', viewer);
	await addUser('stranger', viewer);
	await addUser('outsider', noTasks);
});

afterAll(async () => {
	setTodayForTests(null);
	await close?.();
});

describe('Boards', () => {
	it('legt ein Board mit Standardspalten an', async () => {
		const board = ok<BoardDetail>(
			await call('owner', 'POST', '/boards', {
				name: 'Sommerlager-Vorbereitung',
				color: '#16A34A'
			}),
			201
		);
		boardId = board.id;
		cols = board.columns;
		expect(board.columns.map((c) => [c.name, c.isDone])).toEqual([
			['Offen', false],
			['In Arbeit', false],
			['Erledigt', true]
		]);
		expect(board.color).toBe('#16a34a');
		expect(board.access).toEqual({ level: 'edit', isOwner: true, canShare: true });
	});

	it('ohne Recht kein Anlegen; Fremde sehen nichts', async () => {
		expect((await call('parent', 'POST', '/boards', { name: 'X' })).status).toBe(403);
		expect((await call('stranger', 'GET', `/boards/${boardId}`)).status).toBe(404);
		expect(ok<BoardList>(await call('stranger', 'GET', '/boards')).items).toEqual([]);
		expect((await call('outsider', 'GET', '/boards')).status).toBe(403);
	});

	it('Rollen-Freigabe (lesen) gibt Konten mit der Rolle Zugriff', async () => {
		ok(
			await call('owner', 'PUT', `/boards/${boardId}/shares`, {
				shares: [{ type: 'role', id: parentRole, level: 'read' }]
			})
		);
		const seen = ok<BoardDetail>(await call('parent', 'GET', `/boards/${boardId}`));
		expect(seen.access.level).toBe('read');
		expect(
			(await call('parent', 'POST', `/boards/${boardId}/tasks`, { title: 'Nicht erlaubt' })).status
		).toBe(403);
		expect((await call('parent', 'PUT', `/boards/${boardId}/shares`, { shares: [] })).status).toBe(
			403
		);
	});
});

describe('Aufgaben', () => {
	it('legt eine Aufgabe mit Zuständigen und Unteraufgaben an', async () => {
		const task = ok<TaskDetail>(
			await call('owner', 'POST', `/boards/${boardId}/tasks`, {
				title: 'Zeltplatz buchen',
				description: 'Bis Ostern',
				priority: 'high',
				dueOn: '2027-03-01',
				assigneeIds: [userIds.owner],
				checklist: [
					{ title: 'Angebote einholen', assigneeId: userIds.helper },
					{ title: 'Anzahlung', dueOn: '2027-02-15' }
				]
			}),
			201
		);
		taskId = task.id;
		expect(task.columnId).toBe(cols[0]!.id);
		expect(task.assignees.map((a) => a.id)).toEqual([userIds.owner]);
		expect(task.items.map((i) => [i.title, i.assignee?.id ?? null])).toEqual([
			['Angebote einholen', userIds.helper],
			['Anzahlung', null]
		]);
		expect(task.checklist).toEqual({ done: 0, total: 2 });
		expect(task.canEdit).toBe(true);
	});

	it('Zugewiesene ohne Freigabe sehen das Board, dürfen verschieben und abhaken, aber nicht bearbeiten', async () => {
		const board = ok<BoardDetail>(await call('helper', 'GET', `/boards/${boardId}`));
		expect(board.access.level).toBe('read');
		expect(board.tasks.find((t) => t.id === taskId)?.canMove).toBe(true);
		const detail = ok<TaskDetail>(await call('helper', 'GET', `/tasks/${taskId}`));
		const item = detail.items[0]!;
		const done = ok<TaskDetail>(
			await call('helper', 'PATCH', `/tasks/${taskId}/checklist/${item.id}`, { done: true })
		);
		expect(done.checklist).toEqual({ done: 1, total: 2 });
		expect(
			(await call('helper', 'PATCH', `/tasks/${taskId}/checklist/${item.id}`, { title: 'X' }))
				.status
		).toBe(403);
		expect((await call('helper', 'PATCH', `/tasks/${taskId}`, { title: 'X' })).status).toBe(403);
		const moved = ok<TaskDetail>(
			await call('helper', 'POST', `/tasks/${taskId}/move`, { columnId: cols[1]!.id, position: 0 }),
			201
		);
		expect(moved.columnId).toBe(cols[1]!.id);
		// Lesende ohne Zuweisung dürfen nicht verschieben
		expect(
			(
				await call('parent', 'POST', `/tasks/${taskId}/move`, {
					columnId: cols[0]!.id,
					position: 0
				})
			).status
		).toBe(403);
	});

	it('Erledigt-Spalte setzt den Erledigt-Zeitpunkt, Zurückschieben löscht ihn', async () => {
		const done = ok<TaskDetail>(
			await call('owner', 'POST', `/tasks/${taskId}/move`, { columnId: cols[2]!.id, position: 5 }),
			201
		);
		expect(done.completedAt).not.toBeNull();
		const back = ok<TaskDetail>(
			await call('owner', 'POST', `/tasks/${taskId}/move`, { columnId: cols[0]!.id, position: 0 }),
			201
		);
		expect(back.completedAt).toBeNull();
	});

	it('ordnet Aufgaben innerhalb einer Spalte', async () => {
		const b = ok<TaskDetail>(
			await call('owner', 'POST', `/boards/${boardId}/tasks`, { title: 'Zweite' }),
			201
		);
		const c = ok<TaskDetail>(
			await call('owner', 'POST', `/boards/${boardId}/tasks`, { title: 'Dritte' }),
			201
		);
		ok(
			await call('owner', 'POST', `/tasks/${c.id}/move`, { columnId: cols[0]!.id, position: 0 }),
			201
		);
		const board = ok<BoardDetail>(await call('owner', 'GET', `/boards/${boardId}`));
		const order = board.tasks
			.filter((t) => t.columnId === cols[0]!.id)
			.sort((x, y) => x.position - y.position)
			.map((t) => t.title);
		expect(order).toEqual(['Dritte', 'Zeltplatz buchen', 'Zweite']);
		ok(await call('owner', 'DELETE', `/tasks/${b.id}`));
		ok(await call('owner', 'DELETE', `/tasks/${c.id}`));
	});

	it('prüft Zuständige und Felder (422)', async () => {
		const bad = await call('owner', 'POST', `/boards/${boardId}/tasks`, {
			title: 'X',
			assigneeIds: [userIds.outsider]
		});
		expect(bad.status).toBe(422);
		expect(
			(await call('owner', 'POST', `/boards/${boardId}/tasks`, { title: '', priority: 'egal' }))
				.status
		).toBe(422);
		expect(
			(await call('owner', 'POST', `/boards/${boardId}/tasks`, { title: 'X', dueOn: '2027-02-30' }))
				.status
		).toBe(422);
	});

	it('„Meine Aufgaben“ enthält direkte und Unteraufgaben-Zuweisungen', async () => {
		const mine = ok<MyTask[]>(await call('owner', 'GET', '/my/tasks'));
		expect(mine.map((t) => [t.title, t.viaChecklist])).toEqual([['Zeltplatz buchen', false]]);
		// Unteraufgabe des Helfers ist abgehakt → nicht mehr offen für ihn
		expect(ok<MyTask[]>(await call('helper', 'GET', '/my/tasks'))).toEqual([]);
	});
});

describe('Spalten', () => {
	it('Spalte mit Aufgaben nur mit Ziel löschbar; Erledigt-Spalte wechselbar', async () => {
		expect(
			(await call('owner', 'DELETE', `/boards/${boardId}/columns/${cols[0]!.id}`)).status
		).toBe(409);
		const after = ok<BoardDetail>(
			await call(
				'owner',
				'DELETE',
				`/boards/${boardId}/columns/${cols[0]!.id}?moveTo=${cols[1]!.id}`
			)
		);
		expect(after.columns.map((c) => c.name)).toEqual(['In Arbeit', 'Erledigt']);
		expect(after.tasks.every((t) => t.columnId === cols[1]!.id)).toBe(true);
		const flipped = ok<BoardDetail>(
			await call('owner', 'PATCH', `/boards/${boardId}/columns/${cols[1]!.id}`, { isDone: true })
		);
		expect(flipped.columns.map((c) => c.isDone)).toEqual([true, false]);
		expect(flipped.tasks.every((t) => t.completedAt !== null)).toBe(true);
		const reset = ok<BoardDetail>(
			await call('owner', 'PATCH', `/boards/${boardId}/columns/${cols[2]!.id}`, { isDone: true })
		);
		expect(reset.tasks.every((t) => t.completedAt === null)).toBe(true);
		const added = ok<BoardDetail>(
			await call('owner', 'POST', `/boards/${boardId}/columns`, { name: 'Ideen' }),
			201
		);
		const ids = added.columns.map((c) => c.id);
		const reordered = ok<BoardDetail>(
			await call('owner', 'PUT', `/boards/${boardId}/columns/order`, {
				ids: [ids[2]!, ids[0]!, ids[1]!]
			})
		);
		expect(reordered.columns.map((c) => c.name)).toEqual(['Ideen', 'In Arbeit', 'Erledigt']);
		expect(
			(await call('owner', 'PUT', `/boards/${boardId}/columns/order`, { ids: [ids[0]!] })).status
		).toBe(422);
	});
});

describe('ohne installiertes Modul actions', () => {
	it('Board an eine Aktion hängen → 422, Board der Aktion → 404', async () => {
		const actionId = crypto.randomUUID();
		const created = await call('owner', 'POST', '/boards', { name: 'Herbstfahrt', actionId });
		expect(created.status).toBe(422);
		expect(JSON.stringify(created.body.error?.details)).toContain('actionId');
		const patched = await call('owner', 'PATCH', `/boards/${boardId}`, { actionId });
		expect(patched.status).toBe(422);
		expect(JSON.stringify(patched.body.error?.details)).toContain('actionId');
		expect((await call('owner', 'GET', `/boards/by-action/${actionId}`)).status).toBe(404);
		const board = ok<BoardDetail>(await call('owner', 'GET', `/boards/${boardId}`));
		expect(board.action).toBeNull();
		expect(board.actionShift).toBeNull();
	});
});

describe('Audit, Fälligkeit, Konto löschen, Modul aus', () => {
	it('Audit ohne Titel/Beschreibungen', async () => {
		const { rows } = await listAudit({ action: 'tasks.', limit: 200 });
		expect(rows.length).toBeGreaterThan(3);
		const text = JSON.stringify(rows.map((i) => i.metadata));
		expect(text).not.toContain('Zeltplatz');
		expect(text).not.toContain('Ostern');
	});

	it('Job erinnert einmal je Tag an fällige Aufgaben', async () => {
		setTodayForTests('2027-02-28');
		const ctx = core.auth.systemContext('test');
		expect(await sendDueReminders(ctx)).toEqual({ tasks: 1, people: 1 });
		expect(await sendDueReminders(ctx)).toEqual({ tasks: 0, people: 0 });
		setTodayForTests(null);
	});

	it('Konto löschen entfernt Zuweisungen und überträgt Eigentum', async () => {
		await core.database
			.forModule('tasks')
			.transaction((tx) =>
				onUserDeleted!(tx, { userId: userIds.owner!, transferTo: userIds.helper! })
			);
		const rows = await core.database.forModule('tasks').transaction(async (tx) => ({
			owners: (await tx.execute(sql`SELECT DISTINCT owner_id FROM boards`)) as unknown as {
				rows: { owner_id: string }[];
			},
			assignees: (await tx.execute(
				sql`SELECT count(*)::int AS n FROM task_assignees WHERE user_id = ${userIds.owner!}`
			)) as unknown as { rows: { n: number }[] }
		}));
		expect(rows.owners.rows.map((r) => r.owner_id)).toEqual([userIds.helper]);
		expect(Number(rows.assignees.rows[0]!.n)).toBe(0);
	});

	it('Modul deaktiviert → 404', async () => {
		await disableModule(admin, 'tasks');
		expect((await call('admin', 'GET', '/boards')).status).toBe(404);
		await enableModule(admin, 'tasks');
	});
});
