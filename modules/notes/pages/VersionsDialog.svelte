<script lang="ts">
	// Versionsverlauf: Liste (automatisch + benannt), Vorschau, aktuelle Fassung als Version speichern,
	// Wiederherstellen (der Server sichert vorher den aktuellen Stand) und Löschen
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import History from '@lucide/svelte/icons/history';
	import Save from '@lucide/svelte/icons/save';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { apiFetch } from '$lib/sdk/client';
	import { formatDateTimeDe } from '$lib/sdk/dates';
	import { BUSY_SAVE, ConfirmDialog, ErrorState, LoadingState } from '$lib/components/layout';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { cn } from '$lib/utils';
	import type { NoteVersion, NoteVersionDetail } from '../schemas';
	import { API, errMsg } from './helpers';
	import VersionPreview from './VersionPreview.svelte';

	let {
		open = $bindable(false),
		noteId,
		canEdit,
		onrestored
	}: {
		open?: boolean;
		noteId: string;
		canEdit: boolean;
		onrestored: () => void;
	} = $props();

	let versions = $state<NoteVersion[]>([]);
	let loading = $state(false);
	let error = $state('');
	let selected = $state<NoteVersionDetail | null>(null);
	let previewLoading = $state(false);
	let label = $state('');
	let saving = $state(false);
	let restoreOpen = $state(false);
	let deleteOpen = $state(false);

	async function load() {
		loading = true;
		error = '';
		try {
			versions = await apiFetch<NoteVersion[]>(`${API}/notes/${noteId}/versions`);
		} catch (e) {
			error = errMsg(e, 'Versionen konnten nicht geladen werden');
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		if (!open) return;
		untrack(() => {
			selected = null;
			label = '';
			void load();
		});
	});

	async function select(v: NoteVersion) {
		previewLoading = true;
		try {
			selected = await apiFetch<NoteVersionDetail>(`${API}/notes/${noteId}/versions/${v.id}`);
		} catch (e) {
			toast.error(errMsg(e, 'Version konnte nicht geladen werden'));
		} finally {
			previewLoading = false;
		}
	}

	async function saveVersion(e: SubmitEvent) {
		e.preventDefault();
		if (!label.trim()) return;
		saving = true;
		try {
			await apiFetch(`${API}/notes/${noteId}/versions`, {
				method: 'POST',
				body: JSON.stringify({ label: label.trim() })
			});
			toast.success('Version gespeichert');
			label = '';
			await load();
		} catch (err) {
			toast.error(errMsg(err, 'Speichern fehlgeschlagen'));
		} finally {
			saving = false;
		}
	}

	async function restore() {
		if (!selected) return;
		try {
			await apiFetch(`${API}/notes/${noteId}/versions/${selected.id}/restore`, { method: 'POST' });
			toast.success('Version wiederhergestellt');
			open = false;
			onrestored();
		} catch (e) {
			toast.error(errMsg(e, 'Wiederherstellen fehlgeschlagen'));
		}
	}

	async function remove() {
		if (!selected) return;
		try {
			await apiFetch(`${API}/notes/${noteId}/versions/${selected.id}`, { method: 'DELETE' });
			toast.success('Version gelöscht');
			selected = null;
			await load();
		} catch (e) {
			toast.error(errMsg(e, 'Löschen fehlgeschlagen'));
		}
	}

	const versionName = (v: NoteVersion) => v.label ?? (v.auto ? 'Automatisch gesichert' : 'Version');
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-5xl">
		<Dialog.Header>
			<Dialog.Title>Versionen</Dialog.Title>
			<Dialog.Description>
				Frühere Stände ansehen und wiederherstellen. Vor dem Wiederherstellen wird der aktuelle
				Stand gesichert.
			</Dialog.Description>
		</Dialog.Header>

		{#if canEdit}
			<form class="flex flex-col gap-2 sm:flex-row" onsubmit={saveVersion}>
				<Input
					bind:value={label}
					maxlength={100}
					placeholder="Name der Version, z. B. „Vor der Abstimmung“"
					aria-label="Name der Version"
					class="sm:flex-1"
				/>
				<Button type="submit" disabled={saving || !label.trim()}>
					<Save />
					{saving ? BUSY_SAVE : 'Diese Version speichern'}
				</Button>
			</form>
		{/if}

		<div class="grid min-h-0 gap-3 sm:grid-cols-[16rem_1fr]">
			<div class="max-h-[min(28rem,50dvh)] overflow-y-auto rounded-md border">
				{#if loading && !versions.length}
					<LoadingState label="Versionen" rows={4} />
				{:else if error}
					<ErrorState compact message={error} onretry={load} />
				{:else if !versions.length}
					<p class="p-3 text-sm text-muted-foreground">
						Noch keine Versionen. Während der Bearbeitung werden regelmäßig Stände gesichert.
					</p>
				{:else}
					<ul class="divide-y" aria-label="Versionen">
						{#each versions as v (v.id)}
							<li>
								<button
									type="button"
									class={cn(
										'flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-sm outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring',
										selected?.id === v.id && 'bg-muted'
									)}
									aria-pressed={selected?.id === v.id}
									onclick={() => select(v)}
								>
									<span class="flex w-full items-center gap-2">
										<span class="min-w-0 flex-1 truncate font-medium">{versionName(v)}</span>
										{#if v.auto}<Badge variant="secondary">auto</Badge>{/if}
									</span>
									<span class="text-xs text-muted-foreground">
										{formatDateTimeDe(v.createdAt)}{v.createdBy ? ` · ${v.createdBy.name}` : ''}
									</span>
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
			<div class="flex min-h-48 min-w-0 flex-col rounded-md border">
				{#if previewLoading}
					<LoadingState label="Vorschau" rows={5} />
				{:else if selected}
					<div class="flex flex-wrap items-center gap-2 border-b px-3 py-2">
						<span class="min-w-0 flex-1 truncate text-sm font-medium">{versionName(selected)}</span>
						{#if canEdit}
							<Button size="sm" onclick={() => (restoreOpen = true)}>
								<History /> Wiederherstellen
							</Button>
							<Button
								size="sm"
								variant="ghost"
								aria-label="Version löschen"
								onclick={() => (deleteOpen = true)}
							>
								<Trash2 />
							</Button>
						{/if}
					</div>
					<div class="max-h-[min(26rem,45dvh)] overflow-y-auto p-4">
						{#key selected.id}
							<VersionPreview content={selected.content} />
						{/key}
					</div>
				{:else}
					<p class="m-auto p-6 text-sm text-muted-foreground">Wähle links eine Version aus.</p>
				{/if}
			</div>
		</div>
	</Dialog.Content>
</Dialog.Root>

<ConfirmDialog
	bind:open={restoreOpen}
	title="Version wiederherstellen?"
	description="Der Inhalt wird für alle auf diesen Stand gesetzt. Der aktuelle Stand wird vorher als Version gesichert."
	confirmLabel="Wiederherstellen"
	onconfirm={restore}
/>
<ConfirmDialog
	bind:open={deleteOpen}
	title="Version löschen?"
	description="Diese Version wird endgültig gelöscht. Der Inhalt der Notiz bleibt unverändert."
	confirmLabel="Löschen"
	destructive
	onconfirm={remove}
/>
