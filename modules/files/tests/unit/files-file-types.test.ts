/**
 * Dateityp für die Anzeige (`files/pages/file-types.ts`): Art über Content-Type, Rückfall über die Endung,
 * Kürzel für das Abzeichen.
 */
import { describe, expect, it } from 'vitest';
import {
	FILE_KIND_CLASSES,
	FILE_KIND_ICONS,
	FILE_KINDS,
	fileTint,
	fileTypeOf
} from '$modules/files/pages/file-types';

describe('fileTypeOf', () => {
	it.each([
		['application/pdf', 'a.pdf', 'pdf', 'PDF'],
		[
			'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
			'a.docx',
			'word',
			'DOCX'
		],
		['application/vnd.ms-excel', 'a.xls', 'sheet', 'XLS'],
		['text/csv', 'liste.csv', 'sheet', 'CSV'],
		['application/vnd.oasis.opendocument.presentation', 'a.odp', 'slides', 'ODP'],
		['image/jpeg', 'foto.jpeg', 'image', 'JPEG'],
		['application/zip', 'a.zip', 'archive', 'ZIP'],
		['text/plain', 'notiz.txt', 'text', 'TXT'],
		['application/json', 'daten.json', 'code', 'JSON'],
		['audio/mpeg', 'lied.mp3', 'audio', 'MP3'],
		['video/mp4', 'film.mp4', 'video', 'MP4']
	])('%s → %s', (type, name, kind, badge) => {
		expect(fileTypeOf(type, name)).toMatchObject({ kind, badge });
	});

	it('erkennt über die Endung, wenn der Browser keinen Typ geschickt hat', () => {
		expect(fileTypeOf('application/octet-stream', 'Plan.DOCX').kind).toBe('word');
		expect(fileTypeOf(null, 'Kalkulation.xlsx').kind).toBe('sheet');
		expect(fileTypeOf('', 'Folien.pptx').kind).toBe('slides');
	});

	it('Content-Type schlägt die Endung, Parameter werden ignoriert', () => {
		expect(fileTypeOf('application/pdf; charset=binary', 'falsch.docx').kind).toBe('pdf');
	});

	it('unbekannt → Datei; lange oder fehlende Endung ohne Kürzel', () => {
		expect(fileTypeOf('application/octet-stream', 'README')).toEqual({
			kind: 'other',
			badge: '',
			label: 'Datei'
		});
		expect(fileTypeOf('application/x-foo', 'datei.verylong').badge).toBe('');
		expect(fileTypeOf('application/pdf', 'ohne-endung').badge).toBe('PDF');
	});

	it('jede Art hat Symbol und Farbklassen; Tönung passt zur Art', () => {
		for (const k of FILE_KINDS) {
			expect(FILE_KIND_ICONS[k]).toBeTruthy();
			expect(FILE_KIND_CLASSES[k].text).toMatch(/^text-/);
		}
		expect(fileTint('application/pdf', 'a.pdf')).toBe('bg-file-pdf-muted');
		expect(fileTint(null, 'x')).toBe('bg-muted/50');
	});
});
