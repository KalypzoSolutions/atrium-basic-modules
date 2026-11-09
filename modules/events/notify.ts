/**
 * Benachrichtigungen zu Terminen über `core.notifications` (Standard „Aus“, jede Person schaltet sie im
 * Profil ein): neuer Termin, verschoben (Datum/Uhrzeit/Ort), abgesagt. Empfänger sind alle, die den Termin
 * sehen dürfen (Eigentümer*in und Freigaben, `everyone` = alle mit Leserecht), nie die handelnde Person.
 * Nur kommende Termine. Immer nach der Transaktion; wirft nie.
 */
import {
	bestEffort,
	core,
	moduleDb,
	principalUserIds,
	todayBerlin,
	type Principal,
	type RequestContext
} from '$lib/sdk/server';
import { loadShares } from './access';
import { loadEventRow, type EventRow } from './events.service';
import { formatEventDate, formatEventRange } from './format';
import { describeRecurrence, lastOccurrence } from './recurrence';
import {
	MODULE_ID,
	NOTIFY_EVENT_CANCELLED,
	NOTIFY_EVENT_CHANGED,
	NOTIFY_EVENT_NEW
} from './schemas';

const VIEW = 'events.event.view';

export interface EventSnapshot {
	row: EventRow;
	shares: Principal[];
}

/** Termin und Freigaben (eigene Transaktion, vor bzw. nach der Änderung aufrufen) */
export async function eventSnapshot(id: string): Promise<EventSnapshot | null> {
	return moduleDb(MODULE_ID).transaction(async (tx) => {
		const row = await loadEventRow(tx, id);
		if (!row) return null;
		const shares = (await loadShares(tx, id)).map((s) => ({ type: s.type, id: s.id }));
		return { row, shares };
	});
}

async function audience(s: EventSnapshot, actorId: string | null): Promise<string[]> {
	const ids = await principalUserIds(
		MODULE_ID,
		[...s.shares, { type: 'user', id: s.row.ownerId }],
		{ permission: VIEW, everyone: true, exclude: [actorId] }
	);
	return ids;
}

/** Noch nicht vorbei (Serie: letztes Vorkommen bzw. offen) */
function isUpcoming(row: EventRow): boolean {
	const today = todayBerlin();
	if (row.recurrence) {
		const last = lastOccurrence(row, row.recurrence);
		return last === null || last >= today;
	}
	return (row.endsOn ?? row.startsOn) >= today;
}

function whenText(row: EventRow): string {
	const when = row.recurrence
		? `${describeRecurrence(row.recurrence, row.startsOn)}, ab ${formatEventDate(row.startsOn)}`
		: formatEventRange(row);
	return row.location ? `${when} · ${row.location}` : when;
}

const link = (id: string) => `/modules/events?event=${encodeURIComponent(id)}`;

const timingKey = (r: EventRow) =>
	JSON.stringify([r.startsOn, r.startsTime, r.endsOn, r.endsTime, r.location, r.recurrence]);

/** Neuer Termin: alle, die ihn sehen dürfen */
export async function notifyEventCreated(ctx: RequestContext, id: string): Promise<void> {
	await bestEffort(
		'events.notify.created',
		async () => {
			const s = await eventSnapshot(id);
			if (!s || !isUpcoming(s.row)) return;
			const userIds = await audience(s, ctx.userId);
			if (!userIds.length) return;
			await core.notifications.send(ctx, MODULE_ID, [
				{
					type: NOTIFY_EVENT_NEW,
					userIds,
					title: `Neuer Termin: ${s.row.title}`,
					body: whenText(s.row),
					link: link(id)
				}
			]);
		},
		{ ctx, target: id }
	);
}

/**
 * Nach dem Ändern: neu sichtbar gewordene Personen erfahren den Termin als „neu“, alle anderen nur, wenn
 * sich Datum, Uhrzeit, Ort oder Wiederholung geändert haben.
 */
export async function notifyEventUpdated(
	ctx: RequestContext,
	before: EventSnapshot | null,
	id: string
): Promise<void> {
	await bestEffort(
		'events.notify.updated',
		async () => {
			const after = await eventSnapshot(id);
			if (!after || !isUpcoming(after.row)) return;
			const now = await audience(after, ctx.userId);
			const old = new Set(before ? await audience(before, ctx.userId) : []);
			const added = now.filter((u) => !old.has(u));
			const moved = before !== null && timingKey(before.row) !== timingKey(after.row);
			const items = [];
			if (added.length) {
				items.push({
					type: NOTIFY_EVENT_NEW,
					userIds: added,
					title: `Neuer Termin: ${after.row.title}`,
					body: whenText(after.row),
					link: link(id)
				});
			}
			const stay = now.filter((u) => old.has(u));
			if (moved && stay.length) {
				items.push({
					type: NOTIFY_EVENT_CHANGED,
					userIds: stay,
					title: `Termin geändert: ${after.row.title}`,
					body: `Neu: ${whenText(after.row)}`,
					link: link(id)
				});
			}
			if (items.length) await core.notifications.send(ctx, MODULE_ID, items);
		},
		{ ctx, target: id }
	);
}

/** Ein Vorkommen einer Serie abgesagt bzw. zeitlich/örtlich geändert */
export async function notifyOccurrence(
	ctx: RequestContext,
	id: string,
	date: string,
	change: { cancelled: boolean; override: Record<string, unknown> | null }
): Promise<void> {
	const moved =
		!!change.override &&
		['startsOn', 'startsTime', 'endsOn', 'endsTime', 'location'].some(
			(k) => change.override![k] !== undefined
		);
	if (!change.cancelled && !moved) return;
	if (date < todayBerlin()) return;
	await bestEffort(
		'events.notify.occurrence',
		async () => {
			const s = await eventSnapshot(id);
			if (!s) return;
			const userIds = await audience(s, ctx.userId);
			if (!userIds.length) return;
			const day = formatEventDate(date);
			await core.notifications.send(ctx, MODULE_ID, [
				change.cancelled
					? {
							type: NOTIFY_EVENT_CANCELLED,
							userIds,
							title: `Termin abgesagt: ${s.row.title} am ${day}`,
							body: `„${s.row.title}“ am ${day} fällt aus.`,
							link: link(id)
						}
					: {
							type: NOTIFY_EVENT_CHANGED,
							userIds,
							title: `Termin geändert: ${s.row.title} am ${day}`,
							body: `Der Termin am ${day} hat sich geändert – Details in der App.`,
							link: link(id)
						}
			]);
		},
		{ ctx, target: id }
	);
}

/** Termin gelöscht (Empfänger vorher mit `eventSnapshot` ermitteln) */
export async function notifyEventDeleted(
	ctx: RequestContext,
	before: EventSnapshot | null
): Promise<void> {
	if (!before || !isUpcoming(before.row)) return;
	await bestEffort(
		'events.notify.deleted',
		async () => {
			const userIds = await audience(before, ctx.userId);
			if (!userIds.length) return;
			await core.notifications.send(ctx, MODULE_ID, [
				{
					type: NOTIFY_EVENT_CANCELLED,
					userIds,
					title: `Termin abgesagt: ${before.row.title}`,
					body: `„${before.row.title}“ (${whenText(before.row)}) findet nicht statt.`,
					link: '/modules/events'
				}
			]);
		},
		{ ctx, target: before.row.id }
	);
}
