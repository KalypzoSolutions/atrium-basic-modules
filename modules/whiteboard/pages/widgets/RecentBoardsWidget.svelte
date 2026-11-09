<script lang="ts">
	// Dashboard-Kachel „Whiteboards“: zuletzt geänderte sichtbare Whiteboards
	import { onMount } from 'svelte';
	import Presentation from '@lucide/svelte/icons/presentation';
	import { apiFetch } from '$lib/sdk/client';
	import type { DashboardWidgetProps } from '$lib/sdk/types/module-ui';
	import { DashboardCard } from '$lib/components/layout';
	import type { Board } from '../../schemas';
	import { BASE, errMsg, relativeTime } from '../helpers';

	let { onstatus }: DashboardWidgetProps = $props();

	let items = $state<Board[]>([]);
	let loading = $state(true);
	let error = $state('');

	async function load() {
		loading = true;
		error = '';
		onstatus?.('loading');
		try {
			items = await apiFetch<Board[]>(`${BASE}/boards/recent?limit=6`);
			onstatus?.(items.length ? 'ready' : 'empty');
		} catch (e) {
			error = errMsg(e, 'Whiteboards konnten nicht geladen werden.');
			onstatus?.('error');
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void load();
	});
</script>

<DashboardCard
	title="Whiteboards"
	icon={Presentation}
	href={BASE}
	{loading}
	{error}
	onretry={load}
	empty={!items.length}
	emptyText="Noch keine Whiteboards."
>
	<ul class="divide-y">
		{#each items as b (b.id)}
			<li class="py-2">
				<a
					href={`${BASE}/${b.id}`}
					class="flex items-start gap-2 rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
				>
					<span
						class="mt-1.5 size-2.5 shrink-0 rounded-full bg-muted-foreground/40"
						style:background-color={b.color ?? undefined}
						aria-hidden="true"
					></span>
					<span class="min-w-0 flex-1">
						<span class="block truncate text-sm font-medium">{b.name}</span>
						<span class="block truncate text-xs text-muted-foreground">
							{relativeTime(b.updatedAt)}{b.updatedBy ? ` · ${b.updatedBy.name}` : ''}{b.actionName
								? ` · ${b.actionName}`
								: ''}
						</span>
					</span>
				</a>
			</li>
		{/each}
	</ul>
</DashboardCard>
