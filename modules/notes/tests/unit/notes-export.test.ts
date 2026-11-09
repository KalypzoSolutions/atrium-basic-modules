/**
 * Notizen-Export (rein): HTML-Serialisierer (Escaping, Allowlist), Markdown (Bilder/Einbettungen, ZIP-Struktur),
 * Word (gültiges ZIP mit `word/document.xml`), Import-Hilfen (Titel, relative Pfade, ZIP-Grenzen).
 */
import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync, zipSync } from 'fflate';
import { exportDocx, hexColor } from '$modules/notes/export/docx';
import { nodeHtml, htmlDocument, pagesFragment } from '$modules/notes/export/html';
import {
	exportMarkdown,
	exportMarkdownFiles,
	parseMarkdown,
	resolveRelative,
	rewriteImageRefs,
	takeTitle
} from '$modules/notes/export/markdown';
import { readZip, ZipError } from '$modules/notes/export/zip';
import type { ResolvedEmbed } from '$modules/notes/export/embeds';

const ASSET = '0b8f3c1e-7d2a-4f6b-9c1e-1234567890ab';
const FOREIGN = '1b8f3c1e-7d2a-4f6b-9c1e-1234567890ab';
const BOARD = '9a7e6d5c-4b3a-4f2e-8d1c-abcdefabcdef';

const p = (...content: unknown[]) => ({ type: 'paragraph', content });
const t = (text: string, marks?: unknown[]) => ({
	type: 'text',
	text,
	...(marks ? { marks } : {})
});
const doc = (...content: unknown[]) => ({ type: 'doc', content });

describe('notes-export: HTML', () => {
	it('escapt Text und verwirft unbekannte Knoten', () => {
		const html = nodeHtml(
			doc(p(t('<script>alert(1)</script> & "x"')), { type: 'iframe', attrs: { src: 'x' } }) as never
		);
		expect(html).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;x&quot;</p>');
	});

	it('Links nur http/https/mailto – javascript: wird zu reinem Text', () => {
		const html = nodeHtml(
			doc(
				p(
					t('böse', [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }]),
					t('gut', [{ type: 'link', attrs: { href: 'https://example.org/?a=1&b="2"' } }]),
					t('mail', [{ type: 'link', attrs: { href: 'mailto:a@b.de' } }])
				)
			) as never
		);
		expect(html).not.toContain('javascript');
		expect(html).toContain('böse');
		expect(html).not.toContain('"2"');
		expect(html).toContain('href="mailto:a@b.de"');
		expect(html).toContain('rel="noopener noreferrer"');
	});

	it('Style-Injection in color/fontSize/highlight wird verworfen', () => {
		const html = nodeHtml(
			doc(
				p(
					t('a', [
						{ type: 'textStyle', attrs: { color: 'red;background:url(x)', fontSize: '12px' } }
					]),
					t('b', [
						{ type: 'textStyle', attrs: { color: '#ff0000', fontSize: '20px;position:fixed' } }
					]),
					t('c', [{ type: 'textStyle', attrs: { fontSize: '500px' } }]),
					t('d', [{ type: 'highlight', attrs: { color: 'expression(alert(1))' } }]),
					t('e', [{ type: 'textStyle', attrs: { color: 'rgb(1, 2, 3)' } }])
				)
			) as never
		);
		expect(html).not.toContain('url(');
		expect(html).not.toContain('position');
		expect(html).not.toContain('500px');
		expect(html).not.toContain('expression');
		expect(html).toContain('<span style="font-size:12px">a</span>');
		expect(html).toContain('<span style="color:#ff0000">b</span>');
		expect(html).toContain('<mark style="background-color:#fef08a">d</mark>');
		expect(html).toContain('color:rgb(1, 2, 3)');
	});

	it('Ausrichtung, Aufgaben, Tabellen, Code, Bilder und Einbettungen', () => {
		const embeds = new Map<string, ResolvedEmbed>([
			[
				`whiteboard:board:${BOARD}`,
				{
					title: 'Plan <b>',
					kindLabel: 'Whiteboard',
					href: 'https://intern.test/modules/whiteboard/x'
				}
			]
		]);
		const html = nodeHtml(
			doc(
				{ type: 'heading', attrs: { level: 2, textAlign: 'center' }, content: [t('Titel')] },
				{ type: 'paragraph', attrs: { textAlign: 'left;color:red' }, content: [t('x')] },
				{
					type: 'taskList',
					content: [{ type: 'taskItem', attrs: { checked: true }, content: [p(t('fertig'))] }]
				},
				{
					type: 'table',
					content: [
						{
							type: 'tableRow',
							content: [
								{
									type: 'tableHeader',
									attrs: { colspan: 2, rowspan: 'x', colwidth: [100, 50] },
									content: [p(t('K'))]
								}
							]
						}
					]
				},
				{ type: 'codeBlock', content: [t('a < b')] },
				{ type: 'image', attrs: { assetId: ASSET, alt: 'Zelt"' } },
				{ type: 'image', attrs: { assetId: FOREIGN, alt: 'fremd' } },
				{ type: 'image', attrs: { assetId: null, src: 'https://evil.test/x.png' } },
				{ type: 'embed', attrs: { module: 'whiteboard', kind: 'board', refId: BOARD } },
				{ type: 'embed', attrs: { module: 'whiteboard', kind: 'board', refId: FOREIGN } }
			) as never,
			{ imageSrc: (id) => (id === ASSET ? 'data:image/webp;base64,AAAA' : null), embeds }
		);
		expect(html).toContain('<h2 style="text-align:center">Titel</h2>');
		expect(html).toContain('<p>x</p>');
		expect(html).toContain(
			'<li class="task-item checked"><input type="checkbox" disabled checked />'
		);
		expect(html).toContain('<th colspan="2" style="width:150px">');
		expect(html).not.toContain('rowspan');
		expect(html).toContain('<pre><code>a &lt; b</code></pre>');
		expect(html).toContain('src="data:image/webp;base64,AAAA" alt="Zelt&quot;"');
		expect(html).toContain('[Bild: fremd]');
		expect(html).not.toContain('evil.test');
		expect(html).toContain('Whiteboard: Plan &lt;b&gt;');
		expect(html).toContain('href="https://intern.test/modules/whiteboard/x"');
		expect(html).toContain('Eingebetteter Inhalt');
	});

	it('Dokument mit CSP, ohne Skripte; Seiten mit Überschrift', () => {
		const fragment = pagesFragment(
			[
				{ title: 'Eins', depth: 0, json: doc(p(t('a'))) },
				{ title: '<Zwei>', depth: 1, json: doc(p(t('b'))) }
			],
			{ pageBreaks: true, skipFirstTitle: true }
		);
		expect(fragment).not.toContain('<h1>Eins</h1>');
		expect(fragment).toContain('<h1>&lt;Zwei&gt;</h1>');
		expect(fragment).toContain('page-break');
		const full = htmlDocument('A & B', fragment);
		expect(full).toContain('<title>A &amp; B</title>');
		expect(full).toContain("default-src 'none'");
		expect(full).not.toContain('<script');
	});
});

