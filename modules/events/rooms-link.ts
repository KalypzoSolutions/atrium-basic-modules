/**
 * Raumbuchung am Termin über das optionale Modul `rooms` (Repo `atrium-gemeinde-modules`, `RoomsService`).
 * Ohne aktives `rooms` liefern alle Funktionen „nichts“ (`null`/leer); Anfragen mit `room` werden dann abgelehnt.
 * Nur AUSSERHALB von Transaktionen aufrufen. Die Bearbeitungsrechte am Termin prüft `events` vorher selbst.
 */
import { core, CoreError, errors, type RequestContext } from '$lib/sdk/server';
import type { EventRow } from './events.service';
import type { EventRoomResult, EventRoomSpec, RoomsService } from './peer-contracts';
import { MODULE_ID, type EventRoomInput } from './schemas';

export async function roomsService(): Promise<RoomsService | null> {
	return core.modules.useOptional<RoomsService>('rooms', MODULE_ID);
}

type RowLike = Pick<
	EventRow,
	'title' | 'startsOn' | 'startsTime' | 'endsOn' | 'endsTime' | 'recurrence'
>;

export function roomSpec(
	row: RowLike,
	room: EventRoomInput,
	cancelledDates: string[]
): EventRoomSpec {
	return {
		...room,
		title: row.title,
		startsOn: row.startsOn,
		startsAt: row.startsTime,
		endsAt: row.endsTime,
		endsOn: row.endsOn,
		recurrence: row.recurrence,
		cancelledDates
	};
}

/** Ergebnis von `rooms` als Fehler (409 bei belegt, 422 bei nicht passendem Termin, 403 ohne Recht) */
function toError(r: Extract<EventRoomResult, { ok: false }>): CoreError {
	if (r.code === 'ROOMS_FORBIDDEN') return errors.forbidden(r.message);
	if (r.code === 'ROOMS_NO_ROOM') {
		return new CoreError('conflict', r.message, { code: r.code, conflicts: r.conflicts });
	}
	return errors.validation([{ path: ['room'], message: r.message }]);
}

/** Probelauf vor dem Speichern; wirft bei Problemen (nichts wird gespeichert) */
export async function checkRoom(
	ctx: RequestContext,
	eventId: string | null,
	row: RowLike,
	room: EventRoomInput,
	cancelledDates: string[] = []
): Promise<void> {
	const svc = await roomsService();
	if (!svc) {
		throw errors.validation([{ path: ['room'], message: 'Die Raumplanung ist nicht aktiviert' }]);
	}
	const r = await svc.checkEventBooking(ctx, eventId, roomSpec(row, room, cancelledDates));
	if (!r.ok) throw toError(r);
}

/**
 * Buchung nach dem Speichern anlegen/ändern (`room` Objekt) oder entfernen (`null`). Liefert eine Warnung, wenn die
 * Buchung trotz Probelauf scheitert (z. B. gleichzeitige Buchung) – der Termin bleibt gespeichert.
 */
export async function syncRoom(
	ctx: RequestContext,
	eventId: string,
	row: RowLike,
	room: EventRoomInput | null,
	cancelledDates: string[] = []
): Promise<string | null> {
	const svc = await roomsService();
	if (!svc) return null;
	if (!room) {
		await svc.removeEventBooking(ctx, eventId);
		return null;
	}
	const r = await svc.syncEventBooking(ctx, eventId, roomSpec(row, room, cancelledDates));
	return r.ok ? null : r.message;
}

/** Entfernt die Buchung eines gelöschten Termins (still, wenn `rooms` aus ist) */
export async function removeRoom(ctx: RequestContext, eventId: string): Promise<void> {
	const svc = await roomsService();
	await svc?.removeEventBooking(ctx, eventId);
}

/** Gespeicherte Raum-Anforderung eines Termins (oder `null`) */
export async function roomRequestOf(
	ctx: RequestContext,
	eventId: string
): Promise<EventRoomInput | null> {
	const svc = await roomsService();
	if (!svc) return null;
	const [info] = await svc.eventRooms(ctx, [eventId], { from: '0001-01-01', to: '0001-01-01' });
	return info ? { ...info.request } : null;
}

/**
 * Raumnamen je Vorkommen (`<id>:<datum>` → Name bzw. `null` = gebucht, aber ohne Raum). Termine ohne Buchung fehlen.
 */
export async function roomNames(
	ctx: RequestContext,
	occurrences: readonly { id: string; occurrenceDate: string | null; startsOn: string }[]
): Promise<Map<string, string | null>> {
	const out = new Map<string, string | null>();
	if (!occurrences.length) return out;
	const svc = await roomsService();
	if (!svc) return out;
	const dates = occurrences.map((o) => o.occurrenceDate ?? o.startsOn).sort();
	const ids = [...new Set(occurrences.map((o) => o.id))];
	const infos = await svc.eventRooms(ctx, ids, { from: dates[0]!, to: dates.at(-1)! });
	for (const info of infos) {
		for (const a of info.assignments) out.set(`${info.eventId}:${a.date}`, a.roomName);
	}
	return out;
}

export const roomKey = (o: { id: string; occurrenceDate: string | null; startsOn: string }) =>
	`${o.id}:${o.occurrenceDate ?? o.startsOn}`;
