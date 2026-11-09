<script lang="ts">
	// Ein Whiteboard (vollflächig): laden, dann den Editor zeigen
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import { apiFetch, ApiClientError } from '$lib/sdk/client';
	import type { ModulePageProps } from '$lib/sdk/types/module-ui';
	import { Button } from '$lib/components/ui/button';
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

{#if loading && !board}
	<div class="p-4 sm:p-6">
		<LoadingState label="Whiteboard" rows={1} rowClass="h-[60dvh] w-full" />
	</div>
{:else if notFound}
	<div class="p-4 sm:p-6">
		<EmptyState
			title="Whiteboard nicht gefunden"
			description="Das Whiteboard existiert nicht oder du hast keinen Zugriff darauf."
		>
			<Button href={BASE} variant="outline"><ArrowLeft /> Zu den Whiteboards</Button>
		</EmptyState>
	</div>
{:else if loadError && !board}
	<div class="p-4 sm:p-6">
		<ErrorState message={loadError} onretry={() => load(id)} />
	</div>
{:else if board}
	{#key board.id}
		<Editor initial={board} />
	{/key}
{/if}
