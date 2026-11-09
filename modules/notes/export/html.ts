/**
 * Eigener Serialisierer ProseMirror-JSON → HTML für den Export (ohne DOM-Bibliothek, Server und Tests).
 *
 * Nur Knoten und Marks aus dem Notiz-Schema werden ausgegeben (Allowlist), alles andere entfällt bzw. nur sein Text
 * bleibt. Jeder Text und jedes Attribut wird escaped; Attributwerte werden geprüft:
 *   - Links nur http/https/mailto, Farben nur `#rgb`/`#rrggbb`/`rgb()`/`rgba()`, Schriftgröße nur 8–96 px,
 *     Ausrichtung nur left/right/center/justify, `colspan`/`rowspan` 1–99, Spaltenbreiten 1–5000 px.
 *   - Bilder: Adresse kommt nur aus `opts.imageSrc(assetId)` (z. B. data-URL), nie aus dem Dokument.
 *   - Einbettungen: Platzhalter-Kasten mit Titel und Link (Adresse aus `opts.embed`).
 */
import { isUuid } from '../doc/extensions';
import {
	childListContext,
	listMarker,
	listStart,
	ownListStyle,
	type ListContext
} from '../doc/list-style';
import type { PmNode } from '../doc/text';
import { embedKey, embedLabel, type ResolvedEmbed } from './embeds';

export interface HtmlOptions {
	/** Bild-Adresse zur Asset-ID (`null` = Bild weglassen, nur Alt-Text) */
	imageSrc?: (assetId: string) => string | null;
	/** Einbettungen (Schlüssel `module:kind:refId`) */
	embeds?: ReadonlyMap<string, ResolvedEmbed>;
	/** intern: Nummerierung der umgebenden geordneten Liste (Unterlisten erben die Art) */
	list?: { ctx: ListContext; item: number };
}

export function escapeHtml(value: unknown): string {
	return String(value ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

const COLOR_RES = [
	/^#[0-9a-f]{3}$/i,
	/^#[0-9a-f]{6}$/i,
	/^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d{1,3})\s*)?\)$/i
];

/** Gültige CSS-Farbe oder `null` */
export function safeColor(v: unknown): string | null {
	if (typeof v !== 'string') return null;
	const s = v.trim();
	return COLOR_RES.some((re) => re.test(s)) ? s : null;
}

/** Schriftgröße in px (8–96) oder `null` */
export function safeFontSize(v: unknown): number | null {
	const m = typeof v === 'string' ? /^(\d{1,3}(?:\.\d{1,2})?)px$/.exec(v.trim()) : null;
	const n = m ? Number(m[1]) : typeof v === 'number' ? v : NaN;
	return Number.isFinite(n) && n >= 8 && n <= 96 ? n : null;
}

const ALIGNS = new Set(['left', 'right', 'center', 'justify']);
export function safeAlign(v: unknown): string | null {
	return typeof v === 'string' && ALIGNS.has(v) ? v : null;
}

