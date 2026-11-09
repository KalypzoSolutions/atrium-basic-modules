<script lang="ts">
	// Papierkorb: gelöschte Seiten (mit Unterseiten) wiederherstellen oder endgültig löschen
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { apiFetch } from '$lib/sdk/client';
	import { formatDateDe } from '$lib/sdk/dates';
	import { ConfirmDialog, EmptyState, ErrorState, LoadingState } from '$lib/components/layout';
	import { Button } from '$lib/components/ui/button';
	import { TRASH_DAYS, type TrashItem } from '../schemas';
	import NoteIcon from './NoteIcon.svelte';
	import { API, errMsg, noteTitle, relativeTime } from './helpers';

	let items = $state<TrashItem[]>([]);
	let loading = $state(true);
	let error = $state('');
	let busy = $state<string | null>(null);
	let purgeItem = $state<TrashItem | null>(null);
	let purgeOpen = $state(false);

	async function load() {
		loading = true;
		error = '';
		try {
			items = await apiFetch<TrashItem[]>(`${API}/notes/trash`);
		} catch (e) {
			error = errMsg(e, 'Papierkorb konnte nicht geladen werden');
		} finally {
			loading = false;
		}
	}

	async function restore(item: TrashItem) {
		busy = item.id;
		try {
			await apiFetch<{ restored: number }>(`${API}/notes/trash/restore`, {
				method: 'POST',
				body: JSON.stringify({ ids: [item.id] })
			});
			toast.success(`„${noteTitle(item.title)}“ wiederhergestellt`);
			await load();
		} catch (e) {
			toast.error(errMsg(e, 'Wiederherstellen fehlgeschlagen'));
		} finally {
			busy = null;
		}
	}

	async function purge() {
		const item = purgeItem;
		if (!item) return;
		try {
			await apiFetch(`${API}/notes/trash/purge`, {
				method: 'POST',
				body: JSON.stringify({ ids: [item.id] })
			});
			toast.success('Endgültig gelöscht');
			await load();
		} catch (e) {
			toast.error(errMsg(e, 'Löschen fehlgeschlagen'));
		}
	}

	onMount(() => {
		void load();
	});
</script>

{#if loading && !items.length}
	<LoadingState label="Papierkorb" rows={3} />
{:else if error}
	<ErrorState message={error} onretry={load} />
{:else if !items.length}
	<EmptyState
		title="Der Papierkorb ist leer"
		description={`Gelöschte Notizen bleiben ${TRASH_DAYS} Tage hier und lassen sich wiederherstellen.`}
	/>
{:else}
	<p class="mb-3 text-sm text-muted-foreground">
		Gelöschte Notizen werden nach {TRASH_DAYS} Tagen endgültig entfernt.
	</p>
	<ul class="divide-y rounded-lg border bg-card">
		{#each items as item (item.id)}
			<li class="flex flex-wrap items-center gap-3 px-3 py-2.5">
				<NoteIcon icon={item.icon} color={null} class="size-5" />
				<div class="min-w-0 flex-1">
					<p class="truncate text-sm font-medium">{noteTitle(item.title)}</p>
					<p class="truncate text-xs text-muted-foreground">
						Gelöscht {relativeTime(item.deletedAt)}{item.deletedBy
							? ` von ${item.deletedBy.name}`
							: ''}{item.parentTitle
							? ` · aus „${noteTitle(item.parentTitle)}“`
							: ''}{item.descendants
							? ` · ${item.descendants} ${item.descendants === 1 ? 'Unterseite' : 'Unterseiten'}`
							: ''} · endgültig am {formatDateDe(item.purgeOn)}
					</p>
				</div>
				<div class="flex gap-2">
					<Button
						size="sm"
						variant="outline"
						disabled={busy === item.id}
						onclick={() => restore(item)}
					>
						<RotateCcw /> Wiederherstellen
					</Button>
					<Button
						size="sm"
						variant="destructive"
						onclick={() => {
							purgeItem = item;
							purgeOpen = true;
						}}
					>
						<Trash2 /> Endgültig löschen
					</Button>
				</div>
			</li>
		{/each}
	</ul>
{/if}

<ConfirmDialog
	bind:open={purgeOpen}
	title="Endgültig löschen?"
	description={purgeItem
		? `„${noteTitle(purgeItem.title)}“${purgeItem.descendants ? ` mit ${purgeItem.descendants} Unterseiten` : ''} wird unwiderruflich gelöscht, samt Bildern und Versionen.`
		: ''}
	confirmLabel="Endgültig löschen"
	destructive
	onconfirm={purge}
/>
