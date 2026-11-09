/**
 * Datenzugriff und DTO-Aufbau für Termine.
 *
 * Zwei Schritte wie bei Aktionen: Zeilen (inkl. Tags, Gruppen, Freigaben) werden INNERHALB der
 * Modul-Transaktion gelesen/geschrieben (`load*`, `write*`), Namen aus Core-Diensten
 * (Benutzerverzeichnis, Gruppen, Principals, Einstellungen) erst DANACH aufgelöst (`build*`).
 */
import { sql } from 'drizzle-orm';
import { todayBerlin } from '$lib/sdk/dates';
import {
	core,
	describePrincipals,
	errors,
	inList,
	type Principal,
	type RequestContext,
	rowsOf,
	toIso,
	type Tx
} from '$lib/sdk/server';
import type { z } from 'zod';
import { replaceShares } from './access';
import { loadGroupMap, stammName } from './groups';
import {
	addDays,
	daysBetween,
	expandOccurrences,
	isOccurrence,
	lastOccurrence,
	type Occurrence
} from './recurrence';
import {
	MAX_OCCURRENCES,
	MODULE_ID,
	OPEN_WINDOW_DAYS,
	checkEventDates,
	occurrenceOverride,
	recurrenceRule,
	type EventAccess,
	type EventDates,
	type EventDetail,
	type EventGroupRef,
	type EventInput,
	type EventItem,
	type EventShare,
	type OccurrenceOverride,
	type RecurrenceRule,
	type ShareLevel,
	type UserRef
} from './schemas';

/** Rohdaten eines Termins (nur Datenbank, ohne aufgelöste Namen) */
export interface EventRow {
	id: string;
	title: string;
	description: string | null;
	location: string | null;
	color: string | null;
	startsOn: string;
	startsTime: string | null;
	endsOn: string | null;
	endsTime: string | null;
	onWebsite: boolean;
	ownerId: string;
	createdAt: string;
	updatedAt: string;
	tags: string[];
	groupIds: string[];
	/** Serienregel oder `null` (einmaliger Termin) */
	recurrence: RecurrenceRule | null;
}

/** Ein Listeneintrag: einmaliger Termin oder ein Vorkommen einer Serie (Felder bereits mit Override) */
export interface OccurrenceRow extends EventRow {
	key: string;
	/** Ursprüngliches Datum des Vorkommens; `null` bei einmaligen Terminen */
	occurrenceDate: string | null;
	isException: boolean;
	cancelled: boolean;
}

/** Ausnahme eines Vorkommens (`event_exceptions`) */
export interface ExceptionRow {
	date: string;
	cancelled: boolean;
	override: OccurrenceOverride | null;
}

/** Ausnahmen je Termin-ID und ursprünglichem Datum */
export type ExceptionMap = Map<string, Map<string, ExceptionRow>>;

export interface ShareRow extends Principal {
	level: ShareLevel;
}

const FAR_FUTURE = '9999-12-31';

const strOrNull = (v: unknown): string | null => (v == null ? null : String(v));

/** jsonb: pg liefert Objekte, PGlite je nach Version auch Strings */
function jsonOf(v: unknown): unknown {
	if (v == null) return null;
	if (typeof v === 'string') {
		try {
			return JSON.parse(v);
		} catch {
			return null;
		}
	}
	return v;
}

export function parseRecurrence(v: unknown): RecurrenceRule | null {
	const raw = jsonOf(v);
	if (!raw) return null;
	const parsed = recurrenceRule.safeParse(raw);
	return parsed.success ? parsed.data : null;
}

function parseOverride(v: unknown): OccurrenceOverride | null {
	const raw = jsonOf(v);
	if (!raw) return null;
	const parsed = occurrenceOverride.safeParse(raw);
	return parsed.success && Object.keys(parsed.data).length ? parsed.data : null;
}

/** Heutiges Datum in Europe/Berlin als `JJJJ-MM-TT` (zentral in `$lib/sdk/dates`) */
export { todayBerlin };

export const EVENT_COLUMNS = sql`e.id, e.title, e.description, e.location, e.color,
	to_char(e.starts_on, 'YYYY-MM-DD') AS starts_on, e.starts_at,
	to_char(e.ends_on, 'YYYY-MM-DD') AS ends_on, e.ends_at,
	e.on_website, e.owner_id, e.created_at, e.updated_at, e.recurrence`;

