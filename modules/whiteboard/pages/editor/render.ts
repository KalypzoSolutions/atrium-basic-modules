/**
 * Hilfen für die Darstellung (rein): Farbpalette (hell/dunkel, aus dem Theme), Kontrastfarbe, Datei-Adressen,
 * Dateigröße, Symbol je Dateityp/Karte.
 *
 * Die Fläche folgt Dunkelmodus und persönlichem Theme: die Palette kommt zur Laufzeit aus den Design-Tokens
 * (`readPalette`). SVG-Attribute lösen keine CSS-Variablen auf, deshalb werden die Werte gelesen und als Farben
 * eingesetzt. Gespeicherte Standard-„Tinte“ (fast Schwarz) wird im Dunkelmodus hell gezeichnet (`ink`), Nutzerfarben
 * bleiben unverändert. Der Export nutzt immer `LIGHT` (druckbar, unabhängig vom Gerät).
 */
import type { RefType } from '../../schemas';
import { API_BASE } from '../../schemas';

export interface Palette {
	dark: boolean;
	/** Fläche (Export, Verbinder-Beschriftung); auf dem Bildschirm scheint der Seitenhintergrund durch */
	paper: string;
	/** Raster/Punkte */
	pattern: string;
	ink: string;
	muted: string;
	card: string;
	cardBorder: string;
	/** Platzhalterfläche (fehlendes Bild, Kartenbild lädt) */
	placeholder: string;
}

export const LIGHT: Palette = {
	dark: false,
	paper: '#ffffff',
	pattern: '#cbd5e1',
	ink: '#1f2937',
	muted: '#64748b',
	card: '#ffffff',
	cardBorder: '#cbd5e1',
	placeholder: '#f1f5f9'
};

export const SELECTION = '#2563eb';
/** Standard-Tinte für neue Linien/Striche (wird im Dunkelmodus hell gezeichnet) */
export const DEFAULT_INK = LIGHT.ink;

/** Fast schwarze Farben gelten als „Tinte“ und passen sich dem Modus an */
const INK_COLORS = new Set(['#1f2937', '#000000', '#111827', '#212121', '#0f172a']);

/** Farbe einer Linie/eines Strichs für die Darstellung (Tinte folgt dem Modus) */
export function ink(color: string, palette: Palette): string {
	return palette.dark && INK_COLORS.has(color.toLowerCase()) ? palette.ink : color;
}

/** Palette aus den aktuellen Design-Tokens (Browser); ohne DOM `LIGHT` */
export function readPalette(): Palette {
	if (typeof document === 'undefined') return LIGHT;
	const root = document.documentElement;
	const css = getComputedStyle(root);
	const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
	const dark = root.classList.contains('dark');
	return {
		dark,
		paper: v('--background', LIGHT.paper),
		pattern: dark
			? `color-mix(in oklch, ${v('--muted-foreground', '#94a3b8')} 45%, transparent)`
			: v('--border', LIGHT.pattern),
		ink: v('--foreground', LIGHT.ink),
		muted: v('--muted-foreground', LIGHT.muted),
		card: v('--card', LIGHT.card),
		cardBorder: v('--border', LIGHT.cardBorder),
		placeholder: v('--muted', LIGHT.placeholder)
	};
}

