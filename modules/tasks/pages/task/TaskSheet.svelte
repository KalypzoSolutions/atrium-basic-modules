<script lang="ts">
	import * as Sheet from '$lib/components/ui/sheet';
	import { BottomSheet, deviceLayout } from '$lib/components/layout';
	import type { Column, Phase, TaskCard } from '../../schemas';
	import TaskEditor from './TaskEditor.svelte';

	/**
	 * Aufgabe als Blatt: rechts neben dem Board (Desktop/Tablet), von unten am Handy.
	 * `taskId = null` legt eine neue Aufgabe an (mit `defaults`), danach wechselt das Blatt zur neuen Aufgabe.
	 */
	let {
		open = $bindable(false),
		taskId = $bindable(null),
		boardId,
		boardName,
		columns,
		phases,
		tasks,
		order = [],
		defaults = {},
		canEditBoard,
		onchanged
	}: {
		open?: boolean;
		taskId?: string | null;
		boardId: string;
		boardName: string;
		columns: Column[];
		phases: Phase[];
		tasks: TaskCard[];
		/** sichtbare Reihenfolge für Vor/Zurück */
		order?: string[];
		defaults?: { columnId?: string | null; phaseId?: string | null; dueOn?: string | null };
		canEditBoard: boolean;
		onchanged: () => void;
	} = $props();

	const phone = $derived(deviceLayout() === 'phone');
	const index = $derived(taskId ? order.indexOf(taskId) : -1);
	const navigate = $derived({
		prev: index > 0 ? () => (taskId = order[index - 1]!) : null,
		next: index >= 0 && index < order.length - 1 ? () => (taskId = order[index + 1]!) : null
	});
	const title = $derived(taskId ? 'Aufgabe' : 'Neue Aufgabe');
</script>

{#snippet editor()}
	<TaskEditor
		{taskId}
		{boardId}
		{boardName}
		{columns}
		{phases}
		{tasks}
		{defaults}
		{canEditBoard}
		{onchanged}
		oncreated={(id) => (taskId = id)}
		onclose={() => (open = false)}
		onnavigate={phone ? undefined : navigate}
	/>
{/snippet}

{#if phone}
	<BottomSheet bind:open {title} size="tall" showClose={false} bodyClass="p-0">
		{@render editor()}
	</BottomSheet>
{:else}
	<Sheet.Root bind:open>
		<Sheet.Content
			side="right"
			showCloseButton={false}
			class="w-full gap-0 p-0 data-[side=right]:sm:max-w-lg"
		>
			<Sheet.Title class="sr-only">{title}</Sheet.Title>
			<Sheet.Description class="sr-only">
				Stand, Phase, Zeitraum, Zuständige, Beschreibung und Unteraufgaben
			</Sheet.Description>
			{#if open}{@render editor()}{/if}
		</Sheet.Content>
	</Sheet.Root>
{/if}
