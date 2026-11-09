/** UI-Hilfen des Moduls `files` (`pages/helpers.ts`). */
import { describe, expect, it } from 'vitest';
import {
	breakableName,
	compareNodes,
	folderMeta,
	formatBytes,
	iconFor,
	previewKind
} from '$modules/files/pages/helpers';

describe('previewKind', () => {
	it('Bilder, PDF, Text', () => {
		expect(previewKind('image/jpeg')).toBe('image');
		expect(previewKind('IMAGE/PNG')).toBe('image');
		expect(previewKind('image/avif')).toBe('image');
		expect(previewKind('application/pdf')).toBe('pdf');
		expect(previewKind('text/plain; charset=utf-8')).toBe('text');
		expect(previewKind('application/json')).toBe('text');
		expect(previewKind('text/csv')).toBe('text');
	});

	it('aktive oder unbekannte Inhalte ohne Vorschau', () => {
		expect(previewKind('image/svg+xml')).toBeNull();
		expect(previewKind('text/html')).toBeNull();
		expect(previewKind('application/zip')).toBeNull();
		expect(previewKind('')).toBeNull();
		expect(previewKind(null)).toBeNull();
		expect(previewKind(undefined)).toBeNull();
	});
});

describe('formatBytes', () => {
	it('Bytes', () => {
		expect(formatBytes(0)).toBe('0 B');
		expect(formatBytes(1)).toBe('1 B');
		expect(formatBytes(1023)).toBe('1023 B');
	});

	it('Einheiten (Basis 1024, de-DE)', () => {
		expect(formatBytes(1024)).toBe('1 KB');
		expect(formatBytes(1536)).toBe('1,5 KB');
		expect(formatBytes(1.5 * 1024 * 1024)).toBe('1,5 MB');
		expect(formatBytes(15 * 1024 * 1024)).toBe('15 MB');
		expect(formatBytes(1024 ** 3)).toBe('1 GB');
		expect(formatBytes(2 * 1024 ** 4)).toBe('2 TB');
	});

	it('ungültige Werte → „0 B“', () => {
		expect(formatBytes(NaN)).toBe('0 B');
		expect(formatBytes(-5)).toBe('0 B');
		expect(formatBytes(Infinity)).toBe('0 B');
		expect(formatBytes(null)).toBe('0 B');
		expect(formatBytes(undefined)).toBe('0 B');
	});
});

describe('compareNodes', () => {
	const f = (name: string) => ({ kind: 'file' as const, name });
	const d = (name: string) => ({ kind: 'folder' as const, name });
	const sort = (list: { kind: 'file' | 'folder'; name: string }[]) =>
		[...list].sort(compareNodes).map((n) => n.name);

	it('Ordner zuerst', () => {
		expect(compareNodes(d('Z'), f('A'))).toBeLessThan(0);
		expect(compareNodes(f('A'), d('Z'))).toBeGreaterThan(0);
		expect(sort([f('a.txt'), d('Zelt'), f('b.txt'), d('Abc')])).toEqual([
			'Abc',
			'Zelt',
			'a.txt',
			'b.txt'
		]);
	});

	it('natürliche Zahlen', () => {
		expect(compareNodes(f('Bild 2'), f('Bild 10'))).toBeLessThan(0);
		expect(sort([f('Bild 10'), f('Bild 2'), f('Bild 1')])).toEqual(['Bild 1', 'Bild 2', 'Bild 10']);
	});

	it('ohne Groß/Klein, Umlaute deutsch', () => {
		expect(compareNodes(f('apfel'), f('Apfel'))).toBe(0);
		expect(compareNodes(f('Ärger'), f('Zelt'))).toBeLessThan(0);
		expect(sort([f('Zelt'), f('Öl'), f('Ofen'), f('Apfel')])).toEqual([
			'Apfel',
			'Ofen',
			'Öl',
			'Zelt'
		]);
	});
});

describe('iconFor', () => {
	it('unterschiedliche Icons für Ordner, Bild, PDF, unbekannt', () => {
		const folder = iconFor('folder', null);
		const image = iconFor('file', 'image/png');
		const pdf = iconFor('file', 'application/pdf');
		const other = iconFor('file', 'application/octet-stream');
		expect(new Set([folder, image, pdf, other]).size).toBe(4);
		expect(iconFor('folder', 'image/png')).toBe(folder);
		expect(iconFor('file', null)).toBe(other);
	});

	it('Tabellen, Präsentationen, Archive', () => {
		const sheet = iconFor(
			'file',
			'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
		);
		const pres = iconFor(
			'file',
			'application/vnd.openxmlformats-officedocument.presentationml.presentation'
		);
		const zip = iconFor('file', 'application/zip');
		const other = iconFor('file', 'application/octet-stream');
		expect(new Set([sheet, pres, zip, other]).size).toBe(4);
		expect(iconFor('file', 'application/vnd.ms-excel')).toBe(sheet);
	});

	it('Vorlagen und OpenDocument wie die Dokumentart', () => {
		const text = iconFor(
			'file',
			'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
		);
		const sheet = iconFor('file', 'application/vnd.ms-excel');
		const pres = iconFor('file', 'application/vnd.ms-powerpoint');
		expect(
			iconFor('file', 'application/vnd.openxmlformats-officedocument.wordprocessingml.template')
		).toBe(text);
		expect(iconFor('file', 'application/rtf')).toBe(text);
		expect(iconFor('file', 'application/vnd.oasis.opendocument.text-template')).toBe(text);
		expect(
			iconFor('file', 'application/vnd.openxmlformats-officedocument.spreadsheetml.template')
		).toBe(sheet);
		expect(iconFor('file', 'application/vnd.oasis.opendocument.spreadsheet')).toBe(sheet);
		expect(
			iconFor('file', 'application/vnd.openxmlformats-officedocument.presentationml.template')
		).toBe(pres);
		expect(iconFor('file', 'application/vnd.oasis.opendocument.presentation-template')).toBe(pres);
	});
});

describe('breakableName', () => {
	it('trennt nach _ - . und vor Ziffern, Text bleibt vollständig', () => {
		const parts = breakableName('Einladung_Stammesthing_EP_2026_v2.pdf');
		expect(parts.join('')).toBe('Einladung_Stammesthing_EP_2026_v2.pdf');
		expect(parts).toEqual(['Einladung_', 'Stammesthing_', 'EP_', '2026_', 'v', '2.', 'pdf']);
		expect(breakableName('Protokoll 2025')).toEqual(['Protokoll 2025']);
		expect(breakableName('a-b')).toEqual(['a-', 'b']);
		expect(breakableName('')).toEqual([]);
	});
});

describe('folderMeta', () => {
	it('leer, Einzahl, Mehrzahl mit Größe', () => {
		expect(folderMeta({ childCount: 0, folderBytes: 0 })).toBe('Leer');
		expect(folderMeta({ childCount: 1, folderBytes: 0 })).toBe('1 Eintrag');
		expect(folderMeta({ childCount: 12, folderBytes: 4.1 * 1024 * 1024 })).toBe(
			'12 Einträge · 4,1 MB'
		);
		expect(folderMeta({ childCount: null, folderBytes: null })).toBe('Leer');
	});
});
