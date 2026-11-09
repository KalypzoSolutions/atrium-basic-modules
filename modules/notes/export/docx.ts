/**
 * Word-Export (.docx) der Notizen mit der Bibliothek `docx` – rein (ohne Server-Dienste), Bilder kommen
 * bereits als PNG/JPEG (Umwandlung über `core.images.process` im Endpunkt, Word kennt kein WebP).
 *
 * Abbildung: Überschriften 1–3, Absätze mit Ausrichtung, fett/kursiv/unterstrichen/durchgestrichen, Code (Monospace),
 * Textfarbe, Schriftgröße, Markierung (als Schattierung in genau der Farbe), Links (nur http/https/mailto),
 * Aufzählungen/Nummerierungen (verschachtelt, Nummerierung je Liste neu), Aufgaben als ☐/☑, Zitate (eingerückt mit
 * Linie), Codeblöcke, Trennlinie, Tabellen (colspan/rowspan), Bilder mit Seitenverhältnis (höchstens Seitenbreite),
 * Einbettungen als Hinweis mit Link. Jede Unterseite beginnt auf einer neuen Seite.
 */
import {
	AlignmentType,
	BorderStyle,
	Document,
	ExternalHyperlink,
	HeadingLevel,
	ImageRun,
	LevelFormat,
	Packer,
	Paragraph,
	ShadingType,
	Tab,
	Table,
	TableCell,
	TableRow,
	TextRun,
	WidthType,
	type IParagraphOptions,
	type ParagraphChild
} from 'docx';
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
import { safeAlign, safeColor, safeFontSize, safeHref } from './html';

export interface DocxImage {
	type: 'png' | 'jpg';
	data: Uint8Array;
	width: number | null;
	height: number | null;
}

export interface DocxPage {
	title: string;
	json: unknown;
}

export interface DocxOptions {
	images?: ReadonlyMap<string, DocxImage>;
	embeds?: ReadonlyMap<string, ResolvedEmbed>;
	title?: string;
}

/** Nutzbare Breite einer A4-Seite mit Standardrändern (px bei 96 dpi) */
export const MAX_IMAGE_WIDTH_PX = 600;
const MAX_IMAGE_HEIGHT_PX = 860;

type Block = Paragraph | Table;
type Format = {
	bold?: boolean;
	italics?: boolean;
	underline?: boolean;
	strike?: boolean;
	code?: boolean;
	color?: string;
	size?: number;
	highlight?: string;
	href?: string;
};

/** `#rgb`, `#rrggbb` oder `rgb()` → `RRGGBB` */
export function hexColor(v: unknown): string | null {
	const c = safeColor(v);
	if (!c) return null;
	if (c.startsWith('#')) {
		const h = c.slice(1);
		return (h.length === 3 ? [...h].map((x) => x + x).join('') : h).toUpperCase();
	}
	const nums =
		c
			.match(/\d{1,3}/g)
			?.slice(0, 3)
			.map(Number) ?? [];
	if (nums.length < 3 || nums.some((n) => n > 255)) return null;
	return nums
		.map((n) => n.toString(16).padStart(2, '0'))
		.join('')
		.toUpperCase();
}

const ALIGN: Record<string, (typeof AlignmentType)[keyof typeof AlignmentType]> = {
	left: AlignmentType.LEFT,
	center: AlignmentType.CENTER,
	right: AlignmentType.RIGHT,
	justify: AlignmentType.JUSTIFIED
};

const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3] as const;

function formatOf(marks: PmNode['marks'], base: Format = {}): Format {
	const f: Format = { ...base };
	for (const m of marks ?? []) {
		switch (m.type) {
			case 'bold':
				f.bold = true;
				break;
			case 'italic':
				f.italics = true;
				break;
			case 'underline':
				f.underline = true;
				break;
			case 'strike':
				f.strike = true;
				break;
			case 'code':
				f.code = true;
				break;
			case 'link': {
				const href = safeHref(m.attrs?.href);
				if (href) f.href = href;
				break;
			}
			case 'textStyle': {
				const color = hexColor(m.attrs?.color);
				const size = safeFontSize(m.attrs?.fontSize);
				if (color) f.color = color;
				// px → pt (×0,75), docx erwartet halbe Punkte
				if (size) f.size = Math.round(size * 0.75 * 2);
				break;
			}
			case 'highlight':
				f.highlight = hexColor(m.attrs?.color) ?? 'FEF08A';
				break;
		}
	}
	return f;
}

