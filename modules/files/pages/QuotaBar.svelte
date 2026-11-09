<script lang="ts">
	// VERTRAG (Welle 0) – Props nicht ändern; Implementierung: Welle 4.4.
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import { cn } from '$lib/utils';
	import type { Quota } from '../schemas';
	import { formatBytes } from './helpers';

	let { quota, class: className = '' }: { quota: Quota; class?: string } = $props();

	const uid = $props.id();

	const used = $derived(Math.max(0, Number.isFinite(quota.usedBytes) ? quota.usedBytes : 0));
	const limit = $derived(
		quota.limitBytes !== null && Number.isFinite(quota.limitBytes) && quota.limitBytes > 0
			? quota.limitBytes
			: null
	);
	/** Anteil in Prozent (ungerundet, kann > 100 sein) */
	const ratio = $derived(limit === null ? 0 : (used / limit) * 100);
	const percent = $derived(Math.min(100, Math.round(ratio)));
	const state = $derived<'ok' | 'warn' | 'full'>(
		limit === null ? 'ok' : ratio >= 100 ? 'full' : ratio >= 90 ? 'warn' : 'ok'
	);
	const label = $derived(
		limit === null
			? `${formatBytes(used)} belegt (unbegrenzt)`
			: `${formatBytes(used)} von ${formatBytes(limit)} belegt`
	);
</script>

<div class={cn('grid gap-1 text-sm', className)}>
	{#if limit === null}
		<p class="text-muted-foreground">{label}</p>
	{:else}
		<div class="flex items-baseline justify-between gap-2">
			<span id="{uid}-label" class="text-muted-foreground tabular-nums">{label}</span>
			{#if state === 'warn'}
				<span class="inline-flex items-center gap-1 text-xs font-medium text-warning">
					<TriangleAlert class="size-3.5" aria-hidden="true" />
					Fast voll
				</span>
			{/if}
		</div>
		<div
			role="meter"
			aria-labelledby="{uid}-label"
			aria-valuemin={0}
			aria-valuemax={limit}
			aria-valuenow={Math.min(used, limit)}
			aria-valuetext="{label} ({percent} %)"
			class="bg-muted h-2 w-full overflow-hidden rounded-full"
		>
			<div
				class={cn(
					'h-full rounded-full transition-[width]',
					state === 'full' ? 'bg-destructive' : state === 'warn' ? 'bg-warning' : 'bg-primary'
				)}
				style="width: {percent}%"
			></div>
		</div>
		{#if state === 'full'}
			<p role="status" class="text-destructive flex items-start gap-1 text-xs font-medium">
				<TriangleAlert class="mt-px size-3.5 shrink-0" aria-hidden="true" />
				Speicher voll – lösche Dateien oder leere den Papierkorb.
			</p>
		{/if}
	{/if}
	<p class="text-muted-foreground text-xs">Der Papierkorb zählt mit.</p>
</div>
