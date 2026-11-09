/**
 * Vertrag der Dienste, die `files` anderen Modulen anbietet (`ModuleDefinition.provides`).
 * Abruf: `await core.modules.useOptional<FileRefsService>('files', '<aufrufendes Modul>')`
 * (Aufrufer führt `files` in `optionalDependencies`). Nur AUSSERHALB offener Transaktionen aufrufen.
 * Alle Funktionen prüfen die Rechte von `ctx` selbst (ohne `files.file.view` → leere Liste).
 */
import type { RequestContext } from '$lib/sdk/types';

/** Verweis auf eine Datei oder einen Ordner (nur für Personen mit Zugriff) */
export interface FileRefInfo {
	id: string;
	kind: 'folder' | 'file';
	name: string;
	/** nur Dateien */
	contentType: string | null;
	sizeBytes: number | null;
	/** Vorschaubild über `GET /api/v1/modules/files/nodes/:id/thumb` vorhanden */
	hasThumb: boolean;
	/** Ordner: Icon/Farbe */
	icon: string | null;
	color: string | null;
	/** Pfad in der App (Ordner bzw. Ordner der Datei) */
	href: string;
	/** Dateien: Inhalt über die API (inline bei Bild/PDF/Text) */
	contentUrl: string | null;
}

export interface FileRefsService {
	/** Sichtbare Dateien/Ordner nach Name (ab 2 Zeichen, sonst leer), höchstens `limit` (1–50, Standard 20) */
	searchFileRefs(
		ctx: RequestContext,
		opts: { search: string; limit?: number }
	): Promise<FileRefInfo[]>;
	/** Nur sichtbare, nicht gelöschte Einträge aus `ids` (höchstens 200), Reihenfolge wie `ids` */
	describeFileRefs(ctx: RequestContext, ids: readonly string[]): Promise<FileRefInfo[]>;
}
