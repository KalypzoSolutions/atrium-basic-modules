import { sql, type SQL } from 'drizzle-orm';
import {
	eventSnapshot,
	notifyEventCreated,
	notifyEventDeleted,
	notifyEventUpdated,
	notifyOccurrence
} from './notify';
import {
	type ApiEndpoint,
	core,
	defineEndpoint,
	errors,
	moduleDb,
	principalKeysFor,
	type RequestContext,
	rowsOf,
	type Tx,
	validatePrincipals
} from '$lib/sdk/server';
import { accessForMany, loadShares, requireAccess, visibleEventsFilter } from './access';
import {
	EVENT_COLUMNS,
	EVENT_ORDER,
	buildDetail,
	buildItems,
	compareOccurrences,
	deleteException,
	expandRow,
	hydrateRows,
	insertEvent,
	loadEventRow,
	loadExceptions,
	resolveDetailOccurrence,
	seriesDates,
	seriesInfo,
	singleOccurrence,
	todayBerlin,
	updateEvent,
	upsertException,
	validateGroupIds,
	validateOverride,
	type OccurrenceRow
} from './events.service';
import { addDays, isOccurrence } from './recurrence';
import {
	MAX_OCCURRENCES,
	MODULE_ID,
	PUBLISH_PERMISSION,
	OPEN_WINDOW_DAYS,
	detailQuery,
	eventInput,
	idParams,
	listQuery,
	occurrenceInput,
	occurrenceParams,
	type EventAccess,
	type EventList
} from './schemas';

const tags = ['Modul: events'];

/**
 * Höchstzahl Kandidaten-Zeilen je Listenabfrage. Einmalige Termine und Serien werden gemeinsam
 * geladen, Serien in JS expandiert und erst danach sortiert und paginiert (`offset`/`limit` auf
 * Vorkommen) – SQL-Pagination wäre mit expandierten Serien nicht korrekt.
 */
const LIST_ROW_CAP = 5000;

/** `%`, `_` und `\` für ILIKE maskieren */
const likePattern = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

function matchesSearch(o: OccurrenceRow, search: string): boolean {
	const q = search.toLocaleLowerCase('de-DE');
	return [o.title, o.location, o.description].some(
		(v) => !!v && v.toLocaleLowerCase('de-DE').includes(q)
	);
}

/**
 * Detaildaten in der Transaktion: Zugriff, Zeile, Ausnahmen, Freigaben und das angefragte
 * Vorkommen (bzw. Standard-Vorkommen). Nur Datenbankzugriffe und reine Logik.
 */
async function loadDetailData(
	tx: Tx,
	ctx: RequestContext,
	id: string,
	keys: readonly string[],
	occurrence?: string
) {
	const access = await requireAccess(tx, ctx, id, keys, 'read');
	const row = await loadEventRow(tx, id);
	if (!row) throw errors.notFound('Termin nicht gefunden');
	const exceptions = row.recurrence ? (await loadExceptions(tx, [id])).get(id) : undefined;
	const shares = access.level === 'edit' ? await loadShares(tx, id) : [];
	const occ = resolveDetailOccurrence(row, exceptions, occurrence, access.level === 'edit');
	return { occ, access, shares, series: seriesInfo(row), exceptions };
}

type DetailData = Awaited<ReturnType<typeof loadDetailData>>;

const detailOf = (ctx: RequestContext, d: DetailData) =>
	buildDetail(ctx, d.occ, d.access, d.shares, d.series, d.exceptions);

/** Gemeinsame Prüfung für die Vorkommen-Endpoints: Bearbeiten, Serie, gültiges Datum */
async function requireOccurrence(
	tx: Tx,
	ctx: RequestContext,
	id: string,
	date: string,
	keys: readonly string[]
) {
	await requireAccess(tx, ctx, id, keys, 'edit');
	const row = await loadEventRow(tx, id);
	if (!row) throw errors.notFound('Termin nicht gefunden');
	if (!row.recurrence) throw errors.badRequest('Kein Serientermin');
	if (!isOccurrence(seriesDates(row), row.recurrence, date)) {
		throw errors.notFound('Termin nicht gefunden');
	}
	return row;
}

