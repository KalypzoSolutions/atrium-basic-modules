<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import Plus from '@lucide/svelte/icons/plus';
	import Tent from '@lucide/svelte/icons/tent';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
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
	import { PERM, type BoardDetail, type BoardList } from '../schemas';
	import BoardDialog from './BoardDialog.svelte';
	import { BASE, errMsg, shortDate } from './helpers';

	const permissions = $derived((page.data.permissions ?? []) as string[]);
	const canCreate = $derived(can(permissions, PERM.create));
	const search = $derived(page.url.searchParams.get('search') ?? '');

	let data = $state<BoardList | null>(null);
	let loading = $state(true);
	let loadError = $state('');
	let createOpen = $state(false);
	let reloadKey = $state(0);

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
				if (!stale) loadError = errMsg(e, 'Boards konnten nicht geladen werden');
			})
			.finally(() => {
				if (!stale) loading = false;
			});
		return () => {
			stale = true;
		};
	});

	function percent(done: number, total: number) {
		return total ? Math.round((done / total) * 100) : 0;
	}

	function created(board: BoardDetail) {
		void goto(`${BASE}/${board.id}`);
	}
</script>

<PageHeader title="Aufgaben" description="Boards für Vorbereitung, Aktionen und Ämter">
	{#snippet actions()}
		{#if canCreate}
			<Button onclick={() => (createOpen = true)}><Plus /> Board anlegen</Button>
		{/if}
	{/snippet}
</PageHeader>

<div class="mb-4 max-w-sm">
	<SearchInput placeholder="Boards suchen …" />
</div>

{#if loading && !data}
	<LoadingState label="Boards" rows={3} rowClass="h-28 w-full" />
{:else if loadError}
	<ErrorState
		message={loadError}
		onretry={() => {
			reloadKey++;
		}}
	/>
{:else if data && data.items.length === 0}
	<EmptyState
		title={search ? 'Keine Boards gefunden' : 'Noch keine Boards'}
		description={search
			? 'Kein Board passt zur Suche.'
			: canCreate
				? 'Lege ein Board an, um Aufgaben zu sammeln, zu verteilen und abzuhaken.'
				: 'Sobald jemand ein Board mit dir teilt oder dir eine Aufgabe zuweist, erscheint es hier.'}
	>
		{#if canCreate && !search}
			<Button onclick={() => (createOpen = true)}><Plus /> Board anlegen</Button>
		{/if}
	</EmptyState>
{:else if data}
	<ul class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-label="Boards">
		{#each data.items as board (board.id)}
			<li>
				<a
					href={`${BASE}/${board.id}`}
					class="block h-full rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
				>
					<Card.Root class="h-full transition-colors hover:bg-muted/40">
						<Card.Header class="space-y-1">
							<Card.Title level={2} class="flex items-center gap-2">
								<span
									class="size-2.5 shrink-0 rounded-full bg-muted-foreground/40"
									style:background-color={board.color ?? undefined}
									aria-hidden="true"
								></span>
								<span class="truncate">{board.name}</span>
							</Card.Title>
							{#if board.description}
								<p class="line-clamp-2 text-sm text-muted-foreground">{board.description}</p>
							{/if}
						</Card.Header>
						<Card.Content class="space-y-3">
							{#if board.currentPhase || board.nextMilestone}
								<dl class="space-y-1 text-xs">
									{#if board.currentPhase}
										<div class="flex items-center gap-1.5">
											<dt class="text-muted-foreground">Phase</dt>
											<dd class="flex min-w-0 items-center gap-1.5 font-medium">
												<span
													class="size-2 shrink-0 rounded-full bg-muted-foreground/40"
													style:background-color={board.currentPhase.color ?? undefined}
													aria-hidden="true"
												></span>
												<span class="truncate">{board.currentPhase.name}</span>
											</dd>
										</div>
									{/if}
									{#if board.nextMilestone}
										<div class="flex items-center gap-1.5">
											<dt class="text-muted-foreground">Nächster Meilenstein</dt>
											<dd class="min-w-0 truncate font-medium">
												◆ {board.nextMilestone.title} · {shortDate(board.nextMilestone.dueOn)}
											</dd>
										</div>
									{/if}
								</dl>
							{/if}
							<div class="flex flex-wrap gap-1.5">
								{#if board.action}
									<Badge variant="outline"><Tent aria-hidden="true" /> {board.action.name}</Badge>
								{/if}
								{#if board.counts.overdue}
									<Badge variant="destructive">
										<TriangleAlert aria-hidden="true" />
										{board.counts.overdue} überfällig
									</Badge>
								{/if}
								{#if board.access.level === 'read'}
									<Badge variant="secondary">Nur Ansicht</Badge>
								{/if}
							</div>
							<div>
								<div class="mb-1 flex justify-between text-xs text-muted-foreground">
									<span>{board.counts.open} offen</span>
									<span class="tabular-nums">
										{board.counts.done} von {board.counts.total} erledigt
									</span>
								</div>
								<div
									class="h-1.5 overflow-hidden rounded-full bg-muted"
									role="progressbar"
									aria-label="Fortschritt"
									aria-valuemin={0}
									aria-valuemax={100}
									aria-valuenow={percent(board.counts.done, board.counts.total)}
								>
									<div
										class="h-full rounded-full bg-success"
										style:width={`${percent(board.counts.done, board.counts.total)}%`}
									></div>
								</div>
							</div>
						</Card.Content>
					</Card.Root>
				</a>
			</li>
		{/each}
	</ul>
{/if}

<BoardDialog bind:open={createOpen} onsaved={created} />
