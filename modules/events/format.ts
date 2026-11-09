/**
 * Reine Formatierung von Terminzeiten (de-DE), ohne Abhängigkeiten – im Browser und in Tests nutzbar.
 * Unit-Test: `tests/unit/events-format.test.ts`.
 */
import type { EventDates } from './schemas';

const WEEKDAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'] as const;

/** Ganztägig: weder Start- noch Enduhrzeit */
export function isAllDay(e: Pick<EventDates, 'startsTime' | 'endsTime'>): boolean {
	return !e.startsTime && !e.endsTime;
}

/** `HH:MM` (Sekunden aus der Datenbank werden abgeschnitten); leer/ungültig → `''` */
export function formatEventTime(time: string | null | undefined): string {
	if (!time) return '';
	const m = /^(\d{2}):(\d{2})/.exec(time);
	return m ? `${m[1]}:${m[2]}` : '';
}

/** `JJJJ-MM-TT` → „Sa, 24.10.2026“; ungültig → Eingabe unverändert */
export function formatEventDate(iso: string): string {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
	if (!m) return iso;
	const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
	if (Number.isNaN(d.getTime())) return iso;
	return `${WEEKDAYS[d.getUTCDay()]}, ${m[3]}.${m[2]}.${m[1]}`;
}

/**
 * Zeitraum eines Termins, z. B.
 * - „Sa, 24.10.2026“ (ganztägig, ein Tag)
 * - „Sa, 24.10.2026, 10:00 – 14:00“ (ein Tag mit Uhrzeiten)
 * - „Sa, 24.10.2026, 10:00 – So, 25.10.2026, 14:00“ (mehrtägig)
 * - „Sa, 24.10.2026 – So, 25.10.2026“ (mehrtägig, ganztägig)
 */
export function formatEventRange(e: EventDates): string {
	const startDate = formatEventDate(e.startsOn);
	const startTime = formatEventTime(e.startsTime);
	const endTime = formatEventTime(e.endsTime);
	const multiDay = !!e.endsOn && e.endsOn !== e.startsOn;
	const start = startTime ? `${startDate}, ${startTime}` : startDate;

	if (!multiDay) {
		if (!endTime) return start;
		return startTime ? `${start} – ${endTime}` : `${start}, bis ${endTime}`;
	}
	const endDate = formatEventDate(e.endsOn!);
	const end = endTime ? `${endDate}, ${endTime}` : endDate;
	return `${start} – ${end}`;
}
