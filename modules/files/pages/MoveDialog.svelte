<script lang="ts">
	// Zielordner wählen: ein Baum ab „Dateien“ (eigene Wurzel + freigegebene Ordner), Kinder werden beim Aufklappen geladen.
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Folder from '@lucide/svelte/icons/folder';
	import HardDrive from '@lucide/svelte/icons/hard-drive';
	import { apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import {
		ROOT_LABEL,
		type BulkResult,
		type FileNode,
		type FilesMeta,
		type FolderListing
	} from '../schemas';
	import { API, compareNodes, errorText } from './helpers';

	let {
		open = $bindable(false),
		nodes,
		meta: _meta = null,
		onmoved
	}: {
		open?: boolean;
		/** Zu verschiebende Einträge */
		nodes: FileNode[];
		/** Fähigkeiten des Aufrufers (Ziele bestimmt der Zugriff je Ordner) */
		meta?: FilesMeta | null;
		onmoved: () => void;
	} = $props();

	interface Branch {
		loading: boolean;
		error: string | null;
		folders: FileNode[];
	}
	interface Target {
		/** `null` = eigene Wurzel („Dateien“) */
		id: string | null;
		name: string;
		/** Zielordner (für den Eigentümer-Hinweis), `null` bei der Wurzel */
		node: FileNode | null;
	}

	const keyOf = (id: string | null) => id ?? 'root';

	let branches = $state<Record<string, Branch>>({});
	let expanded = $state<Record<string, boolean>>({});
	let target = $state<Target | null>(null);
	let busy = $state(false);
	let error = $state<string | null>(null);

	/** Zu verschiebende Ordner ausblenden – damit sind auch ihre Unterbäume nicht erreichbar */
	const movingIds = $derived(new Set(nodes.map((n) => n.id)));

	/** Ziel = aktueller Ort aller Einträge → nichts zu tun */
	const isCurrent = $derived(
		!!target && nodes.length > 0 && nodes.every((n) => n.parentId === target!.id)
	);
	const canSubmit = $derived(!!target && !isCurrent && !busy && nodes.length > 0);

	/** Hinweis, wenn der Zielordner einer anderen Person gehört */
	const ownerHint = $derived.by(() => {
		const t = target?.node;
		if (!t || t.own) return null;
		return nodes.length === 1
			? `Der Eintrag gehört danach ${t.owner.name}.`
			: `Die Einträge gehören danach ${t.owner.name}.`;
	});

	async function load(id: string | null) {
		const key = keyOf(id);
		branches[key] = { loading: true, error: null, folders: [] };
		try {
			const qs = id ? `?${new URLSearchParams({ parent: id }).toString()}` : '';
			const listing = await apiFetch<FolderListing>(`${API}/nodes${qs}`);
			branches[key] = {
				loading: false,
				error: null,
				folders: listing.items
					.filter((n) => n.kind === 'folder' && !movingIds.has(n.id))
					.sort(compareNodes)
			};
		} catch (e) {
			branches[key] = {
				loading: false,
				error: errorText(e, 'Ordner konnten nicht geladen werden'),
				folders: []
			};
		}
	}

	function toggle(id: string | null) {
		const key = keyOf(id);
		const next = !expanded[key];
		expanded[key] = next;
		if (next && !branches[key]) void load(id);
	}

	function select(id: string | null, name: string, node: FileNode | null) {
		target = { id, name, node };
		error = null;
	}

	const isSelected = (id: string | null) => !!target && target.id === id;

	/** Beim Öffnen zurücksetzen; Wurzel aufklappen */
	let wasOpen = false;
	$effect(() => {
		if (open && !wasOpen) {
			untrack(() => {
				branches = {};
				expanded = {};
				target = null;
				error = null;
				busy = false;
				toggle(null);
			});
		}
		wasOpen = open;
	});

	async function submit() {
		if (!target || !canSubmit) return;
		busy = true;
		error = null;
		try {
			const res = await apiFetch<BulkResult>(`${API}/nodes/move`, {
				method: 'POST',
				body: JSON.stringify({ ids: nodes.map((n) => n.id), targetId: target.id })
			});
			const n = res?.affected ?? nodes.length;
			toast.success(n === 1 ? '1 Eintrag verschoben' : `${n} Einträge verschoben`);
			open = false;
			onmoved();
		} catch (e) {
			error = errorText(e, 'Verschieben fehlgeschlagen');
		} finally {
			busy = false;
		}
	}

	const countLabel = $derived(
		nodes.length === 1 ? `„${nodes[0]!.name}“` : `${nodes.length} Einträge`
	);
</script>

{#snippet row(
	node: FileNode | null,
	name: string,
	depth: number,
	selectable: boolean,
	hasChildren: boolean
)}
	{@const id = node?.id ?? null}
	{@const key = keyOf(id)}
	{@const isOpen = !!expanded[key]}
	{@const isRoot = id === null}
	<li>
		<div
			class="flex items-center gap-1 rounded-md pr-2 {isSelected(id)
				? 'bg-primary/10'
				: 'hover:bg-muted'}"
			style="padding-left: {depth * 1.25}rem"
		>
			{#if hasChildren}
				<Button
					variant="ghost"
					size="icon"
					class="size-7 shrink-0"
					aria-expanded={isOpen}
					aria-label={isOpen ? `${name} zuklappen` : `${name} aufklappen`}
					onclick={() => toggle(id)}
				>
					{#if isOpen}
						<ChevronDown class="size-4" aria-hidden="true" />
					{:else}
						<ChevronRight class="size-4" aria-hidden="true" />
					{/if}
				</Button>
			{:else}
				<span class="size-7 shrink-0" aria-hidden="true"></span>
			{/if}
			<button
				type="button"
				class="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
				aria-pressed={isSelected(id)}
				disabled={!selectable}
				title={selectable ? undefined : 'Keine Berechtigung zum Bearbeiten'}
				onclick={() => select(id, name, node)}
				ondblclick={() => hasChildren && toggle(id)}
			>
				{#if isRoot}
					<HardDrive class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
				{:else}
					<Folder class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
				{/if}
				<span class="truncate {isRoot ? 'font-medium' : ''}">{name}</span>
				{#if node && !node.own}
					<span class="shrink-0 text-xs text-muted-foreground">von {node.owner.name}</span>
				{/if}
			</button>
		</div>
		{#if hasChildren && isOpen}
			{@const branch = branches[key]}
			<ul class="grid gap-0.5">
				{#if !branch || branch.loading}
					<li style="padding-left: {(depth + 1) * 1.25 + 2}rem" class="py-1">
						<Skeleton class="h-5 w-40" />
					</li>
				{:else if branch.error}
					<li
						style="padding-left: {(depth + 1) * 1.25 + 2}rem"
						class="flex flex-wrap items-center gap-2 py-1 text-xs text-destructive"
					>
						<span role="alert">{branch.error}</span>
						<Button variant="link" size="sm" class="h-auto p-0" onclick={() => load(id)}>
							Erneut versuchen
						</Button>
					</li>
				{:else if branch.folders.length === 0}
					<li
						style="padding-left: {(depth + 1) * 1.25 + 2}rem"
						class="py-1 text-xs text-muted-foreground"
					>
						Keine Unterordner
					</li>
				{:else}
					{#each branch.folders as f (f.id)}
						{@render row(f, f.name, depth + 1, f.access === 'edit', (f.childCount ?? 1) > 0)}
					{/each}
				{/if}
			</ul>
		{/if}
	</li>
{/snippet}

<Dialog.Root bind:open>
	<Dialog.Content class="flex flex-col sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Verschieben</Dialog.Title>
			<Dialog.Description>Wähle den Zielordner für {countLabel}.</Dialog.Description>
		</Dialog.Header>

		<nav
			aria-label="Zielordner"
			class="max-h-[50dvh] min-h-40 overflow-y-auto rounded-md border p-1"
		>
			<ul class="grid gap-0.5">
				{@render row(null, ROOT_LABEL, 0, true, true)}
			</ul>
		</nav>

		<p class="text-xs text-muted-foreground" aria-live="polite">
			{#if !target}
				Noch kein Ziel gewählt.
			{:else if isCurrent}
				Die Einträge liegen bereits in „{target.name}“.
			{:else}
				Ziel: {target.id ? `„${target.name}“` : ROOT_LABEL}
			{/if}
		</p>

		{#if ownerHint && !isCurrent}
			<p class="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">{ownerHint}</p>
		{/if}

		{#if error}
			<p role="alert" class="text-sm text-destructive">{error}</p>
		{/if}

		<Dialog.Footer>
			<Button type="button" variant="outline" onclick={() => (open = false)} disabled={busy}>
				Abbrechen
			</Button>
			<Button type="button" disabled={!canSubmit} onclick={submit}>
				{busy ? 'Verschiebt …' : 'Hierher verschieben'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
