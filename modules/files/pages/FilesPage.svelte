<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Download from '@lucide/svelte/icons/download';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import FolderInput from '@lucide/svelte/icons/folder-input';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import FolderPlus from '@lucide/svelte/icons/folder-plus';
	import FolderUp from '@lucide/svelte/icons/folder-up';
	import Info from '@lucide/svelte/icons/info';
	import LayoutGrid from '@lucide/svelte/icons/layout-grid';
	import ListIcon from '@lucide/svelte/icons/list';
	import Search from '@lucide/svelte/icons/search';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import Upload from '@lucide/svelte/icons/upload';
	import X from '@lucide/svelte/icons/x';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Input } from '$lib/components/ui/input';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import FileTypeGlyph from './FileTypeGlyph.svelte';
	import {
		ConfirmDialog,
		EmptyState,
		MobileActionBar,
		PageHeader,
		toastWithUndo,
		PageTitle
	} from '$lib/components/layout';
	import {
		ROOT_LABEL,
		type BulkResult,
		type FileNode,
		type FilesMeta,
		type FolderListing,
		type SearchResult
	} from '../schemas';
	import {
		API,
		DRAG_MIME,
		VIEWS,
		VIEW_LABELS,
		contentUrl,
		errorText,
		iconFor,
		type NodeAction,
		type PreviewNode,
		type View
	} from './helpers';
	import FileList from './FileList.svelte';
	import FilePreview from './FilePreview.svelte';
	import FolderStyleDialog from './FolderStyleDialog.svelte';
	import LinkDialog from './LinkDialog.svelte';
	import MoveDialog from './MoveDialog.svelte';
	import NameDialog from './NameDialog.svelte';
	import NodeInfoDialog from './NodeInfoDialog.svelte';
	import QuotaBar from './QuotaBar.svelte';
	import ShareNodeDialog from './ShareNodeDialog.svelte';
	import TrashView from './TrashView.svelte';
	import UploadDropzone from './UploadDropzone.svelte';

	const VIEW_MODE_KEY = 'files.view-mode';

	// --- Meta (Kontingent, Rechte) ---------------------------------------------------------
	let meta = $state<FilesMeta | null>(null);

	async function loadMeta() {
		try {
			meta = await apiFetch<FilesMeta>(`${API}/meta`);
		} catch {
			// Ohne Meta funktioniert die Ablage weiter (Prüfungen macht der Server)
		}
	}

	// --- Zustand aus der URL (?view=trash, ?folder=) -----------------------------------------
	const view = $derived.by<View>(() => {
		const v = page.url.searchParams.get('view') ?? '';
		return (VIEWS as readonly string[]).includes(v) ? (v as View) : 'files';
	});
	const folderId = $derived(view === 'trash' ? null : page.url.searchParams.get('folder'));

	function navigate(v: View, folder: string | null, replace = false) {
		const url = new URL(page.url);
		url.searchParams.delete('view');
		url.searchParams.delete('folder');
		if (v !== 'files') url.searchParams.set('view', v);
		if (folder && v === 'files') url.searchParams.set('folder', folder);
		clearSearch();
		void goto(url, { keepFocus: true, noScroll: true, replaceState: replace });
	}

	// --- Ordnerinhalt laden ----------------------------------------------------------------
	let listing = $state<FolderListing | null>(null);
	let loading = $state(true);
	let loadError = $state('');
	let reloadKey = $state(0);
	let selected = $state<string[]>([]);

	$effect(() => {
		const v = view;
		const f = folderId;
		void reloadKey;
		if (v === 'trash') return;
		let stale = false;
		loading = true;
		selected = [];
		const qs = f ? `?${new URLSearchParams({ parent: f }).toString()}` : '';
		apiFetch<FolderListing>(`${API}/nodes${qs}`)
			.then((r) => {
				if (stale) return;
				listing = r;
				loadError = '';
			})
			.catch((e) => {
				if (stale) return;
				if (f && e instanceof ApiClientError && (e.status === 404 || e.status === 422)) {
					toast.error('Der Ordner wurde nicht gefunden oder gelöscht.');
					navigate('files', null, true);
					return;
				}
				listing = null;
				loadError = errorText(e, 'Der Ordner konnte nicht geladen werden.');
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

	function reloadAll() {
		reload();
		void loadMeta();
	}

	const items = $derived(listing?.items ?? []);
	const canEdit = $derived(!!listing && listing.access === 'edit' && !loadError);
	const parentId = $derived(listing?.folder?.id ?? null);
	const atRoot = $derived(!listing?.folder);

	// --- Suche (über alles, was ich sehe) ------------------------------------------------------
	let searchText = $state('');
	let searchQ = $state('');
	let searchTimer: ReturnType<typeof setTimeout> | undefined;
	let searchResult = $state<SearchResult | null>(null);
	let searchLoading = $state(false);
	let searchError = $state('');
	let searchKey = $state(0);
	const searching = $derived(searchQ.length >= 2);

	function onSearchInput() {
		clearTimeout(searchTimer);
		searchTimer = setTimeout(() => {
			const q = searchText.trim();
			searchQ = q.length >= 2 ? q : '';
		}, 300);
	}

	function clearSearch() {
		clearTimeout(searchTimer);
		searchText = '';
		searchQ = '';
		searchResult = null;
		searchError = '';
	}

	$effect(() => {
		const q = searchQ;
		const v = view;
		void searchKey;
		if (q.length < 2 || v === 'trash') return;
		let stale = false;
		searchLoading = true;
		apiFetch<SearchResult>(`${API}/search?${new URLSearchParams({ q }).toString()}`)
			.then((r) => {
				if (stale) return;
				searchResult = r;
				searchError = '';
			})
			.catch((e) => {
				if (!stale) searchError = errorText(e, 'Die Suche ist fehlgeschlagen.');
			})
			.finally(() => {
				if (!stale) searchLoading = false;
			});
		return () => {
			stale = true;
		};
	});

	/** Ordner eines Treffers: liegt er direkt in der Wurzel (auch freigegebene Einträge), dann die Wurzel */
	function hitFolder(hit: SearchResult['items'][number]): string | null {
		return hit.path === ROOT_LABEL ? null : hit.parentId;
	}

	// --- Raster/Liste ----------------------------------------------------------------------
	let viewMode = $state<'grid' | 'list'>('grid');

	onMount(() => {
		void loadMeta();
		try {
			const v = localStorage.getItem(VIEW_MODE_KEY);
			if (v === 'grid' || v === 'list') viewMode = v;
		} catch {
			// ohne Speicher: Standard
		}
	});

	function setViewMode(v: 'grid' | 'list') {
		viewMode = v;
		try {
			localStorage.setItem(VIEW_MODE_KEY, v);
		} catch {
			// egal
		}
	}

	// --- Upload ----------------------------------------------------------------------------
	let uploadZone = $state<ReturnType<typeof UploadDropzone>>();
	const canUpload = $derived(view !== 'trash' && canEdit && !searching);

	function onbackground(action: 'new-folder' | 'upload-files' | 'upload-folder') {
		if (!canEdit) return;
		if (action === 'new-folder') newFolder();
		else if (action === 'upload-files') uploadZone?.openFilePicker();
		else uploadZone?.openFolderPicker();
	}

	// --- Breadcrumbs -----------------------------------------------------------------------
	const crumbs = $derived(listing?.breadcrumbs ?? []);
	let dropCrumb = $state<number | null>(null);

	function openCrumb(i: number) {
		const c = crumbs[i];
		if (!c || i === crumbs.length - 1) return;
		navigate('files', c.id);
	}

	function crumbDroppable(i: number): boolean {
		return !!crumbs[i] && i !== crumbs.length - 1 && !searching;
	}

	function onCrumbDragOver(e: DragEvent, i: number) {
		if (!crumbDroppable(i) || !e.dataTransfer?.types.includes(DRAG_MIME)) return;
		e.preventDefault();
		e.dataTransfer.dropEffect = 'move';
		dropCrumb = i;
	}

	function onCrumbDrop(e: DragEvent, i: number) {
		dropCrumb = null;
		if (!crumbDroppable(i) || !e.dataTransfer?.types.includes(DRAG_MIME)) return;
		e.preventDefault();
		let ids: string[] = [];
		try {
			const parsed: unknown = JSON.parse(e.dataTransfer.getData(DRAG_MIME));
			if (Array.isArray(parsed)) ids = parsed.filter((x): x is string => typeof x === 'string');
		} catch {
			return;
		}
		if (ids.length) void moveTo(ids, crumbs[i]!.id, crumbs[i]!.name);
	}

	// --- Verschieben per Drag & Drop ---------------------------------------------------------
	async function moveTo(ids: string[], targetId: string | null, targetName?: string) {
		if (!listing) return;
		// Rückweg: je Eintrag der bisherige Elternordner (in der Wurzel können freigegebene Einträge
		// anderer liegen, deren echter Elternordner nicht die eigene Wurzel ist)
		const fallback = listing.folder?.id ?? null;
		const origins = new Map<string | null, string[]>();
		for (const id of ids) {
			const from = items.find((n) => n.id === id)?.parentId ?? fallback;
			origins.set(from, [...(origins.get(from) ?? []), id]);
		}
		const target =
			targetName ?? (targetId ? items.find((n) => n.id === targetId)?.name : null) ?? 'Ordner';
		try {
			const r = await apiFetch<BulkResult>(`${API}/nodes/move`, {
				method: 'POST',
				body: JSON.stringify({ ids, targetId })
			});
			const n = r?.affected ?? ids.length;
			toastWithUndo({
				message:
					n === 1 ? `Nach „${target}“ verschoben` : `${n} Einträge nach „${target}“ verschoben`,
				undo: async () => {
					for (const [from, group] of origins) {
						await apiFetch(`${API}/nodes/move`, {
							method: 'POST',
							body: JSON.stringify({ ids: group, targetId: from })
						});
					}
				},
				onundone: reload
			});
			selected = [];
			reload();
		} catch (e) {
			toast.error(errorText(e, 'Verschieben fehlgeschlagen.'));
		}
	}

	// --- Aktionen --------------------------------------------------------------------------
	let previewOpen = $state(false);
	let previewCurrent = $state<PreviewNode | null>(null);
	let previewNodes = $state<PreviewNode[]>([]);

	let nameOpen = $state(false);
	let nameMode = $state<'create' | 'rename'>('create');
	let nameNode = $state<FileNode | null>(null);

	let moveOpen = $state(false);
	let moveNodes = $state<FileNode[]>([]);

	let shareOpen = $state(false);
	let linkOpen = $state(false);
	let infoOpen = $state(false);
	let styleOpen = $state(false);
	let dialogNode = $state<FileNode | null>(null);

	let trashOpen = $state(false);
	let trashNodes = $state<FileNode[]>([]);

	function openNode(node: FileNode, siblings: FileNode[] = items) {
		if (node.kind === 'folder') {
			navigate('files', node.id);
			return;
		}
		previewNodes = siblings.filter((n) => n.kind === 'file');
		previewCurrent = node;
		previewOpen = true;
	}

	function download(nodes: FileNode[]) {
		const files = nodes.filter((n) => n.kind === 'file');
		if (!files.length) {
			toast.info('Ordner lassen sich nicht als Ganzes herunterladen.');
			return;
		}
		for (const f of files) {
			const a = document.createElement('a');
			a.href = contentUrl(f.id, true);
			a.download = f.name;
			a.rel = 'noopener';
			document.body.append(a);
			a.click();
			a.remove();
		}
	}

	function onaction(action: NodeAction, nodes: FileNode[]) {
		const first = nodes[0];
		if (!first) return;
		switch (action) {
			case 'open':
				openNode(first);
				break;
			case 'download':
				download(nodes);
				break;
			case 'rename':
				nameMode = 'rename';
				nameNode = first;
				nameOpen = true;
				break;
			case 'move':
				moveNodes = nodes;
				moveOpen = true;
				break;
			case 'share':
				dialogNode = first;
				shareOpen = true;
				break;
			case 'link':
				if (!meta?.can.linkCreate) {
					toast.error('Du darfst keine öffentlichen Links anlegen.');
					break;
				}
				dialogNode = first;
				linkOpen = true;
				break;
			case 'info':
				dialogNode = first;
				infoOpen = true;
				break;
			case 'style':
				dialogNode = first;
				styleOpen = true;
				break;
			case 'trash':
				trashNodes = nodes;
				trashOpen = true;
				break;
		}
	}

	/** Schnellwahl „Farbe“ im Menü (auch für mehrere Ordner), mit Rückgängig auf die bisherigen Farben */
	async function setColor(nodes: FileNode[], color: string | null) {
		const ids = nodes.map((n) => n.id);
		const previous = new Map<string | null, string[]>();
		for (const n of nodes) previous.set(n.color, [...(previous.get(n.color) ?? []), n.id]);
		try {
			await apiFetch<BulkResult>(`${API}/nodes/style`, {
				method: 'POST',
				body: JSON.stringify({ ids, color })
			});
			toastWithUndo({
				message: color
					? ids.length === 1
						? 'Farbe geändert'
						: `Farbe von ${ids.length} Ordnern geändert`
					: ids.length === 1
						? 'Farbe entfernt'
						: `Farbe von ${ids.length} Ordnern entfernt`,
				undo: async () => {
					for (const [before, group] of previous) {
						await apiFetch(`${API}/nodes/style`, {
							method: 'POST',
							body: JSON.stringify({ ids: group, color: before })
						});
					}
				},
				onundone: reload
			});
			reload();
		} catch (e) {
			toast.error(errorText(e, 'Farbe konnte nicht geändert werden.'));
		}
	}

	function newFolder() {
		nameMode = 'create';
		nameNode = null;
		nameOpen = true;
	}

	const trashTitle = $derived(
		trashNodes.length === 1
			? `„${trashNodes[0]!.name}“ in den Papierkorb?`
			: `${trashNodes.length} Einträge in den Papierkorb?`
	);
	const trashDescription = $derived(
		`Du kannst ${trashNodes.length === 1 ? 'ihn' : 'sie'} ${
			meta ? `${meta.trashDays} Tage lang` : 'eine Zeit lang'
		} aus dem Papierkorb wiederherstellen.${
			trashNodes.some((n) => n.kind === 'folder') ? ' Ordner kommen mit ihrem Inhalt dorthin.' : ''
		}`
	);

	async function confirmTrash() {
		const ids = trashNodes.map((n) => n.id);
		const label = trashNodes.length === 1 ? `„${trashNodes[0]!.name}“` : null;
		try {
			const r = await apiFetch<BulkResult>(`${API}/nodes/trash`, {
				method: 'POST',
				body: JSON.stringify({ ids })
			});
			const n = r?.affected ?? ids.length;
			toastWithUndo({
				message: label && n === 1 ? `${label} liegt im Papierkorb` : `${n} Einträge im Papierkorb`,
				undo: () =>
					apiFetch(`${API}/trash/restore`, { method: 'POST', body: JSON.stringify({ ids }) }),
				undone: 'Wiederhergestellt',
				onundone: reloadAll
			});
			selected = [];
			reloadAll();
			if (searching) refreshSearch();
		} catch (e) {
			toast.error(errorText(e, 'Löschen fehlgeschlagen.'));
		}
	}

	function refreshSearch() {
		searchKey++;
	}

	function afterChange() {
		reload();
		if (searching) refreshSearch();
	}

	// --- Auswahl ---------------------------------------------------------------------------
	const selectedNodes = $derived(items.filter((n) => selected.includes(n.id)));
	const selectionEditable = $derived(
		selectedNodes.length > 0 && selectedNodes.every((n) => n.access === 'edit')
	);
	const singleFile = $derived(
		selectedNodes.length === 1 && selectedNodes[0]!.kind === 'file' ? selectedNodes[0]! : null
	);
	const showSelection = $derived(!searching && view !== 'trash' && selectedNodes.length > 0);

	// --- Leere Zustände --------------------------------------------------------------------
	const empty = $derived.by(() => {
		if (atRoot)
			return {
				title: 'Noch keine Dateien',
				description:
					'Ziehe Dateien hierher, nutze „Hochladen“ oder lass dir einen Ordner freigeben.'
			};
		return canEdit
			? {
					title: 'Dieser Ordner ist leer',
					description: 'Ziehe Dateien hierher oder nutze „Hochladen“.'
				}
			: { title: 'Dieser Ordner ist leer', description: 'Hier liegen noch keine Dateien.' };
	});
</script>

<PageTitle title={VIEW_LABELS[view]} />

<PageHeader
	title={VIEW_LABELS[view]}
	description={view === 'trash'
		? 'Gelöschte Einträge wiederherstellen oder endgültig löschen.'
		: 'Dateien ablegen, ordnen und mit anderen teilen.'}
>
	{#snippet actions()}
		{#if view === 'trash'}
			<Button variant="outline" onclick={() => navigate('files', null)}>
				<ArrowLeft /> Zurück zu Dateien
			</Button>
		{:else}
			{#if canUpload}
				{@render uploadMenu()}
				<Button variant="outline" onclick={newFolder}><FolderPlus /> Neuer Ordner</Button>
			{/if}
			<Button variant="ghost" onclick={() => navigate('trash', null)}>
				<Trash2 /> Papierkorb
			</Button>
		{/if}
	{/snippet}
</PageHeader>

{#snippet uploadMenu()}
	<DropdownMenu.Root>
		<DropdownMenu.Trigger>
			{#snippet child({ props })}
				<Button {...props}><Upload /> Hochladen <ChevronDown /></Button>
			{/snippet}
		</DropdownMenu.Trigger>
		<DropdownMenu.Content align="end">
			<DropdownMenu.Item onclick={() => uploadZone?.openFilePicker()}>
				<Upload /> Dateien
			</DropdownMenu.Item>
			<DropdownMenu.Item onclick={() => uploadZone?.openFolderPicker()}>
				<FolderUp /> Ordner
			</DropdownMenu.Item>
		</DropdownMenu.Content>
	</DropdownMenu.Root>
{/snippet}

{#if view === 'trash'}
	<div class="space-y-4">
		<nav aria-label="Ordnerpfad" class="min-w-0">
			<ol class="flex min-w-0 items-center gap-0.5 text-sm">
				<li class="flex items-center">
					<button
						type="button"
						class="rounded-md px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
						onclick={() => navigate('files', null)}
					>
						{ROOT_LABEL}
					</button>
					<ChevronRight class="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
				</li>
				<li class="flex items-center">
					<span class="rounded-md px-2 py-1 font-medium" aria-current="page">
						{VIEW_LABELS.trash}
					</span>
				</li>
			</ol>
		</nav>
		{#if meta}
			<QuotaBar quota={meta.quota} class="max-w-sm" />
		{/if}
		<TrashView {meta} onchanged={() => void loadMeta()} />
	</div>
{:else}
	<div class={['space-y-4', showSelection && 'max-sm:pb-20']}>
		{#if meta}
			<QuotaBar quota={meta.quota} class="max-w-sm" />
		{/if}

		<!-- Toolbar -->
		<div class="flex flex-wrap items-center gap-2">
			<div class="relative w-full sm:max-w-sm">
				<Search
					class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
					aria-hidden="true"
				/>
				<Input
					type="search"
					class="pr-8 pl-8"
					placeholder="In allen Dateien suchen …"
					aria-label="Dateien und Ordner suchen"
					bind:value={searchText}
					oninput={onSearchInput}
					onkeydown={(e) => {
						if (e.key === 'Escape') clearSearch();
					}}
				/>
				{#if searchText}
					<button
						type="button"
						class="absolute top-1/2 right-1.5 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
						aria-label="Suche leeren"
						onclick={clearSearch}
					>
						<X class="size-3.5" />
					</button>
				{/if}
			</div>
			<div class="ml-auto flex items-center gap-1" role="group" aria-label="Darstellung">
				<Button
					variant={viewMode === 'grid' ? 'secondary' : 'ghost'}
					size="icon"
					aria-label="Raster"
					aria-pressed={viewMode === 'grid'}
					onclick={() => setViewMode('grid')}
				>
					<LayoutGrid />
				</Button>
				<Button
					variant={viewMode === 'list' ? 'secondary' : 'ghost'}
					size="icon"
					aria-label="Liste"
					aria-pressed={viewMode === 'list'}
					onclick={() => setViewMode('list')}
				>
					<ListIcon />
				</Button>
			</div>
		</div>

		{#if searching}
			{@render searchResults()}
		{:else}
			<!-- Breadcrumbs -->
			{#if crumbs.length}
				<nav aria-label="Ordnerpfad" class="min-w-0">
					<ol class="flex min-w-0 items-center gap-0.5 text-sm">
						{#if crumbs.length > 1}
							<li class="flex items-center sm:hidden">
								<DropdownMenu.Root>
									<DropdownMenu.Trigger>
										{#snippet child({ props })}
											<Button
												{...props}
												variant="ghost"
												size="icon-sm"
												aria-label="Übergeordnete Ordner"
											>
												<Ellipsis />
											</Button>
										{/snippet}
									</DropdownMenu.Trigger>
									<DropdownMenu.Content align="start">
										{#each crumbs.slice(0, -1) as c, i (c.id ?? 'root')}
											<DropdownMenu.Item onclick={() => openCrumb(i)}>
												<FolderOpen />
												{c.name}
											</DropdownMenu.Item>
										{/each}
									</DropdownMenu.Content>
								</DropdownMenu.Root>
								<ChevronRight class="size-3.5 text-muted-foreground" aria-hidden="true" />
							</li>
						{/if}
						{#each crumbs as c, i (c.id ?? 'root')}
							{@const last = i === crumbs.length - 1}
							<li class={['flex min-w-0 items-center', !last && 'max-sm:hidden']}>
								{#if last}
									<span
										class="truncate rounded-md px-2 py-1 font-medium"
										aria-current="page"
										title={c.name}>{c.name}</span
									>
								{:else}
									<button
										type="button"
										class={[
											'max-w-48 truncate rounded-md px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground',
											dropCrumb === i && 'bg-primary/10 text-foreground ring-2 ring-primary'
										]}
										title={c.name}
										onclick={() => openCrumb(i)}
										ondragover={(e) => onCrumbDragOver(e, i)}
										ondragleave={() => {
											if (dropCrumb === i) dropCrumb = null;
										}}
										ondrop={(e) => onCrumbDrop(e, i)}
									>
										{c.name}
									</button>
									<ChevronRight
										class="size-3.5 shrink-0 text-muted-foreground"
										aria-hidden="true"
									/>
								{/if}
							</li>
						{/each}
					</ol>
				</nav>
			{:else if loading}
				<Skeleton class="h-7 w-48" />
			{/if}

			<!-- Auswahl -->
			<MobileActionBar show={showSelection} label="Auswahl" class="rounded-lg sm:border sm:p-2">
				<span class="text-sm font-medium tabular-nums">
					{selectedNodes.length === 1 ? '1 ausgewählt' : `${selectedNodes.length} ausgewählt`}
				</span>
				{#if singleFile}
					<Button variant="outline" size="sm" onclick={() => download([singleFile])}>
						<Download /> Herunterladen
					</Button>
				{/if}
				{#if selectionEditable}
					<Button variant="outline" size="sm" onclick={() => onaction('move', selectedNodes)}>
						<FolderInput /> Verschieben
					</Button>
					<Button variant="destructive" size="sm" onclick={() => onaction('trash', selectedNodes)}>
						<Trash2 /> Löschen
					</Button>
				{/if}
				<Button variant="ghost" size="sm" class="ml-auto" onclick={() => (selected = [])}>
					Auswahl aufheben
				</Button>
			</MobileActionBar>

			{#if loadError}
				<div
					class="flex flex-col items-center gap-3 rounded-lg border border-destructive/40 p-6 text-center"
					role="alert"
				>
					<p class="text-sm text-destructive">{loadError}</p>
					<Button variant="outline" onclick={reload}>Erneut versuchen</Button>
				</div>
			{:else}
				<UploadDropzone
					bind:this={uploadZone}
					{parentId}
					disabled={!canEdit}
					{meta}
					onuploaded={reloadAll}
				>
					<FileList
						{items}
						view={viewMode}
						bind:selected
						loading={loading && !listing}
						{canEdit}
						canCreate={canEdit}
						canLink={!!meta?.can.linkCreate}
						emptyTitle={empty.title}
						emptyDescription={empty.description}
						emptyAction={canUpload ? emptyUpload : undefined}
						onopen={(n) => openNode(n)}
						{onaction}
						onmove={(ids, targetId) => void moveTo(ids, targetId)}
						{onbackground}
						oncolor={(nodes, color) => void setColor(nodes, color)}
					/>
				</UploadDropzone>
			{/if}
		{/if}
	</div>
{/if}

{#snippet emptyUpload()}
	{@render uploadMenu()}
{/snippet}

{#snippet searchResults()}
	{#if searchError}
		<div
			class="flex flex-col items-center gap-3 rounded-lg border border-destructive/40 p-6 text-center"
			role="alert"
		>
			<p class="text-sm text-destructive">{searchError}</p>
			<Button variant="outline" onclick={refreshSearch}>Erneut versuchen</Button>
		</div>
	{:else if searchLoading && !searchResult}
		<div class="space-y-2" aria-busy="true">
			{#each [0, 1, 2, 3] as i (i)}
				<Skeleton class="h-12 w-full" />
			{/each}
		</div>
	{:else if searchResult && searchResult.items.length === 0}
		<EmptyState
			title="Nichts gefunden"
			description={`Kein Ordner und keine Datei enthält „${searchQ}“.`}
		/>
	{:else if searchResult}
		<p class="text-xs text-muted-foreground" aria-live="polite">
			{searchResult.items.length === 1
				? '1 Treffer'
				: `${searchResult.items.length} Treffer`}{searchResult.truncated
				? ' – es gibt mehr, bitte genauer suchen'
				: ''}
		</p>
		<ul class="divide-y rounded-lg border">
			{#each searchResult.items as hit (hit.id)}
				{@const Icon = iconFor(hit.kind, hit.contentType)}
				<li class="flex items-center gap-2 px-3 py-2">
					<button
						type="button"
						class="flex min-w-0 flex-1 items-center gap-3 rounded-md text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
						onclick={() => openNode(hit, searchResult?.items ?? [])}
					>
						{#if hit.kind === 'folder'}
							<Icon class="size-5 shrink-0 text-link" aria-hidden="true" />
						{:else}
							<FileTypeGlyph contentType={hit.contentType} name={hit.name} size="sm" />
						{/if}
						<span class="min-w-0">
							<span class="block truncate font-medium">{hit.name}</span>
							<span class="block truncate text-xs text-muted-foreground">
								{hit.path}{hit.own ? '' : ` · von ${hit.owner.name}`}
							</span>
						</span>
					</button>
					<DropdownMenu.Root>
						<DropdownMenu.Trigger>
							{#snippet child({ props })}
								<Button
									{...props}
									variant="ghost"
									size="icon-sm"
									aria-label={`Aktionen für ${hit.name}`}
								>
									<Ellipsis />
								</Button>
							{/snippet}
						</DropdownMenu.Trigger>
						<DropdownMenu.Content align="end">
							<DropdownMenu.Item onclick={() => openNode(hit, searchResult?.items ?? [])}>
								<FolderOpen /> Öffnen
							</DropdownMenu.Item>
							{#if hit.kind === 'file'}
								<DropdownMenu.Item onclick={() => download([hit])}>
									<Download /> Herunterladen
								</DropdownMenu.Item>
							{/if}
							<DropdownMenu.Item onclick={() => navigate('files', hitFolder(hit))}>
								<FolderInput /> Im Ordner anzeigen
							</DropdownMenu.Item>
							<DropdownMenu.Item onclick={() => onaction('info', [hit])}>
								<Info /> Informationen
							</DropdownMenu.Item>
							{#if hit.access === 'edit'}
								<DropdownMenu.Separator />
								<DropdownMenu.Item
									class="text-destructive"
									onclick={() => onaction('trash', [hit])}
								>
									<Trash2 /> In den Papierkorb
								</DropdownMenu.Item>
							{/if}
						</DropdownMenu.Content>
					</DropdownMenu.Root>
				</li>
			{/each}
		</ul>
	{/if}
{/snippet}

<FilePreview bind:open={previewOpen} nodes={previewNodes} bind:current={previewCurrent} />

<NameDialog bind:open={nameOpen} mode={nameMode} {parentId} node={nameNode} onsaved={afterChange} />

<MoveDialog bind:open={moveOpen} nodes={moveNodes} {meta} onmoved={afterChange} />
<ShareNodeDialog bind:open={shareOpen} node={dialogNode} onchanged={afterChange} />
<LinkDialog bind:open={linkOpen} node={dialogNode} onchanged={afterChange} />
<NodeInfoDialog bind:open={infoOpen} node={dialogNode} />
<FolderStyleDialog bind:open={styleOpen} node={dialogNode} onsaved={afterChange} />

<ConfirmDialog
	bind:open={trashOpen}
	title={trashTitle}
	description={trashDescription}
	confirmLabel="In den Papierkorb"
	destructive
	onconfirm={confirmTrash}
/>