function run(text: string, f: Format, extra: { break?: number } = {}): TextRun {
	return new TextRun({
		text,
		bold: f.bold,
		italics: f.italics,
		underline: f.underline || f.href ? {} : undefined,
		strike: f.strike,
		font: f.code ? 'Courier New' : undefined,
		color: f.href ? (f.color ?? '2563EB') : f.color,
		size: f.size,
		shading: f.highlight
			? { type: ShadingType.CLEAR, color: 'auto', fill: f.highlight }
			: f.code
				? { type: ShadingType.CLEAR, color: 'auto', fill: 'F3F4F6' }
				: undefined,
		...extra
	});
}

class Builder {
	private listInstance = 0;
	constructor(private readonly opts: DocxOptions) {}

	/** Inline-Inhalt eines Textblocks */
	inline(node: PmNode, base: Format = {}): ParagraphChild[] {
		const out: ParagraphChild[] = [];
		for (const c of node.content ?? []) {
			if (c.type === 'text' && typeof c.text === 'string') {
				const f = formatOf(c.marks, base);
				const r = run(c.text, f);
				out.push(f.href ? new ExternalHyperlink({ link: f.href, children: [r] }) : r);
			} else if (c.type === 'hardBreak') {
				out.push(new TextRun({ text: '', break: 1 }));
			} else if (c.type === 'image') {
				const img = this.image(c);
				if (img) out.push(img);
			}
		}
		return out;
	}

	image(node: PmNode): ImageRun | TextRun | null {
		const id = node.attrs?.assetId;
		const alt = typeof node.attrs?.alt === 'string' ? node.attrs.alt.slice(0, 300) : '';
		const img = isUuid(id) ? this.opts.images?.get(id) : undefined;
		if (!img) return alt ? new TextRun({ text: `[Bild: ${alt}]`, italics: true }) : null;
		const ratio = img.width && img.height ? img.height / img.width : 0.75;
		const wanted = Number(node.attrs?.width);
		let width = Math.min(
			MAX_IMAGE_WIDTH_PX,
			Number.isFinite(wanted) && wanted > 16 ? wanted : (img.width ?? MAX_IMAGE_WIDTH_PX)
		);
		let height = width * ratio;
		if (height > MAX_IMAGE_HEIGHT_PX) {
			height = MAX_IMAGE_HEIGHT_PX;
			width = height / ratio;
		}
		return new ImageRun({
			type: img.type,
			data: img.data,
			transformation: { width: Math.round(width), height: Math.round(height) },
			altText: alt
				? { name: alt.slice(0, 100), description: alt, title: alt.slice(0, 100) }
				: undefined
		});
	}

	paragraph(
		node: PmNode,
		extra: Omit<IParagraphOptions, 'children'> = {},
		base: Format = {}
	): Paragraph {
		const align = safeAlign(node.attrs?.textAlign);
		return new Paragraph({
			alignment: align ? ALIGN[align] : undefined,
			...extra,
			children: this.inline(node, base)
		});
	}