export const EVENT_ORDER = sql`e.starts_on, e.starts_at NULLS FIRST, e.title, e.id`;

/** Zeilen mit Tags (nach `position`) und Gruppen-IDs anreichern */
export async function hydrateRows(tx: Tx, rows: Record<string, unknown>[]): Promise<EventRow[]> {
	if (rows.length === 0) return [];
	const ids = rows.map((r) => String(r.id));
	const tagRows = await rowsOf(
		tx,
		sql`SELECT event_id, tag FROM event_tags WHERE event_id IN (${inList(ids)})
			ORDER BY event_id, position, tag`
	);
	const groupRows = await rowsOf(
		tx,
		sql`SELECT event_id, group_id FROM event_groups WHERE event_id IN (${inList(ids)})
			ORDER BY event_id, group_id`
	);
	const tags = new Map<string, string[]>();
	for (const t of tagRows) {
		const k = String(t.event_id);
		tags.set(k, [...(tags.get(k) ?? []), String(t.tag)]);
	}
	const groups = new Map<string, string[]>();
	for (const g of groupRows) {
		const k = String(g.event_id);
		groups.set(k, [...(groups.get(k) ?? []), String(g.group_id)]);
	}
	return rows.map((r) => {
		const id = String(r.id);
		return {
			id,
			title: String(r.title),
			description: strOrNull(r.description),
			location: strOrNull(r.location),
			color: strOrNull(r.color),
			startsOn: String(r.starts_on),
			startsTime: strOrNull(r.starts_at),
			endsOn: strOrNull(r.ends_on),
			endsTime: strOrNull(r.ends_at),
			onWebsite: r.on_website === true || r.on_website === 't',
			ownerId: String(r.owner_id),
			createdAt: toIso(r.created_at),
			updatedAt: toIso(r.updated_at),
			tags: tags.get(id) ?? [],
			groupIds: groups.get(id) ?? [],
			recurrence: parseRecurrence(r.recurrence)
		};
	});
}

export async function loadEventRow(tx: Tx, id: string): Promise<EventRow | null> {
	const rows = await rowsOf(tx, sql`SELECT ${EVENT_COLUMNS} FROM events e WHERE e.id = ${id}`);
	const [row] = await hydrateRows(tx, rows);
	return row ?? null;
}

/** Tags, Gruppen und Freigaben vollständig ersetzen */
async function replaceChildren(
	tx: Tx,
	ctx: RequestContext,
	id: string,
	input: EventInput
): Promise<void> {
	await tx.execute(sql`DELETE FROM event_tags WHERE event_id = ${id}`);
	await tx.execute(sql`DELETE FROM event_groups WHERE event_id = ${id}`);
	for (const [position, tag] of input.tags.entries()) {
		await tx.execute(
			sql`INSERT INTO event_tags (event_id, tag, position) VALUES (${id}, ${tag}, ${position})`
		);
	}
	for (const groupId of input.groupIds) {
		await tx.execute(sql`INSERT INTO event_groups (event_id, group_id) VALUES (${id}, ${groupId})`);
	}
	await replaceShares(tx, ctx, id, input.shares);
}

export function seriesDates(input: EventDates): EventDates {
	return {
		startsOn: input.startsOn,
		startsTime: input.startsTime,
		endsOn: input.endsOn,
		endsTime: input.endsTime
	};
}

/** Werte der Serie selbst für `EventDetail.series` */
export function seriesInfo(row: EventRow): NonNullable<EventDetail['series']> {
	return {
		...seriesDates(row),
		title: row.title,
		description: row.description,
		location: row.location
	};
}

/** jsonb-Wert und `recurrence_until` (letztes Vorkommen, bei offener Serie `null`) */
function recurrenceValues(input: EventInput): { json: string | null; until: string | null } {
	if (!input.recurrence) return { json: null, until: null };
	return {
		json: JSON.stringify(input.recurrence),
		until: lastOccurrence(seriesDates(input), input.recurrence)
	};
}

