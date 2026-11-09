/** API-Vertrag des Moduls "tasks" (Aufgaben-Boards): Zod-Schemas für Server und UI, DTOs, Konstanten. */
import { z } from 'zod';
import { isRealDate } from '$lib/sdk/dates';
import { PRINCIPAL_TYPES, type PrincipalType } from '$lib/sdk/types/sharing';

export const MODULE_ID = 'tasks';

/** Benachrichtigungen (core.notifications) */
export const NOTIFY_TASK_ASSIGNED = 'task-assigned';
export const NOTIFY_TASK_DUE = 'task-due';
export const NOTIFY_BOARD_SHARED = 'board-shared';

export const PERM = {
	view: 'tasks.board.view',
	create: 'tasks.board.create',
	viewAll: 'tasks.board.view-all',
	editAll: 'tasks.board.edit-all'
} as const;

// --- Konstanten -------------------------------------------------------------

export const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const PRIORITY_LABELS: Record<Priority, string> = {
	low: 'Niedrig',
	medium: 'Mittel',
	high: 'Hoch',
	urgent: 'Dringend'
};
/** Sortierrang (höher = wichtiger) */
export const PRIORITY_RANK: Record<Priority, number> = { low: 0, medium: 1, high: 2, urgent: 3 };

export const SHARE_LEVELS = ['read', 'edit'] as const;
export type ShareLevel = (typeof SHARE_LEVELS)[number];
export const SHARE_LEVEL_LABELS: Record<ShareLevel, string> = {
	read: 'Ansehen',
	edit: 'Bearbeiten'
};

/** Spalten eines neuen Boards; die letzte gilt als „erledigt“ */
export const DEFAULT_COLUMNS: readonly { name: string; isDone: boolean }[] = [
	{ name: 'Offen', isDone: false },
	{ name: 'In Arbeit', isDone: false },
	{ name: 'Erledigt', isDone: true }
];

export const BOARD_COLORS = [
	'#2563eb',
	'#16a34a',
	'#d97706',
	'#dc2626',
	'#7c3aed',
	'#0891b2',
	'#db2777',
	'#475569'
] as const;

export const MAX_BOARD_NAME = 100;
export const MAX_BOARD_DESCRIPTION = 2000;
export const MAX_COLUMNS = 20;
export const MAX_COLUMN_NAME = 60;
export const MAX_TASKS_PER_BOARD = 2000;
export const MAX_TASK_TITLE = 200;
export const MAX_TASK_DESCRIPTION = 10000;
export const MAX_ASSIGNEES = 20;
export const MAX_CHECKLIST = 100;
export const MAX_CHECKLIST_TITLE = 200;
export const MAX_SHARES = 200;
export const MAX_PHASES = 20;
export const MAX_PHASE_NAME = 60;
export const MAX_DEPENDENCIES = 20;
export const MAX_TEMPLATES_PER_USER = 50;
export const MAX_TEMPLATE_NAME = 100;
export const MAX_TEMPLATE_DESCRIPTION = 500;
/** Verschieben aller Daten eines Boards: höchstens so viele Tage */
export const MAX_SHIFT_DAYS = 3660;

/** Ansichten eines Boards (`?view=`) */
export const VIEWS = ['board', 'list', 'timeline', 'calendar'] as const;
export type BoardView = (typeof VIEWS)[number];
export const VIEW_LABELS: Record<BoardView, string> = {
	board: 'Board',
	list: 'Liste',
	timeline: 'Zeitleiste',
	calendar: 'Kalender'
};

// --- Bausteine --------------------------------------------------------------

const uuid = z.uuid('Ungültige ID');
/** Benutzer-IDs (Better Auth, kein UUID-Format garantiert) */
const userId = z
	.string()
	.trim()
	.min(1)
	.max(64)
	.regex(/^[A-Za-z0-9_-]+$/, 'Ungültige ID');

const optionalText = (max: number) =>
	z
		.string()
		.trim()
		.max(max, `Höchstens ${max} Zeichen`)
		.nullish()
		.transform((v) => (v ? v : null));

