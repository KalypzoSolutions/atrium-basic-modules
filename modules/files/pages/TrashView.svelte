<script lang="ts">
	// VERTRAG (Welle 0) – Props nicht ändern; Implementierung: Welle 3.5.
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import X from '@lucide/svelte/icons/x';
	import { apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as Table from '$lib/components/ui/table';
	import { ConfirmDialog, DataTable, MobileActionBar } from '$lib/components/layout';
	import {
		DEFAULT_TRASH_DAYS,
		MAX_BULK,
		type BulkResult,
		type FilesMeta,
		type TrashItem
	} from '../schemas';
	import { API, errorText, formatBytes, formatDateTime, iconFor } from './helpers';
	import FileTypeGlyph from './FileTypeGlyph.svelte';

	let {
		meta,
		onchanged
	}: {
		/** `trashDays` für den Hinweistext */
		meta: FilesMeta | null;
		/** Nach Wiederherstellen/Löschen (Kontingent neu laden) */
		onchanged: () => void;
	} = $props();

	let items = $state<TrashItem[]>([]);
	let loading = $state(true);
	let loadError = $state('');
	let selected = $state<string[]>([]);
	let busy = $state(false);
	let confirmPurge = $state(false);
	let confirmEmpty = $state(false);

	const trashDays = $derived(meta?.trashDays ?? DEFAULT_TRASH_DAYS);
	const allSelected = $derived(items.length > 0 && selected.length === items.length);
	const someSelected = $derived(selected.length > 0 && selected.length < items.length);

	async function load() {
		loading = true;
		loadError = '';
		try {
			items = await apiFetch<TrashItem[]>(`${API}/trash`);
			const ids = new Set(items.map((i) => i.id));
			selected = selected.filter((id) => ids.has(id));
		} catch (e) {
			loadError = errorText(e, 'Papierkorb konnte nicht geladen werden');
		} finally {
			loading = false;
		}
	}

	onMount(load);

	function toggle(id: string, on: boolean) {
		selected = on ? [...new Set([...selected, id])] : selected.filter((s) => s !== id);
	}
	function toggleAll(on: boolean) {
		selected = on ? items.map((i) => i.id) : [];
	}

	const entries = (n: number) => (n === 1 ? '1 Eintrag' : `${n} Einträge`);

	/** Bulk-Aufruf in Stücken zu höchstens `MAX_BULK` IDs */
	async function bulk(path: string, ids: string[]): Promise<number> {
		let affected = 0;
		for (let i = 0; i < ids.length; i += MAX_BULK) {
			const res = await apiFetch<BulkResult>(`${API}${path}`, {
				method: 'POST',
				body: JSON.stringify({ ids: ids.slice(i, i + MAX_BULK) })
			});
			affected += res?.affected ?? 0;
		}
		return affected;
	}

	async function run(path: string, ids: string[], done: (n: number) => string, failed: string) {
		if (ids.length === 0 || busy) return;
		busy = true;
		try {
			const n = await bulk(path, ids);
			toast.success(done(n));
			selected = [];
		} catch (e) {
			toast.error(errorText(e, failed));
		} finally {
			busy = false;
			await load();
			onchanged();
		}
	}

	const restore = (ids: string[]) =>
		run(
			'/trash/restore',
			ids,
			(n) => `${entries(n)} wiederhergestellt`,
			'Wiederherstellen fehlgeschlagen'
		);
	const purge = (ids: string[]) =>
		run(
			'/trash/purge',
			ids,
			(n) => `${entries(n)} endgültig gelöscht`,
			'Endgültiges Löschen fehlgeschlagen'
		);

	function formatDay(day: string): string {
		const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
		return m ? `${m[3]}.${m[2]}.${m[1]}` : day;
	}
</script>

<div class="space-y-4 {selected.length ? 'pb-20 sm:pb-0' : ''}">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<p class="text-sm text-muted-foreground">
			Einträge werden nach {trashDays} Tagen endgültig gelöscht.
		</p>
		{#if items.length > 0}
			<Button
				variant="outline"
				size="sm"
				class="text-destructive"
				disabled={busy}
				onclick={() => (confirmEmpty = true)}
			>
				<Trash2 /> Papierkorb leeren
			</Button>
		{/if}
	</div>

	<DataTable
		caption="Papierkorb"
		mobile="cards"
		{loading}
		error={loadError}
		empty={items.length === 0}
		emptyTitle="Der Papierkorb ist leer"
		emptyDescription="Gelöschte Dateien und Ordner landen hier und lassen sich wiederherstellen."
	>
		{#snippet toolbar()}
			{#if loadError}
				<Button size="sm" variant="outline" onclick={load}>Erneut versuchen</Button>
			{/if}
			<MobileActionBar
				show={selected.length > 0}
				label="Auswahl im Papierkorb"
				class="sm:w-full sm:rounded-md sm:border sm:bg-muted/40 sm:px-3 sm:py-2"
			>
				<span class="text-sm font-medium" aria-live="polite">{selected.length} ausgewählt</span>
				<Button size="sm" variant="outline" disabled={busy} onclick={() => restore(selected)}>
					<RotateCcw />
					{busy ? 'Speichert …' : 'Wiederherstellen'}
				</Button>
				<Button
					size="sm"
					variant="outline"
					class="text-destructive"
					disabled={busy}
					onclick={() => (confirmPurge = true)}
				>
					<Trash2 /> Endgültig löschen
				</Button>
				<Button size="sm" variant="ghost" class="ml-auto" onclick={() => (selected = [])}>
					<X /> Auswahl aufheben
				</Button>
			</MobileActionBar>
		{/snippet}
		{#snippet head()}
			<Table.Row>
				<Table.Head class="w-10">
					<Checkbox
						aria-label="Alle Einträge auswählen"
						checked={allSelected}
						indeterminate={someSelected}
						onCheckedChange={(v) => toggleAll(v === true)}
					/>
				</Table.Head>
				<Table.Head>Name</Table.Head>
				<Table.Head>Ursprünglicher Ort</Table.Head>
				<Table.Head>Gelöscht</Table.Head>
				<Table.Head class="text-right">Größe</Table.Head>
				<Table.Head>Wird gelöscht am</Table.Head>
				<Table.Head class="text-right"><span class="sr-only">Aktionen</span></Table.Head>
			</Table.Row>
		{/snippet}
		{#each items as item (item.id)}
			{@const Icon = iconFor(item.kind, null)}
			<Table.Row data-state={selected.includes(item.id) ? 'selected' : undefined}>
				<Table.Cell>
					<Checkbox
						aria-label={`${item.name} auswählen`}
						checked={selected.includes(item.id)}
						onCheckedChange={(v) => toggle(item.id, v === true)}
					/>
				</Table.Cell>
				<Table.Cell class="font-medium">
					<div class="flex min-w-0 items-center gap-2">
						{#if item.kind === 'file'}
							<FileTypeGlyph contentType={null} name={item.name} size="sm" class="size-4" />
						{:else}
							<Icon class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
						{/if}
						<span class="max-w-xs truncate" title={item.name}>{item.name}</span>
					</div>
				</Table.Cell>
				<Table.Cell>
					<span class="max-w-xs truncate text-muted-foreground" title={item.originalPath}>
						{item.originalPath}
					</span>
				</Table.Cell>
				<Table.Cell>
					<span class="whitespace-nowrap">{formatDateTime(item.deletedAt)}</span>
					{#if item.deletedBy}
						<span class="block text-xs text-muted-foreground">von {item.deletedBy.name}</span>
					{/if}
				</Table.Cell>
				<Table.Cell class="text-right tabular-nums">{formatBytes(item.sizeBytes)}</Table.Cell>
				<Table.Cell class="tabular-nums">{formatDay(item.purgeOn)}</Table.Cell>
				<Table.Cell class="text-right">
					<Button
						size="sm"
						variant="ghost"
						disabled={busy}
						aria-label={`${item.name} wiederherstellen`}
						onclick={() => restore([item.id])}
					>
						<RotateCcw /> <span class="sm:sr-only">Wiederherstellen</span>
					</Button>
				</Table.Cell>
			</Table.Row>
		{/each}
	</DataTable>
</div>

<ConfirmDialog
	bind:open={confirmPurge}
	title={`${entries(selected.length)} endgültig löschen?`}
	description="Die ausgewählten Einträge werden unwiderruflich gelöscht und können nicht wiederhergestellt werden."
	confirmLabel="Endgültig löschen"
	destructive
	onconfirm={() => purge([...selected])}
/>

<ConfirmDialog
	bind:open={confirmEmpty}
	title="Papierkorb leeren?"
	description={items.length === 1
		? 'Der Eintrag im Papierkorb wird unwiderruflich gelöscht.'
		: `Alle ${items.length} Einträge im Papierkorb werden unwiderruflich gelöscht.`}
	confirmLabel="Papierkorb leeren"
	destructive
	onconfirm={() => purge(items.map((i) => i.id))}
/>