describe('notes-export: Markdown', () => {
	const images = new Map([
		[ASSET, { id: ASSET, name: 'Zelt Foto.jpg', bytes: new Uint8Array([1, 2]) }]
	]);
	const embeds = new Map<string, ResolvedEmbed>([
		[
			`whiteboard:board:${BOARD}`,
			{
				title: 'Lagerplan',
				kindLabel: 'Whiteboard',
				href: 'https://intern.test/modules/whiteboard/b'
			}
		]
	]);
	const ctx = { images, embeds, origin: 'https://intern.test' };
	const json = doc(
		p(t('Text mit '), t('fett', [{ type: 'bold' }])),
		{ type: 'image', attrs: { assetId: ASSET, alt: 'Zelt' } },
		{ type: 'image', attrs: { assetId: FOREIGN, alt: 'Fremd' } },
		{ type: 'embed', attrs: { module: 'whiteboard', kind: 'board', refId: BOARD, height: 480 } }
	);

	it('.md: Titel, Bild als Link in die App, Einbettung als Link', () => {
		const md = exportMarkdown(
			[
				{ id: 'a', parentId: null, depth: 0, title: 'Lager', json },
				{ id: 'b', parentId: 'a', depth: 1, title: 'Planung', json: doc(p(t('x'))) }
			],
			ctx
		);
		expect(md.startsWith('# Lager\n')).toBe(true);
		expect(md).toContain('**fett**');
		expect(md).toContain(
			`[Bild: Zelt](https://intern.test/api/v1/modules/notes/assets/${ASSET}/web)`
		);
		expect(md).toContain('[Bild: Fremd]');
		expect(md).not.toContain(FOREIGN);
		expect(md).toContain('[Whiteboard: Lagerplan](https://intern.test/modules/whiteboard/b)');
		expect(md).not.toContain(':::embed');
		expect(md).toContain('---\n\n# Planung');
	});

	it('.zip: Seiten in Ordnern, Bilder unter bilder/, relativ verlinkt', () => {
		const files = exportMarkdownFiles(
			[
				{ id: 'a', parentId: null, depth: 0, title: 'Lager/1', json: doc(p(t('a'))) },
				{ id: 'b', parentId: 'a', depth: 1, title: 'Planung', json },
				{ id: 'c', parentId: 'a', depth: 1, title: 'Planung', json: doc(p(t('c'))) }
			],
			ctx
		);
		const names = Object.keys(files).sort();
		expect(names).toEqual([
			'Lager 1.md',
			'Lager 1/Planung (2).md',
			'Lager 1/Planung.md',
			'bilder/1-Zelt_Foto.webp'
		]);
		const planung = new TextDecoder().decode(files['Lager 1/Planung.md']);
		expect(planung).toContain('![Zelt](../bilder/1-Zelt_Foto.webp)');
		expect(planung).not.toContain('asset:');
	});
});