/** Link-Ziel nur http/https/mailto (sonst `null`) */
export function safeHref(v: unknown): string | null {
	if (typeof v !== 'string') return null;
	const s = v.trim();
	if (s.length > 2000 || /[\s"<>\\]/.test(s)) return null;
	if (/^https?:\/\/[^/]/i.test(s) || /^mailto:[^\s]+$/i.test(s)) return s;
	return null;
}

const span = (v: unknown): number | null => {
	const n = Number(v);
	return Number.isInteger(n) && n > 1 && n < 100 ? n : null;
};

const colWidths = (v: unknown): number[] =>
	Array.isArray(v)
		? v.map((x) => Number(x)).filter((n) => Number.isFinite(n) && n >= 1 && n <= 5000)
		: [];

const attr = (name: string, value: string | number) => ` ${name}="${escapeHtml(value)}"`;

function styleAttr(parts: (string | null)[]): string {
	const s = parts.filter(Boolean).join(';');
	return s ? attr('style', s) : '';
}

function alignStyle(node: PmNode): string | null {
	const a = safeAlign(node.attrs?.textAlign);
	return a && a !== 'left' ? `text-align:${a}` : null;
}

type Mark = NonNullable<PmNode['marks']>[number];

function openMark(m: Mark): [string, string] | null {
	switch (m.type) {
		case 'bold':
			return ['<strong>', '</strong>'];
		case 'italic':
			return ['<em>', '</em>'];
		case 'underline':
			return ['<u>', '</u>'];
		case 'strike':
			return ['<s>', '</s>'];
		case 'code':
			return ['<code>', '</code>'];
		case 'link': {
			const href = safeHref(m.attrs?.href);
			return href
				? [`<a${attr('href', href)} target="_blank" rel="noopener noreferrer">`, '</a>']
				: null;
		}
		case 'textStyle': {
			const color = safeColor(m.attrs?.color);
			const size = safeFontSize(m.attrs?.fontSize);
			const style = styleAttr([
				color ? `color:${color}` : null,
				size ? `font-size:${size}px` : null
			]);
			return style ? [`<span${style}>`, '</span>'] : null;
		}
		case 'highlight': {
			const color = safeColor(m.attrs?.color) ?? '#fef08a';
			return [`<mark${styleAttr([`background-color:${color}`])}>`, '</mark>'];
		}
		default:
			return null;
	}
}

function textHtml(node: PmNode): string {
	let out = escapeHtml(node.text ?? '');
	for (const m of node.marks ?? []) {
		const pair = openMark(m);
		if (pair) out = pair[0] + out + pair[1];
	}
	return out;
}

function children(node: PmNode, opts: HtmlOptions): string {
	return (Array.isArray(node.content) ? node.content : []).map((c) => nodeHtml(c, opts)).join('');
}

function cellHtml(node: PmNode, opts: HtmlOptions): string {
	const tag = node.type === 'tableHeader' ? 'th' : 'td';
	const cs = span(node.attrs?.colspan);
	const rs = span(node.attrs?.rowspan);
	const widths = colWidths(node.attrs?.colwidth);
	const width = widths.length ? widths.reduce((a, b) => a + b, 0) : null;
	return (
		`<${tag}${cs ? attr('colspan', cs) : ''}${rs ? attr('rowspan', rs) : ''}` +
		`${styleAttr([width ? `width:${width}px` : null])}>${children(node, opts)}</${tag}>`
	);
}

function embedHtml(node: PmNode, opts: HtmlOptions): string {
	const a = node.attrs ?? {};
	const ok = typeof a.module === 'string' && typeof a.kind === 'string' && isUuid(a.refId);
	const info = ok
		? opts.embeds?.get(
				embedKey({ module: String(a.module), kind: String(a.kind), refId: String(a.refId) })
			)
		: undefined;
	const label = escapeHtml(embedLabel(info));
	const href = info?.href ? safeHref(info.href) : null;
	const link = href
		? `<div class="embed-link"><a${attr('href', href)} target="_blank" rel="noopener noreferrer">${escapeHtml(href)}</a></div>`
		: '<div class="embed-link">Nur in der App sichtbar</div>';
	return `<div class="embed-box"><div class="embed-title">${label}</div>${link}</div>`;
}

function imageHtml(node: PmNode, opts: HtmlOptions): string {
	const id = node.attrs?.assetId;
	const alt = typeof node.attrs?.alt === 'string' ? node.attrs.alt.slice(0, 300) : '';
	const src = isUuid(id) ? (opts.imageSrc?.(id) ?? null) : null;
	if (!src) return alt ? `<p><em>[Bild: ${escapeHtml(alt)}]</em></p>` : '';
	const w = Number(node.attrs?.width);
	const width = Number.isFinite(w) && w >= 16 && w <= 5000 ? Math.round(w) : null;
	return `<img${attr('src', src)}${attr('alt', alt)}${styleAttr([width ? `width:${width}px` : null])} />`;
}

/**
 * Geordnete Liste: Standard als `<ol>`; mit Nummerierungsart (Gliederung 1.1.1, a), römisch …) mit ausgeschriebenen
 * Nummern als Liste ohne Aufzählungszeichen (`task-list`/`task-item` – die einzigen Listenklassen, die die
 * HTML-Bereinigung des PDF-Exports durchlässt), damit HTML, PDF und Editor dieselben Nummern zeigen.
 */
function orderedListHtml(node: PmNode, opts: HtmlOptions): string {
	const ctx = childListContext(opts.list?.ctx ?? null, ownListStyle(node.attrs), opts.list?.item);
	const start = listStart(node.attrs?.start);
	const items = Array.isArray(node.content) ? node.content : [];
	if (!ctx.style) {
		const s = start > 1 ? attr('start', start) : '';
		const inner = items
			.map((item, i) => nodeHtml(item, { ...opts, list: { ctx, item: start + i } }))
			.join('');
		return `<ol${s}>${inner}</ol>`;
	}
	const inner = items
		.map((item, i) => {
			const n = start + i;
			const body = children(item, { ...opts, list: { ctx, item: n } });
			return `<li class="task-item"><span>${escapeHtml(listMarker(ctx, n))}</span><div>${body}</div></li>`;
		})
		.join('');
	return `<ul class="task-list">${inner}</ul>`;
}

/** Ein Knoten als HTML (Allowlist) */
export function nodeHtml(node: PmNode, opts: HtmlOptions = {}): string {
	if (!node || typeof node !== 'object') return '';
	switch (node.type) {
		case 'doc':
			return children(node, opts);
		case 'text':
			return textHtml(node);
		case 'paragraph':
			return `<p${styleAttr([alignStyle(node)])}>${children(node, opts)}</p>`;
		case 'heading': {
			const level = Math.min(3, Math.max(1, Math.round(Number(node.attrs?.level) || 1)));
			return `<h${level}${styleAttr([alignStyle(node)])}>${children(node, opts)}</h${level}>`;
		}
		case 'bulletList':
			return `<ul>${children(node, opts)}</ul>`;
		case 'orderedList':
			return orderedListHtml(node, opts);
		case 'listItem':
			return `<li>${children(node, opts)}</li>`;
		case 'taskList':
			return `<ul class="task-list">${children(node, opts)}</ul>`;
		case 'taskItem': {
			const checked = node.attrs?.checked === true;
			return (
				`<li class="task-item${checked ? ' checked' : ''}">` +
				`<input type="checkbox" disabled${checked ? ' checked' : ''} />` +
				`<div>${children(node, opts)}</div></li>`
			);
		}
		case 'blockquote':
			return `<blockquote>${children(node, opts)}</blockquote>`;
		case 'codeBlock': {
			const text = (node.content ?? []).map((c) => escapeHtml(c.text ?? '')).join('');
			return `<pre><code>${text}</code></pre>`;
		}
		case 'horizontalRule':
			return '<hr />';
		case 'hardBreak':
			return '<br />';
		case 'table':
			return `<table><tbody>${children(node, opts)}</tbody></table>`;
		case 'tableRow':
			return `<tr>${children(node, opts)}</tr>`;
		case 'tableHeader':
		case 'tableCell':
			return cellHtml(node, opts);
		case 'image':
			return imageHtml(node, opts);
		case 'embed':
			return embedHtml(node, opts);
		default:
			// unbekannter Knoten: nur der Inhalt (Text bleibt lesbar)
			return children(node, opts);
	}
}

/** Bytes als data-URL */
export function dataUrl(contentType: string, bytes: Uint8Array): string {
	return `data:${contentType};base64,${Buffer.from(bytes).toString('base64')}`;
}

export interface HtmlPage {
	title: string;
	depth: number;
	json: unknown;
}

/**
 * Fragment aller Seiten: je Seite eine Überschrift (Titel) und der Inhalt; zwischen den Seiten ein Seitenumbruch
 * (`div.page-break`, für PDF). `skipFirstTitle` = Titel der ersten Seite weglassen (PDF-Vorlage druckt ihn selbst).
 */
export function pagesFragment(
	pages: readonly HtmlPage[],
	opts: HtmlOptions & { skipFirstTitle?: boolean; pageBreaks?: boolean } = {}
): string {
	return pages
		.map((p, i) => {
			const title =
				i === 0 && opts.skipFirstTitle ? '' : `<h1>${escapeHtml(p.title || 'Ohne Titel')}</h1>`;
			const brk = i > 0 && opts.pageBreaks ? '<div class="page-break"></div>' : '';
			return `${brk}<div class="note-page">${title}${nodeHtml(p.json as PmNode, opts)}</div>`;
		})
		.join('\n');
}

const DOCUMENT_CSS = `
:root { color-scheme: light; }
body { font-family: system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #1f2937; line-height: 1.6;
	max-width: 50rem; margin: 2rem auto; padding: 0 1rem; }
h1, h2, h3 { line-height: 1.25; }
.note-page + .note-page { margin-top: 3rem; padding-top: 2rem; border-top: 1px solid #e5e7eb; }
img { max-width: 100%; height: auto; border-radius: 4px; }
blockquote { margin: 1rem 0; padding: .25rem 0 .25rem 1rem; border-left: 3px solid #d1d5db; color: #4b5563; }
pre { background: #f3f4f6; border-radius: 6px; padding: .75rem 1rem; overflow-x: auto; white-space: pre-wrap; }
code { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: .92em; }
:not(pre) > code { background: #f3f4f6; border-radius: 4px; padding: 0 .25em; }
table { border-collapse: collapse; margin: 1rem 0; }
th, td { border: 1px solid #d1d5db; padding: .35rem .6rem; vertical-align: top; text-align: left; }
th { background: #f3f4f6; }
td > p, th > p { margin: 0; }
ul.task-list { list-style: none; padding-left: .25rem; }
li.task-item { display: flex; gap: .5rem; align-items: flex-start; }
li.task-item > div > p { margin: 0; }
li.task-item.checked > div { color: #6b7280; text-decoration: line-through; }
li.task-item input { margin-top: .4rem; }
li.task-item > span { white-space: nowrap; font-variant-numeric: tabular-nums; }
hr { border: 0; border-top: 1px solid #e5e7eb; margin: 1.5rem 0; }
a { color: #2563eb; }
.embed-box { border: 1px dashed #9ca3af; border-radius: 8px; padding: .75rem 1rem; margin: 1rem 0; }
.embed-title { font-weight: 600; }
.embed-link { font-size: .9em; color: #4b5563; overflow-wrap: anywhere; }
.page-break { display: none; }
`;

/** Vollständiges HTML-Dokument (eingebettetes CSS, Bilder als data-URL, keine Skripte) */
export function htmlDocument(title: string, fragment: string): string {
	return [
		'<!doctype html>',
		'<html lang="de">',
		'<head>',
		'<meta charset="utf-8" />',
		'<meta name="viewport" content="width=device-width, initial-scale=1" />',
		`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'" />`,
		`<title>${escapeHtml(title || 'Notiz')}</title>`,
		`<style>${DOCUMENT_CSS}</style>`,
		'</head>',
		'<body>',
		fragment,
		'</body>',
		'</html>',
		''
	].join('\n');
}
