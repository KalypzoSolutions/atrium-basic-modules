/**
 * Reine Hilfen für Namen und Pfade (ohne Server-/Svelte-Imports, in Tests und UI nutzbar).
 * VERTRAG (Welle 0) – Implementierung: Welle 1.3. Signaturen nicht ändern.
 */
import { INVISIBLE_CHARS, MAX_NAME } from './schemas';

/** Unsichtbare Zeichen (Bidi, Zero-Width, BOM) – global zum Entfernen */
const INVISIBLE_ALL_RE = new RegExp(INVISIBLE_CHARS.source, 'gu');

/** Endung: Punkt + 1–10 Buchstaben/Ziffern (z. B. „.pdf“, „.tar“), kein Leerzeichen */
const EXTENSION_RE = /^\.[\p{L}\p{N}]{1,10}$/u;
/** Vorhandenes Zähler-Suffix „ (n)“ am Ende der Basis */
const COUNTER_RE = /^(.*) \((\d{1,6})\)$/su;
/** Steuerzeichen (wie in `nodeName`) */
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/** Auf `max` Zeichen (Codepoints) kürzen, ohne Surrogatpaare zu zerreißen */
function cut(s: string, max: number): string {
	const chars = Array.from(s);
	return chars.length <= max ? s : chars.slice(0, Math.max(0, max)).join('');
}

const length = (s: string) => Array.from(s).length;

/** `base` so kürzen, dass `base + suffix` höchstens `MAX_NAME` Zeichen hat */
function fit(base: string, suffix: string): string {
	const room = MAX_NAME - length(suffix);
	if (room <= 0) return cut(base + suffix, MAX_NAME);
	return cut(base, room).trimEnd() + suffix;
}

/** Name normalisieren: unsichtbare Zeichen entfernen, NFC, Mehrfach-Leerzeichen zu einem, trimmen, auf `MAX_NAME` kürzen (Endung erhalten) */
export function normalizeName(name: string): string {
	const clean = name.normalize('NFC').replace(INVISIBLE_ALL_RE, '').replace(/\s+/gu, ' ').trim();
	if (length(clean) <= MAX_NAME) return clean;
	const [base, ext] = splitExtension(clean);
	return fit(base, ext).trim();
}

/** Basis und Endung: „bericht.final.pdf“ → [„bericht.final“, „.pdf“]; Ordner/ohne Punkt → [name, ''] */
export function splitExtension(name: string): [string, string] {
	const dot = name.lastIndexOf('.');
	// kein Punkt, Punkt am Anfang („.gitignore“) oder am Ende → keine Endung
	if (dot <= 0 || dot === name.length - 1) return [name, ''];
	const ext = name.slice(dot);
	if (!EXTENSION_RE.test(ext)) return [name, ''];
	return [name.slice(0, dot), ext];
}

/**
 * Freier Name ohne Konflikt (Vergleich ohne Groß/Klein): „Bild.jpg“ → „Bild (2).jpg“ → „Bild (3).jpg“;
 * „Bild (2).jpg“ wird zu „Bild (3).jpg“ weitergezählt.
 */
export function uniqueName(existing: readonly string[], wanted: string): string {
	const taken = new Set(existing.map((n) => n.toLowerCase()));
	if (!taken.has(wanted.toLowerCase())) return wanted;
	const [base, ext] = splitExtension(wanted);
	const match = COUNTER_RE.exec(base);
	const stem = match ? match[1]! : base;
	let n = match ? Number(match[2]) + 1 : 2;
	for (; ; n++) {
		const candidate = fit(stem, ` (${n})${ext}`);
		if (!taken.has(candidate.toLowerCase())) return candidate;
	}
}

/**
 * Relativen Upload-Pfad zerlegen: „Fotos/2026/bild.jpg“ → { folders: ['Fotos','2026'], file: 'bild.jpg' }.
 * Leere Segmente, „.“, „..“ und Backslashes werden entfernt bzw. als `/` behandelt; `null` bei ungültigem Pfad.
 */
export function splitRelativePath(path: string): { folders: string[]; file: string } | null {
	if (CONTROL_RE.test(path)) return null;
	const parts = path
		.replace(/\\/g, '/')
		.split('/')
		.map((p) => normalizeName(p))
		.filter((p) => p !== '' && p !== '.' && p !== '..');
	const file = parts.pop();
	if (!file) return null;
	return { folders: parts, file };
}

/** Pfad zur Anzeige: [„Meine Dateien“, „Fotos“] → „Meine Dateien / Fotos“ */
export function displayPath(parts: readonly string[]): string {
	return parts.join(' / ');
}
