/** Reine Namens-/Pfadhilfen des Moduls `files` (`names.ts`). */
import { describe, expect, it } from 'vitest';
import {
	displayPath,
	normalizeName,
	splitExtension,
	splitRelativePath,
	uniqueName
} from '$modules/files/names';
import { MAX_NAME } from '$modules/files/schemas';

const RLO = String.fromCodePoint(0x202e);
const ZWSP = String.fromCodePoint(0x200b);
const BOM = String.fromCodePoint(0xfeff);
const len = (s: string) => Array.from(s).length;

describe('normalizeName', () => {
	it('trimmt und fasst Leerraum zusammen', () => {
		expect(normalizeName('  Bericht   2026 .pdf  ')).toBe('Bericht 2026 .pdf');
		expect(normalizeName('a\t\tb\nc')).toBe('a b c');
		expect(normalizeName('   ')).toBe('');
	});

	it('normalisiert nach NFC', () => {
		const decomposed = 'Mu' + 'e' + String.fromCodePoint(0x0308) + 'll'; // „e“ + Trema
		const result = normalizeName('Gru' + String.fromCodePoint(0x0308) + 'n');
		expect(result).toBe('Grün');
		expect(result.length).toBe(4);
		expect(normalizeName(decomposed)).toBe('Mu' + String.fromCodePoint(0xeb) + 'll');
	});

	it('entfernt unsichtbare Zeichen (Bidi, Zero-Width, BOM)', () => {
		expect(normalizeName(`rechnung${RLO}fdp.exe`)).toBe('rechnungfdp.exe');
		expect(normalizeName(`a${ZWSP}b`)).toBe('ab');
		expect(normalizeName(`${BOM}datei.txt`)).toBe('datei.txt');
		expect(normalizeName(`${ZWSP}${BOM}`)).toBe('');
	});

	it('lässt Namen bis MAX_NAME unverändert', () => {
		const name = 'x'.repeat(MAX_NAME - 4) + '.pdf';
		expect(normalizeName(name)).toBe(name);
	});

	it('kürzt auf MAX_NAME und erhält die Endung', () => {
		const result = normalizeName('a'.repeat(300) + '.pdf');
		expect(len(result)).toBe(MAX_NAME);
		expect(result.endsWith('.pdf')).toBe(true);
	});

	it('kürzt ohne Endung einfach ab', () => {
		const result = normalizeName('b'.repeat(MAX_NAME + 1));
		expect(result).toBe('b'.repeat(MAX_NAME));
	});

	it('zerreißt beim Kürzen keine Emoji (Codepoints)', () => {
		const emoji = String.fromCodePoint(0x1f600);
		const result = normalizeName(emoji.repeat(MAX_NAME + 10) + '.png');
		expect(len(result)).toBe(MAX_NAME);
		expect(result.endsWith('.png')).toBe(true);
		expect(result).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
	});

	it('Leerzeichen an der Schnittstelle werden entfernt', () => {
		const base = 'a'.repeat(MAX_NAME - 5) + ' ' + 'b'.repeat(10);
		const result = normalizeName(base + '.pdf');
		expect(result.endsWith(' .pdf')).toBe(false);
		expect(result.endsWith('.pdf')).toBe(true);
	});
});

describe('splitExtension', () => {
	it('normale Endung', () => {
		expect(splitExtension('bild.jpg')).toEqual(['bild', '.jpg']);
		expect(splitExtension('bericht.final.pdf')).toEqual(['bericht.final', '.pdf']);
	});

	it('Punkt am Anfang oder Ende → keine Endung', () => {
		expect(splitExtension('.gitignore')).toEqual(['.gitignore', '']);
		expect(splitExtension('a.')).toEqual(['a.', '']);
	});

	it('ohne Punkt → keine Endung', () => {
		expect(splitExtension('Fotos')).toEqual(['Fotos', '']);
		expect(splitExtension('')).toEqual(['', '']);
	});

	it('Leerzeichen oder zu lang → keine Endung', () => {
		expect(splitExtension('Teil 1. Abschnitt')).toEqual(['Teil 1. Abschnitt', '']);
		expect(splitExtension('x.abcdefghijk')).toEqual(['x.abcdefghijk', '']);
		expect(splitExtension('x.abcdefghij')).toEqual(['x', '.abcdefghij']);
	});

	it('Umlaute in der Endung erlaubt', () => {
		expect(splitExtension('notiz.übung')).toEqual(['notiz', '.übung']);
	});
});

