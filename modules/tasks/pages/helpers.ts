/** Kleine UI-Hilfen der Aufgaben-Seiten (ohne Server-Importe). */
import { ApiClientError } from '$lib/sdk/client';
import { daysBetween, formatDateDe, todayBerlin } from '$lib/sdk/dates';
import { dueState, PRIORITY_LABELS, type Priority } from '../schemas';

export const BASE = '/modules/tasks';

export function errMsg(e: unknown, fallback: string): string {
	return e instanceof ApiClientError && e.message ? e.message : fallback;
}

/** Badge-Variante je Priorität (Farbe nie allein: der Text steht immer dabei) */
export function priorityVariant(p: Priority): 'destructive' | 'warning' | 'secondary' | 'outline' {
	if (p === 'urgent') return 'destructive';
	if (p === 'high') return 'warning';
	if (p === 'medium') return 'secondary';
	return 'outline';
}

export const priorityLabel = (p: Priority) => PRIORITY_LABELS[p];

/** „Heute“, „Morgen“, „Überfällig · 03.05.2027“, sonst Datum */
export function dueLabel(dueOn: string | null, done = false): string {
	if (!dueOn) return '';
	const state = dueState(dueOn, todayBerlin(), done);
	if (state === 'today') return 'Heute fällig';
	if (state === 'overdue') return `Überfällig · ${formatDateDe(dueOn)}`;
	const tomorrow = new Date(`${todayBerlin()}T00:00:00Z`);
	tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
	if (dueOn === tomorrow.toISOString().slice(0, 10)) return 'Morgen fällig';
	return formatDateDe(dueOn);
}

/** Text-Klasse für die Fälligkeit (Status-Tokens) */
export function dueClass(dueOn: string | null, done = false): string {
	const state = dueState(dueOn, todayBerlin(), done);
	if (state === 'overdue') return 'text-destructive';
	if (state === 'today' || state === 'soon') return 'text-warning';
	return 'text-muted-foreground';
}

/** `2027-04-12` → `12.04.` (mit Jahr, wenn es nicht das aktuelle ist) */
export function shortDate(iso: string): string {
	const [y, m, d] = iso.split('-');
	return y === todayBerlin().slice(0, 4) ? `${d}.${m}.` : `${d}.${m}.${y}`;
}

/** Kurztext der Fälligkeit für Karten/Listen: „Heute“, „Morgen“, „seit 3 Tagen“, „05.01.–20.01.“ */
export function dueText(
	dueOn: string | null,
	done = false,
	startsOn: string | null = null
): string {
	if (!dueOn) return startsOn ? `ab ${shortDate(startsOn)}` : '';
	const today = todayBerlin();
	if (!done) {
		const diff = daysBetween(today, dueOn);
		if (diff === 0) return 'Heute';
		if (diff === 1) return 'Morgen';
		if (diff < 0) return diff === -1 ? 'seit gestern' : `seit ${-diff} Tagen`;
	}
	return startsOn && startsOn !== dueOn
		? `${shortDate(startsOn)}–${shortDate(dueOn)}`
		: shortDate(dueOn);
}

/** Farbstufe der Fälligkeit: überfällig (rot), bald (≤ 3 Tage, Warnfarbe), sonst normal */
export function dueTone(dueOn: string | null, done = false): 'overdue' | 'soon' | 'normal' {
	const state = dueState(dueOn, todayBerlin(), done);
	if (state === 'overdue') return 'overdue';
	if (state === 'today' || state === 'soon') return 'soon';
	return 'normal';
}

export function initials(name: string): string {
	const parts = name.trim().split(/\s+/).filter(Boolean);
	return (
		((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '')).toUpperCase() ||
		'?'
	);
}
