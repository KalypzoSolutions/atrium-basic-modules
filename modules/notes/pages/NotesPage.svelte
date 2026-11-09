<script lang="ts">
	// Übersicht der Notizen: Suche, zuletzt bearbeitet, eigene, geteilte und Aktions-Notizen; Anlegen, Import, Papierkorb
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { toast } from 'svelte-sonner';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import FileUp from '@lucide/svelte/icons/file-up';
	import NotebookPen from '@lucide/svelte/icons/notebook-pen';
	import Plus from '@lucide/svelte/icons/plus';
	import Search from '@lucide/svelte/icons/search';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { apiFetch } from '$lib/sdk/client';
	import { EmptyState, ErrorState, LoadingState, PageHeader } from '$lib/components/layout';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import type { NoteNode, NoteRoots, NoteSearchHit } from '../schemas';
	import NoteIcon from './NoteIcon.svelte';
	import NoteList from './NoteList.svelte';
	import TrashView from './TrashView.svelte';
	import {
		API,
		BASE,
		createNote,
		errMsg,
		IMPORT_ACCEPT,
		importNote,
		noteTitle,
		notePath
	} from './helpers';

	const trash = $derived(page.url.searchParams.get('view') === 'trash');

	let roots = $state<NoteRoots | null>(null);
	let recent = $state<NoteNode[]>([]);
	let loading = $state(true);
	let loadError = $state('');
	let creating = $state(false);
	let importing = $state(false);
	let fileInput = $state<HTMLInputElement | null>(null);

	let query = $state('');
	let hits = $state<NoteSearchHit[] | null>(null);
	let searching = $state(false);
	let searchError = $state('');

	async function load() {
		loading = true;
		loadError = '';
		try {
			const [r, rec] = await Promise.all([
				apiFetch<NoteRoots>(`${API}/notes/roots`),
				apiFetch<NoteNode[]>(`${API}/notes/recent?limit=8`)
			]);
			roots = r;
			recent = rec;
		} catch (e) {
			loadError = errMsg(e, 'Notizen konnten nicht geladen werden');
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		if (!trash) void load();
	});

	$effect(() => {
		const q = query.trim();
		if (q.length < 2) {
			hits = null;
			searching = false;
			searchError = '';
			return;
		}
		let stale = false;
		searching = true;
		const t = setTimeout(() => {
			apiFetch<NoteSearchHit[]>(`${API}/notes/search?q=${encodeURIComponent(q)}`)
				.then((res) => {
					if (!stale) {
						hits = res;
						searchError = '';
					}
				})
				.catch((e) => {
					if (!stale) searchError = errMsg(e, 'Suche fehlgeschlagen');
				})
				.finally(() => {
					if (!stale) searching = false;
				});
		}, 250);
		return () => {
			stale = true;
			clearTimeout(t);
		};
	});

	async function create() {
		creating = true;
		try {
			const note = await createNote({ title: '' });
			await goto(notePath(note.id));
		} catch (e) {
			toast.error(errMsg(e, 'Notiz konnte nicht angelegt werden'));
		} finally {
			creating = false;
		}
	}

	async function importFile(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		importing = true;
		try {
			const res = await importNote(file);
			toast.success('Notiz importiert');
			await goto(notePath(res.id));
		} catch (err) {
			toast.error(errMsg(err, 'Import fehlgeschlagen'));
		} finally {
			importing = false;
		}
	}

	const empty = $derived(
		!!roots && !roots.own.length && !roots.shared.length && !roots.actions.length
	);
</script>

