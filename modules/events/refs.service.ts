/**
 * Dienst `EventRefsService` für andere Module (z. B. `galleries`), siehe `contract.ts`.
 * Sichtbarkeit wie `GET /events`: Principal-Schlüssel VOR der Transaktion, dann `visibleEventsFilter`.
 */
import { sql } from 'drizzle-orm';
import {
	core,
	inList,
	moduleDb,
	principalKeysFor,
	type RequestContext,
	rowsOf
} from '$lib/sdk/server';
import { visibleEventsFilter } from './access';
import type { EventRefInfo, EventRefsService } from './contract';

const MAX_IDS = 500;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 50;

/** `%`, `_` und `\` für ILIKE maskieren */
const likePattern = (s: string) => `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const COLUMNS = sql`e.id, e.title, to_char(e.starts_on, 'YYYY-MM-DD') AS starts_on,
	to_char(e.ends_on, 'YYYY-MM-DD') AS ends_on, e.color, (e.recurrence IS NOT NULL) AS recurring,
	e.on_website`;

function toRef(r: Record<string, unknown>): EventRefInfo {
	return {
		id: String(r.id),
		title: String(r.title),
		startsOn: String(r.starts_on),
		endsOn: r.ends_on == null ? null : String(r.ends_on),
		color: r.color == null ? null : String(r.color),
		recurring: r.recurring === true || r.recurring === 't',
		onWebsite: r.on_website === true || r.on_website === 't'
	};
}

function canView(ctx: RequestContext): boolean {
	return ctx.actor.type === 'system' || core.permissions.has(ctx, 'events.event.view');
}

function normalizeIds(ids: readonly string[]): string[] {
	return [...new Set(ids.filter((id) => typeof id === 'string' && id.length > 0))].slice(
		0,
		MAX_IDS
	);
}

function inOrder(ids: readonly string[], refs: EventRefInfo[]): EventRefInfo[] {
	const byId = new Map(refs.map((r) => [r.id, r]));
	return ids.flatMap((id) => {
		const r = byId.get(id);
		return r ? [r] : [];
	});
}

export async function searchEventRefs(
	ctx: RequestContext,
	opts: { search?: string; limit?: number } = {}
): Promise<EventRefInfo[]> {
	if (!canView(ctx)) return [];
	const raw = Number.isFinite(opts.limit) ? Math.trunc(opts.limit as number) : DEFAULT_LIMIT;
	const limit = Math.min(MAX_LIMIT, Math.max(1, raw));
	const search = opts.search?.trim() ?? '';
	const keys = await principalKeysFor(ctx, 'events');
	const rows = await moduleDb('events').transaction((tx) =>
		rowsOf(
			tx,
			sql`SELECT ${COLUMNS} FROM events e
				WHERE ${visibleEventsFilter(ctx, keys)}
					${search ? sql`AND e.title ILIKE ${likePattern(search)}` : sql``}
				ORDER BY e.starts_on DESC, e.title, e.id
				LIMIT ${limit}`
		)
	);
	return rows.map(toRef);
}

export async function describeEventRefs(
	ctx: RequestContext,
	ids: readonly string[]
): Promise<EventRefInfo[]> {
	const list = normalizeIds(ids);
	if (list.length === 0 || !canView(ctx)) return [];
	const keys = await principalKeysFor(ctx, 'events');
	const rows = await moduleDb('events').transaction((tx) =>
		rowsOf(
			tx,
			sql`SELECT ${COLUMNS} FROM events e
				WHERE e.id IN (${inList(list)}) AND ${visibleEventsFilter(ctx, keys)}`
		)
	);
	return inOrder(list, rows.map(toRef));
}

export async function websiteEventRefs(ids: readonly string[]): Promise<EventRefInfo[]> {
	const list = normalizeIds(ids);
	if (list.length === 0) return [];
	const rows = await moduleDb('events').transaction((tx) =>
		rowsOf(
			tx,
			sql`SELECT ${COLUMNS} FROM events e
				WHERE e.id IN (${inList(list)}) AND e.on_website = TRUE`
		)
	);
	return inOrder(list, rows.map(toRef));
}

export const eventRefsService: EventRefsService = {
	searchEventRefs,
	describeEventRefs,
	websiteEventRefs
};
