/** Filter der Board-Ansichten (rein, lokal im Browser). */
import { addDays } from '$lib/sdk/dates';
import { dueState, type Priority, type TaskCard } from '../schemas';

export type DueFilter = 'all' | 'overdue' | 'week' | 'none';

export const DUE_FILTER_LABELS: Record<DueFilter, string> = {
	all: 'Alle',
	overdue: 'Überfällig',
	week: 'Nächste 7 Tage',
	none: 'Ohne Datum'
};

/** `phaseId`: `null` = alle, `'none'` = ohne Phase */
export interface TaskFilter {
	search: string;
	assignees: string[];
	priorities: Priority[];
	due: DueFilter;
	onlyMine: boolean;
	phaseId: string | null;
}

export const emptyFilter = (): TaskFilter => ({
	search: '',
	assignees: [],
	priorities: [],
	due: 'all',
	onlyMine: false,
	phaseId: null
});

/** Zahl der gesetzten Filter (Suche zählt mit) */
export function activeFilterCount(f: TaskFilter): number {
	return (
		(f.search.trim() ? 1 : 0) +
		(f.assignees.length ? 1 : 0) +
		(f.priorities.length ? 1 : 0) +
		(f.due !== 'all' ? 1 : 0) +
		(f.onlyMine ? 1 : 0) +
		(f.phaseId ? 1 : 0)
	);
}

export interface FilterContext {
	myId: string | null;
	/** Bearbeiten-Zugriff: „Nur meine“ zählt dann nur direkte Zuweisungen */
	canEdit: boolean;
	today: string;
	/** Aufgaben in der Erledigt-Spalte (Fälligkeit zählt dann nicht) */
	isDone: (t: TaskCard) => boolean;
}

export function matchesFilter(t: TaskCard, f: TaskFilter, c: FilterContext): boolean {
	if (f.onlyMine) {
		// Lesezugriff: `canMove` markiert auch Zuweisungen über Unteraufgaben
		const mine = t.assignees.some((a) => a.id === c.myId) || (!c.canEdit && t.canMove);
		if (!mine) return false;
	}
	if (f.assignees.length && !t.assignees.some((a) => f.assignees.includes(a.id))) return false;
	if (f.priorities.length && !f.priorities.includes(t.priority)) return false;
	if (f.phaseId === 'none' ? t.phaseId !== null : f.phaseId && t.phaseId !== f.phaseId) {
		return false;
	}
	if (f.due !== 'all') {
		const done = c.isDone(t);
		if (f.due === 'none' && t.dueOn) return false;
		if (f.due === 'overdue' && dueState(t.dueOn, c.today, done) !== 'overdue') return false;
		if (
			f.due === 'week' &&
			(!t.dueOn || done || t.dueOn < c.today || t.dueOn > addDays(c.today, 7))
		) {
			return false;
		}
	}
	const q = f.search.trim().toLowerCase();
	return !q || t.title.toLowerCase().includes(q);
}