describe('uniqueName', () => {
	it('frei → unverändert, auch bei leerer Liste', () => {
		expect(uniqueName([], 'Bild.jpg')).toBe('Bild.jpg');
		expect(uniqueName(['Andere.jpg'], 'Bild.jpg')).toBe('Bild.jpg');
	});

	it('Vergleich ohne Groß/Klein', () => {
		expect(uniqueName(['BILD.JPG'], 'Bild.jpg')).toBe('Bild (2).jpg');
	});

	it('zählt weiter', () => {
		expect(uniqueName(['Bild.jpg', 'Bild (2).jpg'], 'Bild.jpg')).toBe('Bild (3).jpg');
		expect(uniqueName(['Bild.jpg', 'Bild (2).jpg'], 'Bild (2).jpg')).toBe('Bild (3).jpg');
		expect(uniqueName(['Bild (9).jpg'], 'Bild (9).jpg')).toBe('Bild (10).jpg');
	});

	it('Lücken werden übersprungen', () => {
		expect(
			uniqueName(['Bild.jpg', 'Bild (2).jpg', 'Bild (3).jpg', 'Bild (5).jpg'], 'Bild.jpg')
		).toBe('Bild (4).jpg');
	});

	it('Ordner ohne Endung', () => {
		expect(uniqueName(['Fotos'], 'Fotos')).toBe('Fotos (2)');
		expect(uniqueName(['.gitignore'], '.gitignore')).toBe('.gitignore (2)');
	});

	it('Länge bleibt ≤ MAX_NAME', () => {
		const wanted = 'x'.repeat(MAX_NAME - 4) + '.jpg';
		const result = uniqueName([wanted], wanted);
		expect(len(result)).toBe(MAX_NAME);
		expect(result.endsWith(' (2).jpg')).toBe(true);
		const next = uniqueName([wanted, result], wanted);
		expect(len(next)).toBeLessThanOrEqual(MAX_NAME);
		expect(next.endsWith(' (3).jpg')).toBe(true);
	});
});

describe('splitRelativePath', () => {
	it('zerlegt Ordner und Datei', () => {
		expect(splitRelativePath('Fotos/2026/bild.jpg')).toEqual({
			folders: ['Fotos', '2026'],
			file: 'bild.jpg'
		});
		expect(splitRelativePath('bild.jpg')).toEqual({ folders: [], file: 'bild.jpg' });
	});

	it('Backslash wie Schrägstrich', () => {
		expect(splitRelativePath('Fotos\\2026\\bild.jpg')).toEqual({
			folders: ['Fotos', '2026'],
			file: 'bild.jpg'
		});
	});

	it('entfernt leere Segmente, „.“ und „..“', () => {
		expect(splitRelativePath('/../Fotos//./2026/../bild.jpg')).toEqual({
			folders: ['Fotos', '2026'],
			file: 'bild.jpg'
		});
	});

	it('normalisiert Segmente', () => {
		expect(splitRelativePath(`  Fotos  /${RLO}bild.jpg`)).toEqual({
			folders: ['Fotos'],
			file: 'bild.jpg'
		});
	});

	it('Steuerzeichen → null', () => {
		expect(splitRelativePath('Fotos/bi' + String.fromCodePoint(0) + 'ld.jpg')).toBeNull();
		expect(splitRelativePath('Fotos\tbild.jpg')).toBeNull();
		expect(splitRelativePath('Fotos/bild' + String.fromCodePoint(0x7f) + '.jpg')).toBeNull();
	});

	it('ohne Dateinamen → null', () => {
		expect(splitRelativePath('')).toBeNull();
		expect(splitRelativePath('/')).toBeNull();
		expect(splitRelativePath('../..')).toBeNull();
		expect(splitRelativePath('./\\.')).toBeNull();
	});

	it('abschließender Schrägstrich: letztes Segment gilt als Datei (aktuelles Verhalten)', () => {
		// „Fotos/“ liefert keinen Ordner, sondern eine Datei „Fotos“ – siehe Bericht
		expect(splitRelativePath('Fotos/')).toEqual({ folders: [], file: 'Fotos' });
	});
});

describe('displayPath', () => {
	it('verbindet mit „ / “', () => {
		expect(displayPath(['Meine Dateien', 'Fotos'])).toBe('Meine Dateien / Fotos');
		expect(displayPath(['Stamm'])).toBe('Stamm');
		expect(displayPath([])).toBe('');
	});
});