const requiredText = (max: number) =>
	z.string().trim().min(1, 'Pflichtfeld').max(max, `Höchstens ${max} Zeichen`);

/** JJJJ-MM-TT oder `null` */
const dueDate = z
	.string()
	.regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT')
	.refine(isRealDate, 'Ungültiges Datum')
	.nullish()
	.transform((v) => v ?? null);

const color = z
	.string()
	.regex(/^#[0-9a-fA-F]{6}$/, 'Farbe als #rrggbb')
	.transform((v) => v.toLowerCase())
	.nullish()
	.transform((v) => v ?? null);

const assigneeIds = z
	.array(userId)
	.max(MAX_ASSIGNEES, `Höchstens ${MAX_ASSIGNEES} Personen`)
	.transform((ids) => [...new Set(ids)]);

/** Vorlage: mitgeliefert (`builtin:fahrt`) oder eigene (UUID) */
export const templateRef = z
	.string()
	.regex(
		/^(builtin:[a-z0-9-]{1,40}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/,
		'Unbekannte Vorlage'
	);

/**
 * Regeln für Zeitraum und Meilenstein einer Aufgabe (Anlegen; beim Ändern mit den gespeicherten Werten
 * zusammengeführt): Beginn ≤ Fälligkeit, Meilenstein ohne Beginn und mit Datum.
 */
export function taskDateIssues(v: {
	startsOn?: string | null;
	dueOn?: string | null;
	isMilestone?: boolean;
}): { path: string[]; message: string }[] {
	const issues: { path: string[]; message: string }[] = [];
	if (v.isMilestone) {
		if (v.startsOn)
			issues.push({ path: ['startsOn'], message: 'Ein Meilenstein hat nur ein Datum' });
		if (!v.dueOn) issues.push({ path: ['dueOn'], message: 'Ein Meilenstein braucht ein Datum' });
	} else if (v.startsOn && v.dueOn && v.startsOn > v.dueOn) {
		issues.push({ path: ['startsOn'], message: 'Der Beginn liegt nach der Fälligkeit' });
	}
	return issues;
}

// --- Eingaben ---------------------------------------------------------------

export const idParams = z.object({ id: uuid });
export const taskParams = z.object({ id: uuid });
export const columnParams = z.object({ id: uuid, columnId: uuid });
export const checklistParams = z.object({ id: uuid, itemId: uuid });
export const actionParams = z.object({ actionId: uuid });

/** POST `/boards` */
export const boardInput = z
	.object({
		name: requiredText(MAX_BOARD_NAME),
		description: optionalText(MAX_BOARD_DESCRIPTION),
		color: color,
		/** Aktion aus `actions` (Zugriff auf die Aktion vererbt sich aufs Board) */
		actionId: uuid.nullish().transform((v) => v ?? null),
		/** Vorlage (`builtin:<id>` oder eigene Vorlage) */
		templateId: templateRef.nullish().transform((v) => v ?? null),
		/** Bezugsdatum der Vorlage (Standard: Beginn der Aktion, sonst heute) */
		anchorOn: dueDate
	})
	.strict();
export type BoardInput = z.input<typeof boardInput>;

/** PATCH `/boards/:id` – nur übergebene Felder */
export const boardUpdateInput = z
	.object({
		name: requiredText(MAX_BOARD_NAME).optional(),
		description: optionalText(MAX_BOARD_DESCRIPTION).optional(),
		color: color.optional(),
		actionId: uuid.nullable().optional(),
		defaultView: z.enum(VIEWS).optional(),
		calendarMilestones: z.boolean().optional()
	})
	.strict();
export type BoardUpdateInput = z.input<typeof boardUpdateInput>;

const principalShare = z
	.object({
		type: z.enum(PRINCIPAL_TYPES),
		id: z.string().trim().min(1).max(64),
		level: z.enum(SHARE_LEVELS)
	})
	.strict();

/** PUT `/boards/:id/shares` – ersetzt alle Freigaben */
export const sharesInput = z
	.object({ shares: z.array(principalShare).max(MAX_SHARES, `Höchstens ${MAX_SHARES} Freigaben`) })
	.strict()
	.superRefine((v, ctx) => {
		const seen = new Set<string>();
		v.shares.forEach((s, i) => {
			const key = `${s.type}:${s.id}`;
			if (seen.has(key)) {
				ctx.addIssue({ code: 'custom', path: ['shares', i, 'id'], message: 'Doppelte Freigabe' });
			}
			seen.add(key);
			if (s.type === 'everyone' && s.id !== '*') {
				ctx.addIssue({ code: 'custom', path: ['shares', i, 'id'], message: 'Ungültige ID' });
			}
		});
	});
export type SharesInput = z.infer<typeof sharesInput>;

/** POST `/boards/:id/columns` */
export const columnInput = z
	.object({ name: requiredText(MAX_COLUMN_NAME), isDone: z.boolean().default(false) })
	.strict();
/** PATCH `/boards/:id/columns/:columnId` */
export const columnUpdateInput = z
	.object({ name: requiredText(MAX_COLUMN_NAME).optional(), isDone: z.boolean().optional() })
	.strict();
/** PUT `/boards/:id/columns/order` – alle Spalten-IDs genau einmal */
export const orderInput = z.object({ ids: z.array(uuid).min(1).max(MAX_TASKS_PER_BOARD) }).strict();
/** DELETE `/boards/:id/columns/:columnId?moveTo=` – Aufgaben in diese Spalte verschieben (sonst 409, wenn nicht leer) */
export const columnDeleteQuery = z.object({ moveTo: uuid.optional() });

const checklistNew = z
	.object({
		title: requiredText(MAX_CHECKLIST_TITLE),
		done: z.boolean().default(false),
		assigneeId: userId.nullish().transform((v) => v ?? null),
		dueOn: dueDate
	})
	.strict();

/** POST `/boards/:id/tasks` */
export const taskInput = z
	.object({
		/** Spalte; fehlt = erste Spalte */
		columnId: uuid.optional(),
		title: requiredText(MAX_TASK_TITLE),
		description: optionalText(MAX_TASK_DESCRIPTION),
		priority: z.enum(PRIORITIES).default('medium'),
		dueOn: dueDate,
		/** Beginn (Zeitraum bis `dueOn`); bei Meilensteinen leer */
		startsOn: dueDate,
		isMilestone: z.boolean().default(false),
		/** Phase des Boards; fehlt = ohne Phase */
		phaseId: uuid.nullish().transform((v) => v ?? null),
		assigneeIds: assigneeIds.default([]),
		checklist: z
			.array(checklistNew)
			.max(MAX_CHECKLIST, `Höchstens ${MAX_CHECKLIST} Unteraufgaben`)
			.default([])
	})
	.strict()
	.superRefine((v, ctx) => {
		for (const issue of taskDateIssues(v)) ctx.addIssue({ code: 'custom', ...issue });
	});
export type TaskInput = z.input<typeof taskInput>;

/** PATCH `/tasks/:id` – nur übergebene Felder; `assigneeIds` ersetzt die Liste */
export const taskUpdateInput = z
	.object({
		title: requiredText(MAX_TASK_TITLE).optional(),
		description: optionalText(MAX_TASK_DESCRIPTION).optional(),
		priority: z.enum(PRIORITIES).optional(),
		dueOn: dueDate.optional(),
		startsOn: dueDate.optional(),
		isMilestone: z.boolean().optional(),
		phaseId: uuid.nullable().optional(),
		assigneeIds: assigneeIds.optional()
	})
	.strict();
export type TaskUpdateInput = z.input<typeof taskUpdateInput>;

/** POST `/tasks/:id/move` – in Spalte an Position (0 = oben; größer als Anzahl = ans Ende) */
export const taskMoveInput = z
	.object({ columnId: uuid, position: z.number().int().min(0).max(MAX_TASKS_PER_BOARD) })
	.strict();

/** POST `/tasks/:id/checklist` */
export const checklistItemInput = checklistNew;
/** PATCH `/tasks/:id/checklist/:itemId` */
export const checklistItemUpdateInput = z
	.object({
		title: requiredText(MAX_CHECKLIST_TITLE).optional(),
		done: z.boolean().optional(),
		assigneeId: userId.nullable().optional(),
		dueOn: dueDate.optional()
	})
	.strict();

export const phaseParams = z.object({ id: uuid, phaseId: uuid });

/** POST `/boards/:id/phases` */
export const phaseInput = z
	.object({
		name: requiredText(MAX_PHASE_NAME),
		color: color,
		startsOn: dueDate,
		endsOn: dueDate
	})
	.strict()
	.superRefine((v, ctx) => {
		if (v.startsOn && v.endsOn && v.endsOn < v.startsOn) {
			ctx.addIssue({ code: 'custom', path: ['endsOn'], message: 'Das Ende liegt vor dem Beginn' });
		}
	});
export type PhaseInput = z.input<typeof phaseInput>;

/** PATCH `/boards/:id/phases/:phaseId` – nur übergebene Felder */
export const phaseUpdateInput = z
	.object({
		name: requiredText(MAX_PHASE_NAME).optional(),
		color: color.optional(),
		startsOn: dueDate.optional(),
		endsOn: dueDate.optional()
	})
	.strict();

/** POST `/boards/:id/shift` – alle Daten um `days` verschieben (`apply: false` = nur Bezugsdatum übernehmen) */
export const shiftInput = z
	.object({
		days: z.number().int().min(-MAX_SHIFT_DAYS).max(MAX_SHIFT_DAYS),
		apply: z.boolean().default(true)
	})
	.strict();

/** POST `/boards/:id/template` – Board als Vorlage speichern */
export const templateSaveInput = z
	.object({
		name: requiredText(MAX_TEMPLATE_NAME),
		description: optionalText(MAX_TEMPLATE_DESCRIPTION)
	})
	.strict();
export const templateParams = z.object({ id: uuid });

/** PUT `/tasks/:id/dependencies` – Vorgänger (ersetzt die Liste) */
export const dependenciesInput = z
	.object({
		ids: z
			.array(uuid)
			.max(MAX_DEPENDENCIES, `Höchstens ${MAX_DEPENDENCIES} Vorgänger`)
			.transform((ids) => [...new Set(ids)])
	})
	.strict();

export const listQuery = z.object({
	search: z.string().trim().max(100).optional(),
	limit: z.coerce.number().int().min(1).max(200).default(100),
	offset: z.coerce.number().int().min(0).default(0)
});

/** GET `/my/tasks` */
export const myTasksQuery = z.object({
	limit: z.coerce.number().int().min(1).max(100).default(20),
	/** auch erledigte */
	done: z
		.enum(['0', '1', 'true', 'false'])
		.optional()
		.transform((v) => v === '1' || v === 'true')
});

export const searchQuery = z.object({
	search: z.string().trim().min(2, 'Mindestens 2 Zeichen').max(100)
});
export const peopleQuery = z.object({
	search: z.string().trim().max(100).optional()
});

// --- Antworten (DTOs) -------------------------------------------------------

export interface UserRef {
	id: string;
	name: string;
	image: string | null;
}

export interface BoardAccess {
	level: ShareLevel;
	isOwner: boolean;
	/** Freigaben ändern, Board löschen (Eigentümer*in, `edit-all`) */
	canShare: boolean;
}

export interface BoardCounts {
	total: number;
	open: number;
	done: number;
	overdue: number;
}

export interface PhaseRef {
	id: string;
	name: string;
	color: string | null;
}

export interface Phase extends PhaseRef {
	startsOn: string | null;
	endsOn: string | null;
	position: number;
}

export interface Board {
	id: string;
	name: string;
	description: string | null;
	color: string | null;
	owner: UserRef;
	action: { id: string; name: string } | null;
	access: BoardAccess;
	counts: BoardCounts;
	defaultView: BoardView;
	/** Meilensteine erscheinen im Kalender-Abo der Zuständigen */
	calendarMilestones: boolean;
	/** laufende Phase, sonst die nächste geplante */
	currentPhase: PhaseRef | null;
	/** nächster offener Meilenstein ab heute */
	nextMilestone: { id: string; title: string; dueOn: string } | null;
	createdAt: string;
	updatedAt: string;
}

export interface BoardList {
	items: Board[];
	total: number;
}

export interface Column {
	id: string;
	name: string;
	position: number;
	isDone: boolean;
}

export interface TaskCard {
	id: string;
	columnId: string;
	title: string;
	priority: Priority;
	dueOn: string | null;
	position: number;
	assignees: UserRef[];
	checklist: { done: number; total: number };
	hasDescription: boolean;
	completedAt: string | null;
	startsOn: string | null;
	isMilestone: boolean;
	phaseId: string | null;
	/** Vorgänger („blockiert durch“), IDs im selben Board */
	blockedBy: string[];
	/** davon noch nicht erledigt */
	openBlockers: number;
	/** Aufrufer darf verschieben/abhaken (Bearbeiten-Zugriff oder zugewiesen) */
	canMove: boolean;
}

export interface BoardDetail extends Board {
	columns: Column[];
	phases: Phase[];
	tasks: TaskCard[];
	/** Bezugsdatum (Aktionsbeginn bzw. Datum der Vorlage) */
	anchorOn: string | null;
	/** Beginn der verknüpften Aktion */
	actionStartsOn: string | null;
	/** Aktionsbeginn liegt so viele Tage neben dem Bezugsdatum (sonst `null`) */
	actionShift: number | null;
}

export interface ChecklistItem {
	id: string;
	title: string;
	done: boolean;
	assignee: UserRef | null;
	dueOn: string | null;
	position: number;
	doneAt: string | null;
}

export interface TaskDetail extends TaskCard {
	boardId: string;
	description: string | null;
	items: ChecklistItem[];
	createdBy: UserRef | null;
	createdAt: string;
	updatedAt: string;
	/** Aufrufer darf alle Felder ändern (Bearbeiten-Zugriff aufs Board) */
	canEdit: boolean;
}

export interface MyTask {
	id: string;
	title: string;
	priority: Priority;
	dueOn: string | null;
	board: { id: string; name: string; color: string | null };
	columnName: string;
	checklist: { done: number; total: number };
	/** nur über eine Unteraufgabe zugewiesen */
	viaChecklist: boolean;
	isMilestone: boolean;
	phase: PhaseRef | null;
}

/** GET `/templates` */
export interface TemplateSummary {
	id: string;
	name: string;
	description: string | null;
	/** mitgeliefert (nicht löschbar) */
	builtin: boolean;
	owner: UserRef | null;
	phases: { name: string; color: string | null }[];
	taskCount: number;
	canDelete: boolean;
}

export interface BoardShareEntry {
	type: PrincipalType;
	/** ID des Principals (Name wie im Baustein `ShareMenu`) */
	userId: string;
	name: string;
	detail: string | null;
	color: string | null;
	image: string | null;
	level: ShareLevel;
}

export interface BoardShares {
	owner: UserRef;
	shares: BoardShareEntry[];
	canManage: boolean;
	everyoneLabel: string;
}

/** GET `/boards/by-action/:actionId` */
export interface ActionBoardInfo {
	board: Board | null;
	/** Aufrufer darf ein Board für die Aktion anlegen */
	canCreate: boolean;
}

/** Fälligkeit relativ zu `today` (JJJJ-MM-TT): überfällig / heute / bald (≤ 3 Tage) / später */
export function dueState(
	dueOn: string | null,
	today: string,
	done = false
): 'none' | 'overdue' | 'today' | 'soon' | 'later' {
	if (!dueOn || done) return 'none';
	if (dueOn < today) return 'overdue';
	if (dueOn === today) return 'today';
	const diff = (Date.parse(`${dueOn}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000;
	return diff <= 3 ? 'soon' : 'later';
}

/** Neue Position nach dem Verschieben: `ids` ohne `moved`, dann an `index` eingefügt */
export function reorder(ids: readonly string[], moved: string, index: number): string[] {
	const rest = ids.filter((id) => id !== moved);
	const at = Math.max(0, Math.min(index, rest.length));
	return [...rest.slice(0, at), moved, ...rest.slice(at)];
}
