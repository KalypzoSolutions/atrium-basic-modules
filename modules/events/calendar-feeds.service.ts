/**
 * Kalender-Abos (iCal): je Person mehrere Abos mit eigenem geheimen Link und Filter.
 *
 * - Token: 32 Zufallsbytes (base64url), gespeichert nur als `token_hash` (`core.crypto.forModule('events').hash`)
 *   und `token_enc` (verschlüsselt, damit die Person den Link später wieder kopieren kann). Erneuern macht
 *   den alten Link sofort ungültig. Datensicherung: `calendarFeedsBackup.rehash`.
 * - Abruf ohne Anmeldung (Kalender-Apps): Der Feed gilt mit den **aktuellen Rechten** der Person, der das
 *   Abo gehört (`core.auth.contextForUser`) – deaktiviertes Konto oder fehlendes `events.event.view` → 404.
 *   Termine wie `GET /events` (Freigaben, Serien mit Absagen/Änderungen), optional gefiltert nach Gruppen
 *   und Tags; Aktionen über `ActionsService.listCalendarActions` (sichtbare + eigene Anmeldungen).
 * Core-Aufrufe nie innerhalb einer Modul-Transaktion (PGlite).
 */
import { sql, type SQL } from 'drizzle-orm';
import {
	core,
	errors,
	inList,
	type ModuleBackupHooks,
	moduleDb,
	principalKeysFor,
	type RequestContext,
	rowsOf,
	toIso,
	toIsoOrNull
} from '$lib/sdk/server';
import type { ActionsService } from './peer-contracts';
import type { TaskRefsService } from '$modules/tasks/contract';
import { visibleEventsFilter } from './access';
import {
	EVENT_COLUMNS,
	EVENT_ORDER,
	compareOccurrences,
	expandRow,
	hydrateRows,
	loadExceptions,
	singleOccurrence,
	todayBerlin,
	validateGroupIds,
	type OccurrenceRow
} from './events.service';
import { stammName } from './groups';
import { buildCalendar, type IcsEvent } from './ical';
import { addDays } from './recurrence';
import {
	FEED_FUTURE_DAYS,
	FEED_PAST_DAYS,
	MAX_CALENDAR_FEEDS,
	MAX_OCCURRENCES,
	MODULE_ID,
	type CalendarFeed,
	type CalendarFeedInput,
	type CalendarFeedList
} from './schemas';

const mdb = () => moduleDb(MODULE_ID);
const crypt = () => core.crypto.forModule(MODULE_ID);
const str = (v: unknown) => (v == null ? '' : String(v));

/** Höchstzahl Kandidaten-Zeilen je Feed (wie die Terminliste) */
const FEED_ROW_CAP = 5000;
/** `last_used_at` höchstens so oft schreiben (Kalender-Apps rufen oft ab) */
const LAST_USED_MINUTES = 10;

function newToken(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return Buffer.from(bytes).toString('base64url');
}

/** Öffentliche Abo-Adresse zu einem Token */
export function feedUrl(token: string): string {
	return `${core.app.origin()}/api/v1/modules/${MODULE_ID}/public/calendar/${token}.ics`;
}

function jsonList(v: unknown): string[] {
	const list = typeof v === 'string' ? (JSON.parse(v) as unknown) : v;
	return Array.isArray(list) ? list.map(String) : [];
}

function toDto(r: Record<string, unknown>): CalendarFeed {
	let url: string | null;
	try {
		url = feedUrl(crypt().decrypt(str(r.token_enc)));
	} catch {
		url = null;
	}
	return {
		id: str(r.id),
		name: str(r.name),
		includeEvents: r.include_events === true || r.include_events === 't',
		includeActions: r.include_actions === true || r.include_actions === 't',
		includeTasks: r.include_tasks === true || r.include_tasks === 't',
		groupIds: jsonList(r.group_ids),
		tags: jsonList(r.tags),
		url,
		webcalUrl: url ? url.replace(/^https?:/, 'webcal:') : null,
		createdAt: toIso(r.created_at),
		lastUsedAt: toIsoOrNull(r.last_used_at)
	};
}

function requireUser(ctx: RequestContext): string {
	if (!ctx.userId) throw errors.badRequest('Kalender-Abos gibt es nur für Benutzerkonten');
	return ctx.userId;
}

