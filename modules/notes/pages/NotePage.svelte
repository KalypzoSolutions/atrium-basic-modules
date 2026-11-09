<script lang="ts">
	// Editor-Seite (vollflächig): Seitenbaum links (einklappbar, mobil als Blatt) und die geöffnete Notiz
	import { onMount } from 'svelte';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import { apiFetch, ApiClientError } from '$lib/sdk/client';
	import type { ModulePageProps } from '$lib/sdk/types/module-ui';
	import {
		BottomSheet,
		deviceLayout,
		EmptyState,
		ErrorState,
		LoadingState
	} from '$lib/components/layout';
	import { Button } from '$lib/components/ui/button';
	import type { NoteDetail } from '../schemas';
	import { API, BASE, errMsg } from './helpers';
	import NoteView from './NoteView.svelte';
	import NoteTree from './tree/NoteTree.svelte';
	import { NoteTreeState } from './tree/tree-state.svelte';

	let { params }: ModulePageProps = $props();
	const id = $derived(params.id ?? '');

	const TREE_KEY = 'notes.treeOpen';
	const tree = new NoteTreeState();
	const phone = $derived(deviceLayout() === 'phone');

	let note = $state<NoteDetail | null>(null);
	let loading = $state(true);
	let notFound = $state(false);
	let loadError = $state('');
	let resetKey = $state(0);
	let treeOpen = $state(true);
	let sheetOpen = $state(false);

	async function load(noteId: string) {
		loading = true;
		loadError = '';
		notFound = false;
		try {
			const detail = await apiFetch<NoteDetail>(`${API}/notes/${noteId}`);
			note = detail;
			// Pfad im Baum aufklappen
			for (const b of detail.breadcrumbs) void tree.expand(b.id);
		} catch (e) {
			note = null;
			if (e instanceof ApiClientError && [400, 404, 422].includes(e.status)) notFound = true;
			else loadError = errMsg(e, 'Notiz konnte nicht geladen werden');
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		void load(id);
	});

	onMount(() => {
		void tree.loadRoots();
		try {
			treeOpen = localStorage.getItem(TREE_KEY) !== '0';
		} catch {
			/* ohne Speicher: Standard offen */
		}
	});

	function toggleTree() {
		if (phone) {
			sheetOpen = !sheetOpen;
			return;
		}
		treeOpen = !treeOpen;
		try {
			localStorage.setItem(TREE_KEY, treeOpen ? '1' : '0');
		} catch {
			/* egal */
		}
	}
</script>

<div class="flex h-full min-h-0">
	{#if !phone && treeOpen}
		<aside
			class="w-64 shrink-0 overflow-y-auto border-r bg-sidebar-surface"
			aria-label="Seitenbaum"
		>
			<div class="flex h-12 items-center border-b px-3">
				<a
					href={BASE}
					class="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"
				>
					<ArrowLeft class="size-4" /> Alle Notizen
				</a>
			</div>
			<NoteTree {tree} activeId={note?.id ?? null} />
		</aside>
	{/if}

	<div class="min-w-0 flex-1">
		{#if loading && !note}
			<div class="p-4 sm:p-6">
				<LoadingState label="Notiz" rows={6} />
			</div>
		{:else if notFound}
			<div class="p-4 sm:p-6">
				<EmptyState
					title="Notiz nicht gefunden"
					description="Die Notiz existiert nicht, liegt im Papierkorb oder du hast keinen Zugriff darauf."
				>
					<Button href={BASE} variant="outline"><ArrowLeft /> Zu den Notizen</Button>
				</EmptyState>
			</div>
		{:else if loadError && !note}
			<div class="p-4 sm:p-6">
				<ErrorState message={loadError} onretry={() => load(id)} />
			</div>
		{:else if note}
			{#key `${note.id}:${resetKey}`}
				<NoteView initial={note} {tree} ontoggletree={toggleTree} onreset={() => resetKey++} />
			{/key}
		{/if}
	</div>
</div>

{#if phone}
	<BottomSheet bind:open={sheetOpen} title="Seiten" size="tall">
		<NoteTree {tree} activeId={note?.id ?? null} onnavigate={() => (sheetOpen = false)} />
	</BottomSheet>
{/if}
