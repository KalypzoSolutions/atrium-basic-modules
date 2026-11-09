<script lang="ts" module>
	import type { Component } from 'svelte';

	export interface TreeMenuEntry {
		label: string;
		icon: Component<{ class?: string }>;
		onclick: () => void;
		destructive?: boolean;
		separatorBefore?: boolean;
	}

	export type DropWhere = 'before' | 'after' | 'inside';
</script>

<script lang="ts">
	// Eine Zeile im Seitenbaum (rekursiv): aufklappen, öffnen, „+“, „…“-Menü, Rechtsklick, Ziehen
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import Plus from '@lucide/svelte/icons/plus';
	import * as ContextMenu from '$lib/components/ui/context-menu';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { cn } from '$lib/utils';
	import type { NoteNode } from '../../schemas';
	import NoteIcon from '../NoteIcon.svelte';
	import { noteTitle, notePath } from '../helpers';
	import type { NoteTreeState } from './tree-state.svelte';
	import Self from './TreeItem.svelte';

	let {
		node,
		depth,
		tree,
		activeId,
		dragging,
		entries,
		oncreatechild,
		ondragstart,
		ondragend,
		ondropon,
		onnavigate
	}: {
		node: NoteNode;
		depth: number;
		tree: NoteTreeState;
		activeId: string | null;
		dragging: NoteNode | null;
		entries: (node: NoteNode) => TreeMenuEntry[];
		oncreatechild: (node: NoteNode) => void;
		ondragstart: (node: NoteNode) => void;
		ondragend: () => void;
		ondropon: (target: NoteNode, where: DropWhere) => void;
		onnavigate?: () => void;
	} = $props();

	const open = $derived(tree.expanded.has(node.id));
	const kids = $derived(tree.children.get(node.id) ?? []);
	const loadingKids = $derived(tree.loading.has(node.id));
	const active = $derived(activeId === node.id);
	const canEdit = $derived(node.level === 'edit');
	let dropWhere = $state<DropWhere | null>(null);

	function whereFrom(e: DragEvent): DropWhere {
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		const y = (e.clientY - rect.top) / rect.height;
		if (y < 0.28) return 'before';
		if (y > 0.72) return 'after';
		return 'inside';
	}

	function allowed(where: DropWhere): boolean {
		if (!dragging || dragging.id === node.id) return false;
		if (tree.isInside(node.id, dragging.id)) return false;
		if (where === 'inside') return canEdit;
		return true;
	}

	function dragover(e: DragEvent) {
		if (!dragging) return;
		const where = whereFrom(e);
		if (!allowed(where)) {
			dropWhere = null;
			return;
		}
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		dropWhere = where;
	}

	function drop(e: DragEvent) {
		const where = dropWhere;
		dropWhere = null;
		if (!dragging || !where) return;
		e.preventDefault();
		ondropon(node, where);
	}
</script>

