<script lang="ts">
	// Dateisymbol nach Typ: Symbol in der Typfarbe (PDF rot, Word blau, Tabelle grün …), ab Größe `md` mit
	// Endungs-Kürzel („DOCX“) darunter. Die getönte Fläche setzt der Aufrufer (`fileTint`).
	import { cn } from '$lib/utils';
	import { FILE_KIND_CLASSES, FILE_KIND_ICONS, fileTypeOf } from './file-types';

	let {
		contentType,
		name = null,
		size = 'md',
		class: className
	}: {
		contentType: string | null | undefined;
		name?: string | null;
		/** `sm` = 20 px ohne Kürzel (Liste, Suche), `md` = 44 px (Raster), `lg` = 64 px (Vorschau, Info) */
		size?: 'sm' | 'md' | 'lg';
		class?: string;
	} = $props();

	const info = $derived(fileTypeOf(contentType, name));
	const Icon = $derived(FILE_KIND_ICONS[info.kind]);
	const color = $derived(FILE_KIND_CLASSES[info.kind].text);
</script>

{#if size === 'sm'}
	<Icon class={cn('size-5 shrink-0', color, className)} aria-hidden="true" />
{:else}
	<span
		class={cn('inline-flex flex-col items-center gap-1.5', color, className)}
		aria-hidden="true"
	>
		<Icon class={size === 'lg' ? 'size-16' : 'size-11'} strokeWidth={1.75} />
		{#if info.badge}
			<span
				class="rounded border border-current/25 bg-card px-1.5 py-px text-xs leading-4 font-semibold tracking-wide"
			>
				{info.badge}
			</span>
		{/if}
	</span>
{/if}
