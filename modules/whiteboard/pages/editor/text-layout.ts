/**
 * Zeilenumbruch für Texte in Formen (rein; Messfunktion wird übergeben). Der Editor rendert Text als SVG-`<text>`
 * mit `<tspan>` je Zeile – so sieht der Bild-Export genauso aus wie die Ansicht (kein `foreignObject`).
 */
import type { FontFamily, TextAlign, VAlign } from '../../schemas';

export const FONT_FAMILY =
	"system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

/** Schriften je Auswahl – nur Systemschriften (keine Web-Fonts, CSP); Export nutzt dieselben */
export const FONT_STACKS: Record<FontFamily, string> = {
	sans: FONT_FAMILY,
	serif: "Georgia, Cambria, 'Times New Roman', Times, serif",
	mono: "ui-monospace, 'Cascadia Mono', 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
	hand: "'Segoe Print', 'Bradley Hand', 'Comic Sans MS', 'Chalkboard SE', 'Comic Neue', cursive"
};
export const LINE_HEIGHT = 1.25;
/** Kleinste Schrift beim automatischen Anpassen */
export const MIN_FIT_SIZE = 8;

export type Measure = (
	text: string,
	fontSize: number,
	bold: boolean,
	italic: boolean,
	family?: FontFamily
) => number;

/** Schätzung ohne DOM (Tests, Server): mittlere Zeichenbreite */
export const approxMeasure: Measure = (text, fontSize, bold, _italic, family) =>
	text.length * fontSize * (family === 'mono' ? 0.6 : bold ? 0.58 : 0.54);

let canvasMeasure: Measure | null = null;

/** Messung über ein Canvas im Browser (gleiche Schrift wie die Darstellung), sonst Schätzung */
export function browserMeasure(): Measure {
	if (canvasMeasure) return canvasMeasure;
	if (typeof document === 'undefined') return approxMeasure;
	const ctx = document.createElement('canvas').getContext('2d');
	if (!ctx) return approxMeasure;
	const cache = new Map<string, number>();
	canvasMeasure = (text, fontSize, bold, italic, family = 'sans') => {
		const key = `${family}|${fontSize}|${bold ? 1 : 0}|${italic ? 1 : 0}|${text}`;
		const hit = cache.get(key);
		if (hit !== undefined) return hit;
		ctx.font = `${italic ? 'italic ' : ''}${bold ? '700 ' : '400 '}${fontSize}px ${FONT_STACKS[family]}`;
		const w = ctx.measureText(text).width;
		if (cache.size > 5000) cache.clear();
		cache.set(key, w);
		return w;
	};
	return canvasMeasure;
}

/** Text in Zeilen umbrechen (Wörter; zu lange Wörter zeichenweise); harte Umbrüche bleiben */
export function wrapText(
	text: string,
	maxWidth: number,
	fontSize: number,
	opts: { bold?: boolean; italic?: boolean; family?: FontFamily; measure?: Measure } = {}
): string[] {
	const measure = opts.measure ?? approxMeasure;
	const bold = !!opts.bold;
	const italic = !!opts.italic;
	const family = opts.family ?? 'sans';
	const fits = (s: string) => measure(s, fontSize, bold, italic, family) <= maxWidth;
	const lines: string[] = [];
	for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
		if (!paragraph) {
			lines.push('');
			continue;
		}
		let line = '';
		for (const word of paragraph.split(/(\s+)/)) {
			if (!word) continue;
			const next = line + word;
			if (fits(next) || !line.trim()) {
				if (fits(next)) {
					line = next;
					continue;
				}
				// Wort allein zu lang: zeichenweise teilen
				let chunk = line;
				for (const ch of word) {
					if (fits(chunk + ch) || !chunk) chunk += ch;
					else {
						lines.push(chunk);
						chunk = ch;
					}
				}
				line = chunk;
				continue;
			}
			lines.push(line.trimEnd());
			line = word.trimStart();
			if (!fits(line)) {
				let chunk = '';
				for (const ch of line) {
					if (fits(chunk + ch) || !chunk) chunk += ch;
					else {
						lines.push(chunk);
						chunk = ch;
					}
				}
				line = chunk;
			}
		}
		lines.push(line.trimEnd());
	}
	return lines;
}

export interface TextLayout {
	lines: { text: string; x: number; y: number }[];
	anchor: 'start' | 'middle' | 'end';
	/** Text passt nicht ganz hinein (abgeschnitten) */
	overflow: boolean;
	/** Tatsächliche Schriftgröße (bei `autoFit` ggf. kleiner) */
	fontSize: number;
}

export interface TextStyle {
	fontSize: number;
	align: TextAlign;
	valign: VAlign;
	bold?: boolean;
	italic?: boolean;
	fontFamily?: FontFamily;
	/** Schrift verkleinern, bis alles hineinpasst */
	autoFit?: boolean;
}

const wrapFor = (text: string, width: number, size: number, style: TextStyle, measure?: Measure) =>
	wrapText(text, Math.max(1, width), size, { ...style, family: style.fontFamily, measure });

/** Größte Schrift ≤ `style.fontSize`, bei der der Text vollständig in den Bereich passt */
export function fitFontSize(
	text: string,
	area: { w: number; h: number },
	style: TextStyle,
	measure?: Measure
): number {
	const fits = (size: number) =>
		wrapFor(text, area.w, size, style, measure).length * size * LINE_HEIGHT <= area.h;
	if (fits(style.fontSize)) return style.fontSize;
	let lo = MIN_FIT_SIZE;
	let hi = style.fontSize;
	while (hi - lo > 0.5) {
		const mid = (lo + hi) / 2;
		if (fits(mid)) lo = mid;
		else hi = mid;
	}
	return Math.floor(lo * 2) / 2;
}

/** Benötigte Höhe des Texts in der Breite `width` (für Textfelder mit wachsender Höhe) */
export function textHeight(
	text: string,
	width: number,
	style: TextStyle,
	measure?: Measure
): number {
	const lines = Math.max(1, wrapFor(text || ' ', width, style.fontSize, style, measure).length);
	return Math.ceil(lines * style.fontSize * LINE_HEIGHT);
}

/**
 * Zeilen in einem Bereich anordnen. `y` ist die Grundlinie jeder Zeile. Zu viele Zeilen werden abgeschnitten
 * (die letzte sichtbare endet mit „…“).
 */
export function layoutText(
	text: string,
	area: { x: number; y: number; w: number; h: number },
	style: TextStyle,
	measure?: Measure
): TextLayout {
	const fontSize = style.autoFit ? fitFontSize(text, area, style, measure) : style.fontSize;
	const lineHeight = fontSize * LINE_HEIGHT;
	let lines = wrapFor(text, area.w, fontSize, style, measure);
	const max = Math.max(1, Math.floor(area.h / lineHeight));
	let overflow = false;
	if (lines.length > max) {
		overflow = true;
		lines = lines.slice(0, max);
		const last = lines[max - 1] ?? '';
		lines[max - 1] = `${last.replace(/\s*\S?$/, '')}…`;
	}
	const total = lines.length * lineHeight;
	const top =
		style.valign === 'top'
			? area.y
			: style.valign === 'bottom'
				? area.y + area.h - total
				: area.y + (area.h - total) / 2;
	const x =
		style.align === 'left'
			? area.x
			: style.align === 'right'
				? area.x + area.w
				: area.x + area.w / 2;
	return {
		lines: lines.map((t, i) => ({ text: t, x, y: top + i * lineHeight + fontSize * 0.95 })),
		anchor: style.align === 'left' ? 'start' : style.align === 'right' ? 'end' : 'middle',
		overflow,
		fontSize
	};
}
