<script lang="ts">
	// Übersicht: alle sichtbaren Whiteboards als Karten, Suche, Anlegen und Import (.epwhiteboard)
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { toast } from 'svelte-sonner';
	import Backpack from '@lucide/svelte/icons/backpack';
	import FileUp from '@lucide/svelte/icons/file-up';
	import Plus from '@lucide/svelte/icons/plus';
	import Presentation from '@lucide/svelte/icons/presentation';
	import Shapes from '@lucide/svelte/icons/shapes';
	import { apiFetch, can } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import {
		EmptyState,
		ErrorState,
		LoadingState,
		PageHeader,
		SearchInput
	} from '$lib/components/layout';
	import {
		ARCHIVE_EXTENSION,
		PERM,
		type Board,
		type BoardDetail,
		type BoardList
	} from '../schemas';
	import BoardDialog from './BoardDialog.svelte';
	import { BASE, errMsg, relativeTime } from './helpers';

	const permissions = $derived((page.data.permissions ?? []) as string[]);
	const canCreate = $derived(can(permissions, PERM.create));
	const search = $derived(page.url.searchParams.get('search') ?? '');

	let data = $state<BoardList | null>(null);
	let loading = $state(true);
	let loadError = $state('');
	let createOpen = $state(false);
	let reloadKey = $state(0);
	let importing = $state(false);
	let fileInput = $state<HTMLInputElement | null>(null);

	$effect(() => {
		const q = search;
		void reloadKey;
		let stale = false;
		loading = true;
		const params = new URLSearchParams({ limit: '200' });
		if (q) params.set('search', q);
		apiFetch<BoardList>(`${BASE}/boards?${params}`)
			.then((res) => {
				if (stale) return;
				data = res;
				loadError = '';
			})
			.catch((e) => {
				if (!stale) loadError = errMsg(e, 'Whiteboards konnten nicht geladen werden');
			})
			.finally(() => {
				if (!stale) loading = false;
			});
		return () => {
			stale = true;
		};
	});

	function created(board: Board | BoardDetail) {
		void goto(`${BASE}/${board.id}`);
	}

	async function importFile(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		importing = true;
		try {
			const form = new FormData();
			form.set('file', file);
			const board = await apiFetch<BoardDetail>(`${BASE}/boards/import`, {
				method: 'POST',
				body: form
			});
			toast.success(`„${board.name}“ importiert`);
			void goto(`${BASE}/${board.id}`);
		} catch (err) {
			toast.error(errMsg(err, 'Import fehlgeschlagen'));
		} finally {
			importing = false;
		}
	}
</script>

<PageHeader
	title="Whiteboards"
	description="Ideen sammeln, Programme planen, Notizen festhalten – gemeinsam und live"
>
	{#snippet actions()}
		{#if canCreate}
			<Button onclick={() => (createOpen = true)}><Plus /> Neues Whiteboard</Button>
			<Button variant="outline" onclick={() => fileInput?.click()} disabled={importing}>
				<FileUp />
				{importing ? 'Importiert …' : 'Importieren'}
			</Button>
			<input
				bind:this={fileInput}
				type="file"
				accept={`${ARCHIVE_EXTENSION},application/zip`}
				class="hidden"
				aria-hidden="true"
				tabindex="-1"
				onchange={importFile}
			/>
		{/if}
	{/snippet}
</PageHeader>

<div class="mb-4 max-w-sm">
	<SearchInput placeholder="Whiteboards suchen …" />
</div>

{#if loading && !data}
	<LoadingState label="Whiteboards" rows={3} rowClass="h-32 w-full" />
{:else if loadError}
	<ErrorState
		message={loadError}
		onretry={() => {
			reloadKey++;
		}}
	/>
{:else if data && data.items.length === 0}
	<EmptyState
		title={search ? 'Keine Whiteboards gefunden' : 'Noch keine Whiteboards'}
		description={search
			? 'Kein Whiteboard passt zur Suche.'
			: canCreate
				? 'Lege ein Whiteboard an – mit Notizzetteln, Formen, Pfeilen, Bildern, Links und Karten aus Aktionen, Terminen oder Aufgaben.'
				: 'Sobald jemand ein Whiteboard mit dir teilt, erscheint es hier.'}
	>
		{#if canCreate && !search}
			<Button onclick={() => (createOpen = true)}><Plus /> Neues Whiteboard</Button>
		{/if}
	</EmptyState>
{:else if data}
	<ul class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Whiteboards">
		{#each data.items as board (board.id)}
			<li>
				<a
					href={`${BASE}/${board.id}`}
					class="block h-full rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
				>
					<Card.Root class="h-full pt-0 transition-colors hover:bg-muted/40">
						<div
							class="flex h-20 items-center justify-center bg-muted"
							style:background-color={board.color
								? `color-mix(in oklch, ${board.color} 18%, transparent)`
								: undefined}
							aria-hidden="true"
						>
							<Presentation
								class="size-8 text-muted-foreground"
								style={board.color ? `color:${board.color}` : undefined}
							/>
						</div>
						<Card.Header class="space-y-1">
							<Card.Title level={2} class="truncate">{board.name}</Card.Title>
							{#if board.description}
								<p class="line-clamp-2 text-sm text-muted-foreground">{board.description}</p>
							{/if}
						</Card.Header>
						<Card.Content class="space-y-2">
							<div class="flex flex-wrap gap-1.5">
								{#if board.actionName}
									<Badge variant="outline"><Backpack aria-hidden="true" /> {board.actionName}</Badge
									>
								{/if}
								{#if board.access.level === 'read'}
									<Badge variant="secondary">Nur Ansicht</Badge>
								{/if}
								<Badge variant="outline">
									<Shapes aria-hidden="true" />
									{board.elementCount}
									{board.elementCount === 1 ? 'Element' : 'Elemente'}
								</Badge>
							</div>
							<p class="text-xs text-muted-foreground">
								Geändert {relativeTime(board.updatedAt)}{board.updatedBy
									? ` von ${board.updatedBy.name}`
									: ''}
							</p>
						</Card.Content>
					</Card.Root>
				</a>
			</li>
		{/each}
	</ul>
{/if}

<BoardDialog bind:open={createOpen} onsaved={created} />
