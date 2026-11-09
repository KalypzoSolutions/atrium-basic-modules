/**
 * Nummerierungsarten geordneter Listen: Marker, Vererbung an Unterlisten, Schema-Attribut, HTML- und Word-Export.
 */
import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import {
	childListContext,
	listMarker,
	ownListStyle,
	ROOT_LIST_CONTEXT
} from '$modules/notes/doc/list-style';
import { noteSchema } from '$modules/notes/doc/extensions';
import { exportDocx } from '$modules/notes/export/docx';
import { nodeHtml } from '$modules/notes/export/html';
import type { PmNode } from '$modules/notes/doc/text';

const p = (text: string): PmNode => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const li = (text: string, ...nested: PmNode[]): PmNode => ({
	type: 'listItem',
	content: [p(text), ...nested]
});
const ol = (attrs: Record<string, unknown>, ...items: PmNode[]): PmNode => ({
	type: 'orderedList',
	attrs: { start: 1, type: null, listStyle: null, ...attrs },
	content: items
});

/** Gliederung: 1. A / 1.1. A1 / 1.1.1. A1a / 1.2. A2 / 2. B */
const outline = ol(
	{ listStyle: 'outline' },
	li('A', ol({}, li('A1', ol({}, li('A1a'))), li('A2'))),
	li('B')
);

describe('notes-list-style: Marker', () => {
	it('Zahlen, Buchstaben, römisch', () => {
		const ctx = (style: string) => childListContext(null, style);
		expect(listMarker(ctx('decimal'), 3)).toBe('3.');
		expect(listMarker(ctx('lower-alpha'), 1)).toBe('a)');
		expect(listMarker(ctx('lower-alpha'), 27)).toBe('aa)');
		expect(listMarker(ctx('upper-alpha'), 2)).toBe('B.');
		expect(listMarker(ctx('upper-roman'), 14)).toBe('XIV.');
		expect(listMarker(ctx('lower-roman'), 4)).toBe('iv.');
		expect(listMarker(ROOT_LIST_CONTEXT, 7)).toBe('7.');
	});

	it('Gliederung und klassisch erben über die Ebenen', () => {
		const top = childListContext(null, 'outline');
		const sub = childListContext(top, null, 2);
		const subsub = childListContext(sub, null, 3);
		expect(listMarker(subsub, 1)).toBe('2.3.1.');
		const c0 = childListContext(null, 'classic');
		const c1 = childListContext(c0, null, 1);
		const c2 = childListContext(c1, null, 1);
		const c3 = childListContext(c2, null, 1);
		expect([c0, c1, c2, c3].map((c) => listMarker(c, 2))).toEqual(['2.', 'b.', 'ii.', '2.']);
	});

	it('eigene Art einer Unterliste beginnt neu', () => {
		const top = childListContext(null, 'outline');
		const own = childListContext(top, 'upper-roman', 1);
		expect(listMarker(own, 1)).toBe('I.');
		expect(listMarker(childListContext(own, null, 1), 2)).toBe('II.');
	});

	it('Tiptap-`type` gilt als Art, `listStyle` geht vor', () => {
		expect(ownListStyle({ type: 'a' })).toBe('lower-alpha');
		expect(ownListStyle({ type: 'I' })).toBe('upper-roman');
		expect(ownListStyle({ type: '1' })).toBeNull();
		expect(ownListStyle({ type: 'a', listStyle: 'outline' })).toBe('outline');
		expect(ownListStyle({ listStyle: 'kaputt' })).toBeNull();
	});
});

describe('notes-list-style: Schema', () => {
	it('Attribut `listStyle` bleibt erhalten und wird als data-list-style gerendert', () => {
		const node = noteSchema().nodeFromJSON({ type: 'doc', content: [outline] });
		node.check();
		const json = node.toJSON() as { content: { attrs: Record<string, unknown> }[] };
		expect(json.content[0]!.attrs.listStyle).toBe('outline');
		const spec = noteSchema().nodes.orderedList!.spec.toDOM!(
			node.firstChild!
		) as unknown as unknown[];
		expect(spec[1]).toMatchObject({ 'data-list-style': 'outline' });
	});
});

describe('notes-list-style: Export', () => {
	it('HTML: ausgeschriebene Nummern, Standardliste bleibt <ol>', () => {
		const html = nodeHtml({ type: 'doc', content: [outline] });
		for (const m of ['>1.<', '>1.1.<', '>1.1.1.<', '>1.2.<', '>2.<'])
			expect(html).toContain(`<span>${m.slice(1, -1)}</span>`);
		expect(html).not.toContain('<ol');
		const plain = nodeHtml({ type: 'doc', content: [ol({ start: 3 }, li('x'))] });
		expect(plain).toContain('<ol start="3">');
		const alpha = nodeHtml({
			type: 'doc',
			content: [ol({ listStyle: 'lower-alpha' }, li('x'), li('y'))]
		});
		expect(alpha).toContain('<span>b)</span>');
	});

	it('Word: Nummern als Text', async () => {
		const bytes = await exportDocx([{ title: 'Liste', json: { type: 'doc', content: [outline] } }]);
		const xml = strFromU8(unzipSync(bytes)['word/document.xml']!);
		for (const m of ['1.', '1.1.', '1.1.1.', '1.2.', '2.']) expect(xml).toContain(`>${m}<`);
	});
});
