<script lang="ts">
	// Farbknopf für die Eigenschaftsleiste: Vorschlagsfarben, „keine“ (transparent) und eigene Farbe
	import Ban from '@lucide/svelte/icons/ban';
	import { Button } from '$lib/components/ui/button';
	import { ColorPicker } from '$lib/components/ui/color-picker';
	import * as Popover from '$lib/components/ui/popover';

	let {
		label,
		value,
		palette,
		allowNone = false,
		variant = 'fill',
		onchange
	}: {
		label: string;
		value: string | null;
		palette: readonly string[];
		allowNone?: boolean;
		/** Darstellung im Knopf: Fläche oder Linie */
		variant?: 'fill' | 'stroke' | 'text';
		onchange: (color: string) => void;
	} = $props();

	let open = $state(false);
	let custom = $state<string | null>(null);
	const isNone = $derived(!value || value === 'transparent');

	function pick(c: string) {
		onchange(c);
		open = false;
	}
</script>

<Popover.Root bind:open>
	<Popover.Trigger>
		{#snippet child({ props })}
			<Button {...props} variant="ghost" size="icon" aria-label={label} title={label}>
				{#if variant === 'text'}
					<span class="flex flex-col items-center leading-none" aria-hidden="true">
						<span class="text-sm font-bold">A</span>
						<span
							class="mt-0.5 h-1 w-4 rounded-sm border"
							style:background-color={isNone ? undefined : value}
						></span>
					</span>
				{:else if variant === 'stroke'}
					<span
						class="size-4 rounded-full border-[3px]"
						style:border-color={isNone ? undefined : value}
						aria-hidden="true"
					></span>
				{:else}
					<span
						class="size-4 rounded-full border"
						style:background-color={isNone ? undefined : value}
						aria-hidden="true"
					>
						{#if isNone}<Ban class="size-full text-muted-foreground" />{/if}
					</span>
				{/if}
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content class="w-64 space-y-3 p-3">
		<p class="text-xs font-medium text-muted-foreground">{label}</p>
		<div class="grid grid-cols-6 gap-1.5" role="group" aria-label={`${label}: Vorschläge`}>
			{#if allowNone}
				<button
					type="button"
					class="flex size-8 items-center justify-center rounded-md border hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
					aria-label="Keine Farbe"
					aria-pressed={isNone}
					onclick={() => pick('transparent')}
				>
					<Ban class="size-4 text-muted-foreground" />
				</button>
			{/if}
			{#each palette as c (c)}
				<button
					type="button"
					class={[
						'size-8 rounded-md border focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
						value === c && 'ring-2 ring-ring ring-offset-1 ring-offset-background'
					]}
					style:background-color={c}
					aria-label={`Farbe ${c}`}
					aria-pressed={value === c}
					onclick={() => pick(c)}
				></button>
			{/each}
		</div>
		<ColorPicker
			label="Eigene Farbe"
			value={custom ?? (isNone ? null : value)}
			onchange={(c) => {
				custom = c;
				if (c) onchange(c);
			}}
		/>
	</Popover.Content>
</Popover.Root>
