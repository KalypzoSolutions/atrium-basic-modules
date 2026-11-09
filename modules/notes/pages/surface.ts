/**
 * Persönlicher Hintergrund der Notizen (rein, ohne DOM): aus einer festen Farbe die Design-Variablen für den
 * Bereich mit Leiste, Titel und Text ableiten. Die Variablen überschreiben die des Themes nur innerhalb dieses
 * Bereichs; Tailwind-Klassen (`bg-background`, `text-muted-foreground` …) folgen ihnen automatisch.
 */
import type { UserPrefs } from '../schemas';

const HEX_RE = /^#[0-9a-f]{6}$/i;

/** Relative Leuchtdichte nach WCAG (0 = schwarz, 1 = weiß); ungültige Farbe → 1 */
export function luminance(hex: string): number {
	if (!HEX_RE.test(hex)) return 1;
	const channel = (i: number) => {
		const c = parseInt(hex.slice(i, i + 2), 16) / 255;
		return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** Dunkle Fläche → helle Schrift (Grenze: gleicher Kontrast zu Schwarz und Weiß) */
export function isDarkSurface(hex: string): boolean {
	return luminance(hex) < 0.179;
}

/**
 * CSS-Variablen für eine feste Hintergrundfarbe oder `null` (Modus/Theme bleibt). Abgeleitete Töne über
 * `color-mix`, damit sie zur gewählten Farbe passen (z. B. Papier → warme Linien).
 */
export function surfaceVars(prefs: UserPrefs | null | undefined): Record<string, string> | null {
	const s = prefs?.surface;
	if (!s || s.mode !== 'fixed' || !HEX_RE.test(s.color)) return null;
	const bg = s.color.toLowerCase();
	const dark = isDarkSurface(bg);
	const ink = dark ? '#f3f4f6' : '#111827';
	const toward = dark ? 'white' : 'black';
	const mix = (pct: number) => `color-mix(in srgb, ${bg} ${100 - pct}%, ${toward})`;
	return {
		'--background': bg,
		'--foreground': ink,
		'--card': bg,
		'--card-foreground': ink,
		'--muted': mix(dark ? 10 : 5),
		'--muted-foreground': dark ? '#9ca3af' : '#4b5563',
		'--accent': mix(dark ? 14 : 7),
		'--accent-foreground': ink,
		'--secondary': mix(dark ? 12 : 6),
		'--secondary-foreground': ink,
		'--border': mix(dark ? 20 : 13),
		'--input': mix(dark ? 22 : 15),
		'color-scheme': dark ? 'dark' : 'light'
	};
}

/** Inline-Style für das Element (leer = Theme) */
export function surfaceStyle(prefs: UserPrefs | null | undefined): string {
	const vars = surfaceVars(prefs);
	if (!vars) return '';
	return Object.entries(vars)
		.map(([k, v]) => `${k}: ${v}`)
		.concat(['background-color: var(--background)', 'color: var(--foreground)'])
		.join('; ');
}