{#snippet dropdownEntries(list: TreeMenuEntry[])}
	{#each list as entry (entry.label)}
		{#if entry.separatorBefore}<DropdownMenu.Separator />{/if}
		<DropdownMenu.Item
			variant={entry.destructive ? 'destructive' : 'default'}
			onclick={entry.onclick}
		>
			<entry.icon class="size-4" />
			{entry.label}
		</DropdownMenu.Item>
	{/each}
{/snippet}

{#snippet contextEntries(list: TreeMenuEntry[])}
	{#each list as entry (entry.label)}
		{#if entry.separatorBefore}<ContextMenu.Separator />{/if}
		<ContextMenu.Item
			variant={entry.destructive ? 'destructive' : 'default'}
			onclick={entry.onclick}
		>
			<entry.icon class="size-4" />
			{entry.label}
		</ContextMenu.Item>
	{/each}
{/snippet}

<li role="treeitem" aria-expanded={node.hasChildren ? open : undefined} aria-selected={active}>
	<ContextMenu.Root>
		<ContextMenu.Trigger>
			{#snippet child({ props })}
				<div
					{...props}
					class={cn(
						'group relative flex h-8 items-center gap-0.5 rounded-md pr-1 text-sm hover:bg-muted',
						active && 'bg-muted font-medium text-foreground',
						dropWhere === 'inside' && 'ring-2 ring-ring',
						dragging?.id === node.id && 'opacity-50'
					)}
					style:padding-left={`${depth * 0.875 + 0.25}rem`}
					draggable="true"
					role="presentation"
					ondragstart={(e) => {
						e.dataTransfer?.setData('text/plain', node.id);
						if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
						ondragstart(node);
					}}
					ondragend={() => {
						dropWhere = null;
						ondragend();
					}}
					ondragover={dragover}
					ondragleave={() => (dropWhere = null)}
					ondrop={drop}
				>
					{#if dropWhere === 'before'}
						<span class="absolute inset-x-1 top-0 h-0.5 rounded bg-ring" aria-hidden="true"></span>
					{:else if dropWhere === 'after'}
						<span class="absolute inset-x-1 bottom-0 h-0.5 rounded bg-ring" aria-hidden="true"
						></span>
					{/if}
					<button
						type="button"
						class={cn(
							'flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-background',
							!node.hasChildren && 'invisible'
						)}
						aria-label={open ? 'Zuklappen' : 'Aufklappen'}
						tabindex="-1"
						onclick={() => void tree.toggle(node.id)}
					>
						<ChevronRight class={cn('size-3.5 transition-transform', open && 'rotate-90')} />
					</button>
					<a
						href={notePath(node.id)}
						class="flex min-w-0 flex-1 items-center gap-1.5 rounded py-1 outline-none focus-visible:ring-2 focus-visible:ring-ring"
						aria-current={active ? 'page' : undefined}
						draggable="false"
						onclick={() => onnavigate?.()}
					>
						<NoteIcon icon={node.icon} color={node.color} class="size-4" />
						<span class="truncate">{noteTitle(node.title)}</span>
					</a>
					<DropdownMenu.Root>
						<DropdownMenu.Trigger>
							{#snippet child({ props: p })}
								<button
									{...p}
									type="button"
									class="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-background focus-visible:opacity-100 data-[state=open]:opacity-100 [@media(pointer:coarse)]:opacity-100"
									aria-label={`Menü für „${noteTitle(node.title)}“`}
								>
									<Ellipsis class="size-3.5" />
								</button>
							{/snippet}
						</DropdownMenu.Trigger>
						<DropdownMenu.Content align="start" class="w-56">
							{@render dropdownEntries(entries(node))}
						</DropdownMenu.Content>
					</DropdownMenu.Root>
					{#if canEdit}
						<button
							type="button"
							class="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-background focus-visible:opacity-100 [@media(pointer:coarse)]:opacity-100"
							aria-label={`Unterseite in „${noteTitle(node.title)}“ anlegen`}
							title="Unterseite anlegen"
							onclick={() => oncreatechild(node)}
						>
							<Plus class="size-3.5" />
						</button>
					{/if}
				</div>
			{/snippet}
		</ContextMenu.Trigger>
		<ContextMenu.Content class="w-56">
			{@render contextEntries(entries(node))}
		</ContextMenu.Content>
	</ContextMenu.Root>

	{#if open}
		{#if loadingKids && !kids.length}
			<p
				class="py-1 text-xs text-muted-foreground"
				style:padding-left={`${(depth + 1) * 0.875 + 1.75}rem`}
			>
				Lädt …
			</p>
		{:else if !kids.length}
			<p
				class="py-1 text-xs text-muted-foreground"
				style:padding-left={`${(depth + 1) * 0.875 + 1.75}rem`}
			>
				Keine Unterseiten
			</p>
		{:else}
			<ul role="group">
				{#each kids as child (child.id)}
					<Self
						node={child}
						depth={depth + 1}
						{tree}
						{activeId}
						{dragging}
						{entries}
						{oncreatechild}
						{ondragstart}
						{ondragend}
						{ondropon}
						{onnavigate}
					/>
				{/each}
			</ul>
		{/if}
	{/if}
</li>
