<script lang="ts">
	// Auswahl „Einbetten“: Suche über alle Module, die Einbettungen anbieten (z. B. Whiteboards)
	import { untrack } from 'svelte';
	import Search from '@lucide/svelte/icons/search';
	import { ErrorState, iconFor } from '$lib/components/layout';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import type { EmbedHit, EmbedRef } from '$lib/sdk/types/embeds';
	import { errMsg } from '../helpers';
	import { searchEmbeds } from './embeds';

	let {
		open = $bindable(false),
		onpick
	}: {
		open?: boolean;
		onpick: (ref: EmbedRef) => void;
	} = $props();

	let query = $state('');
	let hits = $state<EmbedHit[]>([]);
	let loading = $state(false);
	let error = $state('');
	let active = $state(0);

	$effect(() => {
		if (!open) return;
		untrack(() => {
			query = '';
			hits = [];
			error = '';
			active = 0;
		});
	});

	$effect(() => {
		const q = query.trim();
		if (!open) return;
		if (q.length < 2) {
			hits = [];
			loading = false;
			return;
		}
		let stale = false;
		loading = true;
		const t = setTimeout(() => {
			searchEmbeds(q)
				.then((res) => {
					if (stale) return;
					hits = res;
					active = 0;
					error = '';
				})
				.catch((e) => {
					if (!stale) error = errMsg(e, 'Suche fehlgeschlagen');
				})
				.finally(() => {
					if (!stale) loading = false;
				});
		}, 250);
		return () => {
			stale = true;
			clearTimeout(t);
		};
	});

	function pick(h: EmbedHit) {
		onpick({ module: h.module, kind: h.kind, refId: h.refId });
		open = false;
	}

	function keydown(e: KeyboardEvent) {
		if (!hits.length) return;
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			active = (active + 1) % hits.length;
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			active = (active - 1 + hits.length) % hits.length;
		} else if (e.key === 'Enter') {
			e.preventDefault();
			const h = hits[active];
			if (h) pick(h);
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Einbetten</Dialog.Title>
			<Dialog.Description>
				Whiteboard oder andere Inhalte einbetten – sie bleiben live und lassen sich direkt in der
				Notiz bearbeiten (mit Bearbeiten-Zugriff).
			</Dialog.Description>
		</Dialog.Header>
		<div class="relative">
			<Search
				class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
				aria-hidden="true"
			/>
			<Input
				bind:value={query}
				class="pl-8"
				placeholder="Titel suchen …"
				aria-label="Einbettung suchen"
				aria-controls="note-embed-hits"
				onkeydown={keydown}
				autocomplete="off"
			/>
		</div>
		<div class="max-h-80 min-h-24 overflow-y-auto" aria-live="polite">
			{#if error}
				<ErrorState compact message={error} />
			{:else if query.trim().length < 2}
				<p class="py-6 text-center text-sm text-muted-foreground">Mindestens 2 Zeichen eingeben.</p>
			{:else if loading && !hits.length}
				<p class="py-6 text-center text-sm text-muted-foreground">Sucht …</p>
			{:else if !hits.length}
				<p class="py-6 text-center text-sm text-muted-foreground">Nichts gefunden.</p>
			{:else}
				<ul id="note-embed-hits" role="listbox" aria-label="Treffer" class="grid gap-1">
					{#each hits as h, i (`${h.module}:${h.kind}:${h.refId}`)}
						{@const Icon = iconFor(h.icon)}
						<li role="option" aria-selected={i === active}>
							<button
								type="button"
								class={[
									'flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring',
									i === active && 'bg-muted'
								]}
								onmouseenter={() => (active = i)}
								onclick={() => pick(h)}
							>
								<Icon class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
								<span class="min-w-0 flex-1">
									<span class="block truncate font-medium">{h.title}</span>
									{#if h.subtitle}
										<span class="block truncate text-xs text-muted-foreground">{h.subtitle}</span>
									{/if}
								</span>
								<span class="shrink-0 text-xs text-muted-foreground">{h.kindLabel}</span>
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</Dialog.Content>
</Dialog.Root>
