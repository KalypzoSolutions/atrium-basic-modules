/**
 * Kopplung mit dem Modul `rooms` (Raumplanung, Repo `atrium-gemeinde-modules`): Raum direkt am Termin buchen.
 * Läuft nur, wenn `rooms` im Modulverzeichnis liegt (sonst übersprungen).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	adminContext,
	apiCall,
	contextForEmail,
	createApiKey,
	disableModule,
	enableModule,
	registerCoreApi,
	registerModule,
	syncModules,
	useTestDatabase
} from '$testing';
import { setTodayForTests } from '$lib/sdk/dates';
import type { RequestContext } from '$lib/sdk/types';
import eventsModule from '$modules/events/module';
import type { EventDetail, EventList } from '$modules/events/schemas';

import type { ModuleDefinition } from '$lib/sdk/server';

// `rooms` liegt in einem anderen Repository: nur im kombinierten Lauf vorhanden, sonst wird übersprungen
const roomsLoader = Object.values(
	import.meta.glob<ModuleDefinition>('$modules/rooms/module.ts', { import: 'default' })
)[0];
const hasRooms = !!roomsLoader;
const E = '/modules/events';
const R = '/modules/rooms';
let key = '';
let admin: RequestContext;
const rooms: Record<string, string> = {};

const event = (over: Record<string, unknown> = {}) => ({
	...base(),
	...over,
	endsOn: (over.startsOn as string | undefined) ?? '2026-11-19'
});

const base = () => ({
	title: 'Elternabend',
	description: null,
	location: null,
	startsOn: '2026-11-19',
	startsTime: '19:00',
	endsOn: null,
	endsTime: '21:00',
	tags: [],
	groupIds: [],
	shares: [],
	onWebsite: false
});

describe.skipIf(!hasRooms)('Termine ↔ Räume', () => {
	beforeAll(async () => {
		setTodayForTests('2026-11-09');
		await useTestDatabase();
		registerCoreApi();
		registerModule(eventsModule);
		registerModule(await roomsLoader!());
		await syncModules();
		admin = await adminContext('admin@example.test', 'correct-horse-battery');
		await enableModule(admin, 'events');
		await enableModule(admin, 'rooms');
		admin = await contextForEmail('admin@example.test');
		key = (
			await createApiKey(admin, {
				name: 'k',
				scopes: [
					'events.event.view',
					'events.event.create',
					'events.event.edit-all',
					'rooms.booking.view',
					'rooms.booking.create',
					'rooms.booking.fix',
					'rooms.room.manage'
				]
			})
		).key;
		for (const [name, capacity, heat] of [
			['Saal', 80, 800],
			['Gruppenraum', 20, 200]
		] as const) {
			const r = await apiCall<{ id: string }>(key, 'POST', `${R}/rooms`, {
				name,
				capacity,
				heatingCostCentsPerHour: heat
			});
			expect(r.status).toBe(201);
			rooms[name] = r.body.data!.id;
		}
	});

	afterAll(() => setTodayForTests(null));

	let id = '';

	it('Raumauswahl für das Formular', async () => {
		const r = await apiCall<{ rooms: unknown[]; canBook: boolean }>(
			key,
			'GET',
			`${E}/room-options`
		);
		expect(r.status).toBe(200);
		expect(r.body.data?.rooms).toHaveLength(2);
		expect(r.body.data?.canBook).toBe(true);
	});

	it('Termin mit Raum anlegen: kleinster Raum, Raum als Ort in der Liste', async () => {
		const r = await apiCall<EventDetail>(key, 'POST', `${E}/events`, {
			...event(),
			room: { mode: 'flexible', roomId: null, persons: 15, featureIds: [] }
		});
		expect(r.status, JSON.stringify(r.body)).toBe(201);
		id = r.body.data!.id;
		expect(r.body.data!.roomRequest).toMatchObject({ persons: 15 });
		expect(r.body.data!.room).toEqual({ name: 'Gruppenraum' });
		const list = await apiCall<EventList>(key, 'GET', `${E}/events?from=2026-11-19&to=2026-11-19`);
		expect(list.body.data!.items[0]!.room).toEqual({ name: 'Gruppenraum' });
	});

	it('Termin ändern passt die Buchung an (ohne `room` im Body)', async () => {
		const r = await apiCall<EventDetail>(
			key,
			'PUT',
			`${E}/events/${id}`,
			event({ startsOn: '2026-11-20' })
		);
		expect(r.status, JSON.stringify(r.body)).toBe(200);
		expect(r.body.data!.room).toEqual({ name: 'Gruppenraum' });
		const occ = await apiCall<{ date: string; eventId: string }[]>(
			key,
			'GET',
			`${R}/occurrences?from=2026-11-19&to=2026-11-20`
		);
		expect(occ.body.data!.map((o) => o.date)).toEqual(['2026-11-20']);
	});

	it('kein Raum frei → 409, Termin unverändert', async () => {
		const r = await apiCall(key, 'PUT', `${E}/events/${id}`, {
			...event({ startsOn: '2026-11-20' }),
			room: { mode: 'flexible', roomId: null, persons: 500, featureIds: [] }
		});
		expect(r.status).toBe(409);
		const d = await apiCall<EventDetail>(key, 'GET', `${E}/events/${id}`);
		expect(d.body.data!.roomRequest?.persons).toBe(15);
	});

	it('ganztägige Termine können keinen Raum buchen (422)', async () => {
		const r = await apiCall(key, 'POST', `${E}/events`, {
			...event({ startsTime: null, endsTime: null }),
			room: { mode: 'flexible', roomId: null, persons: 5, featureIds: [] }
		});
		expect(r.status).toBe(422);
	});

	it('Raum entfernen und Termin löschen räumen die Buchung auf', async () => {
		const r = await apiCall<EventDetail>(key, 'PUT', `${E}/events/${id}`, {
			...event({ startsOn: '2026-11-20' }),
			room: null
		});
		expect(r.body.data!.roomRequest).toBeNull();
		const again = await apiCall<EventDetail>(key, 'POST', `${E}/events`, {
			...event(),
			room: { mode: 'fixed', roomId: rooms.Saal, persons: 30, featureIds: [] }
		});
		expect(again.body.data!.room).toEqual({ name: 'Saal' });
		await apiCall(key, 'DELETE', `${E}/events/${again.body.data!.id}`);
		const occ = await apiCall<unknown[]>(
			key,
			'GET',
			`${R}/occurrences?from=2026-11-19&to=2026-11-19`
		);
		expect(occ.body.data).toEqual([]);
	});

	it('ohne aktive Raumplanung: Auswahl `null`, Raum-Anfrage 422', async () => {
		await disableModule(admin, 'rooms');
		const opts = await apiCall(key, 'GET', `${E}/room-options`);
		expect(opts.body.data).toBeNull();
		const r = await apiCall(key, 'POST', `${E}/events`, {
			...event(),
			room: { mode: 'flexible', roomId: null, persons: 5, featureIds: [] }
		});
		expect(r.status).toBe(422);
		await enableModule(admin, 'rooms');
	});
});