describe('notes-export: Word', () => {
	it('erzeugt ein gültiges ZIP mit word/document.xml', async () => {
		const bytes = await exportDocx(
			[
				{
					title: 'Lager',
					json: doc(
						{ type: 'heading', attrs: { level: 1 }, content: [t('Kapitel')] },
						p(t('rot', [{ type: 'textStyle', attrs: { color: '#dc2626', fontSize: '20px' } }])),
						p(t('Link', [{ type: 'link', attrs: { href: 'https://example.org' } }])),
						{
							type: 'bulletList',
							content: [{ type: 'listItem', content: [p(t('Punkt'))] }]
						},
						{
							type: 'taskList',
							content: [{ type: 'taskItem', attrs: { checked: true }, content: [p(t('fertig'))] }]
						},
						{
							type: 'table',
							content: [
								{
									type: 'tableRow',
									content: [{ type: 'tableCell', attrs: { colspan: 2 }, content: [p(t('Zelle'))] }]
								}
							]
						},
						{ type: 'codeBlock', content: [t('let a = 1;\nlet b = 2;')] },
						{ type: 'blockquote', content: [p(t('Zitat'))] },
						{ type: 'embed', attrs: { module: 'whiteboard', kind: 'board', refId: BOARD } }
					)
				},
				{ title: 'Unterseite', json: doc(p(t('zwei'))) }
			],
			{ title: 'Lager' }
		);
		expect(bytes[0]).toBe(0x50);
		expect(bytes[1]).toBe(0x4b);
		const files = unzipSync(bytes);
		const xml = strFromU8(files['word/document.xml']!);
		expect(xml).toContain('Kapitel');
		expect(xml).toContain('DC2626');
		expect(xml).toContain('☑');
		expect(xml).toContain('Eingebetteter Inhalt');
		expect(xml).toContain('pageBreakBefore');
		expect(files['word/numbering.xml']).toBeDefined();
	});

	it('Farben werden in RRGGBB umgerechnet, ungültige verworfen', () => {
		expect(hexColor('#abc')).toBe('AABBCC');
		expect(hexColor('rgb(255, 0, 16)')).toBe('FF0010');
		expect(hexColor('red')).toBeNull();
		expect(hexColor('rgb(300, 0, 0)')).toBeNull();
	});
});

describe('notes-export: Import-Hilfen', () => {
	it('erste H1 wird zum Titel und aus dem Inhalt entfernt', () => {
		const r = takeTitle(parseMarkdown('# Lager 2026\n\nText'), 'datei');
		expect(r.title).toBe('Lager 2026');
		expect(JSON.stringify(r.json)).not.toContain('Lager 2026');
		expect(takeTitle(parseMarkdown('Nur Text'), 'datei').title).toBe('datei');
	});

	it('relative Pfade: .. bleibt im Archiv, absolute/externe → null', () => {
		expect(resolveRelative('Lager/Planung', '../../bilder/a.png')).toBe('bilder/a.png');
		expect(resolveRelative('', 'bilder/a%20b.png')).toBe('bilder/a b.png');
		expect(resolveRelative('', '../a.png')).toBeNull();
		expect(resolveRelative('', '/etc/passwd')).toBeNull();
		expect(resolveRelative('', 'https://evil.test/a.png')).toBeNull();
	});

	it('Bild-Verweise: aufgelöste → asset:, sonst Alt-Text', () => {
		const md = rewriteImageRefs('![A](a.png) ![B](https://x.test/b.png) ![C](<c d.png>)', (t) =>
			t === 'a.png' ? ASSET : null
		);
		expect(md).toBe(`![A](asset:${ASSET}) [Bild: B] [Bild: C]`);
		expect(JSON.stringify(parseMarkdown(md))).toContain(ASSET);
	});

	it('ZIP: ../ und absolute Pfade → ZipError', () => {
		const evil = zipSync({ '../x.md': new TextEncoder().encode('# x') });
		expect(() => readZip(evil, { maxFileBytes: 1000 })).toThrow(ZipError);
		const ok = zipSync({ 'a/b.md': new TextEncoder().encode('# b') });
		expect([...readZip(ok, { maxFileBytes: 1000 }).keys()]).toEqual(['a/b.md']);
		expect(() => readZip(new Uint8Array([1, 2, 3]), { maxFileBytes: 10 })).toThrow(ZipError);
	});
});
