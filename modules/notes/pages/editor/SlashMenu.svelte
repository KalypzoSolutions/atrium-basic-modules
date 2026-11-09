<script lang="ts" module>
	import type { Component } from 'svelte';

	export interface SlashItem {
		id: string;
		label: string;
		description: string;
		icon: Component<{ class?: string }>;
		keywords?: string;
		run: () => void;
	}
</script>

<script lang="ts">
	// Befehlsmenü bei „/“ am Zeilenanfang oder nach einem Leerzeichen: Filter beim Tippen, Pfeiltasten, Enter, Esc
	import type { Editor } from '@tiptap/core';
	import { cn } from '$lib/utils';

	let {
		editor,
		tick,
		items
	}: {
		editor: Editor | null;
		tick: number;
		items: SlashItem[];
	} = $props();

	let active = $state(0);
	let dismissedAt = $state<number | null>(null);
	let list = $state<HTMLUListElement | null>(null);

	const fold = (s: string) =>
		s
			.toLowerCase()
			.normalize('NFD')
			.replace(/\p{Diacritic}/gu, '')
			.replace(/ß/g, 'ss');

	const match = $derived.by(() => {
		void tick;
		if (!editor || !editor.isEditable || !editor.isFocused) return null;
		const sel = editor.state.selection;
		if (!sel.empty) return null;
		const head = sel.$from;
		if (!head.parent.isTextblock || head.parent.type.spec.code) return null;
		const text = head.parent.textBetween(0, head.parentOffset, undefined, '￼');
		const m = /(?:^|\s)\/([^\s/]{0,30})$/.exec(text);
		if (!m) return null;
		const query = m[1] ?? '';
		const from = head.pos - query.length - 1;
		if (from === dismissedAt) return null;
		return { from, to: head.pos, query };
	});

	const filtered = $derived.by(() => {
		if (!match) return [];
		const q = fold(match.query);
		if (!q) return items;
		return items.filter((i) => fold(`${i.label} ${i.keywords ?? ''}`).includes(q));
	});

	const position = $derived.by(() => {
		if (!match || !editor) return null;
		try {
			const c = editor.view.coordsAtPos(match.from);
			const below = window.innerHeight - c.bottom > 320;
			return {
				left: Math.max(8, Math.min(c.left, window.innerWidth - 296)),
				top: below ? c.bottom + 6 : undefined,
				bottom: below ? undefined : window.innerHeight - c.top + 6
			};
		} catch {
			return null;
		}
	});

	const open = $derived(!!match && filtered.length > 0 && !!position);

	$effect(() => {
		void match?.query;
		active = 0;
	});

	$effect(() => {
		// Auswahl sichtbar halten
		const el = list?.querySelector<HTMLElement>(`[data-index="${active}"]`);
		el?.scrollIntoView({ block: 'nearest' });
	});

	function choose(item: SlashItem) {
		if (!editor || !match) return;
		editor.chain().focus().deleteRange({ from: match.from, to: match.to }).run();
		item.run();
	}

	/** Vom Editor (`handleKeyDown`) aufgerufen; `true` = Taste verbraucht */
	export function onKeyDown(e: KeyboardEvent): boolean {
		if (!open || !match) return false;
		if (e.key === 'ArrowDown') {
			active = (active + 1) % filtered.length;
			return true;
		}
		if (e.key === 'ArrowUp') {
			active = (active - 1 + filtered.length) % filtered.length;
			return true;
		}
		if (e.key === 'Enter' || e.key === 'Tab') {
			const item = filtered[active];
			if (item) choose(item);
			return true;
		}
		if (e.key === 'Escape') {
			dismissedAt = match.from;
			return true;
		}
		return false;
	}
</script>

{#if open && position}
	<div
		class="fixed z-50 w-72 overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-lg"
		style:left={`${position.left}px`}
		style:top={position.top !== undefined ? `${position.top}px` : undefined}
		style:bottom={position.bottom !== undefined ? `${position.bottom}px` : undefined}
		role="presentation"
		onmousedown={(e) => e.preventDefault()}
	>
		<ul bind:this={list} class="max-h-80 overflow-y-auto p-1" role="listbox" aria-label="Befehle">
			{#each filtered as item, i (item.id)}
				<li
					role="option"
					aria-selected={i === active}
					data-index={i}
					class={cn(
						'flex cursor-pointer items-center gap-3 rounded-md px-2 py-1.5',
						i === active && 'bg-muted'
					)}
					onmouseenter={() => (active = i)}
					onclick={() => choose(item)}
					onkeydown={() => undefined}
				>
					<span
						class="flex size-8 shrink-0 items-center justify-center rounded-md border bg-background"
						aria-hidden="true"
					>
						<item.icon class="size-4" />
					</span>
					<span class="min-w-0">
						<span class="block truncate text-sm font-medium">{item.label}</span>
						<span class="block truncate text-xs text-muted-foreground">{item.description}</span>
					</span>
				</li>
			{/each}
		</ul>
	</div>
{/if}
