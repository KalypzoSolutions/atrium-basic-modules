/**
 * Vertrag der Dienste, die `notes` anderen Modulen anbietet (`ModuleDefinition.provides`).
 * Abruf: `await core.modules.useOptional<NoteRefsService>('notes', '<aufrufendes Modul>')`
 * (Aufrufer führt `notes` in `optionalDependencies`). Nur AUSSERHALB offener Transaktionen aufrufen.
 * Alle Funktionen prüfen die Rechte von `ctx` selbst (ohne `notes.note.view` → leere Liste).
 */
import type { RequestContext } from '$lib/sdk/types';

/** Kurzverweis auf eine Notiz (z. B. Karte im Whiteboard) */
export interface NoteRefInfo {
	id: string;
	title: string;
	icon: string | null;
	color: string | null;
	/** Textanfang */
	excerpt: string;
	/** Pfad der Oberseiten („Lager › Planung“), ohne die Notiz selbst */
	path: string;
	updatedAt: string;
	/** Pfad in der App */
	href: string;
}

export interface NoteRefsService {
	/** Sichtbare Notizen (nie Papierkorb), Suche in Titel und Text, zuletzt geänderte zuerst, höchstens `limit` (1–50, Standard 20) */
	searchNoteRefs(
		ctx: RequestContext,
		opts?: { search?: string; limit?: number }
	): Promise<NoteRefInfo[]>;
	/** Nur sichtbare Notizen aus `ids` (höchstens 200), Reihenfolge wie `ids` */
	describeNoteRefs(ctx: RequestContext, ids: readonly string[]): Promise<NoteRefInfo[]>;
}