/** Relative Helligkeit einer `#rrggbb`-Farbe (0 = schwarz, 1 = weiß) */
export function luminance(hex: string): number {
	if (!/^#[0-9a-f]{6}$/i.test(hex)) return 1;
	const n = parseInt(hex.slice(1), 16);
	const lin = (c: number) => {
		const v = c / 255;
		return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

/**
 * Feste Fläche (persönliche Einstellung „Feste Farbe“): Palette nur aus `color`, unabhängig von Modus und Theme.
 * Dunkle Flächen bekommen helle Tinte und dunkle Karten, helle Flächen die helle Standard-Palette.
 */
export function fixedPalette(color: string): Palette {
	const dark = luminance(color) < 0.18;
	if (!dark) return { ...LIGHT, paper: color };
	return {
		dark: true,
		paper: color,
		pattern: 'rgba(255, 255, 255, 0.16)',
		ink: '#f1f5f9',
		muted: '#94a3b8',
		card: '#1e293b',
		cardBorder: '#334155',
		placeholder: '#1e293b'
	};
}

/** Gut lesbare Schriftfarbe auf `fill` (dunkel auf hell, hell auf dunkel); ohne Füllung = Tinte des Modus */
export function textOn(fill: string | null | undefined, palette: Palette = LIGHT): string {
	if (!fill || fill === 'transparent' || !/^#[0-9a-f]{6}$/i.test(fill)) return palette.ink;
	const INK = LIGHT.ink;
	const n = parseInt(fill.slice(1), 16);
	const lin = (c: number) => {
		const v = c / 255;
		return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	};
	const l = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
	return l > 0.35 ? INK : '#ffffff';
}

export function assetUrl(
	boardId: string,
	assetId: string,
	variant: 'thumb' | 'web' | 'file'
): string {
	return `${API_BASE}/boards/${encodeURIComponent(boardId)}/assets/${encodeURIComponent(assetId)}/${variant}`;
}

export function formatBytes(bytes: number | null | undefined): string {
	const n = bytes && bytes > 0 ? bytes : 0;
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
	return `${(n / 1024 / 1024).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB`;
}

/** Art einer Datei für Symbol und Farbe */
export type FileKind = 'pdf' | 'doc' | 'sheet' | 'slides' | 'image' | 'archive' | 'text' | 'other';

export function fileKind(contentType: string, name = ''): FileKind {
	const t = contentType.toLowerCase();
	const ext = name.split('.').pop()?.toLowerCase() ?? '';
	if (t === 'application/pdf' || ext === 'pdf') return 'pdf';
	if (t.startsWith('image/')) return 'image';
	if (/word|opendocument\.text|rtf/.test(t) || ['doc', 'docx', 'odt', 'rtf'].includes(ext))
		return 'doc';
	if (/sheet|excel|csv/.test(t) || ['xls', 'xlsx', 'ods', 'csv'].includes(ext)) return 'sheet';
	if (/presentation|powerpoint/.test(t) || ['ppt', 'pptx', 'odp'].includes(ext)) return 'slides';
	if (/zip|compressed|tar/.test(t) || ['zip', '7z', 'tar', 'gz'].includes(ext)) return 'archive';
	if (t.startsWith('text/') || ['txt', 'md', 'json'].includes(ext)) return 'text';
	return 'other';
}

/** Farbe je Dateiart (feste Werte, Papier ist immer hell) */
export const FILE_COLORS: Record<FileKind, string> = {
	pdf: '#dc2626',
	doc: '#2563eb',
	sheet: '#16a34a',
	slides: '#ea580c',
	image: '#7c3aed',
	archive: '#b45309',
	text: '#475569',
	other: '#64748b'
};

export const REF_COLORS: Record<RefType, string> = {
	action: '#0d9488',
	task: '#2563eb',
	taskboard: '#2563eb',
	event: '#d97706',
	gallery: '#7c3aed',
	file: '#475569',
	whiteboard: '#db2777',
	note: '#ca8a04'
};

/** Endung für das Kürzel auf Datei-Karten („PDF“, „DOCX“) */
export function extensionLabel(name: string): string {
	const ext = name.includes('.') ? name.split('.').pop() : '';
	return (ext ?? '').slice(0, 5).toUpperCase();
}

export function hostOf(url: string): string {
	if (url.startsWith('/')) return 'Intern';
	if (url.startsWith('mailto:')) return url.slice(7);
	try {
		return new URL(url).hostname.replace(/^www\./, '');
	} catch {
		return url;
	}
}