	/**
	 * Liste. Geordnete Listen mit Nummerierungsart (Gliederung, a), römisch …; auch geerbt) bekommen die Nummer als
	 * Text mit hängendem Einzug – so stimmen die Nummern mit Editor und PDF überein; Standardlisten nutzen die
	 * Word-Nummerierung.
	 */
	list(
		node: PmNode,
		level: number,
		ordered: boolean,
		instance: number,
		parent: { ctx: ListContext; item: number } | null = null
	): Block[] {
		const out: Block[] = [];
		const ctx = ordered
			? childListContext(parent?.ctx ?? null, ownListStyle(node.attrs), parent?.item)
			: (parent?.ctx ?? null);
		const literal = ordered && !!ctx?.style;
		const start = listStart(node.attrs?.start);
		const hanging = ctx?.style === 'outline' ? 720 : 454;
		(node.content ?? []).forEach((item, index) => {
			const n = start + index;
			const here = ctx ? { ctx, item: n } : null;
			let first = true;
			for (const child of item.content ?? []) {
				if (child.type === 'bulletList' || child.type === 'orderedList') {
					const inst = ++this.listInstance;
					out.push(...this.list(child, level + 1, child.type === 'orderedList', inst, here));
				} else if (child.type === 'taskList') {
					out.push(...this.tasks(child, level + 1));
				} else if (literal && (child.type === 'paragraph' || child.type === 'heading')) {
					const left = 720 * level + hanging + 360;
					const align = safeAlign(child.attrs?.textAlign);
					out.push(
						new Paragraph({
							alignment: align ? ALIGN[align] : undefined,
							indent: first ? { left, hanging } : { left },
							children: [
								...(first ? [new TextRun({ children: [listMarker(ctx!, n), new Tab()] })] : []),
								...this.inline(child)
							]
						})
					);
					first = false;
				} else if (child.type === 'paragraph' || child.type === 'heading') {
					out.push(
						this.paragraph(
							child,
							first
								? {
										numbering: {
											reference: ordered ? 'notes-numbers' : 'notes-bullets',
											level: Math.min(level, 8),
											instance
										}
									}
								: { indent: { left: 720 * (level + 1) } }
						)
					);
					first = false;
				} else {
					out.push(...this.blocks([child]));
				}
			}
		});
		return out;
	}

	tasks(node: PmNode, level: number): Block[] {
		const out: Block[] = [];
		for (const item of node.content ?? []) {
			const checked = item.attrs?.checked === true;
			let first = true;
			for (const child of item.content ?? []) {
				if (child.type === 'taskList') {
					out.push(...this.tasks(child, level + 1));
				} else if (child.type === 'bulletList' || child.type === 'orderedList') {
					out.push(
						...this.list(child, level + 1, child.type === 'orderedList', ++this.listInstance)
					);
				} else if (child.type === 'paragraph') {
					const box = first ? [new TextRun({ text: checked ? '☑ ' : '☐ ' })] : [];
					out.push(
						new Paragraph({
							indent: { left: 360 + 360 * level, hanging: first ? 300 : 0 },
							children: [
								...box,
								...this.inline(child, checked ? { strike: false, color: '6B7280' } : {})
							]
						})
					);
					first = false;
				}
			}
		}
		return out;
	}

