<script lang="ts">
	import type { Component } from 'svelte';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Plus from '@lucide/svelte/icons/plus';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { Button } from '$lib/components/ui/button';
	import * as ContextMenu from '$lib/components/ui/context-menu';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Input } from '$lib/components/ui/input';
	import {
		MAX_TASK_TITLE,
		type BoardDetail,
		type Column,
		type Phase,
		type TaskCard
	} from '../../schemas';
	import TaskCardView from '../TaskCardView.svelte';

	/**
	 * Kanban-Spalten mit Ziehen & Ablegen. Mit `grouping` je Phase eine Bahn (Ablegen in einer anderen Bahn
	 * ändert auch die Phase). Anlegen über ＋ im Spaltenkopf (Zeile oben in der Spalte, Enter legt an).
	 */
	let {
		board,
		visible,
		canEdit,
		filtering,
		grouping = false,
		onopen,
		onmove,
		onquickadd,
		onrename,
		ontoggledone,
		onmovecolumn,
		ondeletecolumn
	}: {
		board: BoardDetail;
		/** Aufgaben nach Filter */
		visible: TaskCard[];
		canEdit: boolean;
		filtering: boolean;
		grouping?: boolean;
		onopen: (taskId: string) => void;
		onmove: (taskId: string, columnId: string, position: number, phaseId?: string | null) => void;
		onquickadd: (columnId: string, phaseId: string | null, title: string) => Promise<boolean>;
		onrename: (col: Column) => void;
		ontoggledone: (col: Column) => void;
		onmovecolumn: (col: Column, dir: -1 | 1) => void;
		ondeletecolumn: (col: Column) => void;
	} = $props();

	type Lane = { key: string; phase: Phase | null; label: string | null };
	const lanes = $derived.by((): Lane[] => {
		if (!grouping || !board.phases.length) return [{ key: 'all', phase: null, label: null }];
		return [
			...board.phases.map((p) => ({ key: p.id, phase: p, label: p.name })),
			{ key: 'none', phase: null, label: 'Ohne Phase' }
		];
	});
	const phaseById = $derived(new Map(board.phases.map((p) => [p.id, p])));

	function laneTasks(lane: Lane, columnId: string): TaskCard[] {
		return visible
			.filter(
				(t) =>
					t.columnId === columnId &&
					(lane.key === 'all' || (lane.key === 'none' ? !t.phaseId : t.phaseId === lane.key))
			)
			.sort((a, b) => a.position - b.position);
	}

	const countOf = (columnId: string) => board.tasks.filter((t) => t.columnId === columnId).length;
	const visibleCount = (columnId: string) => visible.filter((t) => t.columnId === columnId).length;

	// --- Ziehen und Ablegen (Fallen: siehe module-tasks.md) ---
	let dragId = $state<string | null>(null);
	let dropTarget = $state<{ lane: string; columnId: string; index: number } | null>(null);

	function onDragStart(e: DragEvent, task: TaskCard) {
		dragId = task.id;
		e.dataTransfer?.setData('text/plain', task.id);
		if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
	}

	function onDragEnd() {
		dragId = null;
		dropTarget = null;
	}

	/** Einfügeposition aus der Mausposition über den Karten der Liste */
	function indexAt(e: DragEvent, list: HTMLElement): number {
		const cards = [...list.querySelectorAll<HTMLElement>('[data-task-id]')].filter(
			(el) => el.dataset.taskId !== dragId
		);
		for (let i = 0; i < cards.length; i++) {
			const r = cards[i]!.getBoundingClientRect();
			if (e.clientY < r.top + r.height / 2) return i;
		}
		return cards.length;
	}

	function onDragOver(e: DragEvent, lane: string, columnId: string) {
		if (!dragId) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		dropTarget = { lane, columnId, index: indexAt(e, e.currentTarget as HTMLElement) };
	}

	function onDrop(e: DragEvent, lane: Lane, columnId: string) {
		e.preventDefault();
		const moved = dragId ?? e.dataTransfer?.getData('text/plain') ?? null;
		// `dragleave` kann das Ziel kurz vor dem Ablegen gelöscht haben → Position direkt bestimmen
		const index = indexAt(e, e.currentTarget as HTMLElement);
		onDragEnd();
		const task = board.tasks.find((t) => t.id === moved && t.canMove);
		if (!moved || !task) return;
		// sichtbare Reihenfolge → Position in der vollständigen Spalte
		const list = laneTasks(lane, columnId).filter((t) => t.id !== moved);
		const all = board.tasks
			.filter((t) => t.columnId === columnId && t.id !== moved)
			.sort((a, b) => a.position - b.position);
		const anchor = list[index];
		const position = anchor ? all.findIndex((t) => t.id === anchor.id) : all.length;
		const phaseId = lane.key === 'all' ? undefined : lane.key === 'none' ? null : lane.key;
		onmove(moved, columnId, position, phaseId === task.phaseId ? undefined : phaseId);
	}

	function shift(task: TaskCard, dir: -1 | 1) {
		const idx = board.columns.findIndex((c) => c.id === task.columnId);
		const next = board.columns[idx + dir];
		if (next) onmove(task.id, next.id, countOf(next.id));
	}

	// --- Anlegen in der Spalte ---
	let adding = $state<string | null>(null);
	let addTitle = $state('');

	function startAdd(lane: Lane, col: Column) {
		adding = `${lane.key}:${col.id}`;
		addTitle = '';
		queueMicrotask(() => document.getElementById(`add-${lane.key}-${col.id}`)?.focus());
	}

	async function submitAdd(lane: Lane, col: Column) {
		const title = addTitle.trim();
		if (!title) {
			adding = null;
			return;
		}
		addTitle = '';
		const ok = await onquickadd(col.id, lane.phase?.id ?? null, title);
		if (!ok) addTitle = title;
		document.getElementById(`add-${lane.key}-${col.id}`)?.focus();
	}

	interface ColumnAction {
		key: string;
		label: string;
		icon: Component<{ class?: string }>;
		disabled?: boolean;
		danger?: boolean;
		run: () => void;
	}

	function columnActions(col: Column, ci: number): ColumnAction[] {
		return [
			{ key: 'rename', label: 'Umbenennen', icon: Pencil, run: () => onrename(col) },
			{
				key: 'done',
				label: col.isDone ? 'Nicht mehr als „erledigt“ werten' : 'Als Erledigt-Spalte festlegen',
				icon: CircleCheck,
				run: () => ontoggledone(col)
			},
			{
				key: 'left',
				label: 'Nach links',
				icon: ArrowLeft,
				disabled: ci === 0,
				run: () => onmovecolumn(col, -1)
			},
			{
				key: 'right',
				label: 'Nach rechts',
				icon: ArrowRight,
				disabled: ci === board.columns.length - 1,
				run: () => onmovecolumn(col, 1)
			},
			{
				key: 'delete',
				label: 'Spalte löschen',
				icon: Trash2,
				danger: true,
				disabled: board.columns.length <= 1,
				run: () => ondeletecolumn(col)
			}
		];
	}
