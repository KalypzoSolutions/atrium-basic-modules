/**
 * Lokale Spiegelung der Teile fremder Modul-Verträge, die `whiteboard` nutzt. Die Module liegen nicht in diesem Repo
 * (`ep-intern-modules`), sind nur `optionalDependencies` und werden zur Laufzeit über
 * `core.modules.useOptional(…)` geholt. Nur strukturelle Typen – bei Änderungen am Original-Vertrag hier nachziehen.
 */

import type { RequestContext } from '$lib/sdk/types';

/** `actions`: Kurzdaten einer Aktion (`$modules/actions/contract` → `ActionRef`) */
export interface ActionRef {
	id: string;
	name: string;
	startsOn: string;
	endsOn: string | null;
}

/** `actions`: Aktion mit Zugriffsstufe des Kontexts (`AccessibleAction`) */
export interface AccessibleAction extends ActionRef {
	level: 'read' | 'edit';
}

/** `actions`: genutzter Ausschnitt von `ActionsService` */
export interface ActionsService {
	/** Aktionen, die `ctx` sehen darf, mit Stufe `read`/`edit`; prüft die Rechte von `ctx` selbst */
	accessibleActions(ctx: RequestContext, query?: { ids?: string[] }): Promise<AccessibleAction[]>;
	/** Kurzdaten von Aktionen (Anzeige, Auswahl); `search` im Namen, max. 200 */
	listActionRefs(query?: { ids?: string[]; search?: string; limit?: number }): Promise<ActionRef[]>;
}

/** `galleries`: Kurzverweis auf eine Galerie (`$modules/galleries/contract` → `GalleryRefInfo`) */
export interface GalleryRefInfo {
	id: string;
	title: string;
	imageCount: number;
}

/** `galleries`: Galerie für Karten in anderen Modulen (`GalleryCardInfo`) */
export interface GalleryCardInfo extends GalleryRefInfo {
	visibility: 'public' | 'private';
	/** Vorschaubild über die API, `null` ohne Bilder */
	coverUrl: string | null;
	/** Pfad in der App */
	href: string;
}

/** `galleries`: genutzter Ausschnitt von `GalleryRefsService` */
export interface GalleryRefsService {
	/** Galerien, die `ctx` sehen darf, Suche im Titel, höchstens `limit` (1–50, Standard 20) */
	searchGalleryCards(
		ctx: RequestContext,
		opts?: { search?: string; limit?: number }
	): Promise<GalleryCardInfo[]>;
	/** Nur die für `ctx` sichtbaren Galerien aus `ids` (höchstens 200), Reihenfolge wie `ids` */
	describeGalleryCards(ctx: RequestContext, ids: readonly string[]): Promise<GalleryCardInfo[]>;
}
