<script lang="ts">
	// Quelltext-Ansicht (Markdown): Tippen wird nach 800 ms Ruhe BLOCKWEISE in den Editor übernommen
	// (nur der geänderte Bereich, eine Transaktion) – gleichzeitige Änderungen anderer an anderen Stellen bleiben.
	// Während das Feld fokussiert ist, werden Fremdänderungen nicht hineingespiegelt (Hinweis + „Neu laden“).
	import { onDestroy, onMount } from 'svelte';
	import type { Editor, JSONContent } from '@tiptap/core';
	import { MarkdownManager } from '@tiptap/markdown';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import X from '@lucide/svelte/icons/x';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Button } from '$lib/components/ui/button';
	import { Textarea } from '$lib/components/ui/textarea';
	import { noteExtensions } from '../../doc/extensions';
	import {
		applyPlan,
		blockPositions,
		canonical,
		chunksFromBlocks,
		chunksText,
		planSourceEdit,
		type SourceChunk
	} from './source-diff';

	let {
		editor,
		canEdit,
		onclose
	}: {
		editor: Editor;
		canEdit: boolean;
		onclose: () => void;
	} = $props();

	const manager = new MarkdownManager({ extensions: noteExtensions() });
	const APPLY_MS = 800;

	let text = $state('');
	let chunks: SourceChunk[] = [];
	let focused = $state(false);
	let dirty = false;
	let stale = $state(false);
	let conflict = $state(false);
	let applying = false;
	let applyTimer: ReturnType<typeof setTimeout> | null = null;
	let syncTimer: ReturnType<typeof setTimeout> | null = null;

	const serializeBlock = (block: unknown) =>
		manager.serialize({ type: 'doc', content: [block as JSONContent] });

	function currentBlocks(): string[] {
		const out: string[] = [];
		editor.state.doc.forEach((child) => out.push(canonical(child.toJSON())));
		return out;
	}

	/** Textfeld aus dem Dokument neu aufbauen */
	function resync() {
		const blocks: unknown[] = [];
		editor.state.doc.forEach((child) => blocks.push(child.toJSON()));
		chunks = chunksFromBlocks(blocks, serializeBlock);
		text = chunksText(chunks);
		stale = false;
		conflict = false;
		dirty = false;
	}

	function applyNow() {
		if (applyTimer) clearTimeout(applyTimer);
		applyTimer = null;
		if (!dirty || !canEdit) return;
		const current = currentBlocks();
		const plan = planSourceEdit(chunks, current, text);
		if (plan.kind === 'none') {
			dirty = false;
			return;
		}
		if (plan.kind === 'conflict') {
			conflict = true;
			stale = true;
			return;
		}
		const parsed = (manager.parse(plan.text).content ?? []) as JSONContent[];
		const sizes: number[] = [];
		editor.state.doc.forEach((child) => sizes.push(child.nodeSize));
		const range = blockPositions(sizes, plan.fromBlock, plan.toBlock);
		const whole = range.from === 0 && range.to === editor.state.doc.content.size;
		applying = true;
		try {
			const chain = editor.chain();
			if (parsed.length) chain.insertContentAt(range, parsed, { updateSelection: false });
			else if (whole)
				chain.insertContentAt(range, { type: 'paragraph' }, { updateSelection: false });
			else chain.deleteRange(range);
			chain.run();
		} finally {
			applying = false;
		}
		const kept = current.length - (plan.toBlock - plan.fromBlock);
		const after = currentBlocks();
		const added = Math.max(0, after.length - kept);
		chunks = applyPlan(chunks, plan, after.slice(plan.fromBlock, plan.fromBlock + added));
		dirty = false;
		conflict = false;
	}

	function oninput() {
		dirty = true;
		if (applyTimer) clearTimeout(applyTimer);
		applyTimer = setTimeout(applyNow, APPLY_MS);
	}

	function onDocUpdate() {
		if (applying) return;
		if (focused || dirty) {
			stale = true;
			return;
		}
		if (syncTimer) return;
		syncTimer = setTimeout(() => {
			syncTimer = null;
			if (!focused && !dirty) resync();
			else stale = true;
		}, 300);
	}

	function reload() {
		applyNow();
		resync();
	}

	onMount(() => {
		resync();
		editor.on('update', onDocUpdate);
	});

	onDestroy(() => {
		editor.off('update', onDocUpdate);
		if (syncTimer) clearTimeout(syncTimer);
		// Ausstehendes noch übernehmen
		applyNow();
	});
</script>

<section class="flex h-full min-h-0 flex-col" aria-label="Quelltext (Markdown)">
	<div class="flex h-10 shrink-0 items-center gap-2 border-b px-3">
		<span class="text-sm font-medium">Markdown</span>
		<span class="text-xs text-muted-foreground">
			{canEdit ? 'Änderungen werden nach kurzer Pause übernommen' : 'Nur Ansicht'}
		</span>
		<span class="flex-1"></span>
		<Button variant="ghost" size="icon-sm" aria-label="Quelltext schließen" onclick={onclose}>
			<X />
		</Button>
	</div>
	{#if stale}
		<div class="shrink-0 p-2">
			<Alert variant={conflict ? 'warning' : 'info'}>
				<AlertDescription class="flex flex-wrap items-center gap-2">
					<span class="flex-1">
						{conflict
							? 'Andere haben genau diese Stelle geändert – deine Eingabe wurde nicht übernommen.'
							: 'Andere haben geändert – neu laden, um den aktuellen Stand zu sehen.'}
					</span>
					<Button size="sm" variant="outline" onclick={reload}><RefreshCw /> Neu laden</Button>
				</AlertDescription>
			</Alert>
		</div>
	{/if}
	<div class="min-h-0 flex-1 p-2">
		<Textarea
			bind:value={text}
			readonly={!canEdit}
			spellcheck={false}
			aria-label="Markdown-Quelltext"
			class="h-full min-h-0 resize-none overflow-auto font-mono text-sm leading-relaxed [field-sizing:fixed]"
			{oninput}
			onfocus={() => (focused = true)}
			onblur={() => {
				focused = false;
				applyNow();
				if (stale && !conflict) resync();
			}}
		/>
	</div>
</section>
