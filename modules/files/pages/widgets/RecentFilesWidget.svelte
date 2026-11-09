<script lang="ts">
	// Dashboard-Kachel „Zuletzt geändert“: zuletzt geänderte eigene und freigegebene Dateien.
	// Klick öffnet den Ordner der Datei (bzw. die Wurzel „Dateien“, wenn der Ordner nicht zugänglich ist).
	import { onMount } from 'svelte';
	import Cloud from '@lucide/svelte/icons/cloud';
	import { apiFetch } from '$lib/sdk/client';
	import type { DashboardWidgetProps } from '$lib/sdk/types/module-ui';
	import { DashboardCard } from '$lib/components/layout';
	import { BASE_PATH, type RecentFile } from '../../schemas';
	import { errorText, formatBytes, formatDateTime } from '../helpers';
	import FileTypeGlyph from '../FileTypeGlyph.svelte';

	let { onstatus }: DashboardWidgetProps = $props();

	const LIMIT = 6;

	let items = $state<RecentFile[]>([]);
	let loading = $state(true);
	let error = $state('');

	async function load() {
		loading = true;
		error = '';
		onstatus?.('loading');
		try {
			items = await apiFetch<RecentFile[]>(`${BASE_PATH}/recent?limit=${LIMIT}`);
			onstatus?.(items.length ? 'ready' : 'empty');
		} catch (e) {
			error = errorText(e, 'Dateien konnten nicht geladen werden.');
			onstatus?.('error');
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void load();
	});

	const hrefOf = (f: RecentFile) =>
		f.parentId ? `${BASE_PATH}?folder=${encodeURIComponent(f.parentId)}` : BASE_PATH;
</script>

<DashboardCard
	title="Zuletzt geändert"
	icon={Cloud}
	href={BASE_PATH}
	{loading}
	{error}
	onretry={load}
	empty={!items.length}
	emptyText="Noch keine Dateien."
>
	<ul class="divide-y">
		{#each items as f (f.id)}
			<li class="py-2">
				<a
					href={hrefOf(f)}
					class="flex items-center gap-2 rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
				>
					<FileTypeGlyph contentType={f.mime} name={f.name} size="sm" class="size-4" />
					<span class="min-w-0 flex-1">
						<span class="block truncate font-medium">{f.name}</span>
						<span class="block truncate text-xs text-muted-foreground tabular-nums">
							{formatDateTime(f.updatedAt)} · {formatBytes(f.size)}{f.own ? '' : ' · freigegeben'}
						</span>
					</span>
				</a>
			</li>
		{/each}
	</ul>
</DashboardCard>
