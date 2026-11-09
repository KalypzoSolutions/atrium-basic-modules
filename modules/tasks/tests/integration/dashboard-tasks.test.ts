/**
 * Übersicht – Quelle `tasks` (`ModuleDefinition.dashboard`): eigene offene Aufgaben (direkt oder über eine
 * offene Unteraufgabe), überfällig oder in 7 Tagen fällig; Wochenstreifen als Fristen mit `late`.
 * Fremde, erledigte, spätere und Aufgaben ohne Fälligkeit erscheinen nicht; Modul aus → nichts.
 * Heute = Mittwoch 2026-06-03, Woche 2026-06-01 … 2026-06-07.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin, createUser } from '$testing';
import { createRole } from '$testing';
import { registerModule } from '$testing';
import { disableModule, enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { getDb, schema } from '$testing';
import { collectDashboardFeed } from '$testing';
import { core } from '$lib/sdk/server';
import { setTodayForTests } from '$lib/sdk/dates';
import tasksModule from '$modules/tasks/module';
import type { RequestContext } from '$lib/sdk/types';

const TODAY = '2026-06-03';
let close: () => Promise<void>;
let admin: RequestContext;
const userIds: Record<string, string> = {};
const taskIds: Record<string, string> = {};
const BOARD = crypto.randomUUID();
const OPEN_COL = crypto.randomUUID();
const DONE_COL = crypto.randomUUID();

const ctxOf = async (id: string) => (await contextForUser(id))!.ctx;
async function exec(q: ReturnType<typeof sql>) {
	await core.database.forModule('tasks').transaction(async (tx) => {
		await tx.execute(q);
	});
}

async function mkTask(
	key: string,
	opts: { due?: string | null; assignees?: string[]; done?: boolean }
): Promise<string> {
	const id = crypto.randomUUID();
	taskIds[key] = id;
	await exec(
		sql`INSERT INTO tasks (id, board_id, column_id, title, due_on, completed_at)
			VALUES (${id}, ${BOARD}, ${opts.done ? DONE_COL : OPEN_COL}, ${`Aufgabe ${key}`},
				${opts.due ?? null}::date, ${opts.done ? sql`now()` : sql`NULL`})`
	);
	for (const who of opts.assignees ?? []) {
		await exec(sql`INSERT INTO task_assignees (task_id, user_id) VALUES (${id}, ${userIds[who]!})`);
	}
	return id;
}

async function checklist(taskKey: string, done: boolean, assignee?: string) {
	await exec(
		sql`INSERT INTO task_checklist (id, task_id, title, done, assignee_id)
			VALUES (${crypto.randomUUID()}, ${taskIds[taskKey]!}, 'Punkt', ${done}, ${assignee ? userIds[assignee]! : null})`
	);
}

async function feed(who: string) {
	const f = await collectDashboardFeed(await ctxOf(userIds[who]!), { today: TODAY });
	return {
		todos: f.todos.filter((t) => t.moduleId === 'tasks'),
		agenda: f.agenda.filter((a) => a.moduleId === 'tasks'),
		failed: f.failed
	};
}

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
	setTodayForTests(TODAY);

	const role = await createRole(admin, { name: 'Aufgaben', permissions: ['tasks.board.view'] });
	const none = await createRole(admin, { name: 'Ohne', permissions: ['core.api.manage'] });
	for (const [name, r] of [
		['anna', role],
		['bert', role],
		['ohne', none]
	] as const) {
		userIds[name] = await createUser(admin, {
			name,
			email: `${name}@example.test`,
			password: 'a-long-enough-pw',
			roleIds: [r]
		});
	}

	await exec(
		sql`INSERT INTO boards (id, name, owner_id) VALUES (${BOARD}, 'Sommerlager', ${userIds.bert!})`
	);
	await exec(
		sql`INSERT INTO board_columns (id, board_id, name, position, is_done) VALUES
			(${OPEN_COL}, ${BOARD}, 'Offen', 0, false), (${DONE_COL}, ${BOARD}, 'Erledigt', 1, true)`
	);
	await mkTask('ueberfaellig', { due: '2026-05-30', assignees: ['anna'] });
	await mkTask('gestern', { due: '2026-06-02', assignees: ['anna'] });
	await mkTask('heute', { due: '2026-06-03', assignees: ['anna'] });
	await checklist('heute', true);
	await checklist('heute', false);
	await mkTask('bald', { due: '2026-06-10', assignees: ['anna'] });
	await mkTask('spaeter', { due: '2026-06-11', assignees: ['anna'] });
	await mkTask('ohneFrist', { due: null, assignees: ['anna'] });
	await mkTask('erledigt', { due: '2026-06-03', assignees: ['anna'], done: true });
	await mkTask('fremd', { due: '2026-06-03', assignees: ['bert'] });
	await mkTask('unteraufgabe', { due: '2026-06-04', assignees: ['bert'] });
	await checklist('unteraufgabe', false, 'anna');
	await mkTask('unteraufgabeFertig', { due: '2026-06-04', assignees: ['bert'] });
	await checklist('unteraufgabeFertig', true, 'anna');
});

afterAll(async () => {
	setTodayForTests(null);
	await close();
});

const id = (key: string) => `task:${taskIds[key]}`;

describe('Zu erledigen', () => {
	it('eigene offene Aufgaben, überfällig oder in 7 Tagen fällig', async () => {
		const f = await feed('anna');
		expect(f.failed).toEqual([]);
		expect(f.todos.map((t) => t.id)).toEqual(
			['ueberfaellig', 'gestern', 'heute', 'unteraufgabe', 'bald'].map(id)
		);
		const byId = new Map(f.todos.map((t) => [t.id, t]));
		expect(byId.get(id('ueberfaellig'))).toMatchObject({
			severity: 'overdue',
			due: '2026-05-30',
			title: 'Aufgabe ueberfaellig',
			detail: 'Aufgabe · Sommerlager'
		});
		expect(byId.get(id('heute'))).toMatchObject({
			severity: 'due',
			detail: 'Aufgabe · Sommerlager · Unteraufgaben 1 von 2',
			action: {
				label: 'Öffnen',
				href: `/modules/tasks/${BOARD}?task=${taskIds.heute}`
			}
		});
		expect(byId.get(id('bald'))?.severity).toBe('due');
	});

	it('andere Person sieht nur ihre eigenen', async () => {
		const f = await feed('bert');
		expect(f.todos.map((t) => t.id).sort()).toEqual(
			['fremd', 'unteraufgabe', 'unteraufgabeFertig'].map(id).sort()
		);
	});

	it('ohne Recht nichts', async () => {
		const f = await feed('ohne');
		expect(f.todos).toEqual([]);
		expect(f.agenda).toEqual([]);
	});
});

describe('Diese Woche', () => {
	it('Fristen im Zeitraum, verstrichene mit late', async () => {
		const f = await feed('anna');
		expect(f.agenda.map((a) => a.id)).toEqual(['gestern', 'heute', 'unteraufgabe'].map(id));
		expect(f.agenda[0]).toMatchObject({ kind: 'deadline', date: '2026-06-02', late: true });
		expect(f.agenda[1]?.late).toBeUndefined();
		expect(f.agenda[1]?.href).toBe(`/modules/tasks/${BOARD}?task=${taskIds.heute}`);
	});
});

describe('Modul deaktiviert', () => {
	it('liefert nichts', async () => {
		await disableModule(admin, 'tasks');
		try {
			const f = await feed('anna');
			expect(f.todos).toEqual([]);
			expect(f.agenda).toEqual([]);
		} finally {
			await enableModule(admin, 'tasks');
		}
	});
});
