<script lang="ts">
	// Knopf der Werkzeugleiste mit Tooltip (Name + Tastenkürzel); hält den Fokus im Editor (mousedown)
	import type { Component } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Tooltip from '$lib/components/ui/tooltip';

	let {
		label,
		shortcut,
		icon: Icon,
		active,
		disabled = false,
		onclick
	}: {
		label: string;
		shortcut?: string;
		icon: Component<{ class?: string }>;
		active?: boolean;
		disabled?: boolean;
		onclick: () => void;
	} = $props();
</script>

<Tooltip.Root>
	<Tooltip.Trigger>
		{#snippet child({ props })}
			<Button
				{...props}
				type="button"
				variant="ghost"
				size="icon-sm"
				class={active ? 'bg-muted text-foreground' : 'text-muted-foreground'}
				aria-label={label}
				aria-pressed={active}
				{disabled}
				onmousedown={(e: MouseEvent) => e.preventDefault()}
				{onclick}
			>
				<Icon class="size-4" />
			</Button>
		{/snippet}
	</Tooltip.Trigger>
	<Tooltip.Content side="bottom">
		{label}{#if shortcut}<span class="ml-1 opacity-70">{shortcut}</span>{/if}
	</Tooltip.Content>
</Tooltip.Root>
