/**
 * Gemeinsames Dokumentschema der Notizen (Server UND Browser, ohne DOM-Zugriff): Tiptap-Erweiterungen, aus
 * denen `getSchema()` das ProseMirror-Schema baut. Der Browser ergänzt nur Verhalten (Collaboration, Cursor,
 * Platzhalter, Markdown-Einfügen, Node-Views) – nie neue Knoten/Marks, sonst passen Server-Ableitung und Export
 * nicht mehr.
 *
 * Eigene Knoten:
 *   - `image` speichert nur `assetId` (+ `alt`, `width`); die Adresse wird beim Darstellen aus der ID gebaut, eine
 *     freie `src` aus dem Dokument wird nie ausgegeben (kein Nachladen fremder Server). Markdown: `![alt](asset:<id>)`.
 *   - `embed` = eingebetteter Inhalt eines anderen Moduls (z. B. Whiteboard), `{ module, kind, refId, height }`.
 *     Markdown: `:::embed {module="whiteboard" kind="board" refId="…" height="480"} :::`.
 */
import {
	createAtomBlockMarkdownSpec,
	getSchema,
	mergeAttributes,
	Node,
	type AnyExtension
} from '@tiptap/core';
import Highlight from '@tiptap/extension-highlight';
import Image from '@tiptap/extension-image';
import { OrderedList, TaskItem, TaskList } from '@tiptap/extension-list';
import { Table, TableKit } from '@tiptap/extension-table';
import TextAlign from '@tiptap/extension-text-align';
import { TextStyleKit } from '@tiptap/extension-text-style';
import StarterKit from '@tiptap/starter-kit';
import type { Schema } from '@tiptap/pm/model';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { API_BASE, DEFAULT_EMBED_HEIGHT, MAX_EMBED_HEIGHT, MIN_EMBED_HEIGHT } from '../schemas';
import { isListStyle, listStart, listStyleFromHtml, ownListStyle } from './list-style';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_RE = /^[a-z][a-z0-9-]{0,40}$/;

export const ASSET_SCHEME = 'asset:';

export function isUuid(v: unknown): v is string {
	return typeof v === 'string' && UUID_RE.test(v);
}

/** Standard-Adresse eines Bildes (relativ, mit Session-Cookie) */
export function assetUrl(assetId: string, variant: 'thumb' | 'web' | 'file' = 'web'): string {
	return `${API_BASE}/assets/${assetId}/${variant}`;
}

export interface NoteExtensionOptions {
	/** Bild-Adresse beim Rendern (Export ersetzt sie durch Dateinamen bzw. data-URLs) */
	assetSrc?: (assetId: string) => string;
	/** Browser: Bildgröße per Ziehgriff */
	resizableImages?: boolean;
}

const clampHeight = (v: unknown): number => {
	const n = Math.round(Number(v));
	if (!Number.isFinite(n)) return DEFAULT_EMBED_HEIGHT;
	return Math.min(MAX_EMBED_HEIGHT, Math.max(MIN_EMBED_HEIGHT, n));
};

/** Bild mit Asset-ID statt freier Adresse */
export function noteImage(options: NoteExtensionOptions = {}) {
	const src = options.assetSrc ?? ((id: string) => assetUrl(id));
	return Image.extend({
		addAttributes() {
			return {
				assetId: {
					default: null,
					parseHTML: (el) => {
						const v = el.getAttribute('data-asset-id');
						return isUuid(v) ? v : null;
					},
					renderHTML: (attrs) => (isUuid(attrs.assetId) ? { 'data-asset-id': attrs.assetId } : {})
				},
				// `src` wird nie aus dem Dokument übernommen, sondern aus der ID gebaut
				src: {
					default: null,
					parseHTML: () => null,
					renderHTML: () => ({})
				},
				alt: { default: null },
				title: { default: null },
				width: {
					default: null,
					parseHTML: (el) => {
						const n = Number(el.getAttribute('width'));
						return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
					}
				},
				height: { default: null, parseHTML: () => null, renderHTML: () => ({}) }
			};
		},
		parseHTML() {
			return [{ tag: 'img[data-asset-id]' }];
		},
		renderHTML({ node, HTMLAttributes }) {
			const id = node.attrs.assetId;
			return [
				'img',
				mergeAttributes(HTMLAttributes, isUuid(id) ? { src: src(id), loading: 'lazy' } : {})
			];
		},
		parseMarkdown: (token, helpers) => {
			const href = String(token.href ?? '');
			const id = href.startsWith(ASSET_SCHEME) ? href.slice(ASSET_SCHEME.length) : '';
			return helpers.createNode('image', {
				assetId: isUuid(id) ? id : null,
				alt: token.text || null,
				title: token.title || null
			});
		},
		renderMarkdown: (node) => {
			const id = node.attrs?.assetId;
			const alt = String(node.attrs?.alt ?? '').replace(/[[\]]/g, '');
			return isUuid(id) ? `![${alt}](${ASSET_SCHEME}${id})` : alt ? `[Bild: ${alt}]` : '';
		}
	}).configure({
		inline: false,
		allowBase64: false,
		resize: options.resizableImages
			? { enabled: true, minWidth: 80, minHeight: 40, alwaysPreserveAspectRatio: true }
			: false
	});
}

