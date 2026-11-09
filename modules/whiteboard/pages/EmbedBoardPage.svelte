<script lang="ts">
	// Whiteboard im iframe (`/embed/whiteboard/<id>`, z. B. in einer Notiz): kompakter Editor über die volle Höhe,
	// Bearbeiten nur mit Bearbeiten-Zugriff (sonst „Nur Ansicht“), „Vollbild öffnen“ im obersten Fenster
	import { apiFetch, ApiClientError } from '$lib/sdk/client';
	import type { ModulePageProps } from '$lib/sdk/types/module-ui';
	import { EmptyState, ErrorState, LoadingState } from '$lib/components/layout';
	import type { BoardDetail } from '../schemas';
	import Editor from './editor/Editor.svelte';
	import { BASE, errMsg } from './helpers';

	let { params }: ModulePageProps = $props();
	const id = $derived(params.id ?? '');

	let board = $state<BoardDetail | null>(null);
	let loading = $state(true);
	let notFound = $state(false);
	let loadError = $state('');

	async function load(boardId: string) {
		loading = true;
		loadError = '';
		notFound = false;
		try {
			board = await apiFetch<BoardDetail>(`${BASE}/boards/${boardId}`);
		} catch (e) {
			board = null;
			if (e instanceof ApiClientError && (e.status === 404 || e.status === 400 || e.status === 422))
				notFound = true;
			else loadError = errMsg(e, 'Whiteboard konnte nicht geladen werden');
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		void load(id);
	});
</script>

<div class="flex h-dvh min-h-0 flex-col">
	{#if loading && !board}
		<div class="p-3">
			<LoadingState label="Whiteboard" rows={1} rowClass="h-[calc(100dvh-1.5rem)] w-full" />
		</div>
	{:else if notFound}
		<div class="flex flex-1 items-center justify-center p-3">
			<EmptyState
				title="Whiteboard nicht verfügbar"
				description="Das Whiteboard existiert nicht mehr oder du hast keinen Zugriff darauf."
			/>
		</div>
	{:else if loadError && !board}
		<div class="p-3">
			<ErrorState message={loadError} onretry={() => load(id)} compact />
		</div>
	{:else if board}
		{#key board.id}
			<Editor initial={board} embedded />
		{/key}
	{/if}
</div>
