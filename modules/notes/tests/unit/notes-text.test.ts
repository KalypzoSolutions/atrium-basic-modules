import { describe, expect, it } from 'vitest';
import { assetIdsOf, embedsOf, excerptOf, plainTextOf } from '$modules/notes/doc/text';

const ASSET = '0b8f3c1e-7d2a-4f6b-9c1e-1234567890ab';
const BOARD = '9a7e6d5c-4b3a-4f2e-8d1c-abcdefabcdef';

const doc = {
	type: 'doc',
	content: [
		{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Packliste' }] },
		{
			type: 'paragraph',
			content: [
				{ type: 'text', text: 'Schlafsack' },
				{ type: 'hardBreak' },
				{ type: 'text', text: 'Isomatte', marks: [{ type: 'bold' }] }
			]
		},
		{ type: 'image', attrs: { assetId: ASSET, alt: 'Zelt' } },
		{ type: 'image', attrs: { assetId: ASSET } },
		{ type: 'image', attrs: { assetId: 'kein-uuid' } },
		{ type: 'embed', attrs: { module: 'whiteboard', kind: 'board', refId: BOARD, height: 480 } },
		{ type: 'embed', attrs: { module: 'whiteboard', kind: 'board', refId: 'x' } }
	]
};

describe('notes: Text aus dem Dokument', () => {
	it('Klartext mit Zeilenumbrüchen je Block', () => {
		expect(plainTextOf(doc)).toBe('Packliste\nSchlafsack\nIsomatte');
		expect(plainTextOf(doc, 5)).toBe('Packl');
		expect(plainTextOf(null)).toBe('');
	});

	it('Textanfang kürzt mit Auslassungszeichen', () => {
		expect(excerptOf('  a   b \n c ')).toBe('a b c');
		expect(excerptOf('x'.repeat(200), 10)).toBe(`${'x'.repeat(9)}…`);
	});

	it('Bilder und Einbettungen nur mit gültigen IDs, ohne Doppelte', () => {
		expect(assetIdsOf(doc)).toEqual([ASSET]);
		expect(embedsOf(doc)).toEqual([{ module: 'whiteboard', kind: 'board', refId: BOARD }]);
	});
});
