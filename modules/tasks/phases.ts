/** Reine Hilfen für Phasen und Zeiträume (Server und UI, ohne Importe aus Server/Svelte). */

export type PhaseState = 'planned' | 'active' | 'past' | 'undated';

export const PHASE_STATE_LABELS: Record<PhaseState, string> = {
	planned: 'geplant',
	active: 'läuft',
	past: 'vorbei',
	undated: 'ohne Datum'
};

interface Dated {
	startsOn: string | null;
	endsOn: string | null;
}

/** Stand einer Phase an `today` (JJJJ-MM-TT); offene Enden zählen als unbegrenzt */
export function phaseState(p: Dated, today: string): PhaseState {
	if (!p.startsOn && !p.endsOn) return 'undated';
	if (p.endsOn && p.endsOn < today) return 'past';
	if (p.startsOn && p.startsOn > today) return 'planned';
	return 'active';
}

/** Laufende Phase (die erste nach Reihenfolge), sonst die nächste geplante, sonst `null` */
export function currentPhase<T extends Dated & { position: number }>(
	phases: readonly T[],
	today: string
): T | null {
	const sorted = [...phases].sort((a, b) => a.position - b.position);
	const active = sorted.find((p) => phaseState(p, today) === 'active');
	if (active) return active;
	const planned = sorted
		.filter((p) => phaseState(p, today) === 'planned')
		.sort((a, b) => (a.startsOn ?? '').localeCompare(b.startsOn ?? ''));
	return planned[0] ?? null;
}

/**
 * Zeitraum einer Aufgabe für Zeitleiste/Kalender: Meilenstein und Aufgaben nur mit Fälligkeit = ein Tag;
 * nur Beginn = ein Tag am Beginn; ohne Datum → `null`.
 */
export function taskRange(t: {
	startsOn: string | null;
	dueOn: string | null;
	isMilestone: boolean;
}): { from: string; to: string } | null {
	if (t.isMilestone) return t.dueOn ? { from: t.dueOn, to: t.dueOn } : null;
	const from = t.startsOn ?? t.dueOn;
	const to = t.dueOn ?? t.startsOn;
	if (!from || !to) return null;
	return from <= to ? { from, to } : { from: to, to: from };
}