/** Filter für `listVisibleOccurrences` (wie `GET /events`, ohne Pagination) */
export interface OccurrenceFilter {
	from?: string | null;
	to?: string | null;
	search?: string | null;
	tag?: string | null;
	groupId?: string | null;
}

/**
 * Sichtbare Termine und Serien-Vorkommen, sortiert und auf `MAX_OCCURRENCES` gekappt, dazu der Zugriff je
 * Termin (für `buildItems`). Gemeinsame Grundlage von `GET /events` und dem PDF-Export, damit beide genau
 * dasselbe zeigen. Ruft Core-Dienste (Principal-Schlüssel) vor der Transaktion auf.
 */
export async function listVisibleOccurrences(
	ctx: RequestContext,
	filter: OccurrenceFilter
): Promise<{ occurrences: OccurrenceRow[]; access: Map<string, EventAccess> }> {
	const keys = await principalKeysFor(ctx, MODULE_ID);
	const from = filter.from ?? null;
	const to = filter.to ?? null;
	const search = filter.search || null;
	// Serien brauchen ein Ende: ohne `to` ein Jahr ab `from` (bzw. heute)
	const seriesTo = to ?? addDays(from ?? todayBerlin(), OPEN_WINDOW_DAYS);

	const conds: SQL[] = [visibleEventsFilter(ctx, keys)];
	const single: SQL[] = [sql`e.recurrence IS NULL`];
	if (to) single.push(sql`e.starts_on <= ${to}::date`);
	if (from) single.push(sql`COALESCE(e.ends_on, e.starts_on) >= ${from}::date`);
	const series: SQL[] = [sql`e.recurrence IS NOT NULL`, sql`e.starts_on <= ${seriesTo}::date`];
	if (from) {
		// letztes Vorkommen + Dauer muss `from` erreichen
		series.push(sql`(e.recurrence_until IS NULL OR
			e.recurrence_until + COALESCE(e.ends_on - e.starts_on, 0) >= ${from}::date)`);
	}
	conds.push(sql`((${sql.join(single, sql` AND `)}) OR (${sql.join(series, sql` AND `)}))`);
	if (search) {
		const p = likePattern(search);
		conds.push(sql`(e.title ILIKE ${p} OR e.location ILIKE ${p} OR e.description ILIKE ${p}
			OR (e.recurrence IS NOT NULL AND EXISTS (SELECT 1 FROM event_exceptions x
				WHERE x.event_id = e.id AND (x.override->>'title' ILIKE ${p}
					OR x.override->>'location' ILIKE ${p}
					OR x.override->>'description' ILIKE ${p}))))`);
	}
	if (filter.tag) {
		conds.push(sql`EXISTS (SELECT 1 FROM event_tags t
			WHERE t.event_id = e.id AND lower(t.tag) = lower(${filter.tag}))`);
	}
	if (filter.groupId) {
		conds.push(sql`EXISTS (SELECT 1 FROM event_groups g
			WHERE g.event_id = e.id AND g.group_id = ${filter.groupId})`);
	}
	const where = sql.join(conds, sql` AND `);

	const { rows, exceptions, access } = await moduleDb(MODULE_ID).transaction(async (tx) => {
		const raw = await rowsOf(
			tx,
			sql`SELECT ${EVENT_COLUMNS} FROM events e WHERE ${where}
				ORDER BY ${EVENT_ORDER} LIMIT ${LIST_ROW_CAP}`
		);
		const rows = await hydrateRows(tx, raw);
		const exceptions = await loadExceptions(
			tx,
			rows.filter((r) => r.recurrence).map((r) => r.id)
		);
		const access = await accessForMany(tx, ctx, rows, keys);
		return { rows, exceptions, access };
	});

	const all: OccurrenceRow[] = [];
	for (const row of rows) {
		if (!row.recurrence) {
			all.push(singleOccurrence(row));
			continue;
		}
		let occs = expandRow(row, exceptions.get(row.id), from ?? row.startsOn, seriesTo);
		if (search) occs = occs.filter((o) => matchesSearch(o, search));
		all.push(...occs);
	}
	all.sort(compareOccurrences);
	return { occurrences: all.slice(0, MAX_OCCURRENCES), access };
}

