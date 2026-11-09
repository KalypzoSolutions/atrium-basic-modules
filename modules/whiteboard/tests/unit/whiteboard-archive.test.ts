/**
 * Modul `whiteboard` – Export-Archiv (`.epwhiteboard`): Rundlauf, Pfadprüfung (Zip-Slip, unerwartete Dateien),
 * Format/Version, ungültiges ZIP, Dateinamen.
 */
import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import {
	ArchiveError,
	assertSafeArchivePath,
	buildArchive,
	fileSlug,
	parseArchive,
	type ArchiveDocument
} from '$modules/whiteboard/archive';

const assetId = crypto.randomUUID();
const doc: ArchiveDocument = {
	format: 'ep-whiteboard',
	version: 1,
	exportedAt: '2026-10-26T10:00:00.000Z',
	board: { name: 'Programm', description: null, color: '#16a34a', background: 'grid' },
	elements: [
		{
			id: crypto.randomUUID(),
			type: 'shape',
			data: { kind: 'note', x: 0, y: 0, w: 10, h: 10 },
			z: 1
		},
		{ id: crypto.randomUUID(), type: 'image', data: { x: 0, y: 0, w: 10, h: 10, assetId }, z: 2 }
	],
	assets: [{ id: assetId, kind: 'image', name: 'karte.webp', contentType: 'image/webp' }]
};

describe('Whiteboard-Archiv', () => {
	it('Rundlauf mit Dateien', () => {
		const bytes = buildArchive(doc, new Map([[assetId, new Uint8Array([1, 2, 3])]]));
		const parsed = parseArchive(bytes);
		expect(parsed.doc).toEqual(doc);
		expect([...parsed.files.get(assetId)!]).toEqual([1, 2, 3]);
	});

	it('weist unerwartete und gefährliche Pfade ab', () => {
		for (const bad of [
			'../board.json',
			'/board.json',
			'assets/../../x',
			'assets/abc',
			'evil.sh',
			'a\\b',
			'C:x'
		]) {
			expect(() => assertSafeArchivePath(bad), bad).toThrow(ArchiveError);
		}
		expect(() => assertSafeArchivePath(`assets/${assetId}`)).not.toThrow();
		const evil = zipSync({ 'board.json': strToU8(JSON.stringify(doc)), '../x': strToU8('x') });
		expect(() => parseArchive(evil)).toThrow(ArchiveError);
	});

	it('prüft Format, Version und Inhalt', () => {
		const wrong = zipSync({ 'board.json': strToU8(JSON.stringify({ ...doc, format: 'anders' })) });
		expect(() => parseArchive(wrong)).toThrow(/kein gültiges Whiteboard/);
		const v2 = zipSync({ 'board.json': strToU8(JSON.stringify({ ...doc, version: 2 })) });
		expect(() => parseArchive(v2)).toThrow(ArchiveError);
		const noJson = zipSync({ [`assets/${assetId}`]: new Uint8Array([1]) });
		expect(() => parseArchive(noJson)).toThrow(/board.json fehlt/);
		const broken = zipSync({ 'board.json': strToU8('{kein json') });
		expect(() => parseArchive(broken)).toThrow(/kein gültiges JSON/);
		expect(() => parseArchive(new Uint8Array([1, 2, 3]))).toThrow(ArchiveError);
	});

	it('Dateiname ohne Sonderzeichen', () => {
		expect(fileSlug('Sommerlager – Programmideen')).toBe('sommerlager-programmideen');
		expect(fileSlug('Größe & Übung')).toBe('groesse-uebung');
		expect(fileSlug('!!!')).toBe('whiteboard');
	});
});
