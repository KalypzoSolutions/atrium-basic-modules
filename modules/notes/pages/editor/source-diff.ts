/**
 * Reine Logik der Quelltext-Ansicht (ohne DOM, ohne Tiptap): Der Markdown-Text im Textfeld besteht aus „Stücken“,
 * die jeweils einem oder mehreren Top-Level-Blöcken des Dokuments entsprechen. Eine Änderung im Textfeld wird auf den
 * kleinsten zusammenhängenden Bereich von Stücken abgebildet; nur diese Blöcke ersetzt der Editor (eine Transaktion),
 * damit gleichzeitige Änderungen anderer an anderen Stellen erhalten bleiben.
 */

/** Trenner zwischen zwei Stücken im Textfeld */
export const SEPARATOR = '\n\n';

export interface SourceChunk {
	/** Markdown dieses Stücks (ohne Trenner) */
	text: string;
	/** Kanonisches JSON der zugehörigen Top-Level-Blöcke (Vergleich mit dem aktuellen Dokument) */
	blocks: string[];
}

export type SourcePlan =
	| { kind: 'none' }
	/** Bereich wurde inzwischen von anderen geändert – nicht übernehmen */
	| { kind: 'conflict' }
	| {
			kind: 'replace';
			/** Stücke `[fromChunk, toChunk)` werden durch ein neues Stück ersetzt */
			fromChunk: number;
			toChunk: number;
			/** Top-Level-Blöcke `[fromBlock, toBlock)` des AKTUELLEN Dokuments */
			fromBlock: number;
			toBlock: number;
			/** neues Markdown des Bereichs (wird geparst) */
			text: string;
	  };

/** JSON mit sortierten Schlüsseln (gleiches Ergebnis unabhängig von der Reihenfolge der Attribute) */
export function canonical(value: unknown): string {
	return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			const v = (value as Record<string, unknown>)[key];
			if (v !== undefined) out[key] = sortKeys(v);
		}
		return out;
	}
	return value;
}

/** Text des Textfelds aus den Stücken */
export function chunksText(chunks: readonly SourceChunk[]): string {
	return chunks.map((c) => c.text).join(SEPARATOR);
}

/** Stücke aus dem Dokument (je Top-Level-Block ein Stück) */
export function chunksFromBlocks(
	blocks: readonly unknown[],
	serialize: (block: unknown) => string
): SourceChunk[] {
	return blocks.map((b) => ({ text: trimNewlines(serialize(b)), blocks: [canonical(b)] }));
}

export function trimNewlines(text: string): string {
	return text.replace(/^\n+|\n+$/g, '');
}

/** Gemeinsamer Anfang/Ende zweier Texte (überlappen nie) */
export function commonEnds(a: string, b: string): { prefix: number; suffix: number } {
	const max = Math.min(a.length, b.length);
	let prefix = 0;
	while (prefix < max && a.charCodeAt(prefix) === b.charCodeAt(prefix)) prefix++;
	let suffix = 0;
	while (
		suffix < max - prefix &&
		a.charCodeAt(a.length - 1 - suffix) === b.charCodeAt(b.length - 1 - suffix)
	)
		suffix++;
	return { prefix, suffix };
}

