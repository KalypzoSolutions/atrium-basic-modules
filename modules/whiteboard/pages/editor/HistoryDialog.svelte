<script lang="ts">
	// Versionsverlauf: benannte und automatische Versionen, Stand speichern, wiederherstellen, löschen
	import { toast } from 'svelte-sonner';
	import History from '@lucide/svelte/icons/history';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { apiFetch } from '$lib/sdk/client';
	import { formatDateTimeDe } from '$lib/sdk/dates';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import {
		BUSY_SAVE,
		ConfirmDialog,
		EmptyState,
		ErrorState,
		LoadingState
	} from '$lib/components/layout';
	import type { Snapshot } from '../../schemas';
	import { BASE, errMsg } from '../helpers';

	let {
		open = $bindable(false),
		boardId,
		canEdit,
		onrestored
	}: { open?: boolean; boardId: string; canEdit: boolean; onrestored: () => void } = $props();

	let items = $state<Snapshot[]>([]);
	let loading = $state(false);
	let error = $state('');
	let label = $state('');
	let saving = $state(false);
	let confirm = $state<Snapshot | null>(null);
	let confirmOpen = $state(false);

	async function load() {
		loading = true;
		error = '';
		try {
			items = await apiFetch<Snapshot[]>(`${BASE}/boards/${boardId}/snapshots`);
		} catch (e) {
			error = errMsg(e, 'Versionen konnten nicht geladen werden');
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		if (open) void load();
	});

	async function save(e: SubmitEvent) {
		e.preventDefault();
		if (!label.trim()) return;
		saving = true;
		try {
			await apiFetch(`${BASE}/boards/${boardId}/snapshots`, {
				method: 'POST',
				body: JSON.stringify({ label: label.trim() })
			});
			label = '';
			toast.success('Version gespeichert');
			await load();
		} catch (err) {
			toast.error(errMsg(err, 'Version konnte nicht gespeichert werden'));
		} finally {
			saving = false;
		}
	}

	async function restore() {
		const s = confirm;
		if (!s) return;
		try {
			await apiFetch(`${BASE}/boards/${boardId}/snapshots/${s.id}/restore`, { method: 'POST' });
			toast.success(
				'Version wiederhergestellt – der vorherige Stand liegt als Version „Vor dem Wiederherstellen“ bereit'
			);
			open = false;
			onrestored();
		} catch (err) {
			toast.error(errMsg(err, 'Wiederherstellen fehlgeschlagen'));
		}
	}

	async function remove(s: Snapshot) {
		try {
			await apiFetch(`${BASE}/boards/${boardId}/snapshots/${s.id}`, { method: 'DELETE' });
			items = items.filter((x) => x.id !== s.id);
			toast.success('Version gelöscht');
		} catch (err) {
			toast.error(errMsg(err, 'Löschen fehlgeschlagen'));
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Versionen</Dialog.Title>
			<Dialog.Description>
				Stündlich wird automatisch eine Version gespeichert, wenn sich etwas geändert hat. Wichtige
				Stände kannst du mit Namen sichern.
			</Dialog.Description>
		</Dialog.Header>
		{#if canEdit}
			<form class="flex gap-2" onsubmit={save}>
				<Input
					bind:value={label}
					maxlength={100}
					placeholder="z. B. Stand nach dem Leitungstreffen"
					aria-label="Name der Version"
				/>
				<Button type="submit" disabled={saving || !label.trim()}
					>{saving ? BUSY_SAVE : 'Speichern'}</Button
				>
			</form>
		{/if}
		<div class="max-h-80 overflow-y-auto">
			{#if loading && !items.length}
				<LoadingState label="Versionen" rows={3} />
			{:else if error}
				<ErrorState message={error} onretry={load} compact />
			{:else if !items.length}
				<EmptyState
					title="Noch keine Versionen"
					description="Sobald sich das Whiteboard ändert, entstehen automatische Versionen."
				/>
			{:else}
				<ul class="divide-y">
					{#each items as s (s.id)}
						<li class="flex items-center gap-3 py-2">
							<History class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
							<div class="min-w-0 flex-1">
								<p class="truncate text-sm font-medium">
									{s.label ?? 'Automatisch gespeichert'}
									{#if s.auto}<Badge variant="secondary" class="ml-1">automatisch</Badge>{/if}
								</p>
								<p class="text-xs text-muted-foreground">
									{formatDateTimeDe(s.createdAt)} · {s.elementCount}
									{s.elementCount === 1 ? 'Element' : 'Elemente'}{s.createdBy
										? ` · ${s.createdBy.name}`
										: ''}
								</p>
							</div>
							{#if canEdit}
								<Button
									variant="outline"
									size="sm"
									onclick={() => {
										confirm = s;
										confirmOpen = true;
									}}
								>
									<RotateCcw /> Wiederherstellen
								</Button>
								{#if !s.auto}
									<Button
										variant="ghost"
										size="icon-sm"
										aria-label={`Version „${s.label}“ löschen`}
										onclick={() => remove(s)}
									>
										<Trash2 />
									</Button>
								{/if}
							{/if}
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	</Dialog.Content>
</Dialog.Root>

<ConfirmDialog
	bind:open={confirmOpen}
	title="Version wiederherstellen?"
	description="Das Whiteboard wird für alle auf diesen Stand gesetzt. Der aktuelle Stand wird vorher als Version gesichert."
	confirmLabel="Wiederherstellen"
	onconfirm={restore}
/>
