import { describe, expect, it } from 'vitest';
import { MarkdownManager } from '@tiptap/markdown';
import { prosemirrorJSONToYDoc, yDocToProsemirrorJSON } from '@tiptap/y-tiptap';
import * as Y from 'yjs';
import { noteExtensions, noteSchema } from '$modules/notes/doc/extensions';

const ASSET = '0b8f3c1e-7d2a-4f6b-9c1e-1234567890ab';
const BOARD = '9a7e6d5c-4b3a-4f2e-8d1c-abcdefabcdef';

describe('notes: Dokumentschema', () => {
	it('baut das Schema mit allen Knoten', () => {
		const schema = noteSchema();
		for (const n of ['heading', 'table', 'taskList', 'image', 'embed', 'codeBlock']) {
			expect(schema.nodes[n], n).toBeDefined();
		}
		for (const m of ['bold', 'italic', 'underline', 'strike', 'textStyle', 'highlight', 'link']) {
			expect(schema.marks[m], m).toBeDefined();
		}
	});

	it('Markdown-Rundreise mit Bild (Asset) und Einbettung', () => {
		const md = new MarkdownManager({ extensions: noteExtensions() });
		const source = [
			'# Titel',
			'',
			'Text mit **fett** und ~~weg~~',
			'',
			`![Zelt](asset:${ASSET})`,
			'',
			`:::embed {module="whiteboard" kind="board" refId="${BOARD}" height="500"} :::`,
			'',
			'Ende'
		].join('\n');
		const json = md.parse(source);
		const text = JSON.stringify(json);
		expect(text).toContain(ASSET);
		expect(text).toContain(BOARD);
		expect(text).toContain('"type":"embed"');
		const back = md.serialize(json);
		expect(back).toContain(`asset:${ASSET}`);
		expect(back).toContain(`refId="${BOARD}"`);
		expect(back).toContain('**fett**');
	});

	it('fremde Bildadressen werden nicht übernommen', () => {
		const md = new MarkdownManager({ extensions: noteExtensions() });
		const json = JSON.stringify(md.parse('![x](https://evil.example/a.png)'));
		expect(json).not.toContain('evil.example');
	});

	it('Yjs-Rundreise behält Inhalt', () => {
		const md = new MarkdownManager({ extensions: noteExtensions() });
		const json = md.parse('| A | B |\n|---|---|\n| 1 | 2 |\n\n- [x] erledigt');
		const doc = prosemirrorJSONToYDoc(noteSchema(), json, 'default');
		const copy = new Y.Doc();
		Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
		const back = md.serialize(yDocToProsemirrorJSON(copy, 'default'));
		expect(back).toContain('| A');
		expect(back).toContain('- [x] erledigt');
	});
});
