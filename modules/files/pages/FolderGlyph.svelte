<script lang="ts">
	// Ordnersymbol mit Aussehen: gefüllter Ordner in der gewählten Farbe (ohne Farbe neutral grau), ab Größe
	// `md` das gewählte Icon darauf (Kontrastfarbe automatisch hell/dunkel).
	import { DynamicIcon } from '$lib/components/ui/icon-picker';
	import { contrastTextColor } from '$lib/components/ui/color-picker';
	import { cn } from '$lib/utils';

	let {
		icon = null,
		color = null,
		size = 'md',
		class: className
	}: {
		icon?: string | null;
		color?: string | null;
		/** `sm` = 20 px (Liste, ohne Icon), `md` = 56 px (Raster), `lg` = 72 px (Vorschau) */
		size?: 'sm' | 'md' | 'lg';
		class?: string;
	} = $props();

	const px = $derived(size === 'sm' ? 20 : size === 'md' ? 56 : 72);
	const emblem = $derived(Math.round(px * 0.4));
	const emblemColor = $derived(color ? contrastTextColor(color) : null);
</script>

<span
	class={cn(
		'relative inline-flex shrink-0',
		// deckend gemischt statt Transparenz: sonst zeichnet die Kontur über der Füllung einen dunkleren Rand
		!color && 'text-[color-mix(in_oklab,var(--muted-foreground)_55%,var(--background))]',
		className
	)}
	style:width="{px}px"
	style:height="{px}px"
	style:color={color ?? undefined}
	aria-hidden="true"
>
	<svg
		xmlns="http://www.w3.org/2000/svg"
		viewBox="0 0 24 24"
		width={px}
		height={px}
		fill="currentColor"
		stroke="currentColor"
		stroke-width="1.5"
		stroke-linejoin="round"
	>
		<path
			d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"
		/>
	</svg>
	{#if icon && size !== 'sm'}
		<span
			class={cn('absolute flex', !emblemColor && 'text-background')}
			style:left="{(px - emblem) / 2}px"
			style:top="{px * 0.555 - emblem / 2}px"
			style:color={emblemColor ?? undefined}
		>
			<DynamicIcon name={icon} strokeWidth={2.25} style="width: {emblem}px; height: {emblem}px" />
		</span>
	{/if}
</span>
