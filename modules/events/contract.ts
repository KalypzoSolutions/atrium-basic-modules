/**
 * Vertrag der Dienste, die `events` anderen Modulen anbietet (`ModuleDefinition.provides`).
 * Abruf: `await core.modules.useOptional<EventRefsService>('events', '<aufrufendes Modul>')`
 * (Aufrufer führt `events` in `optionalDependencies`). Nur AUSSERHALB offener Transaktionen aufrufen.
 */
import type { RequestContext } from '$lib/sdk/types';

/** Kurzverweis auf einen Termin (Serien: Daten des ersten Vorkommens) */
export interface EventRefInfo {
	id: string;
	title: string;
	/** JJJJ-MM-TT */
	startsOn: string;
	endsOn: string | null;
	color: string | null;
	recurring: boolean;
	onWebsite: boolean;
}

export interface EventRefsService {
	/**
	 * Termine, die `ctx` sehen darf (gleiche Regeln wie `GET /events`), Suche im Titel (ILIKE),
	 * neueste zuerst (`starts_on DESC`), höchstens `limit` (1–50, Standard 20). Ohne `search` die neuesten.
	 */
	searchEventRefs(
		ctx: RequestContext,
		opts?: { search?: string; limit?: number }
	): Promise<EventRefInfo[]>;
	/**
	 * Nur die von `ctx` sichtbaren Termine aus `ids` (unbekannte/unsichtbare fehlen), Reihenfolge wie `ids`.
	 * Höchstens 500 IDs.
	 */
	describeEventRefs(ctx: RequestContext, ids: readonly string[]): Promise<EventRefInfo[]>;
	/** Termine aus `ids` mit „auf der Website“ (ohne Rechteprüfung, für Website-Endpoints), Reihenfolge wie `ids` */
	websiteEventRefs(ids: readonly string[]): Promise<EventRefInfo[]>;
}
