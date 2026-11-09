<script lang="ts">
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import CalendarPlus from '@lucide/svelte/icons/calendar-plus';
	import Copy from '@lucide/svelte/icons/copy';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Plus from '@lucide/svelte/icons/plus';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { apiFetch } from '$lib/sdk/client';
	import { formatDateTimeDe } from '$lib/sdk/dates';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Input } from '$lib/components/ui/input';
	import { ConfirmDialog, EmptyState, ErrorState, LoadingState } from '$lib/components/layout';
	import type { CalendarFeed, CalendarFeedList, EventGroupRef } from '../schemas';
	import CalendarFeedDialog from './CalendarFeedDialog.svelte';

	/**
	 * Eigene Kalender-Abos (Profil und Termine-Seite): Link kopieren, in der Kalender-App bzw. Google
	 * Kalender öffnen, bearbeiten, neuen Link erzeugen, löschen.
	 */
	const BASE = '/modules/events';

	let data = $state<CalendarFeedList | null>(null);
	let groups = $state<EventGroupRef[]>([]);
	let loadError = $state('');
	let dialog = $state<{ open: boolean; feed: CalendarFeed | null }>({ open: false, feed: null });
	let confirm = $state<{ open: boolean; kind: 'delete' | 'rotate'; feed: CalendarFeed | null }>({
		open: false,
		kind: 'delete',
		feed: null
	});

	async function load() {
		try {
			const [list, g] = await Promise.all([
				apiFetch<CalendarFeedList>(`${BASE}/calendar-feeds`),
				apiFetch<EventGroupRef[]>(`${BASE}/groups`).catch(() => [] as EventGroupRef[])
			]);
			data = list;
			groups = g;
			loadError = '';
		} catch (e) {
			loadError =
				e instanceof Error ? e.message : 'Die Kalender-Abos konnten nicht geladen werden.';
		}
	}
	$effect(() => {
		untrack(() => void load());
	});

	function summary(f: CalendarFeed): string {
		const parts: string[] = [];
		if (f.includeEvents) {
			const names = f.groupIds.map(
				(id) => groups.find((g) => g.id === id)?.name ?? 'Unbekannte Gruppe'
			);
			parts.push(names.length ? `Termine: ${names.join(', ')}` : 'Alle Termine');
			if (f.tags.length) parts.push(`Tags: ${f.tags.join(', ')}`);
		}
		if (f.includeActions && data?.actionsAvailable) parts.push('Aktionen');
		if (f.includeTasks && data?.tasksAvailable) parts.push('Meilensteine');
		return parts.join(' · ');
	}

	const googleUrl = (f: CalendarFeed) =>
		f.webcalUrl
			? `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(f.webcalUrl)}`
			: null;

	async function copy(f: CalendarFeed) {
		if (!f.url) return;
		try {
			await navigator.clipboard.writeText(f.url);
			toast.success('Link kopiert – in der Kalender-App unter „Kalender abonnieren“ einfügen');
		} catch {
			toast.error('Kopieren nicht möglich – bitte den Link markieren und kopieren');
		}
	}

	async function runConfirm() {
		const f = confirm.feed;
		if (!f) return;
		try {
			if (confirm.kind === 'delete') {
				await apiFetch(`${BASE}/calendar-feeds/${f.id}`, { method: 'DELETE' });
				toast.success('Kalender-Abo gelöscht');
			} else {
				await apiFetch(`${BASE}/calendar-feeds/${f.id}/rotate`, { method: 'POST' });
				toast.success('Neuer Link erzeugt – bitte in der Kalender-App neu abonnieren');
			}
			await load();
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Das hat nicht geklappt');
		}
	}

	const full = $derived(!!data && data.feeds.length >= data.max);
</script>