{#if trash}
	<a href={BASE} class="mb-3 inline-flex items-center gap-1 text-sm text-link hover:underline">
		<ArrowLeft class="size-4" /> Alle Notizen
	</a>
	<PageHeader title="Papierkorb" description="Gelöschte Notizen mit ihren Unterseiten." />
	<TrashView />
{:else}
	<PageHeader title="Notizen" description="Gemeinsame Seiten mit Unterseiten, live bearbeitet.">
		{#snippet actions()}
			{#if roots?.canCreate}
				<Button onclick={create} disabled={creating}><Plus /> Neue Notiz</Button>
				<Button variant="outline" onclick={() => fileInput?.click()} disabled={importing}>
					<FileUp />
					{importing ? 'Importiert …' : 'Importieren'}
				</Button>
			{/if}
			<Button variant="ghost" href={`${BASE}?view=trash`}><Trash2 /> Papierkorb</Button>
		{/snippet}
	</PageHeader>
	<input
		bind:this={fileInput}
		type="file"
		accept={IMPORT_ACCEPT}
		class="hidden"
		onchange={importFile}
	/>

	<div class="relative mb-6 max-w-xl">
		<Search
			class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
			aria-hidden="true"
		/>
		<Input
			type="search"
			bind:value={query}
			class="pl-8"
			placeholder="In Notizen suchen …"
			aria-label="In Notizen suchen"
		/>
	</div>

	{#if query.trim().length >= 2}
		<section class="space-y-3" aria-live="polite">
			<h2 class="text-section">Suchergebnisse</h2>
			{#if searchError}
				<ErrorState compact message={searchError} />
			{:else if searching && !hits}
				<LoadingState label="Suche" rows={3} />
			{:else if hits && !hits.length}
				<p class="text-sm text-muted-foreground">Nichts gefunden.</p>
			{:else if hits}
				<ul class="divide-y rounded-lg border bg-card">
					{#each hits as h (h.id)}
						<li>
							<a
								href={notePath(h.id)}
								class="flex items-start gap-3 px-3 py-2.5 outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
							>
								<NoteIcon icon={h.icon} color={null} class="mt-0.5 size-5" />
								<span class="min-w-0 flex-1">
									<span class="block truncate text-sm font-medium">{noteTitle(h.title)}</span>
									{#if h.path}
										<span class="block truncate text-xs text-muted-foreground">{h.path}</span>
									{/if}
									{#if h.snippet}
										<span class="line-clamp-2 text-xs text-muted-foreground">{h.snippet}</span>
									{/if}
								</span>
							</a>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	{:else if loading && !roots}
		<LoadingState label="Notizen" rows={5} />
	{:else if loadError && !roots}
		<ErrorState message={loadError} onretry={load} />
	{:else if roots}
		{#if empty}
			<EmptyState
				title="Noch keine Notizen"
				description="Lege eine Notiz an und schreibe gemeinsam mit anderen – mit Unterseiten, Bildern, Tabellen und eingebetteten Whiteboards."
			>
				{#if roots.canCreate}
					<Button onclick={create} disabled={creating}><NotebookPen /> Erste Notiz anlegen</Button>
				{/if}
			</EmptyState>
		{:else}
			<div class="grid gap-6 lg:grid-cols-2">
				{#if recent.length}
					<section class="space-y-3 lg:col-span-2">
						<h2 class="text-section">Zuletzt bearbeitet</h2>
						<NoteList notes={recent} />
					</section>
				{/if}
				<section class="space-y-3">
					<h2 class="text-section">Meine Notizen</h2>
					{#if roots.own.length}
						<NoteList notes={roots.own} />
					{:else}
						<p class="text-sm text-muted-foreground">Du hast noch keine eigenen Notizen.</p>
					{/if}
				</section>
				<section class="space-y-3">
					<h2 class="text-section">Mit mir geteilt</h2>
					{#if roots.shared.length}
						<NoteList notes={roots.shared} />
					{:else}
						<p class="text-sm text-muted-foreground">Noch nichts mit dir geteilt.</p>
					{/if}
				</section>
				{#if roots.actions.length}
					<section class="space-y-3 lg:col-span-2">
						<h2 class="text-section">Aus Aktionen</h2>
						<NoteList notes={roots.actions} extra={(n) => n.actionName ?? null} />
					</section>
				{/if}
			</div>
		{/if}
	{/if}
{/if}
