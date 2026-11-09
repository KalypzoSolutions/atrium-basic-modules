/**
 * Lokale Spiegelung der Teile fremder Modul-Verträge, die `events` nutzt. Die Module liegen nicht in diesem Repo
 * (`ep-intern-modules`), sind nur `optionalDependencies` und werden zur Laufzeit über
 * `core.modules.useOptional(…)` geholt. Nur strukturelle Typen – bei Änderungen am Original-Vertrag hier nachziehen.
 */

import type { RequestContext } from '$lib/sdk/types';

/** `actions`: Aktion für Kalender-Abo und Export (`$modules/actions/contract` → `CalendarAction`) */
export interface CalendarAction {
	id: string;
	name: string;
	/** Nur mit Zugriff auf die Aktion, sonst `null` */
	description: string | null;
	location: string | null;
	/** JJJJ-MM-TT */
	startsOn: string;
	endsOn: string | null;
	/** HH:MM */
	startsTime: string | null;
	endsTime: string | null;
	/** Namen der eigenen angemeldeten Personen (Konto oder verknüpfte Mitglieder) */
	registered: string[];
	/** Person darf die Aktion in der App öffnen */
	canOpen: boolean;
}

/** `actions`: genutzter Ausschnitt von `ActionsService` */
export interface ActionsService {
	/** Aktionen im Zeitraum für das Kalender-Abo; prüft die Rechte von `ctx` selbst */
	listCalendarActions(
		ctx: RequestContext,
		window: { from: string; to: string }
	): Promise<CalendarAction[]>;
}

// --- `rooms` (Raumplanung, Repo `atrium-gemeinde-modules`, `$modules/rooms/contract`) -----------------

/** `rooms`: Raum zur Auswahl im Termin-Formular */
export interface RoomOption {
	id: string;
	name: string;
	building: string | null;
	capacity: number;
	featureIds: string[];
}

/** `rooms`: Auswahl für das Termin-Formular */
export interface RoomOptions {
	features: { id: string; name: string }[];
	rooms: RoomOption[];
	canBook: boolean;
	canFix: boolean;
}

/** `rooms`: Raum-Anforderung am Termin (fest = bestimmter Raum, flexibel = nach Personen/Merkmalen) */
export interface EventRoomRequest {
	mode: 'fixed' | 'flexible';
	roomId: string | null;
	persons: number;
	featureIds: string[];
}

/** `rooms`: Termin-Angaben für die Buchung */
export interface EventRoomSpec extends EventRoomRequest {
	title: string;
	startsOn: string;
	startsAt: string | null;
	endsAt: string | null;
	endsOn: string | null;
	recurrence: unknown;
	cancelledDates: string[];
}

export interface EventRoomAssignment {
	date: string;
	roomId: string | null;
	roomName: string | null;
}

export type EventRoomResult =
	| { ok: true; bookingId: string | null; assignments: EventRoomAssignment[] }
	| {
			ok: false;
			code: 'ROOMS_NO_ROOM' | 'ROOMS_UNSUPPORTED' | 'ROOMS_INVALID' | 'ROOMS_FORBIDDEN';
			message: string;
			conflicts: { date: string; reason: string }[];
	  };

export interface EventRoomInfo {
	eventId: string;
	bookingId: string;
	request: EventRoomRequest;
	assignments: EventRoomAssignment[];
}

/** `rooms`: genutzter Ausschnitt von `RoomsService` */
export interface RoomsService {
	roomOptions(ctx: RequestContext): Promise<RoomOptions | null>;
	checkEventBooking(
		ctx: RequestContext,
		eventId: string | null,
		spec: EventRoomSpec
	): Promise<EventRoomResult>;
	syncEventBooking(
		ctx: RequestContext,
		eventId: string,
		spec: EventRoomSpec
	): Promise<EventRoomResult>;
	removeEventBooking(ctx: RequestContext, eventId: string): Promise<void>;
	eventRooms(
		ctx: RequestContext,
		eventIds: readonly string[],
		window?: { from: string; to: string }
	): Promise<EventRoomInfo[]>;
}