<div class="space-y-4">
	{#if !data && !loadError}
		<LoadingState label="Lädt …" rows={2} />
	{:else if loadError || !data}
		<ErrorState message={loadError} onretry={load} compact />
	{:else}
		{#if data.feeds.length === 0}
			<EmptyState
				title="Noch kein Kalender-Abo"
				description="Mit einem Abo erscheinen die Termine automatisch in deinem Kalender (Handy, Outlook, Google, Apple) und bleiben aktuell."
			>
				<Button onclick={() => (dialog = { open: true, feed: null })}>
					<Plus class="size-4" /> Kalender-Abo anlegen
				</Button>
			</EmptyState>
		{:else}
			<ul class="divide-y rounded-md border">
				{#each data.feeds as f (f.id)}
					<li class="space-y-2 p-3">
						<div class="flex items-start gap-2">
							<div class="min-w-0 flex-1">
								<p class="font-medium">{f.name}</p>
								<p class="text-xs text-muted-foreground">{summary(f)}</p>
							</div>
							{#if f.lastUsedAt}
								<Badge variant="success" class="shrink-0">Aktiv</Badge>
							{/if}
							<DropdownMenu.Root>
								<DropdownMenu.Trigger>
									{#snippet child({ props })}
										<Button
											{...props}
											variant="ghost"
											size="icon-sm"
											aria-label={`Aktionen für ${f.name}`}
										>
											<Ellipsis class="size-4" />
										</Button>
									{/snippet}
								</DropdownMenu.Trigger>
								<DropdownMenu.Content align="end">
									<DropdownMenu.Item onSelect={() => (dialog = { open: true, feed: f })}>
										<Pencil class="size-4" /> Bearbeiten
									</DropdownMenu.Item>
									<DropdownMenu.Item
										onSelect={() => (confirm = { open: true, kind: 'rotate', feed: f })}
									>
										<RefreshCw class="size-4" /> Neuen Link erzeugen
									</DropdownMenu.Item>
									<DropdownMenu.Separator />
									<DropdownMenu.Item
										class="text-destructive"
										onSelect={() => (confirm = { open: true, kind: 'delete', feed: f })}
									>
										<Trash2 class="size-4" /> Löschen
									</DropdownMenu.Item>
								</DropdownMenu.Content>
							</DropdownMenu.Root>
						</div>
						{#if f.url}
							<div class="flex flex-col gap-2">
								<Input
									readonly
									value={f.url}
									aria-label={`Abo-Link für ${f.name}`}
									class="w-full font-mono text-xs"
									onfocus={(e) => e.currentTarget.select()}
								/>
								<div class="flex flex-wrap gap-2">
									<Button size="sm" variant="outline" onclick={() => copy(f)}>
										<Copy class="size-4" /> Kopieren
									</Button>
									<Button size="sm" variant="outline" href={f.webcalUrl ?? undefined}>
										<CalendarPlus class="size-4" /> In Kalender-App öffnen
									</Button>
									<Button
										size="sm"
										variant="outline"
										href={googleUrl(f) ?? undefined}
										target="_blank"
										rel="noopener noreferrer"
									>
										Google Kalender
									</Button>
								</div>
							</div>
						{:else}
							<p class="text-sm text-destructive">
								Der Link ist nicht mehr lesbar (z. B. nach einer Datenübernahme). Bitte „Neuen Link
								erzeugen“.
							</p>
						{/if}
						<p class="text-xs text-muted-foreground">
							{f.lastUsedAt
								? `Zuletzt abgerufen: ${formatDateTimeDe(f.lastUsedAt)}`
								: 'Noch nicht abgerufen'} · Link geheim halten – wer ihn hat, sieht diese Termine.
						</p>
					</li>
				{/each}
			</ul>
			<Button
				variant="outline"
				onclick={() => (dialog = { open: true, feed: null })}
				disabled={full}
			>
				<Plus class="size-4" /> Weiteres Abo
			</Button>
			{#if full}
				<p class="text-xs text-muted-foreground">Höchstens {data.max} Abos je Person.</p>
			{/if}
		{/if}
	{/if}
</div>

<CalendarFeedDialog
	bind:open={dialog.open}
	feed={dialog.feed}
	actionsAvailable={data?.actionsAvailable ?? false}
	tasksAvailable={data?.tasksAvailable ?? false}
	onsaved={() => void load()}
/>
<ConfirmDialog
	bind:open={confirm.open}
	title={confirm.kind === 'delete'
		? `„${confirm.feed?.name ?? ''}“ löschen?`
		: 'Neuen Link erzeugen?'}
	description={confirm.kind === 'delete'
		? 'Der Link wird sofort ungültig; Kalender-Apps zeigen die Termine danach nicht mehr an.'
		: 'Der bisherige Link wird sofort ungültig. Du musst den Kalender in deiner App mit dem neuen Link neu abonnieren.'}
	confirmLabel={confirm.kind === 'delete' ? 'Löschen' : 'Neuen Link erzeugen'}
	destructive={confirm.kind === 'delete'}
	onconfirm={runConfirm}
/>