export async function insertEvent(
	tx: Tx,
	ctx: RequestContext,
	id: string,
	ownerId: string,
	input: EventInput
): Promise<void> {
	const rec = recurrenceValues(input);
	await tx.execute(
		sql`INSERT INTO events (id, title, description, location, color, starts_on, starts_at,
				ends_on, ends_at, on_website, owner_id, created_by, recurrence, recurrence_until)
			VALUES (${id}, ${input.title}, ${input.description}, ${input.location}, ${input.color},
				${input.startsOn}::date, ${input.startsTime}, ${input.endsOn}::date, ${input.endsTime},
				${input.onWebsite}, ${ownerId}, ${ctx.userId ?? null}, ${rec.json}::jsonb,
				${rec.until}::date)`
	);
	await replaceChildren(tx, ctx, id, input);
}

/**
 * Termin ersetzen. Ausnahmen, deren Datum nach der Änderung kein Vorkommen mehr ist, werden
 * gelöscht (ohne Serie: alle).
 */
export async function updateEvent(
	tx: Tx,
	ctx: RequestContext,
	id: string,
	input: EventInput
): Promise<void> {
	const rec = recurrenceValues(input);
	await tx.execute(
		sql`UPDATE events SET title = ${input.title}, description = ${input.description},
				location = ${input.location}, color = ${input.color},
				starts_on = ${input.startsOn}::date, starts_at = ${input.startsTime},
				ends_on = ${input.endsOn}::date, ends_at = ${input.endsTime},
				on_website = ${input.onWebsite}, recurrence = ${rec.json}::jsonb,
				recurrence_until = ${rec.until}::date, updated_at = now()
			WHERE id = ${id}`
	);
	await replaceChildren(tx, ctx, id, input);
	if (!input.recurrence) {
		await tx.execute(sql`DELETE FROM event_exceptions WHERE event_id = ${id}`);
		return;
	}
	const dates = seriesDates(input);
	const existing = await rowsOf(
		tx,
		sql`SELECT to_char(occurrence_date, 'YYYY-MM-DD') AS d FROM event_exceptions
			WHERE event_id = ${id}`
	);
	for (const r of existing) {
		const d = String(r.d);
		if (!isOccurrence(dates, input.recurrence, d)) await deleteException(tx, id, d);
	}
}

// ---------------------------------------------------------------------------------------------
// Serien: Ausnahmen und Vorkommen (reine Datenbank bzw. reine Logik, transaktionssicher)

/** Ausnahmen für mehrere Termine in einer Abfrage */
export async function loadExceptions(tx: Tx, ids: readonly string[]): Promise<ExceptionMap> {
	const map: ExceptionMap = new Map();
	const unique = [...new Set(ids)];
	if (unique.length === 0) return map;
	const rows = await rowsOf(
		tx,
		sql`SELECT event_id, to_char(occurrence_date, 'YYYY-MM-DD') AS d, cancelled, override
			FROM event_exceptions WHERE event_id IN (${inList(unique)})`
	);
	for (const r of rows) {
		const eventId = String(r.event_id);
		const inner = map.get(eventId) ?? new Map<string, ExceptionRow>();
		inner.set(String(r.d), {
			date: String(r.d),
			cancelled: r.cancelled === true || r.cancelled === 't',
			override: parseOverride(r.override)
		});
		map.set(eventId, inner);
	}
	return map;
}

/** Ausnahme anlegen/ändern; ohne Absage und ohne Override wird die Zeile gelöscht */
export async function upsertException(
	tx: Tx,
	ctx: RequestContext,
	id: string,
	date: string,
	cancelled: boolean,
	override: OccurrenceOverride | null
): Promise<void> {
	const ov = override && Object.keys(override).length ? override : null;
	if (!cancelled && !ov) {
		await deleteException(tx, id, date);
		return;
	}
	await tx.execute(
		sql`INSERT INTO event_exceptions (event_id, occurrence_date, cancelled, override, updated_by)
			VALUES (${id}, ${date}::date, ${cancelled}, ${ov ? JSON.stringify(ov) : null}::jsonb,
				${ctx.userId ?? null})
			ON CONFLICT (event_id, occurrence_date) DO UPDATE SET cancelled = EXCLUDED.cancelled,
				override = EXCLUDED.override, updated_by = EXCLUDED.updated_by, updated_at = now()`
	);
}

export async function deleteException(tx: Tx, id: string, date: string): Promise<void> {
	await tx.execute(
		sql`DELETE FROM event_exceptions WHERE event_id = ${id} AND occurrence_date = ${date}::date`
	);
}