/*
 * Markdown-Tokenizer: `start` ruft marked für JEDEN Absatz mit dem gesamten restlichen Text auf. Tiptaps Fassungen
 * von Tabelle (`src.split('\n')`) und Einbettung (Regex über den ganzen Rest) sind dadurch quadratisch – ein großer
 * Text (Import, Quelltext-Ansicht, Einfügen) brauchte Sekunden. Hier wird nur der Anfang bzw. der aktuelle Block geprüft.
 */
const TABLE_SEPARATOR = /^[ \t|:]*-[ \t|:-]*$/;

/** Beginnt hier eine Tabelle? (nur die ersten beiden Zeilen) */
export function tableStart(src: string): number {
	const first = src.indexOf('\n');
	if (first < 0) return -1;
	const second = src.indexOf('\n', first + 1);
	const sep = src.slice(first + 1, second < 0 ? undefined : second);
	if (!TABLE_SEPARATOR.test(sep) || !sep.includes('|')) return -1;
	return src.slice(0, first).includes('|') ? 0 : -1;
}

const EMBED_START = /^ {0,3}:::embed(?:\s|$)/m;

/** Position einer Einbettung im aktuellen Block (bis zur nächsten Leerzeile) */
export function embedStart(src: string): number {
	const end = src.indexOf('\n\n');
	const scope = end < 0 ? src : src.slice(0, end + 1);
	return scope.match(EMBED_START)?.index ?? -1;
}

/*
 * Aufgabenliste: Tiptaps Tokenizer zerlegt an JEDER Blockgrenze den ganzen Rest in Zeilen (`parseIndentedBlocks`) –
 * der Hauptgrund für quadratische Laufzeit großer Texte. Vorher billig prüfen, ob hier überhaupt eine Aufgabe beginnt.
 */
const TASK_ITEM_START = /^(?:[ \t]*\n)*\s*[-+*]\s+\[[ xX]\]\s+/;
const taskTokenizer = TaskList.config.markdownTokenizer!;

const NoteTaskList = TaskList.extend({
	markdownTokenizer: {
		...taskTokenizer,
		tokenize: (src, tokens, helper) =>
			TASK_ITEM_START.test(src) ? taskTokenizer.tokenize(src, tokens, helper) : undefined
	}
});

const tableTokenizer = Table.config.markdownTokenizer!;

const NoteTable = Table.extend({
	markdownTokenizer: {
		...tableTokenizer,
		start: tableStart,
		// läuft an jeder Blockgrenze: ohne Tabelle am Anfang sofort aussteigen
		tokenize: (src, tokens, helper) =>
			tableStart(src) === 0 ? tableTokenizer.tokenize(src, tokens, helper) : undefined
	}
});

const embedMarkdown = createAtomBlockMarkdownSpec({
	nodeName: 'embed',
	requiredAttributes: ['module', 'kind', 'refId'],
	defaultAttributes: { height: DEFAULT_EMBED_HEIGHT },
	allowedAttributes: ['module', 'kind', 'refId', 'height']
});

