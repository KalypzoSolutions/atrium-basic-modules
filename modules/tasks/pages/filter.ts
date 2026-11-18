/** Filter der Board-Ansichten (rein, lokal im Browser). */
import { addDays } from '$lib/sdk/dates';
import { dueState, PRIORITY_LABELS, type Priority, type TaskCard } from '../schemas';

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

/** Aktive Filter als Text, z. B. für die Kopfzeile eines Exports („Filter: Nur meine · Priorität: Hoch“) */
export function filterSummary(
	f: TaskFilter,
	names: {
		phases: readonly { id: string; name: string }[];
		people: readonly { id: string; name: string }[];
	}
): string {
	const parts: string[] = [];
	if (f.search.trim()) parts.push(`„${f.search.trim()}“`);
	if (f.onlyMine) parts.push('Nur meine');
	if (f.phaseId) {
		parts.push(
			`Phase: ${f.phaseId === 'none' ? 'Ohne Phase' : (names.phases.find((p) => p.id === f.phaseId)?.name ?? 'Phase')}`
		);
	}
	if (f.assignees.length) {
		parts.push(
			`Zuständig: ${f.assignees.map((id) => names.people.find((p) => p.id === id)?.name ?? 'Unbekannt').join(', ')}`
		);
	}
	if (f.priorities.length)
		parts.push(`Priorität: ${f.priorities.map((p) => PRIORITY_LABELS[p]).join(', ')}`);
	if (f.due !== 'all') parts.push(DUE_FILTER_LABELS[f.due]);
	return parts.length ? `Filter: ${parts.join(' · ')}` : '';
}
