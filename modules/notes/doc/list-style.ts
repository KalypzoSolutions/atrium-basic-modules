/**
 * Nummerierungsarten geordneter Listen (Attribut `listStyle` am Knoten `orderedList`, Server UND Browser).
 *
 * `null` = Standard (1. 2. 3. auf jeder Ebene) bzw. – bei eingerückten Unterlisten – „wie die Oberliste“: eine
 * Unterliste ohne eigene Art übernimmt die Art der nächsten Oberliste. So bleibt die Gliederung beim Einrücken (Tab)
 * erhalten, ohne dass jede Unterliste ein Attribut braucht. Bei `classic` wechselt die Art je Ebene ab der Liste,
 * die die Art festlegt (1. → a. → i. → 1. …), bei `outline` tragen Unterpunkte die Nummern der Oberpunkte (1.2.3.).
 */

export const LIST_STYLES = [
	'decimal',
	'outline',
	'classic',
	'lower-alpha',
	'upper-alpha',
	'upper-roman',
	'lower-roman'
] as const;
export type ListStyle = (typeof LIST_STYLES)[number];

/** Auswahl in Werkzeugleiste und Slash-Menü (Beispiel = so sieht die Liste aus) */
export const LIST_STYLE_OPTIONS: readonly { value: ListStyle; label: string; example: string }[] = [
	{ value: 'decimal', label: 'Zahlen', example: '1. 2. 3.' },
	{ value: 'outline', label: 'Gliederung', example: '1. 1.1. 1.1.1.' },
	{ value: 'classic', label: 'Zahl, Buchstabe, römisch', example: '1. a. i.' },
	{ value: 'lower-alpha', label: 'Kleinbuchstaben', example: 'a) b) c)' },
	{ value: 'upper-alpha', label: 'Großbuchstaben', example: 'A. B. C.' },
	{ value: 'upper-roman', label: 'Römisch groß', example: 'I. II. III.' },
	{ value: 'lower-roman', label: 'Römisch klein', example: 'i. ii. iii.' }
];

export function isListStyle(v: unknown): v is ListStyle {
	return typeof v === 'string' && (LIST_STYLES as readonly string[]).includes(v);
}

/** `type`-Attribut aus eingefügtem HTML (Word, Webseiten) */
const HTML_TYPES: Record<string, ListStyle> = {
	'1': 'decimal',
	a: 'lower-alpha',
	A: 'upper-alpha',
	i: 'lower-roman',
	I: 'upper-roman'
};

/** Art aus HTML lesen (nur `data-list-style`; `type` liest Tiptap selbst ins Attribut `type`) */
export function listStyleFromHtml(el: {
	getAttribute(name: string): string | null;
}): ListStyle | null {
	const own = el.getAttribute('data-list-style');
	return isListStyle(own) ? own : null;
}

/**
 * Eigene Art einer Liste aus ihren Attributen: `listStyle`, sonst Tiptaps `type` (a, A, i, I – aus eingefügtem HTML
 * oder Markdown „a.“), sonst `null` (Standard bzw. wie die Oberliste).
 */
export function ownListStyle(attrs: Record<string, unknown> | null | undefined): ListStyle | null {
	if (isListStyle(attrs?.listStyle)) return attrs.listStyle;
	const type = attrs?.type;
	return typeof type === 'string' && type !== '1' ? (HTML_TYPES[type] ?? null) : null;
}

type Format = 'decimal' | 'lower-alpha' | 'upper-alpha' | 'lower-roman' | 'upper-roman';

/**
 * Wirksame Art einer Liste: eigene Art, sonst die der Oberliste. `depth` = Ebene ab der Liste, die die Art
 * festlegt (0 = diese Liste), für `classic`.
 */
export interface ListContext {
	style: ListStyle | null;
	depth: number;
	/** Nummern der Oberpunkte (für `outline`) */
	path: number[];
}

export const ROOT_LIST_CONTEXT: ListContext = { style: null, depth: 0, path: [] };

/**
 * Kontext einer Liste aus dem Kontext der Oberliste (`null` = oberste Liste), ihrer eigenen Art und der Nummer
 * des Oberpunkts, in dem sie steht.
 */
export function childListContext(
	parent: ListContext | null,
	own: unknown,
	parentItem = 0
): ListContext {
	const inherited = parent?.style ?? null;
	const style = isListStyle(own) ? own : inherited;
	if (!style) return ROOT_LIST_CONTEXT;
	// gleiche Art wie die Oberliste (geerbt oder erneut gesetzt) → Ebenen zählen weiter
	if (parent && inherited === style) {
		return {
			style,
			depth: parent.depth + 1,
			path: style === 'outline' ? [...parent.path, parentItem] : []
		};
	}
	return { style, depth: 0, path: [] };
}

function formatOf(ctx: ListContext): Format {
	switch (ctx.style) {
		case 'classic':
			return (['decimal', 'lower-alpha', 'lower-roman'] as const)[ctx.depth % 3]!;
		case 'lower-alpha':
		case 'upper-alpha':
		case 'lower-roman':
		case 'upper-roman':
			return ctx.style;
		default:
			return 'decimal';
	}
}

function alpha(n: number): string {
	let s = '';
	let v = Math.max(1, Math.floor(n));
	while (v > 0) {
		v -= 1;
		s = String.fromCharCode(97 + (v % 26)) + s;
		v = Math.floor(v / 26);
	}
	return s;
}

function roman(n: number): string {
	let v = Math.floor(n);
	if (v <= 0 || v >= 4000) return String(n);
	const table: [number, string][] = [
		[1000, 'm'],
		[900, 'cm'],
		[500, 'd'],
		[400, 'cd'],
		[100, 'c'],
		[90, 'xc'],
		[50, 'l'],
		[40, 'xl'],
		[10, 'x'],
		[9, 'ix'],
		[5, 'v'],
		[4, 'iv'],
		[1, 'i']
	];
	let s = '';
	for (const [value, sym] of table) {
		while (v >= value) {
			s += sym;
			v -= value;
		}
	}
	return s;
}

function formatNumber(n: number, format: Format): string {
	switch (format) {
		case 'lower-alpha':
			return alpha(n);
		case 'upper-alpha':
			return alpha(n).toUpperCase();
		case 'lower-roman':
			return roman(n);
		case 'upper-roman':
			return roman(n).toUpperCase();
		default:
			return String(n);
	}
}

/**
 * Sichtbare Nummer eines Listenpunkts (Export): `n` = Nummer in seiner Liste.
 * outline → „1.2.3.“, lower-alpha → „a)“, sonst Zahl/Buchstabe/römisch mit Punkt.
 */
export function listMarker(ctx: ListContext, n: number): string {
	if (ctx.style === 'outline') return `${[...ctx.path, n].join('.')}.`;
	const format = formatOf(ctx);
	const text = formatNumber(n, format);
	return ctx.style === 'lower-alpha' ? `${text})` : `${text}.`;
}

/** Word-Zahlenformat der Ebene `level` (ab der Liste, die die Art festlegt) */
export function wordFormat(style: ListStyle | null, level: number): Format {
	return formatOf({ style, depth: level, path: [] });
}

/** Startnummer einer Liste (Attribut `start`, ungültig → 1) */
export function listStart(v: unknown): number {
	const n = Math.round(Number(v));
	return Number.isFinite(n) && n >= 1 && n < 1_000_000 ? n : 1;
}