/** Einmaliger Termin als Listeneintrag */
export function singleOccurrence(row: EventRow): OccurrenceRow {
	return { ...row, key: row.id, occurrenceDate: null, isException: false, cancelled: false };
}

/** Ursprüngliches Vorkommen zu einem Datum (Ende um die Seriendauer verschoben) */
export function occurrenceAt(row: EventDates, date: string): Occurrence {
	const duration = row.endsOn ? daysBetween(row.startsOn, row.endsOn) : null;
	return { date, startsOn: date, endsOn: duration == null ? null : addDays(date, duration) };
}

/**
 * Daten eines Vorkommens mit Override zusammenführen. Wird nur `startsOn` verschoben, wandert das
 * Ende mit (gleiche Dauer).
 */
export function mergeOccurrenceDates(
	row: EventDates,
	occ: Occurrence,
	override: OccurrenceOverride | null
): EventDates {
	const ov = override ?? {};
	const startsOn = ov.startsOn ?? occ.startsOn;
	let endsOn: string | null;
	if (ov.endsOn !== undefined) endsOn = ov.endsOn;
	else if (occ.endsOn && startsOn !== occ.startsOn)
		endsOn = addDays(occ.endsOn, daysBetween(occ.startsOn, startsOn));
	else endsOn = occ.endsOn;
	return {
		startsOn,
		startsTime: ov.startsTime !== undefined ? ov.startsTime : row.startsTime,
		endsOn,
		endsTime: ov.endsTime !== undefined ? ov.endsTime : row.endsTime
	};
}

/**
 * Override gegen die Datumsregeln prüfen (zusammengeführt mit den Seriendaten); 422 mit Pfaden
 * `override.<feld>`.
 */
export function validateOverride(
	row: EventDates,
	date: string,
	override: OccurrenceOverride | null
): void {
	if (!override) return;
	const merged = mergeOccurrenceDates(row, occurrenceAt(row, date), override);
	const issues: { path: (string | number)[]; message: string }[] = [];
	const collector = {
		addIssue: (i: { path?: (string | number)[]; message?: string }) => {
			issues.push({ path: ['override', ...(i.path ?? [])], message: i.message ?? 'Ungültig' });
		}
	} as unknown as z.RefinementCtx;
	checkEventDates(merged, collector);
	if (issues.length) throw errors.validation(issues);
}

function materialize(row: EventRow, occ: Occurrence, exc: ExceptionRow | undefined): OccurrenceRow {
	const ov = exc?.override ?? null;
	return {
		...row,
		...mergeOccurrenceDates(row, occ, ov),
		title: ov?.title ?? row.title,
		description: ov && ov.description !== undefined ? ov.description : row.description,
		location: ov && ov.location !== undefined ? ov.location : row.location,
		key: `${row.id}:${occ.date}`,
		occurrenceDate: occ.date,
		isException: !!exc,
		cancelled: !!exc?.cancelled
	};
}

/** Überlappung mit [`from`, `to`] (`null` = offen) */
export function overlapsWindow(o: EventDates, from: string | null, to: string | null): boolean {
	return (from == null || (o.endsOn ?? o.startsOn) >= from) && (to == null || o.startsOn <= to);
}

/**
 * Vorkommen einer Serie im Fenster [`from`, `to`] nach Overrides. Verschobene Vorkommen müssen
 * danach noch ins Fenster passen; von außerhalb hineingeschobene werden ebenfalls geliefert.
 * Abgesagte nur mit `includeCancelled`.
 */
export function expandRow(
	row: EventRow,
	exceptions: Map<string, ExceptionRow> | undefined,
	from: string,
	to: string,
	opts: { includeCancelled?: boolean; max?: number } = {}
): OccurrenceRow[] {
	if (!row.recurrence) return [];
	const dates = seriesDates(row);
	const out: OccurrenceRow[] = [];
	const seen = new Set<string>();
	const occs = expandOccurrences(dates, row.recurrence, from, to, opts.max ?? MAX_OCCURRENCES);
	for (const occ of occs) {
		seen.add(occ.date);
		out.push(materialize(row, occ, exceptions?.get(occ.date)));
	}
	for (const exc of exceptions?.values() ?? []) {
		if (seen.has(exc.date) || !exc.override) continue;
		if (exc.override.startsOn === undefined && exc.override.endsOn === undefined) continue;
		if (!isOccurrence(dates, row.recurrence, exc.date)) continue;
		out.push(materialize(row, occurrenceAt(dates, exc.date), exc));
	}
	return out.filter((o) => (opts.includeCancelled || !o.cancelled) && overlapsWindow(o, from, to));
}

