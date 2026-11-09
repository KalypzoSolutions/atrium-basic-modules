<script lang="ts">
	// Karte einfügen: Datensatz aus einem anderen Modul suchen (nur Typen, die die Person nutzen darf)
	import { page } from '$app/state';
	import { untrack } from 'svelte';
	import { apiFetch, can } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import { EmptyState, ErrorState, FormField, LoadingState } from '$lib/components/layout';
	import { REF_LABELS, type RefCard, type RefType } from '../../schemas';
	import { BASE, errMsg } from '../helpers';

	let {
		open = $bindable(false),
		initialType = null,
		onpick
	}: { open?: boolean; initialType?: RefType | null; onpick: (card: RefCard) => void } = $props();

	/** Recht, ohne das ein Typ nicht angeboten wird (Modul aus → Recht fehlt) */
	const TYPE_PERMISSION: Record<RefType, string> = {
		action: 'actions.action.view',
		task: 'tasks.board.view',
		taskboard: 'tasks.board.view',
		event: 'events.event.view',
		gallery: 'galleries.gallery.view',
		file: 'files.file.view',
		whiteboard: 'whiteboard.board.view',
		note: 'notes.note.view'
	};

	const permissions = $derived((page.data.permissions ?? []) as string[]);
	const types = $derived(
		(Object.keys(TYPE_PERMISSION) as RefType[]).filter((t) => can(permissions, TYPE_PERMISSION[t]))
	);
	const typeOptions = $derived(types.map((t) => ({ value: t, label: REF_LABELS[t] })));

	let type = $state<RefType>('action');
	let search = $state('');
	let items = $state<RefCard[]>([]);
	let loading = $state(false);
	let error = $state('');

	$effect(() => {
		if (!open) return;
		untrack(() => {
			type = initialType && types.includes(initialType) ? initialType : (types[0] ?? 'whiteboard');
			search = '';
		});
	});

	$effect(() => {
		if (!open) return;
		const t = type;
		const q = search.trim();
		// Dateien nur mit Suchbegriff (sonst zu viele)
		if (t === 'file' && q.length < 2) {
			items = [];
			error = '';
			return;
		}
		let stale = false;
		const timer = setTimeout(() => {
			loading = true;
			apiFetch<RefCard[]>(`${BASE}/refs?type=${t}&search=${encodeURIComponent(q)}`)
				.then((res) => {
					if (!stale) {
						items = res;
						error = '';
					}
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
			clearTimeout(timer);
		};
	});

	function pick(card: RefCard) {
		onpick(card);
		open = false;
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Karte einfügen</Dialog.Title>
			<Dialog.Description>
				Verknüpfe eine Aktion, Aufgabe, einen Termin, eine Galerie, Datei oder ein anderes
				Whiteboard. Jede Person sieht auf der Karte nur, was sie selbst sehen darf.
			</Dialog.Description>
		</Dialog.Header>
		<div class="grid grid-cols-1 gap-3 sm:grid-cols-[12rem_1fr]">
			<FormField label="Art" id="wb-ref-type">
				<SelectField
					id="wb-ref-type"
					label="Art"
					options={typeOptions}
					value={type}
					onchange={(v) => (type = (v ?? type) as RefType)}
				/>
			</FormField>
			<FormField label="Suche" id="wb-ref-search">
				<Input
					id="wb-ref-search"
					bind:value={search}
					placeholder={type === 'file' ? 'Dateiname (ab 2 Zeichen)' : 'Titel suchen …'}
					autocomplete="off"
				/>
			</FormField>
		</div>
		<div class="max-h-80 min-h-32 overflow-y-auto" aria-live="polite">
			{#if loading && !items.length}
				<LoadingState label="Treffer" rows={3} />
			{:else if error}
				<ErrorState message={error} compact />
			{:else if !items.length}
				<EmptyState
					title={type === 'file' && search.trim().length < 2
						? 'Dateinamen eingeben'
						: 'Nichts gefunden'}
					description={type === 'file' && search.trim().length < 2
						? 'Suche nach einer Datei oder einem Ordner aus „Dateien“.'
						: 'Probiere einen anderen Suchbegriff.'}
				/>
			{:else}
				<ul class="divide-y" aria-label="Treffer">
					{#each items as card (card.id)}
						<li>
							<button
								type="button"
								class="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
								onclick={() => pick(card)}
							>
								{#if card.imageUrl}
									<img src={card.imageUrl} alt="" class="size-10 shrink-0 rounded object-cover" />
								{:else}
									<span
										class="size-3 shrink-0 rounded-full bg-muted-foreground/40"
										style:background-color={card.color ?? undefined}
										aria-hidden="true"
									></span>
								{/if}
								<span class="min-w-0 flex-1">
									<span class="block truncate text-sm font-medium">{card.title}</span>
									{#if card.subtitle}
										<span class="block truncate text-xs text-muted-foreground">{card.subtitle}</span
										>
									{/if}
								</span>
								{#if card.badge}<Badge variant="secondary">{card.badge}</Badge>{/if}
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</Dialog.Content>
</Dialog.Root>