	table(node: PmNode): Table | null {
		const rows: TableRow[] = [];
		for (const row of node.content ?? []) {
			const cells: TableCell[] = [];
			for (const cell of row.content ?? []) {
				const header = cell.type === 'tableHeader';
				const colspan = Number(cell.attrs?.colspan);
				const rowspan = Number(cell.attrs?.rowspan);
				const children = this.blocks(cell.content ?? [], header ? { bold: true } : {});
				cells.push(
					new TableCell({
						children: children.length ? children : [new Paragraph({ children: [] })],
						columnSpan:
							Number.isInteger(colspan) && colspan > 1 && colspan < 100 ? colspan : undefined,
						rowSpan:
							Number.isInteger(rowspan) && rowspan > 1 && rowspan < 100 ? rowspan : undefined,
						shading: header ? { type: ShadingType.CLEAR, color: 'auto', fill: 'F3F4F6' } : undefined
					})
				);
			}
			if (cells.length) rows.push(new TableRow({ children: cells }));
		}
		if (!rows.length) return null;
		return new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } });
	}

	embed(node: PmNode): Paragraph {
		const a = node.attrs ?? {};
		const info =
			typeof a.module === 'string' && typeof a.kind === 'string' && isUuid(a.refId)
				? this.opts.embeds?.get(
						embedKey({ module: a.module, kind: a.kind, refId: String(a.refId) })
					)
				: undefined;
		const label = embedLabel(info);
		const href = info?.href ? safeHref(info.href) : null;
		const border = { style: BorderStyle.DASHED, size: 6, color: '9CA3AF', space: 4 };
		return new Paragraph({
			border: { top: border, bottom: border, left: border, right: border },
			children: [
				new TextRun({ text: label, bold: true }),
				new TextRun({ text: '', break: 1 }),
				href
					? new ExternalHyperlink({
							link: href,
							children: [run(href, { href, size: 18 })]
						})
					: new TextRun({ text: 'Nur in der App sichtbar', color: '6B7280', size: 18 })
			]
		});
	}

	blocks(nodes: readonly PmNode[], base: Format = {}): Block[] {
		const out: Block[] = [];
		for (const node of nodes) {
			switch (node.type) {
				case 'paragraph':
					out.push(this.paragraph(node, {}, base));
					break;
				case 'heading': {
					const level = Math.min(3, Math.max(1, Math.round(Number(node.attrs?.level) || 1)));
					out.push(this.paragraph(node, { heading: HEADINGS[level - 1] }, base));
					break;
				}
				case 'bulletList':
				case 'orderedList':
					out.push(...this.list(node, 0, node.type === 'orderedList', ++this.listInstance));
					break;
				case 'taskList':
					out.push(...this.tasks(node, 0));
					break;
				case 'blockquote':
					// je Block ein eingerückter Absatz mit Linie links (Listen o. Ä. im Zitat als reiner Text)
					for (const c of node.content ?? []) {
						out.push(
							new Paragraph({
								indent: { left: 567 },
								border: {
									left: { style: BorderStyle.SINGLE, size: 12, color: 'D1D5DB', space: 8 }
								},
								children: this.inline(
									c.type === 'paragraph' || c.type === 'heading'
										? c
										: { type: 'paragraph', content: textNodes(c) },
									{ ...base, color: '374151' }
								)
							})
						);
					}
					break;
				case 'codeBlock': {
					const text = (node.content ?? []).map((c) => c.text ?? '').join('');
					for (const line of text.split('\n')) {
						out.push(
							new Paragraph({
								shading: { type: ShadingType.CLEAR, color: 'auto', fill: 'F3F4F6' },
								spacing: { before: 0, after: 0 },
								children: [new TextRun({ text: line || ' ', font: 'Courier New', size: 19 })]
							})
						);
					}
					out.push(new Paragraph({ children: [] }));
					break;
				}
				case 'horizontalRule':
					out.push(
						new Paragraph({
							border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'D1D5DB', space: 1 } },
							children: []
						})
					);
					break;
				case 'table': {
					const t = this.table(node);
					if (t) out.push(t, new Paragraph({ children: [] }));
					break;
				}
				case 'image': {
					const img = this.image(node);
					if (img) out.push(new Paragraph({ children: [img] }));
					break;
				}
				case 'embed':
					out.push(this.embed(node));
					break;
				default:
					if (node.content?.length) out.push(...this.blocks(node.content, base));
			}
		}
		return out;
	}
}

/** Alle Textknoten eines Teilbaums (flach, für Zitate mit Listen o. Ä.) */
function textNodes(node: PmNode): PmNode[] {
	const out: PmNode[] = [];
	const stack: PmNode[] = [node];
	while (stack.length) {
		const n = stack.pop()!;
		if (n.type === 'text') out.push(n);
		const c = n.content ?? [];
		for (let i = c.length - 1; i >= 0; i--) stack.push(c[i]!);
	}
	return out;
}

const bulletLevels = Array.from({ length: 9 }, (_, level) => ({
	level,
	format: LevelFormat.BULLET,
	text: ['•', '◦', '▪'][level % 3]!,
	alignment: AlignmentType.LEFT,
	style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } }
}));

const numberLevels = Array.from({ length: 9 }, (_, level) => ({
	level,
	format: [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN][level % 3]!,
	text: `%${level + 1}.`,
	alignment: AlignmentType.LEFT,
	style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } }
}));

/** Word-Dokument aller Seiten (Bytes einer .docx-Datei) */
export async function exportDocx(
	pages: readonly DocxPage[],
	opts: DocxOptions = {}
): Promise<Uint8Array> {
	const b = new Builder(opts);
	const children: Block[] = [];
	pages.forEach((p, i) => {
		children.push(
			new Paragraph({
				heading: HeadingLevel.TITLE,
				pageBreakBefore: i > 0,
				children: [new TextRun({ text: p.title || 'Ohne Titel' })]
			})
		);
		const doc = p.json as PmNode;
		children.push(...b.blocks(doc?.content ?? []));
	});
	const document = new Document({
		creator: 'EP Intern',
		title: opts.title ?? pages[0]?.title ?? 'Notiz',
		styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
		numbering: {
			config: [
				{ reference: 'notes-bullets', levels: bulletLevels },
				{ reference: 'notes-numbers', levels: numberLevels }
			]
		},
		sections: [{ children }]
	});
	return new Uint8Array(await Packer.toBuffer(document));
}
