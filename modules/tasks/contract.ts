/**
 * Vertrag der Dienste, die `tasks` anderen Modulen anbietet (`ModuleDefinition.provides`).
 * Abruf: `await core.modules.useOptional<TaskRefsService>('tasks', '<aufrufendes Modul>')`
 * (Aufrufer führt `tasks` in `optionalDependencies`). Nur AUSSERHALB offener Transaktionen aufrufen.
 * Alle Funktionen prüfen die Rechte von `ctx` selbst (ohne `tasks.board.view` → leere Liste).
 */
import type { RequestContext } from '$lib/sdk/types';
import type { Priority } from './schemas';

/** Kurzverweis auf ein Aufgaben-Board */
export interface TaskBoardRefInfo {
	id: string;
	name: string;
	color: string | null;
	open: number;
	done: number;
	/** Pfad in der App */
	href: string;
}

/** Kurzverweis auf eine Aufgabe */
export interface TaskRefInfo {
	id: string;
	title: string;
	boardId: string;
	boardName: string;
	columnName: string;
	priority: Priority;
	/** JJJJ-MM-TT */
	dueOn: string | null;
	done: boolean;
	/** Pfad in der App (öffnet die Aufgabe im Board) */
	href: string;
}

export interface TaskRefsService {
	/** Sichtbare Boards (wie `GET /boards`), Suche im Namen, zuletzt geänderte zuerst, höchstens `limit` (1–50, Standard 20) */
	searchBoardRefs(
		ctx: RequestContext,
		opts?: { search?: string; limit?: number }
	): Promise<TaskBoardRefInfo[]>;
	/** Nur sichtbare Boards aus `ids` (höchstens 200), Reihenfolge wie `ids` */
	describeBoardRefs(ctx: RequestContext, ids: readonly string[]): Promise<TaskBoardRefInfo[]>;
	/** Aufgaben in sichtbaren Boards, Suche im Titel, zuletzt geänderte zuerst, höchstens `limit` (1–50, Standard 20) */
	searchTaskRefs(
		ctx: RequestContext,
		opts?: { search?: string; limit?: number }
	): Promise<TaskRefInfo[]>;
	/** Nur sichtbare Aufgaben aus `ids` (höchstens 200), Reihenfolge wie `ids` */
	describeTaskRefs(ctx: RequestContext, ids: readonly string[]): Promise<TaskRefInfo[]>;
	/**
	 * Meilensteine für das Kalender-Abo (Modul `events`): nur aus Boards mit „Meilensteine im Kalender-Abo“,
	 * fällig im Zeitraum, für `ctx` sichtbar und der Person zugewiesen (ohne Zuständige: alle mit
	 * Bearbeiten-Zugriff aufs Board). Höchstens 500, nach Datum.
	 */
	calendarMilestones(
		ctx: RequestContext,
		window: { from: string; to: string }
	): Promise<TaskMilestoneRef[]>;
}

/** Meilenstein für das Kalender-Abo */
export interface TaskMilestoneRef {
	id: string;
	title: string;
	boardId: string;
	boardName: string;
	/** JJJJ-MM-TT */
	dueOn: string;
	done: boolean;
	updatedAt: string;
	/** Pfad in der App */
	href: string;
}
