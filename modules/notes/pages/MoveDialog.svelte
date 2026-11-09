<script lang="ts">
	// Seite verschieben: Ziel im Baum wählen (oberste Ebene oder eine Seite mit Bearbeiten-Zugriff), am Ende einreihen
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import House from '@lucide/svelte/icons/house';
	import { apiFetch } from '$lib/sdk/client';
	import { BUSY_SAVE } from '$lib/components/layout';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { cn } from '$lib/utils';
	import { MAX_CHILDREN, type NoteDetail, type NoteNode } from '../schemas';
	import NoteIcon from './NoteIcon.svelte';
	import { API, errMsg, noteTitle } from './helpers';
	import { NoteTreeState } from './tree/tree-state.svelte';

	let {
		open = $bindable(false),
		node,
		onmoved
	}: {
		open?: boolean;
		node: NoteNode | null;
		onmoved: (note: NoteDetail, oldParentId: string | null) => void;
	} = $props();

	const tree = new NoteTreeState();
	/** `''` = oberste Ebene */
	let target = $state<string | null>(null);
	let busy = $state(false);

	$effect(() => {
		if (!open) return;
		untrack(() => {
			target = null;
			tree.expanded.clear();
			tree.children.clear();
			void tree.loadRoots();
		});
	});

	const sections = $derived.by(() => {
		const r = tree.roots;
		if (!r) return [];
		return [
			{ label: 'Meine Notizen', items: r.own },
			{ label: 'Mit mir geteilt', items: r.shared },
			{ label: 'Aus Aktionen', items: r.actions as NoteNode[] }
		].filter((s) => s.items.length);
	});

	const selectable = (n: NoteNode) =>
		!!node && n.level === 'edit' && n.id !== node.id && !tree.isInside(n.id, node.id);

	async function move() {
		if (!node || target === null) return;
		busy = true;
		try {
			const parentId = target === '' ? null : target;
			const note = await apiFetch<NoteDetail>(`${API}/notes/${node.id}/move`, {
				method: 'POST',
				body: JSON.stringify({ parentId, position: MAX_CHILDREN })
			});
			toast.success('Seite verschoben');
			const old = node.parentId;
			open = false;
			onmoved(note, old);
		} catch (e) {
			toast.error(errMsg(e, 'Verschieben fehlgeschlagen'));
		} finally {
			busy = false;
		}
	}
</script>

{#snippet branch(items: NoteNode[], depth: number)}
	<ul role="group" class="grid gap-0.5">
		{#each items as n (n.id)}
			{@const ok = selectable(n)}
			{@const isOpen = tree.expanded.has(n.id)}
			<li>
				<div
					class={cn(
						'flex h-8 items-center gap-1 rounded-md pr-2 text-sm',
						target === n.id ? 'bg-muted font-medium' : 'hover:bg-muted/60'
					)}
					style:padding-left={`${depth * 0.875 + 0.25}rem`}
				>
					<button
						type="button"
						class={cn(
							'flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground',
							(!n.hasChildren || n.id === node?.id) && 'invisible'
						)}
						aria-label={isOpen ? 'Zuklappen' : 'Aufklappen'}
						onclick={() => void tree.toggle(n.id)}
					>
						<ChevronRight class={cn('size-3.5 transition-transform', isOpen && 'rotate-90')} />
					</button>
					<button
						type="button"
						class="flex min-w-0 flex-1 items-center gap-1.5 text-left disabled:opacity-50"
						disabled={!ok}
						aria-pressed={target === n.id}
						onclick={() => (target = n.id)}
					>
						<NoteIcon icon={n.icon} color={n.color} class="size-4" />
						<span class="truncate">{noteTitle(n.title)}</span>
					</button>
				</div>
				{#if isOpen && n.id !== node?.id}
					{@render branch(tree.children.get(n.id) ?? [], depth + 1)}
				{/if}
			</li>
		{/each}
	</ul>
{/snippet}

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Verschieben</Dialog.Title>
			<Dialog.Description>
				Wohin soll „{noteTitle(node?.title)}“ mit allen Unterseiten?
			</Dialog.Description>
		</Dialog.Header>
		<div class="max-h-[min(26rem,55dvh)] overflow-y-auto rounded-md border p-2" role="tree">
			<button
				type="button"
				class={cn(
					'mb-1 flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm',
					target === '' ? 'bg-muted font-medium' : 'hover:bg-muted/60'
				)}
				aria-pressed={target === ''}
				disabled={!node?.parentId && !!node}
				onclick={() => (target = '')}
			>
				<House class="size-4 text-muted-foreground" /> Oberste Ebene (Meine Notizen)
			</button>
			{#if tree.rootsError}
				<p class="p-2 text-sm text-destructive">{tree.rootsError}</p>
			{:else if !tree.roots}
				<p class="p-2 text-sm text-muted-foreground">Lädt …</p>
			{:else}
				{#each sections as s (s.label)}
					<p class="mt-2 px-2 text-xs font-medium text-muted-foreground">{s.label}</p>
					{@render branch(s.items, 0)}
				{/each}
			{/if}
		</div>
		<Dialog.Footer>
			<Button type="button" variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
			<Button type="button" disabled={busy || target === null} onclick={move}>
				{busy ? BUSY_SAVE : 'Hierhin verschieben'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
