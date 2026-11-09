<script lang="ts">
	// Farbwahl der Werkzeugleiste (Textfarbe/Markierung): Vorschläge, eigene Farbe (ColorPicker), Entfernen
	import type { Component } from 'svelte';
	import Check from '@lucide/svelte/icons/check';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import { Button } from '$lib/components/ui/button';
	import { ColorPicker, contrastTextColor } from '$lib/components/ui/color-picker';
	import * as Popover from '$lib/components/ui/popover';

	let {
		label,
		icon: Icon,
		value,
		presets,
		disabled = false,
		size = 'sm',
		onpick,
		onopenchange
	}: {
		label: string;
		icon: Component<{ class?: string }>;
		value: string | null;
		presets: string[];
		disabled?: boolean;
		size?: 'sm' | 'xs';
		/** `null` = entfernen */
		onpick: (color: string | null) => void;
		onopenchange?: (open: boolean) => void;
	} = $props();

	let open = $state(false);
	$effect(() => {
		onopenchange?.(open);
	});

	function pick(color: string | null) {
		onpick(color);
		open = false;
	}
</script>

<Popover.Root bind:open>
	<Popover.Trigger {disabled}>
		{#snippet child({ props })}
			<Button
				{...props}
				variant="ghost"
				size={size === 'sm' ? 'sm' : 'xs'}
				class="shrink-0 px-1.5 text-muted-foreground"
				aria-label={label}
				title={label}
				onmousedown={(e: MouseEvent) => e.preventDefault()}
			>
				<span class="relative inline-flex">
					<Icon class="size-4" />
					<span
						class="absolute -bottom-1 left-0 h-1 w-full rounded-full bg-border"
						style:background-color={value ?? undefined}
						aria-hidden="true"
					></span>
				</span>
				<ChevronDown class="size-3 opacity-60" />
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content class="w-60 space-y-3 p-3" align="start">
		<p class="text-xs font-medium text-muted-foreground">{label}</p>
		<div class="grid grid-cols-5 gap-2" role="radiogroup" aria-label={`${label}: Vorschläge`}>
			{#each presets as c (c)}
				{@const active = value?.toLowerCase() === c}
				<button
					type="button"
					role="radio"
					aria-checked={active}
					aria-label={c.toUpperCase()}
					title={c.toUpperCase()}
					class={[
						'flex size-8 items-center justify-center rounded-md border-2 border-background ring-1 ring-border outline-none focus-visible:ring-2 focus-visible:ring-ring',
						active && 'ring-2 ring-foreground'
					]}
					style:background-color={c}
					onclick={() => pick(c)}
				>
					{#if active}
						<Check class="size-4" style="color: {contrastTextColor(c)}" aria-hidden="true" />
					{/if}
				</button>
			{/each}
		</div>
		<div class="flex items-center gap-2">
			<ColorPicker
				label="Eigene Farbe"
				{value}
				onchange={(v) => v && onpick(v.toLowerCase())}
				{presets}
				class="min-w-0 flex-1"
			/>
			<Button type="button" variant="outline" size="sm" onclick={() => pick(null)}>Entfernen</Button
			>
		</div>
	</Popover.Content>
</Popover.Root>
