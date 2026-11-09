/**
 * Reine Hilfen auf ProseMirror-JSON der Notizen (Server und Browser): Klartext für Suche/Vorschau,
 * verwendete Bilder und Einbettungen.
 */
import { isUuid } from './extensions';

export interface PmNode {
	type?: string;
	text?: string;
	attrs?: Record<string, unknown>;
	marks?: { type: string; attrs?: Record<string, unknown> }[];
	content?: PmNode[];
}

const BLOCKS = new Set([
	'paragraph',
	'heading',
	'blockquote',
	'codeBlock',
	'listItem',
	'taskItem',
	'tableRow',
	'horizontalRule',
	'image',
	'embed'
]);

/** Alle Knoten der Tiefe nach (ohne Rekursion, große Dokumente) */
export function* walk(root: unknown): Generator<PmNode> {
	const stack: PmNode[] = [root as PmNode];
	while (stack.length) {
		const node = stack.pop()!;
		if (!node || typeof node !== 'object') continue;
		yield node;
		const content = Array.isArray(node.content) ? node.content : [];
		for (let i = content.length - 1; i >= 0; i--) stack.push(content[i]!);
	}
}

/** Klartext (Absätze durch Zeilenumbrüche getrennt, höchstens `max` Zeichen) */
export function plainTextOf(root: unknown, max = 200_000): string {
	const parts: string[] = [];
	let len = 0;
	const stack: { node: PmNode; close: boolean }[] = [{ node: root as PmNode, close: false }];
	while (stack.length && len < max) {
		const { node, close } = stack.pop()!;
		if (close) {
			parts.push('\n');
			len += 1;
			continue;
		}
		if (!node || typeof node !== 'object') continue;
		if (node.type === 'text' && typeof node.text === 'string') {
			parts.push(node.text);
			len += node.text.length;
			continue;
		}
		if (node.type === 'hardBreak') {
			parts.push('\n');
			continue;
		}
		if (node.type === 'tableCell' || node.type === 'tableHeader') parts.push(' ');
		if (node.type && BLOCKS.has(node.type)) stack.push({ node, close: true });
		const content = Array.isArray(node.content) ? node.content : [];
		for (let i = content.length - 1; i >= 0; i--) stack.push({ node: content[i]!, close: false });
	}
	return parts
		.join('')
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim()
		.slice(0, max);
}

/** Textanfang für Listen */
export function excerptOf(text: string, max = 160): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Bild-Assets im Dokument (Reihenfolge des Auftretens, ohne Doppelte) */
export function assetIdsOf(root: unknown): string[] {
	const seen = new Set<string>();
	for (const n of walk(root)) {
		if (n.type === 'image' && isUuid(n.attrs?.assetId)) seen.add(String(n.attrs!.assetId));
	}
	return [...seen];
}

export interface EmbedRef {
	module: string;
	kind: string;
	refId: string;
}

/** Einbettungen im Dokument */
export function embedsOf(root: unknown): EmbedRef[] {
	const list: EmbedRef[] = [];
	for (const n of walk(root)) {
		if (n.type !== 'embed') continue;
		const a = n.attrs ?? {};
		if (typeof a.module === 'string' && typeof a.kind === 'string' && isUuid(a.refId)) {
			list.push({ module: a.module, kind: a.kind, refId: String(a.refId) });
		}
	}
	return list;
}
