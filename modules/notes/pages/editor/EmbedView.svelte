<script lang="ts">
	// Darstellung eines eingebetteten Inhalts (Node-View des Knotens `embed`): Kopf mit Titel/Icon, iframe der
	// Einbett-Seite des anbietenden Moduls – erst geladen, wenn sichtbar, außer Sicht nach 30 s wieder entladen –,
	// Höhe per Griff ziehbar. Zugriff prüft das anbietende Modul (je Betrachter*in).
	import { onMount } from 'svelte';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import GripHorizontal from '@lucide/svelte/icons/grip-horizontal';
	import RotateCw from '@lucide/svelte/icons/rotate-cw';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { iconFor } from '$lib/components/layout';
	import { Button } from '$lib/components/ui/button';
	import type { EmbedInfo } from '$lib/sdk/types/embeds';
	import { MAX_EMBED_HEIGHT, MIN_EMBED_HEIGHT } from '../../schemas';
	import { describeEmbed } from './embeds';

	let {
		module,
		kind,
		refId,
		height,
		editable,
		selected,
		onheight,
		onremove
	}: {
		module: string | null;
		kind: string | null;
		refId: string | null;
		height: number;
		editable: boolean;
		selected: boolean;
		onheight: (h: number) => void;
		onremove: () => void;
	} = $props();

	let info = $state<EmbedInfo | null>(null);
	let failed = $state(false);
	let visible = $state(false);
	let loaded = $state(false);
	let frameKey = $state(0);
	let dragHeight = $state<number | null>(null);
	let root = $state<HTMLDivElement | null>(null);
	let unloadTimer: ReturnType<typeof setTimeout> | null = null;

	const shownHeight = $derived(dragHeight ?? height);
	const Icon = $derived(iconFor(info?.icon));

	$effect(() => {
		const ref = module && kind && refId ? { module, kind, refId } : null;
		if (!ref) {
			info = null;
			failed = true;
			return;
		}
		let stale = false;
		failed = false;
		describeEmbed(ref)
			.then((i) => {
				if (!stale) info = i;
			})
			.catch(() => {
				if (!stale) failed = true;
			});
		return () => {
			stale = true;
		};
	});

	onMount(() => {
		if (!root) return;
		const io = new IntersectionObserver(
			([entry]) => {
				visible = !!entry?.isIntersecting;
				if (visible) {
					if (unloadTimer) clearTimeout(unloadTimer);
					unloadTimer = null;
					loaded = true;
				} else if (loaded && !unloadTimer) {
					unloadTimer = setTimeout(() => {
						unloadTimer = null;
						if (!visible) loaded = false;
					}, 30_000);
				}
			},
			{ rootMargin: '200px 0px' }
		);
		io.observe(root);
		return () => {
			io.disconnect();
			if (unloadTimer) clearTimeout(unloadTimer);
		};
	});

	function startResize(e: PointerEvent) {
		if (!editable) return;
		e.preventDefault();
		e.stopPropagation();
		const el = e.currentTarget as HTMLElement;
		el.setPointerCapture(e.pointerId);
		const startY = e.clientY;
		const start = height;
		const clamp = (v: number) =>
			Math.round(Math.min(MAX_EMBED_HEIGHT, Math.max(MIN_EMBED_HEIGHT, v)));
		const move = (ev: PointerEvent) => (dragHeight = clamp(start + ev.clientY - startY));
		const up = () => {
			el.removeEventListener('pointermove', move);
			el.removeEventListener('pointerup', up);
			el.removeEventListener('pointercancel', up);
			if (dragHeight !== null && dragHeight !== height) onheight(dragHeight);
			dragHeight = null;
		};
		el.addEventListener('pointermove', move);
		el.addEventListener('pointerup', up);
		el.addEventListener('pointercancel', up);
	}

	function resizeKey(e: KeyboardEvent) {
		if (!editable) return;
		const step = e.shiftKey ? 100 : 20;
		if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
		e.preventDefault();
		const next = Math.min(
			MAX_EMBED_HEIGHT,
			Math.max(MIN_EMBED_HEIGHT, height + (e.key === 'ArrowDown' ? step : -step))
		);
		if (next !== height) onheight(next);
	}
</script>

<div
	bind:this={root}
	class={[
		'note-embed-card my-3 overflow-hidden rounded-lg border bg-card text-card-foreground',
		selected && 'ring-2 ring-ring'
	]}
	data-drag-handle
>
	<div class="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-sm">
		<Icon class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
		<span class="min-w-0 flex-1 truncate font-medium">
			{info?.title ?? (failed ? 'Eingebetteter Inhalt' : 'Lädt …')}
		</span>
		{#if info?.kindLabel}
			<span class="hidden text-xs text-muted-foreground sm:inline">{info.kindLabel}</span>
		{/if}
		{#if info?.available && loaded}
			<Button
				variant="ghost"
				size="icon"
				class="size-7"
				aria-label="Neu laden"
				title="Neu laden"
				onclick={() => frameKey++}
			>
				<RotateCw class="size-3.5" />
			</Button>
		{/if}
		{#if info?.openHref}
			<Button variant="ghost" size="sm" class="h-7" href={info.openHref} target="_blank">
				<ExternalLink class="size-3.5" /> Öffnen
			</Button>
		{/if}
		{#if editable}
			<Button
				variant="ghost"
				size="icon"
				class="size-7"
				aria-label="Einbettung entfernen"
				title="Einbettung entfernen"
				onclick={onremove}
			>
				<Trash2 class="size-3.5" />
			</Button>
		{/if}
	</div>
	<div class="relative bg-background" style:height={`${shownHeight}px`}>
		{#if failed || (info && !info.available)}
			<div
				class="flex h-full items-center justify-center p-4 text-center text-sm text-muted-foreground"
			>
				Dieser Inhalt ist nicht verfügbar – er wurde gelöscht oder du hast keinen Zugriff darauf.
			</div>
		{:else if info?.embedPath && loaded}
			{#key frameKey}
				<iframe
					src={info.embedPath}
					title={info.title}
					class="size-full border-0"
					loading="lazy"
					allow="fullscreen; clipboard-write"
				></iframe>
			{/key}
		{:else}
			<div class="flex h-full items-center justify-center text-sm text-muted-foreground">
				{info ? 'Wird geladen, sobald sichtbar …' : 'Lädt …'}
			</div>
		{/if}
		{#if dragHeight !== null}
			<!-- iframe fängt sonst die Zeigerereignisse beim Ziehen -->
			<div class="absolute inset-0"></div>
		{/if}
	</div>
	{#if editable}
		<div
			class="flex h-3 cursor-ns-resize items-center justify-center border-t bg-muted/40 text-muted-foreground hover:bg-muted focus-visible:bg-muted"
			role="slider"
			tabindex="0"
			aria-label="Höhe der Einbettung"
			aria-valuemin={MIN_EMBED_HEIGHT}
			aria-valuemax={MAX_EMBED_HEIGHT}
			aria-valuenow={shownHeight}
			aria-orientation="vertical"
			onpointerdown={startResize}
			onkeydown={resizeKey}
		>
			<GripHorizontal class="size-3" aria-hidden="true" />
		</div>
	{/if}
</div>
