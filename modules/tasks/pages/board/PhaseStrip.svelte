<script lang="ts">
	import Settings2 from '@lucide/svelte/icons/settings-2';
	import { todayBerlin } from '$lib/sdk/dates';
	import { Button } from '$lib/components/ui/button';
	import { currentPhase, phaseState, PHASE_STATE_LABELS } from '../../phases';
	import type { Phase, TaskCard } from '../../schemas';
	import { shortDate } from '../helpers';

	/** Phasen als Leiste unter dem Seitenkopf; Klick filtert auf die Phase */
	let {
		phases,
		tasks,
		isDone,
		selected,
		canEdit,
		onselect,
		onmanage
	}: {
		phases: Phase[];
		tasks: TaskCard[];
		isDone: (t: TaskCard) => boolean;
		/** gefilterte Phase */
		selected: string | null;
		canEdit: boolean;
		onselect: (id: string | null) => void;
		onmanage: () => void;
	} = $props();

	const today = todayBerlin();
	const current = $derived(currentPhase(phases, today));

	function range(p: Phase): string {
		if (p.startsOn && p.endsOn) return `${shortDate(p.startsOn)}–${shortDate(p.endsOn)}`;
		if (p.startsOn) return `ab ${shortDate(p.startsOn)}`;
		if (p.endsOn) return `bis ${shortDate(p.endsOn)}`;
		return 'ohne Datum';
	}

	function progress(p: Phase): string {
		const list = tasks.filter((t) => t.phaseId === p.id);
		return list.length ? `${list.filter(isDone).length}/${list.length}` : '';
	}
</script>

{#if phases.length}
	<div class="flex items-stretch gap-1.5 overflow-x-auto pb-1" role="group" aria-label="Phasen">
		{#each phases as p (p.id)}
			{@const state = phaseState(p, today)}
			{@const isCurrent = current?.id === p.id}
			<button
				type="button"
				class="flex min-w-32 flex-1 flex-col gap-0.5 rounded-lg border bg-card px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
				class:border-ring={isCurrent || selected === p.id}
				class:ring-1={selected === p.id}
				class:ring-ring={selected === p.id}
				class:opacity-60={state === 'past' && selected !== p.id}
				aria-pressed={selected === p.id}
				aria-label={`Phase ${p.name}, ${range(p)}, ${PHASE_STATE_LABELS[state]}${isCurrent ? ', aktuell' : ''}`}
				onclick={() => onselect(selected === p.id ? null : p.id)}
			>
				<span class="flex items-center gap-1.5 font-medium">
					<span
						class="size-2 shrink-0 rounded-full bg-muted-foreground/40"
						style:background-color={p.color ?? undefined}
						aria-hidden="true"
					></span>
					<span class="truncate">{p.name}</span>
					{#if isCurrent}
						<span class="ml-auto shrink-0 text-link">
							{state === 'active' ? 'läuft' : 'als Nächstes'}
						</span>
					{/if}
				</span>
				<span class="flex justify-between gap-2 text-muted-foreground tabular-nums">
					<span>{range(p)}</span>
					<span>{progress(p)}</span>
				</span>
			</button>
		{/each}
		{#if canEdit}
			<Button
				variant="ghost"
				size="icon"
				class="h-auto shrink-0"
				aria-label="Phasen verwalten"
				onclick={onmanage}
			>
				<Settings2 />
			</Button>
		{/if}
	</div>
{/if}