async function actionsService(): Promise<ActionsService | null> {
	return core.modules.useOptional<ActionsService>('actions', MODULE_ID);
}

async function tasksService(): Promise<TaskRefsService | null> {
	return core.modules.useOptional<TaskRefsService>('tasks', MODULE_ID);
}

async function loadOwnFeed(userId: string, id: string): Promise<Record<string, unknown>> {
	const [row] = await mdb().transaction((tx) =>
		rowsOf(tx, sql`SELECT * FROM calendar_feeds WHERE id = ${id} AND user_id = ${userId}`)
	);
	if (!row) throw errors.notFound('Kalender-Abo nicht gefunden');
	return row;
}

export async function listFeeds(ctx: RequestContext): Promise<CalendarFeedList> {
	const userId = requireUser(ctx);
	const rows = await mdb().transaction((tx) =>
		rowsOf(tx, sql`SELECT * FROM calendar_feeds WHERE user_id = ${userId} ORDER BY created_at, id`)
	);
	return {
		feeds: rows.map(toDto),
		actionsAvailable: (await actionsService()) !== null,
		tasksAvailable: (await tasksService()) !== null,
		max: MAX_CALENDAR_FEEDS
	};
}

export async function createFeed(
	ctx: RequestContext,
	input: CalendarFeedInput
): Promise<CalendarFeed> {
	const userId = requireUser(ctx);
	await validateGroupIds(ctx, input.groupIds);
	const id = crypto.randomUUID();
	const token = newToken();
	await mdb().transaction(async (tx) => {
		await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`events:feeds:${userId}`}))`);
		const [count] = await rowsOf(
			tx,
			sql`SELECT count(*) AS n FROM calendar_feeds WHERE user_id = ${userId}`
		);
		if (Number(count?.n ?? 0) >= MAX_CALENDAR_FEEDS) {
			throw errors.conflict(`Höchstens ${MAX_CALENDAR_FEEDS} Kalender-Abos je Person`);
		}
		await tx.execute(
			sql`INSERT INTO calendar_feeds (id, user_id, name, token_hash, token_enc, include_events,
					include_actions, include_tasks, group_ids, tags)
				VALUES (${id}, ${userId}, ${input.name}, ${crypt().hash(token)}, ${crypt().encrypt(token)},
					${input.includeEvents}, ${input.includeActions}, ${input.includeTasks},
					${JSON.stringify(input.groupIds)}::jsonb,
					${JSON.stringify(input.tags)}::jsonb)`
		);
	});
	await core.audit.logFromContext(ctx, 'events.calendar-feed.created', {
		target: id,
		metadata: feedMetadata(input)
	});
	return toDto(await loadOwnFeed(userId, id));
}

const feedMetadata = (input: CalendarFeedInput) => ({
	events: input.includeEvents,
	actions: input.includeActions,
	tasks: input.includeTasks,
	groups: input.groupIds.length,
	tags: input.tags.length
});

export async function updateFeed(
	ctx: RequestContext,
	id: string,
	input: CalendarFeedInput
): Promise<CalendarFeed> {
	const userId = requireUser(ctx);
	const current = await loadOwnFeed(userId, id);
	// Gespeicherte Gruppen bleiben gültig (z. B. Gruppe inzwischen gelöscht oder `members` aus)
	await validateGroupIds(ctx, input.groupIds, new Set(jsonList(current.group_ids)));
	await mdb().transaction((tx) =>
		tx.execute(
			sql`UPDATE calendar_feeds SET name = ${input.name}, include_events = ${input.includeEvents},
					include_actions = ${input.includeActions}, include_tasks = ${input.includeTasks}, group_ids = ${JSON.stringify(input.groupIds)}::jsonb,
					tags = ${JSON.stringify(input.tags)}::jsonb, updated_at = now()
				WHERE id = ${id} AND user_id = ${userId}`
		)
	);
	await core.audit.logFromContext(ctx, 'events.calendar-feed.updated', {
		target: id,
		metadata: feedMetadata(input)
	});
	return toDto(await loadOwnFeed(userId, id));
}

/** Neuer Link; der alte gilt ab sofort nicht mehr */
export async function rotateFeed(ctx: RequestContext, id: string): Promise<CalendarFeed> {
	const userId = requireUser(ctx);
	await loadOwnFeed(userId, id);
	const token = newToken();
	await mdb().transaction((tx) =>
		tx.execute(
			sql`UPDATE calendar_feeds SET token_hash = ${crypt().hash(token)}, token_enc = ${crypt().encrypt(token)},
					updated_at = now(), last_used_at = NULL
				WHERE id = ${id} AND user_id = ${userId}`
		)
	);
	await core.audit.logFromContext(ctx, 'events.calendar-feed.rotated', { target: id });
	return toDto(await loadOwnFeed(userId, id));
}

export async function deleteFeed(ctx: RequestContext, id: string): Promise<{ deleted: true }> {
	const userId = requireUser(ctx);
	const rows = await mdb().transaction((tx) =>
		rowsOf(
			tx,
			sql`DELETE FROM calendar_feeds WHERE id = ${id} AND user_id = ${userId} RETURNING id`
		)
	);
	if (!rows.length) throw errors.notFound('Kalender-Abo nicht gefunden');
	await core.audit.logFromContext(ctx, 'events.calendar-feed.deleted', { target: id });
	return { deleted: true };
}

// --- Abruf durch die Kalender-App ----------------------------------------------------------------

const NOT_FOUND = 'Kalender-Abo nicht gefunden';

/** Termine des Abos (sichtbar für `ctx`, Fenster, Filter), Serien expandiert, ohne abgesagte Vorkommen */
async function feedOccurrences(
	ctx: RequestContext,
	window: { from: string; to: string },
	filter: { groupIds: string[]; tags: string[] }
): Promise<OccurrenceRow[]> {
	const keys = await principalKeysFor(ctx, MODULE_ID);
	const conds: SQL[] = [
		visibleEventsFilter(ctx, keys),
		sql`((e.recurrence IS NULL AND e.starts_on <= ${window.to}::date
				AND COALESCE(e.ends_on, e.starts_on) >= ${window.from}::date)
			OR (e.recurrence IS NOT NULL AND e.starts_on <= ${window.to}::date
				AND (e.recurrence_until IS NULL
					OR e.recurrence_until + COALESCE(e.ends_on - e.starts_on, 0) >= ${window.from}::date)))`
	];
	if (filter.groupIds.length) {
		conds.push(sql`EXISTS (SELECT 1 FROM event_groups g
			WHERE g.event_id = e.id AND g.group_id IN (${inList(filter.groupIds)}))`);
	}
	if (filter.tags.length) {
		conds.push(sql`EXISTS (SELECT 1 FROM event_tags t
			WHERE t.event_id = e.id AND lower(t.tag) IN (${inList(filter.tags.map((t) => t.toLowerCase()))}))`);
	}
	const { rows, exceptions } = await mdb().transaction(async (tx) => {
		const raw = await rowsOf(
			tx,
			sql`SELECT ${EVENT_COLUMNS} FROM events e WHERE ${sql.join(conds, sql` AND `)}
				ORDER BY ${EVENT_ORDER} LIMIT ${FEED_ROW_CAP}`
		);
		const rows = await hydrateRows(tx, raw);
		const exceptions = await loadExceptions(
			tx,
			rows.filter((r) => r.recurrence).map((r) => r.id)
		);
		return { rows, exceptions };
	});
	const all: OccurrenceRow[] = [];
	for (const row of rows) {
		if (!row.recurrence) all.push(singleOccurrence(row));
		else all.push(...expandRow(row, exceptions.get(row.id), window.from, window.to));
	}
	all.sort(compareOccurrences);
	return all.slice(0, MAX_OCCURRENCES);
}

const withLink = (text: string | null, url: string | null) =>
	[text?.trim(), url ? `In EP Intern öffnen: ${url}` : null].filter(Boolean).join('\n\n') || null;

/**
 * Feed zum Token als `text/calendar`. Unbekanntes Token, gelöschtes/deaktiviertes Konto oder fehlende
 * Rechte → einheitlich 404 (Existenz nicht verraten).
 */
export async function renderFeed(token: string): Promise<Response> {
	const [feed] = await mdb().transaction((tx) =>
		rowsOf(tx, sql`SELECT * FROM calendar_feeds WHERE token_hash = ${crypt().hash(token)}`)
	);
	if (!feed) throw errors.notFound(NOT_FOUND);
	const resolved = await core.auth.contextForUser(str(feed.user_id));
	if (!resolved || !core.permissions.has(resolved.ctx, 'events.event.view')) {
		throw errors.notFound(NOT_FOUND);
	}
	const ctx = resolved.ctx;
	const dto = toDto(feed);
	const today = todayBerlin();
	const window = { from: addDays(today, -FEED_PAST_DAYS), to: addDays(today, FEED_FUTURE_DAYS) };
	const origin = core.app.origin();
	const host = new URL(origin).hostname || 'ep-intern';
	const events: IcsEvent[] = [];

	if (dto.includeEvents) {
		for (const o of await feedOccurrences(ctx, window, dto)) {
			const url = `${origin}/modules/events?event=${o.id}${o.occurrenceDate ? `&occurrence=${o.occurrenceDate}` : ''}`;
			events.push({
				uid: `${o.id}${o.occurrenceDate ? `-${o.occurrenceDate}` : ''}@events.${host}`,
				title: o.title,
				description: withLink(o.description, url),
				location: o.location,
				url,
				categories: o.tags,
				startsOn: o.startsOn,
				startsTime: o.startsTime,
				endsOn: o.endsOn,
				endsTime: o.endsTime,
				updatedAt: o.updatedAt
			});
		}
	}
	if (dto.includeActions) {
		const actions = await actionsService();
		for (const a of (await actions?.listCalendarActions(ctx, window)) ?? []) {
			const url = a.canOpen ? `${origin}/modules/actions/${a.id}` : null;
			const who = a.registered.length ? `Angemeldet: ${a.registered.join(', ')}` : null;
			events.push({
				uid: `action-${a.id}@actions.${host}`,
				title: a.name,
				description: withLink([who, a.description].filter(Boolean).join('\n\n') || null, url),
				location: a.location,
				url,
				categories: ['Aktion'],
				startsOn: a.startsOn,
				startsTime: a.startsTime,
				endsOn: a.endsOn,
				endsTime: a.endsTime
			});
		}
	}

	if (dto.includeTasks) {
		const tasks = await tasksService();
		for (const m of (await tasks?.calendarMilestones(ctx, window)) ?? []) {
			const url = `${origin}${m.href}`;
			events.push({
				uid: `milestone-${m.id}@tasks.${host}`,
				title: `◆ ${m.title}${m.done ? ' (erledigt)' : ''}`,
				description: withLink(`Meilenstein im Board „${m.boardName}“`, url),
				url,
				categories: ['Meilenstein'],
				startsOn: m.dueOn,
				startsTime: null,
				endsOn: null,
				endsTime: null,
				updatedAt: m.updatedAt
			});
		}
	}

	const body = buildCalendar({
		name: dto.name,
		description: `Kalender-Abo aus EP Intern (${await stammName()})`,
		events
	});
	await mdb().transaction((tx) =>
		tx.execute(
			sql`UPDATE calendar_feeds SET last_used_at = now()
				WHERE id = ${dto.id} AND (last_used_at IS NULL
					OR last_used_at < now() - make_interval(mins => ${LAST_USED_MINUTES}))`
		)
	);
	return new Response(body, {
		headers: {
			'content-type': 'text/calendar; charset=utf-8',
			'content-disposition': 'inline; filename="kalender.ics"',
			'cache-control': 'private, max-age=300',
			'x-content-type-options': 'nosniff'
		}
	});
}

/**
 * Datensicherung: `token_hash` aus `token_enc` (beim Import mit dem Zielschlüssel neu verschlüsselt) neu
 * berechnen. Nicht entschlüsselbare Abos bekommen einen unbrauchbaren Hash (Link tot, Person erneuert ihn).
 */
export const calendarFeedsBackup: ModuleBackupHooks = {
	async rehash(tx, helpers) {
		let updated = 0;
		let unrecoverable = 0;
		const res = (await tx.execute(
			sql`SELECT id, token_hash, token_enc FROM calendar_feeds`
		)) as unknown as { rows: Record<string, unknown>[] };
		for (const r of res.rows) {
			let next: string;
			try {
				next = helpers.hash(helpers.decrypt(str(r.token_enc)));
			} catch {
				next = `unrecoverable:${crypto.randomUUID()}`;
				unrecoverable++;
			}
			if (next === r.token_hash) continue;
			await tx.execute(sql`UPDATE calendar_feeds SET token_hash = ${next} WHERE id = ${str(r.id)}`);
			if (!next.startsWith('unrecoverable:')) updated++;
		}
		return { updated, unrecoverable };
	}
};
