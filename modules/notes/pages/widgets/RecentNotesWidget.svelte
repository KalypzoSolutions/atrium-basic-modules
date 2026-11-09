<script lang="ts">
	// Dashboard-Kachel „Notizen“: zuletzt bearbeitete sichtbare Notizen
	import { onMount } from 'svelte';
	import NotebookPen from '@lucide/svelte/icons/notebook-pen';
	import { apiFetch } from '$lib/sdk/client';
	import type { DashboardWidgetProps } from '$lib/sdk/types/module-ui';
	import { DashboardCard } from '$lib/components/layout';
	import type { NoteNode } from '../../schemas';
	import NoteIcon from '../NoteIcon.svelte';
	import { API, BASE, errMsg, noteTitle, notePath, relativeTime } from '../helpers';

	let { onstatus }: DashboardWidgetProps = $props();

	let items = $state<NoteNode[]>([]);
	let loading = $state(true);
	let error = $state('');

	async function load() {
		loading = true;
		error = '';
		onstatus?.('loading');
		try {
			items = await apiFetch<NoteNode[]>(`${API}/notes/recent?limit=6`);
			onstatus?.(items.length ? 'ready' : 'empty');
		} catch (e) {
			error = errMsg(e, 'Notizen konnten nicht geladen werden.');
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
	title="Notizen"
	icon={NotebookPen}
	href={BASE}
	{loading}
	{error}
	onretry={load}
	empty={!items.length}
	emptyText="Noch keine Notizen."
>
	<ul class="divide-y">
		{#each items as n (n.id)}
			<li class="py-2">
				<a
					href={notePath(n.id)}
					class="flex items-start gap-2 rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
				>
					<NoteIcon icon={n.icon} color={n.color} class="mt-0.5 size-4" />
					<span class="min-w-0 flex-1">
						<span class="block truncate text-sm font-medium">{noteTitle(n.title)}</span>
						<span class="block truncate text-xs text-muted-foreground">
							{relativeTime(n.updatedAt)}{n.updatedBy ? ` · ${n.updatedBy.name}` : ''}
						</span>
					</span>
				</a>
			</li>
		{/each}
	</ul>
</DashboardCard>
