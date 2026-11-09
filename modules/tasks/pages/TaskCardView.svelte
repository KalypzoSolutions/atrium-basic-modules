<script lang="ts">
	import Diamond from '@lucide/svelte/icons/diamond';
	import ListChecks from '@lucide/svelte/icons/list-checks';
	import Lock from '@lucide/svelte/icons/lock';
	import { Avatar, AvatarFallback, AvatarGroup, AvatarImage } from '$lib/components/ui/avatar';
	import type { Phase, TaskCard } from '../schemas';
	import { dueText, dueTone, initials, priorityLabel } from './helpers';

	/**
	 * Karte einer Aufgabe im Board: Titel und eine Zeile mit Angaben. Priorität hoch/dringend als farbiger Rand.
	 * Ganze Karte = Knopf zum Öffnen; ziehbar, wenn verschiebbar. Tastatur: Alt+←/→ in die Nachbarspalte.
	 */
	let {
		task,
		done = false,
		phase = null,
		showPhase = true,
		canLeft,
		canRight,
		onopen,
		ondragstart,
		ondragend,
		onshift
	}: {
		task: TaskCard;
		done?: boolean;
		phase?: Phase | null;
		/** Phase in der Karte zeigen (nicht in Bahnen nach Phase) */
		showPhase?: boolean;
		canLeft: boolean;
		canRight: boolean;
		onopen: () => void;
		ondragstart: (e: DragEvent) => void;
		ondragend: () => void;
		onshift: (dir: -1 | 1) => void;
	} = $props();

	const checklistDone = $derived(
		task.checklist.total > 0 && task.checklist.done === task.checklist.total
	);
	const due = $derived(dueText(task.dueOn, done, task.startsOn));
	const tone = $derived(dueTone(task.dueOn, done));
	const accent = $derived(
		task.priority === 'urgent'
			? 'border-l-destructive'
			: task.priority === 'high'
				? 'border-l-warning'
				: ''
	);

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			onopen();
		} else if (task.canMove && e.altKey && e.key === 'ArrowLeft' && canLeft) {
			e.preventDefault();
			onshift(-1);
		} else if (task.canMove && e.altKey && e.key === 'ArrowRight' && canRight) {
			e.preventDefault();
			onshift(1);
		}
	}
</script>

<div
	role="button"
	tabindex="0"
	draggable={task.canMove}
	class="group block w-full cursor-pointer rounded-md border border-l-3 bg-card px-3 py-2.5 text-left text-sm shadow-xs transition-colors hover:border-ring/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none {accent}"
	class:cursor-grab={task.canMove}
	aria-label={`${task.title}${task.priority === 'urgent' || task.priority === 'high' ? ` – Priorität ${priorityLabel(task.priority)}` : ''}${task.canMove ? ' – Alt+Pfeil links/rechts verschiebt' : ''}`}
	data-task-card
	onclick={onopen}
	{onkeydown}
	{ondragstart}
	{ondragend}
>
	<p
		class="flex items-start gap-1.5 leading-snug font-medium break-words"
		class:line-through={done}
		class:text-muted-foreground={done}
	>
		{#if task.isMilestone}
			<Diamond class="mt-0.5 size-3.5 shrink-0 fill-current" aria-label="Meilenstein" />
		{/if}
		<span class="min-w-0">{task.title}</span>
	</p>

	{#if due || task.checklist.total || task.assignees.length || task.openBlockers || (showPhase && phase)}
		<div class="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
			{#if due}
				<span
					class="tabular-nums"
					class:text-destructive={tone === 'overdue'}
					class:text-warning={tone === 'soon'}
					class:font-medium={tone !== 'normal'}>{due}</span
				>
			{/if}
			{#if task.checklist.total}
				<span
					class="inline-flex items-center gap-1 tabular-nums"
					class:text-success={checklistDone}
					aria-label={`${task.checklist.done} von ${task.checklist.total} Unteraufgaben erledigt`}
				>
					<ListChecks class="size-3.5" aria-hidden="true" />
					{task.checklist.done}/{task.checklist.total}
				</span>
			{/if}
			{#if task.openBlockers && !done}
				<span class="inline-flex items-center gap-1" title="Wartet auf andere Aufgaben">
					<Lock class="size-3.5" aria-hidden="true" /> blockiert
				</span>
			{/if}
			{#if showPhase && phase}
				<span class="inline-flex min-w-0 items-center gap-1">
					<span
						class="size-2 shrink-0 rounded-full bg-muted-foreground/40"
						style:background-color={phase.color ?? undefined}
						aria-hidden="true"
					></span>
					<span class="truncate">{phase.name}</span>
				</span>
			{/if}
			{#if task.assignees.length}
				<AvatarGroup class="ml-auto">
					{#each task.assignees.slice(0, 3) as a (a.id)}
						<Avatar class="size-6 border-2 border-card" title={a.name}>
							{#if a.image}<AvatarImage src={a.image} alt={a.name} />{/if}
							<AvatarFallback class="text-xs">{initials(a.name)}</AvatarFallback>
						</Avatar>
					{/each}
					{#if task.assignees.length > 3}
						<span class="ml-1 text-xs">+{task.assignees.length - 3}</span>
					{/if}
				</AvatarGroup>
				<span class="sr-only">Zuständig: {task.assignees.map((a) => a.name).join(', ')}</span>
			{/if}
		</div>
	{/if}
</div>