/** Gemeinsamer Anfang/Ende zweier Listen (Blöcke als kanonisches JSON) */
export function commonBlockEnds(
	a: readonly string[],
	b: readonly string[]
): { prefix: number; suffix: number } {
	const max = Math.min(a.length, b.length);
	let prefix = 0;
	while (prefix < max && a[prefix] === b[prefix]) prefix++;
	let suffix = 0;
	while (suffix < max - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
	return { prefix, suffix };
}

/**
 * Plan für eine Änderung des Textfelds.
 * @param chunks Stand des Textfelds (letzte Übernahme bzw. Synchronisierung)
 * @param current aktuelle Top-Level-Blöcke des Dokuments (kanonisches JSON)
 * @param newText neuer Inhalt des Textfelds
 */
export function planSourceEdit(
	chunks: readonly SourceChunk[],
	current: readonly string[],
	newText: string
): SourcePlan {
	const oldText = chunksText(chunks);
	if (newText === oldText) return { kind: 'none' };
	const base = chunks.flatMap((c) => c.blocks);

	if (chunks.length === 0) {
		// leeres Dokument: alles ersetzen (Fremdänderungen in der Zwischenzeit → Konflikt)
		if (current.some((b) => b.includes('"content"'))) return { kind: 'conflict' };
		return {
			kind: 'replace',
			fromChunk: 0,
			toChunk: 0,
			fromBlock: 0,
			toBlock: current.length,
			text: newText
		};
	}

	const { prefix, suffix } = commonEnds(oldText, newText);
	// Anfang/Ende jedes Stücks im alten Text
	const starts: number[] = [];
	const ends: number[] = [];
	let offset = 0;
	for (const c of chunks) {
		starts.push(offset);
		ends.push(offset + c.text.length);
		offset += c.text.length + SEPARATOR.length;
	}
	const changeEnd = oldText.length - suffix;
	let fromChunk = 0;
	for (let i = 0; i < chunks.length; i++) if (starts[i]! <= prefix) fromChunk = i;
	let toChunkIncl = chunks.length - 1;
	for (let i = chunks.length - 1; i >= 0; i--) if (ends[i]! >= changeEnd) toChunkIncl = i;
	if (toChunkIncl < fromChunk) toChunkIncl = fromChunk;

	const head = starts[fromChunk]!;
	const tail = oldText.length - ends[toChunkIncl]!;
	const text = newText.slice(head, newText.length - tail);

	// Blockbereich im Stand des Textfelds
	let baseFrom = 0;
	for (let i = 0; i < fromChunk; i++) baseFrom += chunks[i]!.blocks.length;
	let baseTo = baseFrom;
	for (let i = fromChunk; i <= toChunkIncl; i++) baseTo += chunks[i]!.blocks.length;

	// Auf das aktuelle Dokument abbilden (andere können inzwischen woanders geändert haben)
	const range = mapRange(base, current, baseFrom, baseTo);
	if (!range) return { kind: 'conflict' };
	return {
		kind: 'replace',
		fromChunk,
		toChunk: toChunkIncl + 1,
		fromBlock: range.from,
		toBlock: range.to,
		text
	};
}

/**
 * Bereich `[from, to)` aus `base` in `current` wiederfinden. Fremdänderungen bilden (über gemeinsamen Anfang/Ende)
 * einen zusammenhängenden Bereich; liegt er ganz vor bzw. hinter dem eigenen Bereich, wird verschoben, sonst Konflikt.
 */
export function mapRange(
	base: readonly string[],
	current: readonly string[],
	from: number,
	to: number
): { from: number; to: number } | null {
	const { prefix, suffix } = commonBlockEnds(base, current);
	if (prefix === base.length && prefix === current.length) return { from, to };
	const changedFrom = prefix;
	const changedTo = base.length - suffix; // exklusiv, im Stand `base`
	const delta = current.length - base.length;
	// eigener Bereich liegt vor der Fremdänderung
	if (to <= changedFrom && to > from) return { from, to };
	if (from >= changedTo) return { from: from + delta, to: to + delta };
	return null;
}

/** Stücke nach erfolgreicher Übernahme: Bereich durch EIN Stück mit dem eingegebenen Text ersetzen */
export function applyPlan(
	chunks: readonly SourceChunk[],
	plan: Extract<SourcePlan, { kind: 'replace' }>,
	newBlocks: readonly string[]
): SourceChunk[] {
	const replacement: SourceChunk[] =
		newBlocks.length || plan.text.trim() ? [{ text: plan.text, blocks: [...newBlocks] }] : [];
	return [...chunks.slice(0, plan.fromChunk), ...replacement, ...chunks.slice(plan.toChunk)];
}

/** Dokumentpositionen eines Bereichs von Top-Level-Blöcken (`sizes` = `nodeSize` je Block) */
export function blockPositions(
	sizes: readonly number[],
	from: number,
	to: number
): { from: number; to: number } {
	let start = 0;
	for (let i = 0; i < from; i++) start += sizes[i] ?? 0;
	let end = start;
	for (let i = from; i < to; i++) end += sizes[i] ?? 0;
	return { from: start, to: end };
}
