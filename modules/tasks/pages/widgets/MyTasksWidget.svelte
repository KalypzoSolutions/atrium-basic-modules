<script lang="ts">
	// Dashboard-Kachel „Meine Aufgaben“: offene Aufgaben und Unteraufgaben, die mir zugewiesen sind.
	import { onMount } from 'svelte';
	import SquareKanban from '@lucide/svelte/icons/square-kanban';
	import { apiFetch } from '$lib/sdk/client';
	import type { DashboardWidgetProps } from '$lib/sdk/types/module-ui';
	import { Badge } from '$lib/components/ui/badge';
	import { DashboardCard } from '$lib/components/layout';
	import type { MyTask } from '../../schemas';
	import { BASE, dueClass, dueLabel, errMsg, priorityLabel, priorityVariant } from '../helpers';

	let { onstatus }: DashboardWidgetProps = $props();

	let items = $state<MyTask[]>([]);
	let loading = $state(true);
	let error = $state('');

	async function load() {
		loading = true;
		error = '';
		onstatus?.('loading');
		try {
			items = await apiFetch<MyTask[]>(`${BASE}/my/tasks?limit=6`);
			onstatus?.(items.length ? 'ready' : 'empty');
		} catch (e) {
			error = errMsg(e, 'Aufgaben konnten nicht geladen werden.');
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
	title="Meine Aufgaben"
	icon={SquareKanban}
	href={BASE}
	{loading}
	{error}
	onretry={load}
	empty={!items.length}
	emptyText="Dir ist gerade keine offene Aufgabe zugewiesen."
>
	<ul class="divide-y">
		{#each items as t (t.id)}
			<li class="py-2">
				<a
					href={`${BASE}/${t.board.id}?task=${t.id}`}
					class="flex items-start gap-2 rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
				>
					<span
						class="mt-1.5 size-2.5 shrink-0 rounded-full bg-muted-foreground/40"
						style:background-color={t.board.color ?? undefined}
						aria-hidden="true"
					></span>
					<span class="min-w-0 flex-1">
						<span class="block truncate font-medium" title={t.title}
							>{t.isMilestone ? '◆ ' : ''}{t.title}</span
						>
						<span class="block truncate text-xs text-muted-foreground">
							{t.board.name}{#if t.phase}&nbsp;· {t.phase.name}{/if} · {t.columnName}{#if t.viaChecklist}&nbsp;·
								Unteraufgabe{/if}
							{#if t.checklist.total}&nbsp;· {t.checklist.done}/{t.checklist.total}{/if}
						</span>
					</span>
					<span class="flex shrink-0 flex-col items-end gap-1">
						{#if t.priority === 'urgent' || t.priority === 'high'}
							<Badge variant={priorityVariant(t.priority)} class="px-1.5 py-0 text-xs">
								{priorityLabel(t.priority)}
							</Badge>
						{/if}
						{#if t.dueOn}
							<span class={`text-xs ${dueClass(t.dueOn)}`}>{dueLabel(t.dueOn)}</span>
						{/if}
					</span>
				</a>
			</li>
		{/each}
	</ul>
</DashboardCard>