export const eventEndpoints = [
	defineEndpoint({
		method: 'GET',
		path: '/events',
		summary: 'Sichtbare Termine und Serien-Vorkommen (Zeitraum, Suche, Tag, Gruppe)',
		tags,
		permission: 'events.event.view',
		query: listQuery,
		handler: async ({ ctx, query }): Promise<EventList> => {
			const { occurrences, access } = await listVisibleOccurrences(ctx, query);
			const page = occurrences.slice(query.offset, query.offset + query.limit);
			return { items: await buildItems(ctx, page, access), total: occurrences.length };
		}
	}),

	defineEndpoint({
		method: 'PUT',
		path: '/events/:id/occurrences/:date',
		summary: 'Vorkommen einer Serie absagen oder einzeln ändern',
		tags,
		permission: 'events.event.view',
		params: occurrenceParams,
		body: occurrenceInput,
		handler: async ({ ctx, params, body }) => {
			const keys = await principalKeysFor(ctx, MODULE_ID);
			const data = await moduleDb(MODULE_ID).transaction(async (tx) => {
				const row = await requireOccurrence(tx, ctx, params.id, params.date, keys);
				validateOverride(seriesDates(row), params.date, body.override);
				await upsertException(tx, ctx, params.id, params.date, body.cancelled, body.override);
				return loadDetailData(tx, ctx, params.id, keys, params.date);
			});
			const detail = await detailOf(ctx, data);
			await core.audit.logFromContext(ctx, 'events.event.occurrence_updated', {
				target: params.id,
				metadata: {
					cancelled: body.cancelled,
					fields: Object.keys(body.override ?? {}).length
				}
			});
			await notifyOccurrence(ctx, params.id, params.date, {
				cancelled: body.cancelled,
				override: (body.override ?? null) as Record<string, unknown> | null
			});
			return detail;
		}
	}),

	defineEndpoint({
		method: 'DELETE',
		path: '/events/:id/occurrences/:date',
		summary: 'Vorkommen einer Serie zurücksetzen (Absage/Änderung entfernen)',
		tags,
		permission: 'events.event.view',
		params: occurrenceParams,
		handler: async ({ ctx, params }) => {
			const keys = await principalKeysFor(ctx, MODULE_ID);
			const data = await moduleDb(MODULE_ID).transaction(async (tx) => {
				await requireOccurrence(tx, ctx, params.id, params.date, keys);
				await deleteException(tx, params.id, params.date);
				return loadDetailData(tx, ctx, params.id, keys, params.date);
			});
			const detail = await detailOf(ctx, data);
			await core.audit.logFromContext(ctx, 'events.event.occurrence_reset', {
				target: params.id
			});
			return detail;
		}
	}),

	defineEndpoint({
		method: 'GET',
		path: '/events/:id',
		summary: 'Termin bzw. Vorkommen einer Serie (Freigaben nur bei Bearbeiten-Zugriff)',
		tags,
		permission: 'events.event.view',
		params: idParams,
		query: detailQuery,
		handler: async ({ ctx, params, query }) => {
			const keys = await principalKeysFor(ctx, MODULE_ID);
			const data = await moduleDb(MODULE_ID).transaction((tx) =>
				loadDetailData(tx, ctx, params.id, keys, query.occurrence)
			);
			return detailOf(ctx, data);
		}
	}),

	defineEndpoint({
		method: 'POST',
		path: '/events',
		summary: 'Termin anlegen',
		tags,
		permission: 'events.event.create',
		body: eventInput,
		handler: async ({ ctx, body }) => {
			await core.permissions.require(ctx, 'events.event.view');
			// Veröffentlichen ist ein eigenes Recht (#67, 01b-06)
			if (body.onWebsite) await core.permissions.require(ctx, PUBLISH_PERMISSION);
			const ownerId = ctx.userId;
			if (!ownerId) throw errors.badRequest('Termine können nur von Benutzern angelegt werden');
			await validatePrincipals(ctx, MODULE_ID, body.shares);
			await validateGroupIds(ctx, body.groupIds);

			const id = crypto.randomUUID();
			const row = await moduleDb(MODULE_ID).transaction(async (tx) => {
				await insertEvent(tx, ctx, id, ownerId, body);
				return loadEventRow(tx, id);
			});
			if (!row) throw errors.notFound('Termin nicht gefunden');
			const access: EventAccess = { level: 'edit', isOwner: true };
			const detail = await buildDetail(
				ctx,
				resolveDetailOccurrence(row, undefined, undefined, true),
				access,
				body.shares.map((s) => ({ type: s.type, id: s.id, level: s.level })),
				seriesInfo(row)
			);
			await core.audit.logFromContext(ctx, 'events.event.created', {
				target: id,
				metadata: {
					onWebsite: body.onWebsite,
					tags: body.tags.length,
					groups: body.groupIds.length,
					shares: body.shares.length
				}
			});
			if (body.onWebsite) {
				await core.audit.logFromContext(ctx, 'events.event.published', { target: id });
			}
			await notifyEventCreated(ctx, id);
			return detail;
		}
	}),

	defineEndpoint({
		method: 'PUT',
		path: '/events/:id',
		summary: 'Termin bzw. Serie ersetzen (inkl. Tags, Gruppen, Freigaben)',
		tags,
		permission: 'events.event.view',
		params: idParams,
		body: eventInput,
		handler: async ({ ctx, params, body }) => {
			const keys = await principalKeysFor(ctx, MODULE_ID);
			// Zugriff zuerst (Fremde → 404 vor jeder Validierung); gespeicherte Freigaben/Gruppen
			// gelten als gültig, auch wenn ihr Anbieter (members) inzwischen deaktiviert ist.
			const stored = await moduleDb(MODULE_ID).transaction(async (tx) => {
				await requireAccess(tx, ctx, params.id, keys, 'edit');
				const current = await loadEventRow(tx, params.id);
				return {
					shares: await loadShares(tx, params.id),
					groupIds: current?.groupIds ?? [],
					onWebsite: current?.onWebsite ?? false
				};
			});
			// Wechsel auf „öffentlich“ nur mit eigenem Recht (#67, 01b-06); Zurücknehmen darf jede*r mit edit
			const publishing = body.onWebsite && !stored.onWebsite;
			if (publishing) await core.permissions.require(ctx, PUBLISH_PERMISSION);
			await validatePrincipals(ctx, MODULE_ID, body.shares, {
				keep: new Set(stored.shares.map((s) => `${s.type}:${s.id}`))
			});
			await validateGroupIds(ctx, body.groupIds, new Set(stored.groupIds));

			const before = await eventSnapshot(params.id);
			const data = await moduleDb(MODULE_ID).transaction(async (tx) => {
				await requireAccess(tx, ctx, params.id, keys, 'edit');
				// entfernt auch Ausnahmen, die kein Vorkommen mehr sind
				await updateEvent(tx, ctx, params.id, body);
				// Zugriff neu bestimmen (Freigaben können sich geändert haben)
				return loadDetailData(tx, ctx, params.id, keys);
			});
			const detail = await detailOf(ctx, data);
			await core.audit.logFromContext(ctx, 'events.event.updated', {
				target: params.id,
				metadata: {
					onWebsite: body.onWebsite,
					tags: body.tags.length,
					groups: body.groupIds.length,
					shares: body.shares.length
				}
			});
			if (body.onWebsite !== stored.onWebsite) {
				await core.audit.logFromContext(
					ctx,
					publishing ? 'events.event.published' : 'events.event.unpublished',
					{ target: params.id }
				);
			}
			await notifyEventUpdated(ctx, before, params.id);
			return detail;
		}
	}),

	defineEndpoint({
		method: 'DELETE',
		path: '/events/:id',
		summary: 'Termin bzw. ganze Serie löschen',
		tags,
		permission: 'events.event.view',
		params: idParams,
		handler: async ({ ctx, params }) => {
			const keys = await principalKeysFor(ctx, MODULE_ID);
			// Empfänger der Absage vor dem Löschen ermitteln (nur mit Bearbeiten-Zugriff)
			await moduleDb(MODULE_ID).transaction((tx) =>
				requireAccess(tx, ctx, params.id, keys, 'edit')
			);
			const before = await eventSnapshot(params.id);
			await moduleDb(MODULE_ID).transaction(async (tx) => {
				await requireAccess(tx, ctx, params.id, keys, 'edit');
				await tx.execute(sql`DELETE FROM events WHERE id = ${params.id}`);
			});
			await core.audit.logFromContext(ctx, 'events.event.deleted', { target: params.id });
			await notifyEventDeleted(ctx, before);
			return { id: params.id, deleted: true };
		}
	})
] as ApiEndpoint[];
