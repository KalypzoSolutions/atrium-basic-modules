<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { untrack } from 'svelte';
	import Plus from '@lucide/svelte/icons/plus';
	import Repeat from '@lucide/svelte/icons/repeat';
	import { ApiClientError, apiFetch, can } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { Label } from '$lib/components/ui/label';
	import { SelectField } from '$lib/components/ui/select-field';
	import * as Table from '$lib/components/ui/table';
	import * as Tabs from '$lib/components/ui/tabs';
	import {
		ColorBadge,
		DataTable,
		MonthCalendar,
		PageHeader,
		Pagination,
		SearchInput,
		type CalendarItem,
		PageTitle
	} from '$lib/components/layout';
	import {
		buildMonthGrid,
		isValidMonth,
		localToday,
		monthOf
	} from '$lib/components/layout/month-calendar';
	import type { EventGroupRef, EventItem, EventList } from '../schemas';
	import { formatEventRange } from '../format';
	import EventDialog from './EventDialog.svelte';
	import CalendarFeedsPanel from './CalendarFeedsPanel.svelte';
	import CalendarSync from '@lucide/svelte/icons/calendar-sync';
	import FileDown from '@lucide/svelte/icons/file-down';
	import ExportDialog from './ExportDialog.svelte';
	import * as Dialog from '$lib/components/ui/dialog';

	const PAGE_SIZE = 50;
	const MONTH_LIMIT = 500;

	const permissions = $derived((page.data.permissions ?? []) as string[]);
	const canCreate = $derived(can(permissions, 'events.event.create'));

	/** „Heute“ in Europe/Berlin (nicht UTC), einmal beim Laden der Seite bestimmt */
	const today = localToday();

	// --- Zustand aus der URL ---------------------------------------------------------------
	const params = $derived(page.url.searchParams);
	/** Standard: Monat; `view=list` zeigt die Liste */
	const view = $derived<'list' | 'month'>(params.get('view') === 'list' ? 'list' : 'month');
	const month = $derived.by(() => {
		const m = params.get('month');
		return isValidMonth(m) ? m : monthOf(today);
	});
	const search = $derived(params.get('search') ?? '');
	const groupId = $derived(params.get('groupId') || null);
	const tag = $derived(params.get('tag') || null);
	const showPast = $derived(params.get('past') === '1');
	const offset = $derived(Math.max(0, Number(params.get('offset')) || 0));

	/** Setzt URL-Parameter (null/'' entfernt) und springt zurück auf Seite 1 */
	function setParams(values: Record<string, string | null>, resetOffset = true) {
		const url = new URL(page.url);
		for (const [k, v] of Object.entries(values)) {
			if (v) url.searchParams.set(k, v);
			else url.searchParams.delete(k);
		}
		if (resetOffset) url.searchParams.delete('offset');
		void goto(url, { keepFocus: true, noScroll: true, replaceState: true });
	}

	function setView(v: string) {
		const url = new URL(page.url);
		if (v === 'list') url.searchParams.set('view', 'list');
		else url.searchParams.delete('view');
		url.searchParams.delete('offset');
		void goto(url, { keepFocus: true, noScroll: true });
	}

	// --- Filter-Optionen -------------------------------------------------------------------
	let groups = $state<EventGroupRef[]>([]);
	let tags = $state<string[]>([]);
	const groupOptions = $derived(groups.map((g) => ({ value: g.id, label: g.name })));
	const tagOptions = $derived.by(() => {
		const all = tag && !tags.includes(tag) ? [tag, ...tags] : tags;
		return all.map((t) => ({ value: t, label: t }));
	});

	async function loadMeta() {
		try {
			const [g, t] = await Promise.all([
				apiFetch<EventGroupRef[]>('/modules/events/groups'),
				apiFetch<string[]>('/modules/events/tags')
			]);
			groups = g;
			tags = t;
		} catch {
			// Filter bleiben leer; die Liste selbst zeigt ggf. einen Fehler
		}
	}

	$effect(() => {
		void loadMeta();
	});

	// --- Termine laden ---------------------------------------------------------------------
	let items = $state<EventItem[]>([]);
	let total = $state(0);
	let loading = $state(true);
	let loadError = $state('');
	/** Wird nach Speichern/Löschen erhöht und löst ein Neuladen aus */
	let reloadKey = $state(0);

	const query = $derived.by(() => {
		const q = new URLSearchParams();
		if (view === 'month') {
			const grid = buildMonthGrid(month);
			q.set('from', grid[0]![0]!);
			q.set('to', grid[grid.length - 1]![6]!);
			q.set('limit', String(MONTH_LIMIT));
			q.set('offset', '0');
		} else {
			if (!showPast) q.set('from', today);
			q.set('limit', String(PAGE_SIZE));
			q.set('offset', String(offset));
		}
		if (search) q.set('search', search);
		if (groupId) q.set('groupId', groupId);
		if (tag) q.set('tag', tag);
		return q.toString();
	});

	$effect(() => {
		const q = query;
		void reloadKey;
		let stale = false;
		loading = true;
		apiFetch<EventList>(`/modules/events/events?${q}`)
			.then((r) => {
				if (stale) return;
				items = r.items;
				total = r.total;
				loadError = '';
			})
			.catch((e) => {
				if (!stale) {
					loadError =
						e instanceof ApiClientError ? e.message : 'Termine konnten nicht geladen werden.';
				}
			})
			.finally(() => {
				if (!stale) loading = false;
			});
		return () => {
			stale = true;
		};
	});

	function reload() {
		reloadKey++;
	}

	function eventColor(e: EventItem): string | null {
		return e.color ?? e.groups.find((g) => g.color)?.color ?? null;
	}

	/** Eindeutiger Schlüssel (Serien: `id:occurrenceDate`); Fallback, falls das Backend ihn nicht liefert */
	function itemKey(e: EventItem): string {
		return e.key ?? e.id;
	}

	const calendarItems = $derived<CalendarItem[]>(
		items.map((e) => ({
			id: itemKey(e),
			key: itemKey(e),
			recurring: !!e.recurrence,
			title: e.title,
			color: eventColor(e),
			startsOn: e.startsOn,
			startsTime: e.startsTime,
			endsOn: e.endsOn,
			endsTime: e.endsTime
		}))
	);

	const filtered = $derived(!!(search || groupId || tag));

	// --- Ansicht / Bearbeiten --------------------------------------------------------------
	let dialogOpen = $state(false);
	let dialogId = $state<string | null>(null);
	let dialogOccurrence = $state<string | null>(null);
	let dialogMode = $state<'view' | 'create'>('create');
	let dialogDate = $state<string | undefined>(undefined);

	function openView(e: EventItem) {
		dialogId = e.id;
		dialogOccurrence = e.occurrenceDate ?? null;
		dialogMode = 'view';
		dialogDate = undefined;
		dialogOpen = true;
	}

	// Deep-Link (globale Suche): `?event=<id>[&occurrence=JJJJ-MM-TT]` öffnet die Ansicht und
	// entfernt die Parameter wieder (Monat bleibt)
	$effect(() => {
		const id = params.get('event');
		if (!id) return;
		const occ = params.get('occurrence');
		untrack(() => {
			dialogId = id;
			dialogOccurrence = occ && /^\d{4}-\d{2}-\d{2}$/.test(occ) ? occ : null;
			dialogMode = 'view';
			dialogDate = undefined;
			dialogOpen = true;
			setParams({ event: null, occurrence: null }, false);
		});
	});

	function openViewByKey(key: string) {
		const e = items.find((x) => itemKey(x) === key);
		if (e) openView(e);
	}

	function openCreate(date?: string) {
		dialogId = null;
		dialogOccurrence = null;
		dialogMode = 'create';
		dialogDate = date;
		dialogOpen = true;
	}

	function rowKey(ev: KeyboardEvent, e: EventItem) {
		if (ev.target !== ev.currentTarget) return;
		if (ev.key === 'Enter' || ev.key === ' ') {
			ev.preventDefault();
			openView(e);
		}
	}

	function onsaved() {
		reload();
		void loadMeta();
	}

	function ondeleted() {
		reload();
		void loadMeta();
	}

	// Kalender-Abo (iCal) direkt von der Terminseite aus
	let feedsOpen = $state(false);
	// PDF-Export (Terminliste, Monatskalender, Jahresplan)
	let exportOpen = $state(false);
	const groupName = $derived(groups.find((g) => g.id === groupId)?.name ?? null);
