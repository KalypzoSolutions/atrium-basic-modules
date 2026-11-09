<script lang="ts" module>
	export interface SeriesChoice {
		value: string;
		label: string;
		description?: string;
		destructive?: boolean;
	}
</script>

<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';

	let {
		open = $bindable(false),
		title,
		description,
		options,
		onchoose
	}: {
		open?: boolean;
		title: string;
		description?: string;
		options: SeriesChoice[];
		onchoose: (value: string) => void;
	} = $props();

	function choose(value: string) {
		open = false;
		onchoose(value);
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>{title}</Dialog.Title>
			{#if description}
				<Dialog.Description>{description}</Dialog.Description>
			{:else}
				<Dialog.Description class="sr-only">Bitte eine Option wählen.</Dialog.Description>
			{/if}
		</Dialog.Header>
		<div class="grid gap-2">
			{#each options as o (o.value)}
				<button
					type="button"
					class={[
						'grid gap-0.5 rounded-lg border bg-card px-4 py-3 text-left transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring',
						o.destructive && 'border-destructive/40 hover:bg-destructive/10'
					]}
					onclick={() => choose(o.value)}
				>
					<span class={['text-sm font-medium', o.destructive && 'text-destructive']}>
						{o.label}
					</span>
					{#if o.description}
						<span class="text-xs text-muted-foreground">{o.description}</span>
					{/if}
				</button>
			{/each}
		</div>
		<Dialog.Footer>
			<Button type="button" variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
