<script lang="ts">
	// Dashboard-Kachel „Nächste Termine“: die nächsten fünf Termine ab heute (lokal).
	import { onMount } from 'svelte';
	import CalendarDays from '@lucide/svelte/icons/calendar-days';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import type { DashboardWidgetProps } from '$lib/sdk/types/module-ui';
	import { DashboardCard } from '$lib/components/layout';
	import { localToday, monthOf } from '$lib/components/layout/month-calendar';
	import type { EventItem, EventList } from '../../schemas';
	import { formatEventRange } from '../../format';

	let { onstatus }: DashboardWidgetProps = $props();

	const LIMIT = 5;

	let items = $state<EventItem[]>([]);
	let loading = $state(true);
	let error = $state('');

	async function load() {
		loading = true;
		error = '';
		onstatus?.('loading');
		try {
			const today = localToday();
			const r = await apiFetch<EventList>(
				`/modules/events/events?from=${today}&limit=${LIMIT}&offset=0`
			);
			items = r.items.slice(0, LIMIT);
			onstatus?.(items.length ? 'ready' : 'empty');
		} catch (e) {
			error =
				e instanceof ApiClientError && e.message
					? e.message
					: 'Termine konnten nicht geladen werden.';
			onstatus?.('error');
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void load();
	});

	function colorOf(e: EventItem): string | null {
		return e.color ?? e.groups.find((g) => g.color)?.color ?? null;
	}

	/** Monatsansicht des Termins (bei laufenden Terminen der aktuelle Monat) */
	function monthHref(e: EventItem): string {
		const today = localToday();
		const date = e.startsOn < today ? today : e.startsOn;
		return `/modules/events?month=${monthOf(date)}`;
	}
</script>

<DashboardCard
	title="Nächste Termine"
	icon={CalendarDays}
	href="/modules/events"
	{loading}
	{error}
	onretry={load}
	empty={!items.length}
	emptyText="Keine anstehenden Termine."
>
	<ul class="divide-y">
		{#each items as e (e.key)}
			<li class="py-2">
				<a
					href={monthHref(e)}
					class="flex items-start gap-2 rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
				>
					<span
						class="mt-1.5 size-2.5 shrink-0 rounded-full bg-muted-foreground/40"
						style:background-color={colorOf(e) ?? undefined}
						aria-hidden="true"
					></span>
					<span class="min-w-0 flex-1">
						<span class="block truncate font-medium" title={e.title}>{e.title}</span>
						<span class="block truncate text-xs text-muted-foreground">
							{formatEventRange(e)}{#if e.location}&nbsp;· {e.location}{/if}
						</span>
					</span>
				</a>
			</li>
		{/each}
	</ul>
</DashboardCard>
