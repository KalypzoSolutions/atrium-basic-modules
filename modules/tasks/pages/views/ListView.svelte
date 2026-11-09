<script lang="ts">
	import Diamond from '@lucide/svelte/icons/diamond';
	import Lock from '@lucide/svelte/icons/lock';
	import { Badge } from '$lib/components/ui/badge';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { SelectField } from '$lib/components/ui/select-field';
	import { DataTable } from '$lib/components/layout';
	import { PRIORITY_RANK, type BoardDetail, type Phase, type TaskCard } from '../../schemas';
	import { dueText, dueTone, priorityLabel, shortDate } from '../helpers';

	/** Liste je Phase (Gruppe „Ohne Phase“ am Ende), abhaken direkt in der Zeile */
	let {
		board,
		visible,
		isDone,
		ontoggle,
		onopen
	}: {
		board: BoardDetail;
		visible: TaskCard[];
		isDone: (t: TaskCard) => boolean;
		ontoggle: (task: TaskCard, done: boolean) => void;
		onopen: (taskId: string) => void;
	} = $props();

	type Sort = 'due' | 'priority' | 'title' | 'board';
	let sort = $state<Sort | null>('due');
	const sortOptions = [
		{ value: 'due', label: 'Nach Fälligkeit' },
		{ value: 'priority', label: 'Nach Priorität' },
		{ value: 'title', label: 'Nach Titel' },
		{ value: 'board', label: 'Wie im Board' }
	];

	const columnName = (t: TaskCard) => board.columns.find((c) => c.id === t.columnId)?.name ?? '';
	const columnPos = (t: TaskCard) => board.columns.findIndex((c) => c.id === t.columnId);

	function sorted(list: TaskCard[]): TaskCard[] {
		const s = sort ?? 'due';
		return [...list].sort((a, b) => {
			// Erledigte immer unten
			const done = Number(isDone(a)) - Number(isDone(b));
			if (done) return done;
			if (s === 'priority') return PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority];
			if (s === 'title') return a.title.localeCompare(b.title, 'de');
			if (s === 'board') return columnPos(a) - columnPos(b) || a.position - b.position;
			return (a.dueOn ?? '9999').localeCompare(b.dueOn ?? '9999') || a.position - b.position;
		});
	}

	const groups = $derived.by(() => {
		const list: { key: string; phase: Phase | null; tasks: TaskCard[] }[] = board.phases.map(
			(p) => ({ key: p.id, phase: p, tasks: sorted(visible.filter((t) => t.phaseId === p.id)) })
		);
		const rest = sorted(
			visible.filter((t) => !t.phaseId || !board.phases.some((p) => p.id === t.phaseId))
		);
		if (rest.length || !list.length) list.push({ key: 'none', phase: null, tasks: rest });
		return list.filter((g) => g.tasks.length || g.phase);
	});

	function range(p: Phase): string {
		if (p.startsOn && p.endsOn) return `${shortDate(p.startsOn)}–${shortDate(p.endsOn)}`;
		if (p.startsOn) return `ab ${shortDate(p.startsOn)}`;
		return '';
	}
</script>

<div class="space-y-4">
	<div class="flex justify-end">
		<SelectField
			class="w-48"
			size="sm"
			label="Sortierung"
			options={sortOptions}
			bind:value={sort}
		/>
	</div>
	{#each groups as g (g.key)}
		{@const doneCount = g.tasks.filter(isDone).length}
		<section class="space-y-2" aria-labelledby={`grp-${g.key}`}>
			<h2 id={`grp-${g.key}`} class="flex items-center gap-2 text-sm">
				<span
					class="size-2.5 shrink-0 rounded-full bg-muted-foreground/40"
					style:background-color={g.phase?.color ?? undefined}
					aria-hidden="true"
				></span>
				<span class="font-semibold"
					>{g.phase?.name ?? (board.phases.length ? 'Ohne Phase' : 'Aufgaben')}</span
				>
				{#if g.phase && range(g.phase)}
					<span class="text-xs text-muted-foreground tabular-nums">{range(g.phase)}</span>
				{/if}
				<span class="ml-auto text-xs text-muted-foreground tabular-nums">
					{doneCount} von {g.tasks.length} erledigt
				</span>
			</h2>
			<DataTable
				caption={`Aufgaben${g.phase ? ` der Phase ${g.phase.name}` : ''}`}
				mobile="cards"
				empty={!g.tasks.length}
				emptyTitle="Keine Aufgaben"
				emptyDescription="In dieser Phase gibt es (mit diesem Filter) keine Aufgaben."
			>
				{#snippet head()}
					<tr>
						<th class="w-10"><span class="sr-only">Erledigt</span></th>
						<th>Aufgabe</th>
						<th>Zuständig</th>
						<th>Stand</th>
						<th class="text-right">Fällig</th>
					</tr>
				{/snippet}
				{#each g.tasks as t (t.id)}
					{@const done = isDone(t)}
					{@const tone = dueTone(t.dueOn, done)}
					<tr class="cursor-pointer hover:bg-muted/40" onclick={() => onopen(t.id)}>
						<td onclick={(e) => e.stopPropagation()}>
							<Checkbox
								checked={done}
								disabled={!t.canMove}
								aria-label={`„${t.title}“ erledigt`}
								onCheckedChange={(v) => ontoggle(t, v === true)}
							/>
						</td>
						<td class="max-w-md">
							<button
								type="button"
								class="focus-ring flex items-center gap-1.5 rounded-sm text-left font-medium"
								class:line-through={done}
								class:text-muted-foreground={done}
								onclick={(e) => {
									e.stopPropagation();
									onopen(t.id);
								}}
							>
								{#if t.isMilestone}<Diamond
										class="size-3.5 shrink-0 fill-current"
										aria-label="Meilenstein"
									/>{/if}
								<span class="truncate">{t.title}</span>
								{#if t.openBlockers && !done}<Lock
										class="size-3.5 shrink-0 text-muted-foreground"
										aria-label="blockiert"
									/>{/if}
							</button>
							{#if t.priority === 'high' || t.priority === 'urgent'}
								<Badge
									variant={t.priority === 'urgent' ? 'destructive' : 'warning'}
									class="mt-1 px-1.5 py-0 text-xs"
								>
									{priorityLabel(t.priority)}
								</Badge>
							{/if}
						</td>
						<td class="text-sm text-muted-foreground">
							{t.assignees.map((a) => a.name).join(', ') || '–'}
						</td>
						<td><Badge variant="outline">{columnName(t)}</Badge></td>
						<td
							class="text-right text-sm whitespace-nowrap tabular-nums"
							class:text-destructive={tone === 'overdue'}
							class:text-warning={tone === 'soon'}
							class:text-muted-foreground={tone === 'normal'}
						>
							{dueText(t.dueOn, done, t.startsOn) || '–'}
						</td>
					</tr>
				{/each}
			</DataTable>
		</section>
	{/each}
</div>
