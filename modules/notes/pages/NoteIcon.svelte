<script lang="ts">
	// Icon einer Notiz (Icon-Bibliothek, Farbe der Notiz); ohne Icon ein Seitensymbol
	import FileText from '@lucide/svelte/icons/file-text';
	import { DynamicIcon } from '$lib/components/ui/icon-picker';
	import { cn } from '$lib/utils';

	let {
		icon,
		color,
		class: className
	}: {
		icon: string | null | undefined;
		color: string | null | undefined;
		class?: string;
	} = $props();
</script>

<span
	class={cn('inline-flex shrink-0 items-center justify-center text-muted-foreground', className)}
	style:color={color ?? undefined}
	aria-hidden="true"
>
	<DynamicIcon name={icon} class="size-full">
		{#snippet fallback()}
			<FileText class="size-full" />
		{/snippet}
	</DynamicIcon>
</span>