</script>

<PageTitle title="Termine" />

<PageHeader title="Termine" description="Interne Termine und Termine für die Stammeswebsite">
	{#snippet actions()}
		<Button variant="outline" onclick={() => (exportOpen = true)}>
			<FileDown /> Exportieren
		</Button>
		<Button variant="outline" onclick={() => (feedsOpen = true)}>
			<CalendarSync /> Kalender abonnieren
		</Button>
		{#if canCreate}
			<Button onclick={() => openCreate()}><Plus /> Neuer Termin</Button>
		{/if}
	{/snippet}
</PageHeader>

{#snippet filters()}
	<SearchInput placeholder="Termin suchen …" label="Termine suchen" />
	<SelectField
		label="Gruppe"
		size="sm"
		class="w-full sm:w-48"
		options={groupOptions}
		value={groupId}
		emptyLabel="Alle Gruppen"
		onchange={(v) => setParams({ groupId: v })}
	/>
	<SelectField
		label="Tag"
		size="sm"
		class="w-full sm:w-48"
		options={tagOptions}
		value={tag}
		emptyLabel="Alle Tags"
		onchange={(v) => setParams({ tag: v })}
	/>
{/snippet}

<Tabs.Root value={view} onValueChange={setView}>
	<Tabs.List variant="line" class="mb-4" aria-label="Ansicht">
		<Tabs.Trigger value="month">Monat</Tabs.Trigger>
		<Tabs.Trigger value="list">Liste</Tabs.Trigger>
	</Tabs.List>
</Tabs.Root>

{#if view === 'list'}
	<DataTable
		caption="Termine"
		mobile="cards"
		{loading}
		error={loadError}
		empty={!items.length}
		emptyTitle={filtered ? 'Keine passenden Termine' : 'Keine Termine'}
		emptyDescription={filtered
			? 'Passe die Suche oder die Filter an.'
			: showPast
				? 'Es sind noch keine Termine vorhanden oder für dich freigegeben.'
				: 'Ab heute stehen keine Termine an. Vergangene Termine kannst du einblenden.'}
	>
		{#snippet toolbar()}
			{@render filters()}
			<div class="flex items-center gap-2">
				<Checkbox
					id="events-past"
					checked={showPast}
					onCheckedChange={(v) => setParams({ past: v === true ? '1' : null })}
				/>
				<Label for="events-past" class="font-normal">Auch vergangene</Label>
			</div>
		{/snippet}
		{#snippet emptyAction()}
			{#if canCreate && !filtered}
				<Button onclick={() => openCreate()}><Plus /> Neuer Termin</Button>
			{/if}
		{/snippet}
		{#snippet head()}
			<Table.Row>
				<Table.Head>Datum/Zeit</Table.Head>
				<Table.Head>Titel</Table.Head>
				<Table.Head>Ort</Table.Head>
				<Table.Head>Gruppen</Table.Head>
				<Table.Head>Tags</Table.Head>
			</Table.Row>
		{/snippet}
		{#each items as e (itemKey(e))}
			{@const color = eventColor(e)}
			<Table.Row
				class="cursor-pointer focus-visible:bg-muted/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
				tabindex={0}
				aria-label={`Termin ${e.title} anzeigen`}
				onclick={() => openView(e)}
				onkeydown={(ev) => rowKey(ev, e)}
			>
				<Table.Cell class="whitespace-nowrap tabular-nums">{formatEventRange(e)}</Table.Cell>
				<Table.Cell class="font-medium">
					<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
						<span
							class="size-2.5 shrink-0 rounded-full border"
							style:background-color={color ?? 'transparent'}
							aria-hidden="true"
						></span>
						{#if e.recurrence}
							<Repeat class="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
						{/if}
						<span
							>{e.title}{#if e.recurrence}<span class="sr-only"> (Serie)</span>{/if}</span
						>
						{#if e.isException}<Badge variant="outline" class="shrink-0">Geändert</Badge>{/if}
						{#if e.onWebsite}<Badge variant="secondary" class="shrink-0">Website</Badge>{/if}
					</div>
				</Table.Cell>
				<Table.Cell>{e.location ?? '–'}</Table.Cell>
				<Table.Cell>
					{#if e.groups.length}
						<div class="flex flex-wrap gap-1">
							{#each e.groups as g (g.id)}
								<ColorBadge color={g.color}>{g.name}</ColorBadge>
							{/each}
						</div>
					{:else}
						–
					{/if}
				</Table.Cell>
				<Table.Cell>
					{#if e.tags.length}
						<div class="flex flex-wrap gap-1">
							{#each e.tags as t (t)}
								<Badge variant="outline">{t}</Badge>
							{/each}
						</div>
					{:else}
						–
					{/if}
				</Table.Cell>
			</Table.Row>
		{/each}
		{#snippet footer()}
			{#if items.length}<Pagination {total} limit={PAGE_SIZE} {offset} />{/if}
		{/snippet}
	</DataTable>
{:else}
	<div class="space-y-4">
		<div class="flex flex-wrap items-center gap-2">
			{@render filters()}
		</div>
		{#if loadError}
			<div
				class="flex flex-wrap items-center gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
				role="alert"
			>
				<span class="text-destructive">{loadError}</span>
				<Button size="sm" variant="outline" onclick={reload}>Erneut versuchen</Button>
			</div>
		{/if}
		{#if !loading && !loadError && total > items.length}
			<p class="text-xs text-muted-foreground" role="status">
				Es werden nur die ersten {items.length} von {total} Terminen angezeigt. Grenze die Auswahl mit
				den Filtern ein.
			</p>
		{/if}
		<MonthCalendar
			items={calendarItems}
			bind:month={() => month, (v) => setParams({ month: v ?? null })}
			{today}
			{loading}
			onselect={(item) => openViewByKey(item.key ?? item.id)}
			onday={canCreate ? (date) => openCreate(date) : undefined}
		/>
	</div>
{/if}

<EventDialog
	bind:open={dialogOpen}
	eventId={dialogId}
	occurrenceDate={dialogOccurrence}
	mode={dialogMode}
	initialDate={dialogDate}
	{onsaved}
	{ondeleted}
/>

<ExportDialog bind:open={exportOpen} {month} {search} {groupId} {groupName} {tag} />

<Dialog.Root bind:open={feedsOpen}>
	<Dialog.Content class="sm:max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>Kalender abonnieren</Dialog.Title>
			<Dialog.Description>
				Termine und Aktionen automatisch in deinem Kalender – auf dem Handy, in Outlook, Google oder
				Apple Kalender. Du findest deine Abos auch im Profil.
			</Dialog.Description>
		</Dialog.Header>
		{#if feedsOpen}
			<CalendarFeedsPanel />
		{/if}
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (feedsOpen = false)}>Schließen</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