/** Sortierung: Beginn, Uhrzeit (ohne zuerst), Titel, Schlüssel */
export function compareOccurrences(a: OccurrenceRow, b: OccurrenceRow): number {
	if (a.startsOn !== b.startsOn) return a.startsOn < b.startsOn ? -1 : 1;
	if (a.startsTime !== b.startsTime) {
		if (a.startsTime == null) return -1;
		if (b.startsTime == null) return 1;
		return a.startsTime < b.startsTime ? -1 : 1;
	}
	if (a.title !== b.title) return a.title < b.title ? -1 : 1;
	return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * Vorkommen für die Detailansicht. Ohne `occurrence` bei Serien: erstes nicht abgesagtes Vorkommen
 * ab heute, sonst das erste der Serie. Mit `occurrence`: muss ein Vorkommen sein (sonst 404);
 * abgesagte nur bei `canEdit` (sonst 404). Einmalige Termine mit `occurrence` → 404.
 */
export function resolveDetailOccurrence(
	row: EventRow,
	exceptions: Map<string, ExceptionRow> | undefined,
	occurrence: string | undefined,
	canEdit: boolean
): OccurrenceRow {
	if (!row.recurrence) {
		if (occurrence) throw errors.notFound('Termin nicht gefunden');
		return singleOccurrence(row);
	}
	const dates = seriesDates(row);
	if (occurrence) {
		if (!isOccurrence(dates, row.recurrence, occurrence)) {
			throw errors.notFound('Termin nicht gefunden');
		}
		const occ = materialize(row, occurrenceAt(dates, occurrence), exceptions?.get(occurrence));
		if (occ.cancelled && !canEdit) throw errors.notFound('Termin nicht gefunden');
		return occ;
	}
	const today = todayBerlin();
	const from = today > row.startsOn ? today : row.startsOn;
	for (const occ of expandOccurrences(dates, row.recurrence, from, FAR_FUTURE, 100)) {
		const m = materialize(row, occ, exceptions?.get(occ.date));
		if (!m.cancelled) return m;
	}
	const first =
		expandOccurrences(dates, row.recurrence, row.startsOn, FAR_FUTURE, 1)[0] ??
		occurrenceAt(dates, row.startsOn);
	return materialize(row, first, exceptions?.get(first.date));
}

/**
 * Vorkommen für die Website-Detailansicht (`GET /website/events/:id`). Abgesagte Vorkommen gibt es
 * auf der Website nicht (404). Mit `occurrence`: genau dieses Vorkommen (kein Vorkommen → 404).
 * Ohne `occurrence` bei Serien: nächstes nicht abgesagtes Vorkommen, das heute noch nicht vorbei
 * ist (Europe/Berlin), sonst das letzte nicht abgesagte; alle abgesagt → 404.
 */
export function resolveWebsiteOccurrence(
	row: EventRow,
	exceptions: Map<string, ExceptionRow> | undefined,
	occurrence: string | undefined,
	today: string = todayBerlin()
): OccurrenceRow {
	if (!row.recurrence || occurrence) {
		return resolveDetailOccurrence(row, exceptions, occurrence, false);
	}
	// Fenster ab heute (bzw. ab Serienbeginn, falls dieser später liegt)
	const nextTo = addDays(row.startsOn > today ? row.startsOn : today, OPEN_WINDOW_DAYS);
	const next = expandRow(row, exceptions, today, nextTo, { max: 100 })
		.sort(compareOccurrences)
		.find((o) => (o.endsOn ?? o.startsOn) >= today);
	if (next) return next;
	// Rückwärts in wachsenden Fenstern nach dem letzten nicht abgesagten Vorkommen suchen
	const end = lastOccurrence(seriesDates(row), row.recurrence) ?? today;
	const upper = end < today ? end : today;
	for (let window = OPEN_WINDOW_DAYS; ; window *= 4) {
		const lower = addDays(upper, -window);
		const from = lower > row.startsOn ? lower : row.startsOn;
		const past = expandRow(row, exceptions, from, upper).sort(compareOccurrences);
		const last = past[past.length - 1];
		if (last) return last;
		if (from === row.startsOn) break;
	}
	throw errors.notFound('Termin nicht gefunden');
}

// ---------------------------------------------------------------------------------------------
// Nach der Transaktion (Core-Dienste)

/**
 * Prüft Gruppen-IDs gegen die bekannten Gruppen (`stamm` + members); sonst 422.
 * `keep`: bereits gespeicherte Zuordnungen (werden ohne Prüfung akzeptiert).
 */
export async function validateGroupIds(
	ctx: RequestContext,
	groupIds: string[],
	keep: ReadonlySet<string> = new Set()
): Promise<void> {
	if (groupIds.every((id) => keep.has(id))) return;
	const map = await loadGroupMap(ctx);
	const issues: { path: (string | number)[]; message: string }[] = [];
	groupIds.forEach((id, i) => {
		if (!keep.has(id) && !map.has(id))
			issues.push({ path: ['groupIds', i], message: 'Unbekannte Gruppe' });
	});
	if (issues.length) throw errors.validation(issues);
}

async function resolveOwners(
	ctx: RequestContext,
	ids: readonly string[]
): Promise<Map<string, UserRef>> {
	const found = await core.users.byIds(ctx, ids);
	return new Map(
		[...found.values()].map((u) => [u.id, { id: u.id, name: u.name, image: u.image }])
	);
}

function toItem(
	row: OccurrenceRow,
	access: EventAccess,
	owners: Map<string, UserRef>,
	groups: Map<string, EventGroupRef>
): EventItem {
	return {
		id: row.id,
		title: row.title,
		description: row.description,
		location: row.location,
		color: row.color,
		startsOn: row.startsOn,
		startsTime: row.startsTime,
		endsOn: row.endsOn,
		endsTime: row.endsTime,
		tags: row.tags,
		groups: row.groupIds.flatMap((id) => {
			const g = groups.get(id);
			return g ? [g] : [];
		}),
		onWebsite: row.onWebsite,
		owner: owners.get(row.ownerId) ?? null,
		access,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		key: row.key,
		occurrenceDate: row.occurrenceDate,
		recurrence: row.recurrence,
		isException: row.isException
	};
}

export async function buildItems(
	ctx: RequestContext,
	rows: readonly OccurrenceRow[],
	access: Map<string, EventAccess>
): Promise<EventItem[]> {
	if (rows.length === 0) return [];
	const owners = await resolveOwners(
		ctx,
		rows.map((r) => r.ownerId)
	);
	const groups = await loadGroupMap(ctx);
	return rows.map((r) =>
		toItem(r, access.get(r.id) ?? { level: 'read', isOwner: false }, owners, groups)
	);
}

/**
 * Detail aufbauen. `row` ist das Vorkommen (bzw. der einmalige Termin); `exceptions` sind die
 * Ausnahmen der Serie (Daten werden nur bei Bearbeiten-Zugriff ausgegeben).
 */
export async function buildDetail(
	ctx: RequestContext,
	row: OccurrenceRow,
	access: EventAccess,
	shares: readonly ShareRow[],
	series: EventDetail['series'] = null,
	exceptions?: Map<string, ExceptionRow>
): Promise<EventDetail> {
	const [item] = await buildItems(ctx, [row], new Map([[row.id, access]]));
	let described: EventShare[] = [];
	if (access.level === 'edit' && shares.length) {
		const infos = await describePrincipals(ctx, MODULE_ID, shares, {
			everyoneLabel: await stammName()
		});
		described = infos.map((p, i) => ({
			type: p.type,
			id: p.id,
			name: p.name,
			detail: p.detail ?? null,
			color: p.color ?? null,
			image: p.image ?? null,
			level: shares[i]!.level
		}));
	}
	const showExceptions = access.level === 'edit' && !!row.recurrence;
	const exc = showExceptions
		? [...(exceptions?.values() ?? [])].sort((a, b) => (a.date < b.date ? -1 : 1))
		: [];
	return {
		...item!,
		shares: described,
		series: row.recurrence ? series : null,
		override:
			showExceptions && row.occurrenceDate
				? (exceptions?.get(row.occurrenceDate)?.override ?? null)
				: null,
		cancelledDates: exc.filter((e) => e.cancelled).map((e) => e.date),
		exceptionDates: exc.filter((e) => e.override).map((e) => e.date)
	};
}
