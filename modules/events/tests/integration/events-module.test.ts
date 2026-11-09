import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { useTestDatabase } from '$testing';
import { contextForUser } from '$testing';
import { bootstrapAdmin } from '$testing';
import { registerModule } from '$testing';
import { enableModule, syncModules } from '$testing';
import { registerCoreApi } from '$testing';
import { getDb, schema } from '$testing';
import { getSetting } from '$testing';
import { core } from '$lib/sdk/server';
import eventsModule from '$modules/events/module';
import { DEFAULT_STAMM_NAME, STAMM_NAME_SETTING } from '$modules/events/schemas';
import type { RequestContext } from '$lib/sdk/types';

let close: () => Promise<void>;
let admin: RequestContext;
let adminId: string;

const ctxOf = async (userId: string) => (await contextForUser(userId))!.ctx;
const rows = async (query: ReturnType<typeof sql>) =>
	(
		(await core.database.forModule('events').transaction((tx) => tx.execute(query))) as unknown as {
			rows: Record<string, unknown>[];
		}
	).rows;

beforeAll(async () => {
	({ close } = await useTestDatabase());
	registerCoreApi();
	registerModule(eventsModule);
	await syncModules();
	await bootstrapAdmin('admin@example.test', 'Sehr-Sicheres-Passwort-1');
	const [u] = await getDb()
		.select({ id: schema.user.id })
		.from(schema.user)
		.where(eq(schema.user.email, 'admin@example.test'));
	adminId = u!.id;
	admin = await ctxOf(adminId);
	await enableModule(admin, 'events');
	admin = await ctxOf(adminId);
});

afterAll(async () => {
	await close();
});

describe('Modul events (Smoke)', () => {
	it('legt die Tabellen im Schema mod_events an', async () => {
		const res = (await getDb().execute(
			sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'mod_events'`
		)) as unknown as { rows: { table_name: string }[] };
		expect(res.rows.map((r) => r.table_name).sort()).toEqual([
			'calendar_feeds',
			'event_exceptions',
			'event_groups',
			'event_shares',
			'event_tags',
			'events'
		]);
	});

	it('registriert die Rechte und gibt sie der Administrator-Rolle', async () => {
		const perms = await getDb()
			.select({ key: schema.permission.key })
			.from(schema.permission)
			.where(eq(schema.permission.moduleId, 'events'));
		expect(perms.map((p) => p.key).sort()).toEqual([
			'events.ai.use',
			'events.event.create',
			'events.event.edit-all',
			'events.event.publish',
			'events.event.view',
			'events.event.view-all',
			'events.website.read'
		]);
		for (const p of perms) expect(admin.permissions.has(p.key)).toBe(true);
	});

	it('gibt der Rolle Mitglied das Leserecht (defaultRoleGrants)', async () => {
		const granted = await getDb()
			.select({ key: schema.rolePermission.permissionKey })
			.from(schema.rolePermission)
			.innerJoin(schema.role, eq(schema.role.id, schema.rolePermission.roleId))
			.where(eq(schema.role.name, 'Mitglied'));
		const keys = granted.map((g) => g.key);
		expect(keys).toContain('events.event.view');
		expect(keys.filter((k) => k.startsWith('events.'))).toEqual(['events.event.view']);
	});

	it('liefert den Standardnamen des Stamms', async () => {
		expect(await getSetting<string>(STAMM_NAME_SETTING)).toBe(DEFAULT_STAMM_NAME);
	});

	it('resetUsers entfernt Benutzer-Freigaben und überträgt fremde Termine', async () => {
		await core.database.forModule('events').transaction(async (tx) => {
			await tx.execute(sql`INSERT INTO events (id, title, starts_on, owner_id, created_by)
				VALUES ('e1', 'Eigener', '2026-11-01', ${adminId}, ${adminId}),
				       ('e2', 'Fremder', '2026-11-02', 'weg', 'weg')`);
			await tx.execute(sql`INSERT INTO event_shares (event_id, principal_type, principal_id, level, created_by)
				VALUES ('e1', 'user', 'weg', 'edit', 'weg'),
				       ('e1', 'user', ${adminId}, 'read', ${adminId}),
				       ('e2', 'role', 'r1', 'read', 'weg'),
				       ('e2', 'everyone', '*', 'read', 'weg')`);
		});
		await core.database
			.forModule('events')
			.transaction((tx) => eventsModule.resetUsers!(tx, adminId));

		const events = await rows(sql`SELECT id, owner_id, created_by FROM events ORDER BY id`);
		expect(events).toEqual([
			{ id: 'e1', owner_id: adminId, created_by: adminId },
			{ id: 'e2', owner_id: adminId, created_by: adminId }
		]);
		const shares = await rows(
			sql`SELECT event_id, principal_type, principal_id, created_by FROM event_shares
				ORDER BY event_id, principal_type`
		);
		expect(shares).toEqual([
			{ event_id: 'e1', principal_type: 'user', principal_id: adminId, created_by: adminId },
			{ event_id: 'e2', principal_type: 'everyone', principal_id: '*', created_by: adminId },
			{ event_id: 'e2', principal_type: 'role', principal_id: 'r1', created_by: adminId }
		]);
	});
});
