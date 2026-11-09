<script lang="ts">
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import Diamond from '@lucide/svelte/icons/diamond';
	import PanelRightOpen from '@lucide/svelte/icons/panel-right-open';
	import UserPlus from '@lucide/svelte/icons/user-plus';
	import {
		BottomSheet,
		ListRow,
		ScrollPills,
		SheetAction,
		TouchList
	} from '$lib/components/layout';
	import type { BoardDetail, Phase, TaskCard } from '../../schemas';
	import { dueText, dueTone } from '../helpers';

	/**
	 * Handy-Ansicht des Boards (Muster Kasse mobil): Liste statt Spalten, Spalten als Pillen, nach Phase gruppiert;
	 * Tippen öffnet die Aufgabe, langes Drücken das Aktionsblatt (verschieben, erledigt, mir zuweisen).
	 */
	let {
		board,
		visible,
		myId,
		canEdit,
		isDone,
		onopen,
		onmove,
		onassignme
	}: {
		board: BoardDetail;
		visible: TaskCard[];
		myId: string | null;
		canEdit: boolean;
		isDone: (t: TaskCard) => boolean;
		onopen: (taskId: string) => void;
		onmove: (taskId: string, columnId: string) => void;
		onassignme: (task: TaskCard) => void;
	} = $props();

	let column = $state<string>('all');
	let action = $state<TaskCard | null>(null);
	let actionOpen = $state(false);

	const pills = $derived([
		{ value: 'all', label: 'Alle', count: visible.length },
		...board.columns.map((c) => ({
			value: c.id,
			label: c.name,
			count: visible.filter((t) => t.columnId === c.id).length
		}))
	]);

	const shown = $derived(
		visible
			.filter((t) => column === 'all' || t.columnId === column)
			.sort(
				(a, b) =>
					Number(isDone(a)) - Number(isDone(b)) ||
					(a.dueOn ?? '9999').localeCompare(b.dueOn ?? '9999') ||
					a.position - b.position
			)
	);

	const groups = $derived.by(() => {
		const list: { key: string; phase: Phase | null; tasks: TaskCard[] }[] = [];
		for (const p of board.phases) {
			const tasks = shown.filter((t) => t.phaseId === p.id);
			if (tasks.length) list.push({ key: p.id, phase: p, tasks });
		}
		const rest = shown.filter((t) => !t.phaseId || !board.phases.some((p) => p.id === t.phaseId));
		if (rest.length) list.push({ key: 'none', phase: null, tasks: rest });
		return list;
	});

	const columnName = (id: string) => board.columns.find((c) => c.id === id)?.name ?? '';
	const doneColumn = $derived(board.columns.find((c) => c.isDone) ?? null);

	function subtitle(t: TaskCard): string {
		const parts = [column === 'all' ? columnName(t.columnId) : ''];
		const due = dueText(t.dueOn, isDone(t), t.startsOn);
		if (due) parts.push(due);
		if (t.checklist.total) parts.push(`${t.checklist.done}/${t.checklist.total} erledigt`);
		if (t.assignees.length) parts.push(t.assignees.map((a) => a.name.split(' ')[0]).join(', '));
		return parts.filter(Boolean).join(' · ');
	}

	function openActions(t: TaskCard) {
		action = t;
		actionOpen = true;
	}

	function run(fn: () => void) {
		actionOpen = false;
		fn();
	}
</script>

<div class="space-y-3 pb-6">
	<ScrollPills label="Spalte" options={pills} value={column} onchange={(v) => (column = v)} />

	{#if !shown.length}
		<p class="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
			Keine Aufgaben{column === 'all' ? '' : ` in „${columnName(column)}“`}.
		</p>
	{/if}

	{#each groups as g (g.key)}
		<TouchList
			heading={board.phases.length ? (g.phase?.name ?? 'Ohne Phase') : undefined}
			label={g.phase?.name ?? 'Aufgaben'}
		>
			{#each g.tasks as t (t.id)}
				{@const tone = dueTone(t.dueOn, isDone(t))}
				<ListRow
					title={`${t.isMilestone ? '◆ ' : ''}${t.title}`}
					subtitle={subtitle(t)}
					amountClass={tone === 'overdue'
						? 'text-destructive'
						: tone === 'soon'
							? 'text-warning'
							: ''}
					onclick={() => onopen(t.id)}
					onlongpress={t.canMove ? () => openActions(t) : undefined}
					label={`${t.title}${t.canMove ? ', lange drücken für Aktionen' : ''}`}
					class={isDone(t) ? 'opacity-60' : ''}
				>
					{#snippet leading()}
						{#if t.isMilestone}
							<Diamond class="size-4 fill-current text-muted-foreground" aria-hidden="true" />
						{:else}
							<span
								class="block size-2.5 rounded-full bg-muted-foreground/40"
								style:background-color={g.phase?.color ?? undefined}
								aria-hidden="true"
							></span>
						{/if}
					{/snippet}
				</ListRow>
			{/each}
		</TouchList>
	{/each}
</div>

<BottomSheet bind:open={actionOpen} title={action?.title ?? 'Aufgabe'}>
	{#if action}
		{@const t = action}
		<div class="space-y-1">
			<SheetAction icon={PanelRightOpen} title="Öffnen" onclick={() => run(() => onopen(t.id))} />
			{#if doneColumn && t.columnId !== doneColumn.id}
				<SheetAction
					icon={CircleCheck}
					title="Erledigt"
					variant="primary"
					onclick={() => run(() => onmove(t.id, doneColumn.id))}
				/>
			{/if}
			{#each board.columns.filter((c) => c.id !== t.columnId && !c.isDone) as c (c.id)}
				<SheetAction
					icon={ArrowRight}
					title={`Nach „${c.name}“`}
					onclick={() => run(() => onmove(t.id, c.id))}
				/>
			{/each}
			{#if canEdit && myId && !t.assignees.some((a) => a.id === myId)}
				<SheetAction
					icon={UserPlus}
					title="Mir zuweisen"
					onclick={() => run(() => onassignme(t))}
				/>
			{/if}
		</div>
	{/if}
</BottomSheet>