/** Eingebetteter Inhalt eines anderen Moduls (Darstellung im Browser per Node-View als iframe) */
export const Embed = Node.create({
	name: 'embed',
	group: 'block',
	atom: true,
	draggable: true,
	selectable: true,
	addAttributes() {
		return {
			module: {
				default: null,
				parseHTML: (el) => {
					const v = el.getAttribute('data-module');
					return v && KEY_RE.test(v) ? v : null;
				},
				renderHTML: (a) => ({ 'data-module': a.module })
			},
			kind: {
				default: null,
				parseHTML: (el) => {
					const v = el.getAttribute('data-kind');
					return v && KEY_RE.test(v) ? v : null;
				},
				renderHTML: (a) => ({ 'data-kind': a.kind })
			},
			refId: {
				default: null,
				parseHTML: (el) => {
					const v = el.getAttribute('data-ref-id');
					return isUuid(v) ? v : null;
				},
				renderHTML: (a) => ({ 'data-ref-id': a.refId })
			},
			height: {
				default: DEFAULT_EMBED_HEIGHT,
				parseHTML: (el) => clampHeight(el.getAttribute('data-height')),
				renderHTML: (a) => ({ 'data-height': clampHeight(a.height) })
			}
		};
	},
	parseHTML() {
		return [{ tag: 'div[data-embed]' }];
	},
	renderHTML({ HTMLAttributes }) {
		return ['div', mergeAttributes({ 'data-embed': '' }, HTMLAttributes)];
	},
	...embedMarkdown,
	markdownTokenizer: { ...embedMarkdown.markdownTokenizer!, start: embedStart }
});

/**
 * Geordnete Liste mit Nummerierungsart `listStyle` (siehe `list-style.ts`). Gerendert wird die wirksame eigene Art als
 * `data-list-style` (auch aus `type`); Unterlisten ohne Attribut erben sie per CSS. Bei Gliederung o. Ä. mit Start ≠ 1
 * setzt `--ol-start` den Zähler.
 */
export const NoteOrderedList = OrderedList.extend({
	addAttributes() {
		return {
			...this.parent?.(),
			listStyle: {
				default: null,
				parseHTML: (el) => listStyleFromHtml(el),
				renderHTML: (attrs) => {
					const style = ownListStyle(attrs);
					if (!style) return {};
					const start = listStart(attrs.start);
					return {
						'data-list-style': style,
						...(start > 1 ? { style: `--ol-start: ${start - 1}` } : {})
					};
				}
			}
		};
	}
});

/** Nummerierungsart der Liste am Cursor (innerste geordnete Liste) setzen; `null` = Standard */
export function setListStyleAt(
	editor: { state: EditorState; view: { dispatch: (tr: Transaction) => void } },
	style: string | null
): boolean {
	const { state } = editor;
	const $from = state.selection.$from;
	for (let d = $from.depth; d > 0; d--) {
		const node = $from.node(d);
		if (node.type.name !== 'orderedList') continue;
		// „Zahlen“ nur dann ausdrücklich speichern, wenn eine Oberliste eine andere Art vererbt
		let inherited = false;
		for (let up = d - 1; up > 0; up--) {
			const outer = $from.node(up);
			if (outer.type.name === 'orderedList' && ownListStyle(outer.attrs)) inherited = true;
		}
		const next = isListStyle(style) && (style !== 'decimal' || inherited) ? style : null;
		editor.view.dispatch(
			state.tr.setNodeMarkup($from.before(d), undefined, {
				...node.attrs,
				listStyle: next,
				// Tiptaps `type` würde sonst beim Zurücksetzen weiter gelten
				type: null
			})
		);
		return true;
	}
	return false;
}

/** Alle Erweiterungen, die das Schema bestimmen */
export function noteExtensions(options: NoteExtensionOptions = {}): AnyExtension[] {
	return [
		StarterKit.configure({
			heading: { levels: [1, 2, 3] },
			// Rückgängig übernimmt Yjs (nur eigene Änderungen)
			undoRedo: false,
			orderedList: false,
			link: {
				openOnClick: false,
				autolink: true,
				protocols: ['http', 'https', 'mailto'],
				HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' }
			}
		}),
		TextStyleKit.configure({ fontFamily: false, lineHeight: false }),
		Highlight.configure({ multicolor: true }),
		TextAlign.configure({ types: ['heading', 'paragraph'] }),
		NoteOrderedList,
		NoteTaskList,
		TaskItem.configure({ nested: true }),
		TableKit.configure({ table: false }),
		NoteTable.configure({ resizable: !!options.resizableImages }),
		noteImage(options),
		Embed
	];
}

let cachedSchema: Schema | null = null;

/** ProseMirror-Schema (Server: Ableitung, Import, Versionen) */
export function noteSchema(): Schema {
	cachedSchema ??= getSchema(noteExtensions());
	return cachedSchema;
}
