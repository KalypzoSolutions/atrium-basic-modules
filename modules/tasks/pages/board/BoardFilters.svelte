<script lang="ts">
	import ListFilter from '@lucide/svelte/icons/list-filter';
	import X from '@lucide/svelte/icons/x';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { MultiSelect } from '$lib/components/ui/multi-select';
	import * as Popover from '$lib/components/ui/popover';
	import { SelectField } from '$lib/components/ui/select-field';
	import { Switch } from '$lib/components/ui/switch';
	import { ChoiceChips } from '$lib/components/layout';
	import {
		PRIORITIES,
		PRIORITY_LABELS,
		type Phase,
		type Priority,
		type UserRef
	} from '../../schemas';
	import {
		activeFilterCount,
		DUE_FILTER_LABELS,
		emptyFilter,
		type DueFilter,
		type TaskFilter
	} from '../filter';

	/** Ein Knopf „Filter“ mit Popover; aktive Filter als entfernbare Chips daneben */
	let {
		filter = $bindable(),
		people,
		phases,
		showMine,
		grouping = $bindable(false),
		canGroup = false
	}: {
		filter: TaskFilter;
		/** Zuständige, die im Board vorkommen */
		people: UserRef[];
		phases: Phase[];
		showMine: boolean;
		/** Board: Bahnen je Phase */
		grouping?: boolean;
		canGroup?: boolean;
	} = $props();

	const uid = $props.id();
	const count = $derived(activeFilterCount(filter));
	const dueOptions = (Object.keys(DUE_FILTER_LABELS) as DueFilter[]).map((v) => ({
		value: v,
		label: DUE_FILTER_LABELS[v]
	}));
	const priorityOptions = PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABELS[p] }));
	const peopleOptions = $derived(people.map((p) => ({ value: p.id, label: p.name })));
	const phaseOptions = $derived([
		...phases.map((p) => ({ value: p.id, label: p.name })),
		{ value: 'none', label: 'Ohne Phase' }
	]);

	const chips = $derived.by(() => {
		const list: { key: string; label: string; clear: () => void }[] = [];
		if (filter.search.trim()) {
			list.push({
				key: 'q',
				label: `„${filter.search.trim()}“`,
				clear: () => (filter.search = '')
			});
		}
		if (filter.onlyMine)
			list.push({ key: 'mine', label: 'Nur meine', clear: () => (filter.onlyMine = false) });
		if (filter.phaseId) {
			const name =
				filter.phaseId === 'none'
					? 'Ohne Phase'
					: (phases.find((p) => p.id === filter.phaseId)?.name ?? 'Phase');
			list.push({ key: 'phase', label: `Phase: ${name}`, clear: () => (filter.phaseId = null) });
		}
		if (filter.assignees.length) {
			const names = filter.assignees.map(
				(id) => people.find((p) => p.id === id)?.name ?? 'Unbekannt'
			);
			list.push({
				key: 'who',
				label: `Zuständig: ${names.join(', ')}`,
				clear: () => (filter.assignees = [])
			});
		}
		if (filter.priorities.length) {
			list.push({
				key: 'prio',
				label: `Priorität: ${filter.priorities.map((p) => PRIORITY_LABELS[p]).join(', ')}`,
				clear: () => (filter.priorities = [])
			});
		}
		if (filter.due !== 'all') {
			list.push({
				key: 'due',
				label: DUE_FILTER_LABELS[filter.due],
				clear: () => (filter.due = 'all')
			});
		}
		return list;
	});
</script>

<div class="flex flex-wrap items-center gap-1.5">
	{#each chips as chip (chip.key)}
		<span
			class="inline-flex max-w-full items-center gap-1 rounded-full bg-primary/10 py-0.5 pr-1 pl-2.5 text-xs font-medium text-link"
		>
			<span class="truncate">{chip.label}</span>
			<button
				type="button"
				class="focus-ring inline-flex size-5 items-center justify-center rounded-full hover:bg-primary/15"
				aria-label={`Filter „${chip.label}“ entfernen`}
				onclick={chip.clear}
			>
				<X class="size-3" aria-hidden="true" />
			</button>
		</span>
	{/each}
	<Popover.Root>
		<Popover.Trigger>
			{#snippet child({ props })}
				<Button
					{...props}
					variant="outline"
					size="sm"
					aria-label={`Filter${count ? ` (${count} aktiv)` : ''}`}
				>
					<ListFilter />
					Filter{count ? ` · ${count}` : ''}
				</Button>
			{/snippet}
		</Popover.Trigger>
		<Popover.Content align="end" class="w-80 space-y-4">
			<div class="space-y-1.5">
				<Label for={`${uid}-search`}>Suche</Label>
				<Input
					id={`${uid}-search`}
					type="search"
					placeholder="Titel enthält …"
					bind:value={filter.search}
				/>
			</div>
			{#if showMine}
				<div class="flex items-center justify-between gap-3">
					<Label for={`${uid}-mine`}>Nur meine Aufgaben</Label>
					<Switch id={`${uid}-mine`} bind:checked={filter.onlyMine} />
				</div>
			{/if}
			{#if phases.length}
				<div class="space-y-1.5">
					<Label for={`${uid}-phase`}>Phase</Label>
					<SelectField
						id={`${uid}-phase`}
						label="Phase"
						options={phaseOptions}
						bind:value={filter.phaseId}
						emptyLabel="Alle Phasen"
						placeholder="Alle Phasen"
					/>
				</div>
			{/if}
			{#if people.length}
				<div class="space-y-1.5">
					<Label for={`${uid}-who`}>Zuständig</Label>
					<MultiSelect
						id={`${uid}-who`}
						label="Zuständig"
						options={peopleOptions}
						bind:value={filter.assignees}
						placeholder="Alle"
						searchPlaceholder="Person suchen …"
					/>
				</div>
			{/if}
			<div class="space-y-1.5">
				<Label for={`${uid}-prio`}>Priorität</Label>
				<MultiSelect
					id={`${uid}-prio`}
					label="Priorität"
					options={priorityOptions}
					value={filter.priorities}
					onchange={(v) => (filter.priorities = v as Priority[])}
					placeholder="Alle"
				/>
			</div>
			<ChoiceChips
				legend="Fälligkeit"
				options={dueOptions}
				value={filter.due}
				onchange={(v) => (filter.due = v)}
			/>
			{#if canGroup && phases.length}
				<div class="flex items-center justify-between gap-3 border-t pt-3">
					<Label for={`${uid}-group`}>Nach Phasen gruppieren</Label>
					<Switch id={`${uid}-group`} bind:checked={grouping} />
				</div>
			{/if}
			{#if count}
				<Button variant="ghost" size="sm" class="w-full" onclick={() => (filter = emptyFilter())}>
					Alle Filter zurücksetzen
				</Button>
			{/if}
		</Popover.Content>
	</Popover.Root>
</div>