</script>

{#snippet columnHead(lane: Lane, col: Column, ci: number)}
	<div class="group/head flex items-center gap-1.5 px-1 pb-1">
		<h3 id={`col-${lane.key}-${col.id}`} class="min-w-0 truncate text-sm font-semibold">
			{col.name}
		</h3>
		{#if col.isDone}
			<CircleCheck class="size-3.5 shrink-0 text-success" aria-label="Erledigt-Spalte" />
		{/if}
		<span class="text-xs text-muted-foreground tabular-nums" aria-label="Anzahl">
			{lane.key === 'all'
				? filtering
					? `${visibleCount(col.id)}/${countOf(col.id)}`
					: countOf(col.id)
				: laneTasks(lane, col.id).length}
		</span>
		{#if canEdit}
			<div class="ml-auto flex items-center">
				{#if lane.key === lanes[0]?.key}
					<DropdownMenu.Root>
						<DropdownMenu.Trigger>
							{#snippet child({ props })}
								<Button
									{...props}
									variant="ghost"
									size="icon-sm"
									class="opacity-60 group-hover/head:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
									aria-label={`Spalte „${col.name}“`}
								>
									<Ellipsis />
								</Button>
							{/snippet}
						</DropdownMenu.Trigger>
						<DropdownMenu.Content align="end" class="w-60">
							{#each columnActions(col, ci) as a (a.key)}
								{#if a.danger}<DropdownMenu.Separator />{/if}
								<DropdownMenu.Item
									class={a.danger ? 'text-destructive' : ''}
									disabled={a.disabled}
									onclick={a.run}
								>
									<a.icon />
									{a.label}
								</DropdownMenu.Item>
							{/each}
						</DropdownMenu.Content>
					</DropdownMenu.Root>
				{/if}
				<Button
					variant="ghost"
					size="icon-sm"
					aria-label={`Aufgabe in „${col.name}“${lane.label ? ` (${lane.label})` : ''} anlegen`}
					onclick={() => startAdd(lane, col)}
				>
					<Plus />
				</Button>
			</div>
		{/if}
	</div>
{/snippet}

{#snippet columnBody(lane: Lane, col: Column, ci: number)}
	{@const list = laneTasks(lane, col.id)}
	{@const target = dropTarget?.lane === lane.key && dropTarget.columnId === col.id}
	{#if adding === `${lane.key}:${col.id}`}
		<form
			class="mb-2"
			onsubmit={(e) => {
				e.preventDefault();
				void submitAdd(lane, col);
			}}
		>
			<Input
				id={`add-${lane.key}-${col.id}`}
				class="h-8 bg-background"
				placeholder="Titel, Enter zum Anlegen"
				aria-label={`Neue Aufgabe in ${col.name}`}
				maxlength={MAX_TASK_TITLE}
				bind:value={addTitle}
				onkeydown={(e) => {
					if (e.key === 'Escape') {
						e.preventDefault();
						adding = null;
					}
				}}
				onblur={() => {
					if (!addTitle.trim()) adding = null;
				}}
			/>
		</form>
	{/if}
	<ul
		class="flex min-h-16 flex-1 flex-col gap-2 rounded-md"
		class:ring-2={target}
		class:ring-ring={target}
		aria-label={`Aufgaben in ${col.name}${lane.label ? `, ${lane.label}` : ''}`}
		ondragover={(e) => onDragOver(e, lane.key, col.id)}
		ondragleave={(e) => {
			if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) {
				if (target) dropTarget = null;
			}
		}}
		ondrop={(e) => onDrop(e, lane, col.id)}
	>
		{#each list as task, ti (task.id)}
			{#if target && dropTarget?.index === ti && dragId !== task.id}
				<li class="h-1 rounded-full bg-primary" aria-hidden="true"></li>
			{/if}
			<li data-task-id={task.id} class:opacity-40={dragId === task.id}>
				<TaskCardView
					{task}
					done={col.isDone}
					phase={task.phaseId ? (phaseById.get(task.phaseId) ?? null) : null}
					showPhase={lane.key === 'all'}
					canLeft={ci > 0}
					canRight={ci < board.columns.length - 1}
					onopen={() => onopen(task.id)}
					ondragstart={(e) => onDragStart(e, task)}
					ondragend={onDragEnd}
					onshift={(dir) => shift(task, dir)}
				/>
			</li>
		{/each}
		{#if target && list.some((t) => t.id !== dragId) && (dropTarget?.index ?? 0) >= list.filter((t) => t.id !== dragId).length}
			<li class="h-1 rounded-full bg-primary" aria-hidden="true"></li>
		{/if}
		{#if !list.length}
			<li class="px-2 py-4 text-center text-xs text-muted-foreground">
				{filtering && countOf(col.id) ? 'Keine Treffer' : 'Keine Aufgaben'}
			</li>
		{/if}
	</ul>
{/snippet}

<div class="space-y-6">
	{#each lanes as lane (lane.key)}
		<section aria-label={lane.label ?? 'Spalten'}>
			{#if lane.label}
				<h2 class="mb-2 flex items-center gap-2 text-sm font-semibold">
					<span
						class="size-2.5 rounded-full bg-muted-foreground/40"
						style:background-color={lane.phase?.color ?? undefined}
						aria-hidden="true"
					></span>
					{lane.label}
				</h2>
			{/if}
			<div
				class="-mx-4 flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2 sm:snap-none"
				role="list"
				aria-label="Spalten"
			>
				{#each board.columns as col, ci (col.id)}
					<section
						class="flex w-[85vw] max-w-80 shrink-0 snap-start flex-col rounded-lg border bg-muted/40 p-2 sm:w-72"
						role="listitem"
						aria-labelledby={`col-${lane.key}-${col.id}`}
					>
						{#if canEdit && lane.key === lanes[0]?.key}
							<ContextMenu.Root>
								<ContextMenu.Trigger>
									{@render columnHead(lane, col, ci)}
								</ContextMenu.Trigger>
								<ContextMenu.Content class="w-60">
									{#each columnActions(col, ci) as a (a.key)}
										{#if a.danger}<ContextMenu.Separator />{/if}
										<ContextMenu.Item
											class={a.danger ? 'text-destructive' : ''}
											disabled={a.disabled}
											onclick={a.run}
										>
											<a.icon />
											{a.label}
										</ContextMenu.Item>
									{/each}
								</ContextMenu.Content>
							</ContextMenu.Root>
						{:else}
							{@render columnHead(lane, col, ci)}
						{/if}
						{@render columnBody(lane, col, ci)}
					</section>
				{/each}
			</div>
		</section>
	{/each}
</div>
