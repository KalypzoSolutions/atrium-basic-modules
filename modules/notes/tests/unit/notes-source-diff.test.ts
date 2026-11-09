import { describe, expect, it } from 'vitest';
import {
	applyPlan,
	blockPositions,
	canonical,
	chunksText,
	commonEnds,
	mapRange,
	planSourceEdit,
	type SourceChunk
} from '$modules/notes/pages/editor/source-diff';

const block = (text: string) => canonical({ type: 'paragraph', content: [{ type: 'text', text }] });
const chunk = (text: string): SourceChunk => ({ text, blocks: [block(text)] });

describe('notes: Quelltext-Ansicht blockweise übernehmen', () => {
	const chunks = [chunk('# Titel'), chunk('Absatz eins'), chunk('Absatz zwei'), chunk('Ende')];
	const current = chunks.flatMap((c) => c.blocks);

	it('canonical ist unabhängig von der Reihenfolge der Schlüssel', () => {
		expect(canonical({ b: 1, a: { d: 2, c: 3 } })).toBe(canonical({ a: { c: 3, d: 2 }, b: 1 }));
		expect(canonical({ a: undefined, b: 1 })).toBe('{"b":1}');
	});

	it('commonEnds überlappt nie', () => {
		expect(commonEnds('aaa', 'aa')).toEqual({ prefix: 2, suffix: 0 });
		expect(commonEnds('abc', 'abc')).toEqual({ prefix: 3, suffix: 0 });
		expect(commonEnds('abXc', 'abYc')).toEqual({ prefix: 2, suffix: 1 });
	});

	it('keine Änderung → none', () => {
		expect(planSourceEdit(chunks, current, chunksText(chunks))).toEqual({ kind: 'none' });
	});

	it('Änderung in einem Block ersetzt nur diesen', () => {
		const next = chunksText(chunks).replace('Absatz zwei', 'Absatz 2');
		const plan = planSourceEdit(chunks, current, next);
		expect(plan).toEqual({
			kind: 'replace',
			fromChunk: 2,
			toChunk: 3,
			fromBlock: 2,
			toBlock: 3,
			text: 'Absatz 2'
		});
	});

	it('Tippen am Ende eines Blocks bleibt in diesem Block', () => {
		const next = chunksText(chunks).replace('Absatz eins', 'Absatz eins!');
		const plan = planSourceEdit(chunks, current, next);
		expect(plan.kind === 'replace' && [plan.fromBlock, plan.toBlock, plan.text]).toEqual([
			1,
			2,
			'Absatz eins!'
		]);
	});

	it('Trenner löschen verbindet zwei Blöcke', () => {
		const next = chunksText(chunks).replace('eins\n\nAbsatz', 'eins Absatz');
		const plan = planSourceEdit(chunks, current, next);
		expect(plan.kind === 'replace' && [plan.fromBlock, plan.toBlock, plan.text]).toEqual([
			1,
			3,
			'Absatz eins Absatz zwei'
		]);
	});

	it('neuer Absatz zwischen zwei Blöcken', () => {
		const next = chunksText(chunks).replace('eins\n\n', 'eins\n\nNeu\n\n');
		const plan = planSourceEdit(chunks, current, next);
		expect(plan.kind).toBe('replace');
		if (plan.kind !== 'replace') return;
		// Bereich enthält den neuen Text, Nachbarn bleiben außerhalb oder unverändert im Text
		expect(plan.text).toContain('Neu');
		expect(plan.fromBlock).toBeGreaterThanOrEqual(1);
		expect(plan.toBlock).toBeLessThanOrEqual(3);
	});

	it('Anhängen am Ende', () => {
		const next = `${chunksText(chunks)}\n\nNoch was`;
		const plan = planSourceEdit(chunks, current, next);
		expect(plan.kind === 'replace' && [plan.fromBlock, plan.toBlock, plan.text]).toEqual([
			3,
			4,
			'Ende\n\nNoch was'
		]);
	});

	it('Fremdänderung VOR dem eigenen Bereich verschiebt (eingefügter Block)', () => {
		const remote = [current[0]!, block('Neu von anderen'), ...current.slice(1)];
		const next = chunksText(chunks).replace('Ende', 'Schluss');
		const plan = planSourceEdit(chunks, remote, next);
		expect(plan.kind === 'replace' && [plan.fromBlock, plan.toBlock]).toEqual([4, 5]);
	});

	it('Fremdänderung HINTER dem eigenen Bereich bleibt unberührt', () => {
		const remote = [...current.slice(0, 3), block('Ende (geändert)')];
		const next = chunksText(chunks).replace('# Titel', '# Neuer Titel');
		const plan = planSourceEdit(chunks, remote, next);
		expect(plan.kind === 'replace' && [plan.fromBlock, plan.toBlock]).toEqual([0, 1]);
	});

	it('Fremdänderung im selben Block → Konflikt', () => {
		const remote = [current[0]!, current[1]!, block('Absatz zwei (fremd)'), current[3]!];
		const next = chunksText(chunks).replace('Absatz zwei', 'Absatz 2');
		expect(planSourceEdit(chunks, remote, next)).toEqual({ kind: 'conflict' });
	});

	it('leeres Dokument wird ganz ersetzt', () => {
		const plan = planSourceEdit([], [canonical({ type: 'paragraph' })], '# Hallo');
		expect(plan).toEqual({
			kind: 'replace',
			fromChunk: 0,
			toChunk: 0,
			fromBlock: 0,
			toBlock: 1,
			text: '# Hallo'
		});
		expect(planSourceEdit([], [block('fremd')], 'x')).toEqual({ kind: 'conflict' });
	});

	it('applyPlan ersetzt die Stücke durch eines', () => {
		const next = chunksText(chunks).replace('eins\n\nAbsatz', 'eins Absatz');
		const plan = planSourceEdit(chunks, current, next);
		if (plan.kind !== 'replace') throw new Error('erwartet');
		const after = applyPlan(chunks, plan, [block('Absatz eins Absatz zwei')]);
		expect(after.map((c) => c.text)).toEqual(['# Titel', 'Absatz eins Absatz zwei', 'Ende']);
		expect(chunksText(after)).toBe(next);
	});

	it('mapRange ohne Fremdänderung', () => {
		expect(mapRange(current, current, 1, 2)).toEqual({ from: 1, to: 2 });
		// Block gelöscht vor dem Bereich
		expect(mapRange(current, [current[1]!, current[2]!, current[3]!], 2, 3)).toEqual({
			from: 1,
			to: 2
		});
	});

	it('blockPositions summiert nodeSize', () => {
		expect(blockPositions([5, 7, 3], 1, 3)).toEqual({ from: 5, to: 15 });
		expect(blockPositions([5, 7, 3], 0, 0)).toEqual({ from: 0, to: 0 });
	});
});
