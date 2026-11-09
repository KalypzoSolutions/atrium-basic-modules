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
