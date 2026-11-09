/** Reine Hilfen für Abhängigkeiten („blockiert durch“) zwischen Aufgaben eines Boards. */

/**
 * Würde `taskId` mit den Vorgängern `blockers` einen Kreis bilden? `edges` = Aufgabe → ihre Vorgänger
 * (bisheriger Stand; die Kanten von `taskId` selbst werden ignoriert). Breitensuche über die Vorgänger.
 */
export function createsCycle(
	edges: ReadonlyMap<string, readonly string[]>,
	taskId: string,
	blockers: readonly string[]
): boolean {
	const seen = new Set<string>();
	const queue = [...blockers];
	while (queue.length) {
		const id = queue.shift()!;
		if (id === taskId) return true;
		if (seen.has(id)) continue;
		seen.add(id);
		for (const next of edges.get(id) ?? []) if (!seen.has(next)) queue.push(next);
	}
	return false;
}

/**
 * Terminkonflikt: die Aufgabe beginnt (bzw. ist fällig, wenn ohne Beginn) vor der Fälligkeit eines Vorgängers.
 * Fehlende Daten sind kein Konflikt.
 */
export function startsBeforeBlocker(
	task: { startsOn: string | null; dueOn: string | null },
	blocker: { dueOn: string | null }
): boolean {
	const start = task.startsOn ?? task.dueOn;
	return !!start && !!blocker.dueOn && start < blocker.dueOn;
}
