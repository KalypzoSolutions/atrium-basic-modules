<script lang="ts">
	import { todayBerlin } from '$lib/sdk/dates';
	import { MonthCalendar, type CalendarItem } from '$lib/components/layout';
	import type { BoardDetail, TaskCard } from '../../schemas';

	/** Monatskalender: Phasen als Balken, Aufgaben am Fälligkeitstag (Meilensteine mit ◆) */
	let {
		board,
		visible,
		isDone,
		canEdit,
		onopen,
		onday
	}: {
		board: BoardDetail;
		visible: TaskCard[];
		isDone: (t: TaskCard) => boolean;
		canEdit: boolean;
		onopen: (taskId: string) => void;
		/** neue Aufgabe mit Fälligkeit an diesem Tag */
		onday: (date: string) => void;
	} = $props();

	const today = todayBerlin();
	let month = $state(today.slice(0, 7));
	const PHASE = 'phase:';

	const items = $derived.by((): CalendarItem[] => {
		const list: CalendarItem[] = [];
		for (const p of board.phases) {
			const from = p.startsOn ?? p.endsOn;
			if (!from) continue;
			list.push({
				id: `${PHASE}${p.id}`,
				title: `Phase: ${p.name}`,
				color: p.color,
				startsOn: from,
				endsOn: p.endsOn && p.endsOn !== from ? p.endsOn : null
			});
		}
		const color = (t: TaskCard) => board.phases.find((p) => p.id === t.phaseId)?.color ?? null;
		for (const t of visible) {
			if (!t.dueOn) continue;
			list.push({
				id: t.id,
				title: `${t.isMilestone ? '◆ ' : ''}${t.title}${isDone(t) ? ' ✓' : ''}`,
				color: color(t),
				startsOn: t.dueOn
			});
		}
		return list;
	});
	const undated = $derived(visible.filter((t) => !t.dueOn).length);
</script>

<div class="space-y-2">
	<MonthCalendar
		{items}
		bind:month
		{today}
		onselect={(item) => {
			if (!item.id.startsWith(PHASE)) onopen(item.id);
		}}
		onday={canEdit ? onday : undefined}
	/>
	{#if undated}
		<p class="text-xs text-muted-foreground">
			Ohne Fälligkeitsdatum (nur in Board und Liste): {undated}
			{undated === 1 ? 'Aufgabe' : 'Aufgaben'}.
		</p>
	{/if}
</div>
