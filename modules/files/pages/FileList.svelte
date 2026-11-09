<script module lang="ts">
	/** Aktionen des Kontextmenüs auf leerer Fläche */
	export type BackgroundAction = 'new-folder' | 'upload-files' | 'upload-folder';
</script>

<script lang="ts">
	// Dateiliste des Moduls `files`: Raster- oder Listenansicht mit Auswahl, Menü je Eintrag,
	// Tastaturbedienung, Kontextmenü (Rechtsklick an der Mausposition, Long-Press auf Touch)
	// und Drag & Drop zum Verschieben auf Ordner.
	import { onMount, type Component, type Snippet } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import Download from '@lucide/svelte/icons/download';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import FolderInput from '@lucide/svelte/icons/folder-input';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import FolderPlus from '@lucide/svelte/icons/folder-plus';
	import FolderUp from '@lucide/svelte/icons/folder-up';
	import Info from '@lucide/svelte/icons/info';
	import Link from '@lucide/svelte/icons/link';
	import Palette from '@lucide/svelte/icons/palette';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Shapes from '@lucide/svelte/icons/shapes';
	import Share2 from '@lucide/svelte/icons/share-2';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import Upload from '@lucide/svelte/icons/upload';
	import Users from '@lucide/svelte/icons/users';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as ContextMenu from '$lib/components/ui/context-menu';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import * as Table from '$lib/components/ui/table';
	import { DataTable, EmptyState } from '$lib/components/layout';
	import { FOLDER_COLORS, type FileNode } from '../schemas';
	import FolderGlyph from './FolderGlyph.svelte';
	import FileTypeGlyph from './FileTypeGlyph.svelte';
	import { fileTint } from './file-types';
	import {
		DRAG_MIME,
		breakableName,
		folderMeta,
		formatBytes,
		formatDateTime,
		previewKind,
		thumbUrl,
		type NodeAction
	} from './helpers';

	let {
		items,
		view = 'grid',
		selected = $bindable([]),
		loading = false,
		canEdit = false,
		canLink = true,
		emptyTitle = 'Dieser Ordner ist leer',
		emptyDescription = 'Ziehe Dateien hierher oder nutze „Hochladen“.',
		emptyAction,
		canCreate = false,
		onopen,
		onaction,
		onmove,
		onbackground,
		oncolor
	}: {
		items: FileNode[];
		view?: 'grid' | 'list';
		/** IDs der markierten Einträge */
		selected?: string[];
		loading?: boolean;
		/** Bearbeiten im aktuellen Ordner erlaubt (Drag-&-Drop-Verschieben) */
		canEdit?: boolean;
		/** Menüpunkt „Öffentlicher Link“ anbieten (zusätzlich nur bei `access === 'edit'`) */
		canLink?: boolean;
		emptyTitle?: string;
		emptyDescription?: string;
		emptyAction?: Snippet;
		/** Im aktuellen Ordner anlegen/hochladen erlaubt (Kontextmenü auf leerer Fläche) */
		canCreate?: boolean;
		/** Doppelklick/Enter: Ordner öffnen bzw. Datei in der Vorschau */
		onopen: (node: FileNode) => void;
		/** Menü-/Tastatur-Aktion auf einem oder mehreren Einträgen */
		onaction: (action: NodeAction, nodes: FileNode[]) => void;
		/** Einträge per Drag & Drop auf einen Ordner gezogen (`targetId` = Ordner-ID) */
		onmove: (ids: string[], targetId: string) => void;
		/** Kontextmenü auf leerer Fläche (nur mit `canCreate`) */
		onbackground?: (action: BackgroundAction) => void;
		/** Schnellwahl „Farbe“ im Menü für Ordner (`null` = Standard) */
		oncolor?: (nodes: FileNode[], color: string | null) => void;
	} = $props();

	// ---------- Umgebung (Touch / schmale Ansicht) ----------

	let isCoarse = $state(false);
	let isNarrow = $state(false);

	onMount(() => {
		const coarse = window.matchMedia('(pointer: coarse)');
		const narrow = window.matchMedia('(max-width: 639px)');
		const update = () => {
			isCoarse = coarse.matches;
			isNarrow = narrow.matches;
		};
		update();
		coarse.addEventListener('change', update);
		narrow.addEventListener('change', update);
		return () => {
			coarse.removeEventListener('change', update);
			narrow.removeEventListener('change', update);
		};
	});

	// ---------- Auswahl ----------

	const selectedSet = $derived(new Set(selected));
	const selectedNodes = $derived(items.filter((n) => selectedSet.has(n.id)));
	const allSelected = $derived(items.length > 0 && selectedNodes.length === items.length);
	const someSelected = $derived(selectedNodes.length > 0 && !allSelected);

	/** Ausgangspunkt für Shift-Bereiche */
	let anchorId = $state<string | null>(null);
	/** Eintrag mit Tastaturfokus (Roving-Tabindex) */
	let focusId = $state<string | null>(null);
	const activeId = $derived(
		focusId && items.some((n) => n.id === focusId) ? focusId : (items[0]?.id ?? null)
	);

	function setSelected(id: string, on: boolean) {
		if (on) {
			if (!selectedSet.has(id)) selected = [...selected, id];
		} else if (selectedSet.has(id)) {
			selected = selected.filter((s) => s !== id);
		}
		anchorId = id;
	}

	function toggleAll(on: boolean) {
		selected = on ? items.map((n) => n.id) : [];
	}

	function rangeIds(fromId: string, toId: string): string[] {
		const a = items.findIndex((n) => n.id === fromId);
		const b = items.findIndex((n) => n.id === toId);
		if (a < 0 || b < 0) return [toId];
		const [lo, hi] = a <= b ? [a, b] : [b, a];
		return items.slice(lo, hi + 1).map((n) => n.id);
	}

	/** Auswahl per Klick/Tastatur: einfach, additiv (Strg/⌘) oder Bereich (Shift) */
	function selectWith(node: FileNode, mods: { additive: boolean; range: boolean }) {
		if (mods.range && anchorId) {
			const range = rangeIds(anchorId, node.id);
			selected = mods.additive ? [...new Set([...selected, ...range])] : range;
			return; // Anker bleibt
		}
		if (mods.additive) {
			setSelected(node.id, !selectedSet.has(node.id));
			return;
		}
		selected = [node.id];
		anchorId = node.id;
	}

	function onItemClick(e: MouseEvent, node: FileNode) {
		// Loslassen nach einem Long-Press soll den Eintrag nicht zusätzlich öffnen
		if (ctxOpen) return;
		focusId = node.id;
		if (isCoarse) {
			onopen(node);
			return;
		}
		selectWith(node, { additive: e.ctrlKey || e.metaKey, range: e.shiftKey });
	}

	function onItemDblClick(node: FileNode) {
		if (isCoarse) return; // Tap öffnet bereits
		onopen(node);
	}

	// ---------- Menü (gemeinsame Aktionsliste für „…“-Menü und Kontextmenü) ----------

	interface MenuEntry {
		key: string;
		label: string;
		icon: Component;
		run: () => void;
		destructive?: boolean;
		/** Trennlinie davor */
		separator?: boolean;
		/** Untermenü mit Vorschlagsfarben für diese Ordner */
		colors?: FileNode[];
	}

	let menuOpenId = $state<string | null>(null);

	function run(action: NodeAction, nodes: FileNode[]) {
		menuOpenId = null;
		ctxOpen = false;
		if (nodes.length) onaction(action, nodes);
	}

	/**
	 * Aktionen für einen oder mehrere Einträge: Öffnen/Umbenennen/Freigeben/Link/Details nur bei genau einem,
	 * Herunterladen nur bei genau einer Datei, Verschieben/Papierkorb für alle mit Bearbeiten-Zugriff.
	 */
	function actionsFor(nodes: FileNode[]): MenuEntry[] {
		const one = nodes.length === 1 ? nodes[0]! : null;
		const editable = nodes.filter((n) => n.access === 'edit');
		const entries: MenuEntry[] = [];
		const add = (action: NodeAction, label: string, icon: Component, targets: FileNode[]) =>
			entries.push({ key: action, label, icon, run: () => run(action, targets) });
		if (one) add('open', 'Öffnen', FolderOpen, [one]);
		if (one?.kind === 'file') add('download', 'Herunterladen', Download, [one]);
		if (one?.access === 'edit') add('rename', 'Umbenennen', Pencil, [one]);
		// Aussehen nur für Ordner mit Bearbeiten-Zugriff (Farbe auch für mehrere auf einmal)
		const styleable = editable.filter((n) => n.kind === 'folder');
		if (styleable.length && styleable.length === nodes.length) {
			if (oncolor) {
				entries.push({
					key: 'color',
					label: 'Farbe',
					icon: Palette,
					run: () => {},
					colors: styleable
				});
			}
			if (one) add('style', 'Aussehen ändern …', Shapes, [one]);
		}
		if (editable.length) add('move', 'Verschieben', FolderInput, editable);
		// Freigaben/Links nur bereichsberechtigt (Bearbeiten über eine Freigabe reicht nicht)
		if (one?.canShare) {
			add('share', 'Freigeben', Share2, [one]);
			if (canLink) add('link', 'Öffentlicher Link', Link, [one]);
		}
		if (one) add('info', 'Details', Info, [one]);
		if (editable.length) {
			entries.push({
				key: 'trash',
				label: 'In den Papierkorb',
				icon: Trash2,
				run: () => run('trash', editable),
				destructive: true,
				separator: entries.length > 0
			});
		}
		return entries;
	}

	function backgroundActions(): MenuEntry[] {
		if (!canCreate || !onbackground) return [];
		const bg = (action: BackgroundAction) => () => {
			ctxOpen = false;
			onbackground?.(action);
		};
		return [
			{ key: 'new-folder', label: 'Neuer Ordner', icon: FolderPlus, run: bg('new-folder') },
			{ key: 'upload-files', label: 'Dateien hochladen', icon: Upload, run: bg('upload-files') },
			{ key: 'upload-folder', label: 'Ordner hochladen', icon: FolderUp, run: bg('upload-folder') }
		];
	}

	// ---------- Kontextmenü (Rechtsklick / Long-Press) ----------

	let ctxOpen = $state(false);
	/** Ziel des nächsten Öffnens: Eintrag-ID oder `null` = leere Fläche */
	let ctxPending: string | null = null;
	let ctxTitle = $state<string | null>(null);
	let ctxEntries = $state<MenuEntry[]>([]);

	function nodeIdAt(target: EventTarget | null): string | null {
		const el = target instanceof Element ? target.closest('[data-node-id]') : null;
		const id = el?.getAttribute('data-node-id') ?? null;
		return id && items.some((n) => n.id === id) ? id : null;
	}

	/** Rechtsklick (läuft vor bits-ui; `preventDefault` verhindert das Öffnen) */
	function onCtxMenu(e: MouseEvent) {
		ctxPending = nodeIdAt(e.target);
		if (ctxPending === null && backgroundActions().length === 0) {
			e.preventDefault(); // kein leeres Menü
			return;
		}
		if (ctxOpen) onCtxOpenChange(true); // schon offen: Inhalt für das neue Ziel
	}

	/** Touch/Stift: bits-ui öffnet nach einem Long-Press ohne `contextmenu`-Ereignis – Ziel vorab merken */
	function onCtxPointerDown(e: PointerEvent) {
		if (e.pointerType !== 'mouse') ctxPending = nodeIdAt(e.target);
	}

	function onCtxOpenChange(open: boolean) {
		if (!open) return;
		const id = ctxPending;
		const node = id ? items.find((n) => n.id === id) : undefined;
		if (!node) {
			const bg = backgroundActions();
			if (bg.length === 0) {
				ctxOpen = false;
				return;
			}
			ctxTitle = null;
			ctxEntries = bg;
			return;
		}
		// Rechtsklick auf einen nicht markierten Eintrag markiert nur ihn; sonst gilt die ganze Auswahl
		let targets: FileNode[];
		if (selectedSet.has(node.id)) {
			targets = selectedNodes;
		} else {
			selected = [node.id];
			anchorId = node.id;
			targets = [node];
		}
		focusId = node.id;
		menuOpenId = null;
		ctxTitle = targets.length > 1 ? `${targets.length} Einträge ausgewählt` : null;
		ctxEntries = actionsFor(targets);
	}

	/** Klick auf freie Fläche hebt die Auswahl auf */
	function onBackgroundClick(e: MouseEvent) {
		if (e.ctrlKey || e.metaKey || e.shiftKey) return;
		if (e.target === e.currentTarget || e.target === container) selected = [];
	}

	// ---------- Tastatur ----------

	let container = $state<HTMLElement | null>(null);

	function itemElements(): HTMLElement[] {
		return container ? [...container.querySelectorAll<HTMLElement>('[data-node-item]')] : [];
	}

	/** Spaltenzahl im Raster (Einträge in der ersten Zeile) */
	function gridColumns(els: HTMLElement[]): number {
		if (view !== 'grid' || els.length === 0) return 1;
		const top = els[0]!.offsetTop;
		let cols = 0;
		for (const el of els) {
			if (el.offsetTop !== top) break;
			cols++;
		}
		return Math.max(1, cols);
	}

	function focusIndex(index: number) {
		const els = itemElements();
		const el = els[index];
		const node = items[index];
		if (!el || !node) return;
		focusId = node.id;
		el.focus();
		el.scrollIntoView({ block: 'nearest' });
	}

	function onItemKeydown(e: KeyboardEvent, node: FileNode) {
		const self = e.target === e.currentTarget;
		const index = items.findIndex((n) => n.id === node.id);

		if (e.key === 'F2') {
			if (node.access === 'edit') {
				e.preventDefault();
				run('rename', [node]);
			}
			return;
		}
		if (e.key === 'Delete') {
			const base = selectedSet.has(node.id) ? selectedNodes : [node];
			const editable = base.filter((n) => n.access === 'edit');
			if (editable.length) {
				e.preventDefault();
				run('trash', editable);
			}
			return;
		}
		if (!self) return; // Checkbox/Menü-Knopf behalten ihr eigenes Verhalten

		if (e.key === 'Enter') {
			e.preventDefault();
			onopen(node);
		} else if (e.key === ' ') {
			e.preventDefault();
			if (e.shiftKey && anchorId)
				selectWith(node, { additive: e.ctrlKey || e.metaKey, range: true });
			else setSelected(node.id, !selectedSet.has(node.id));
		} else if (e.key === 'Escape') {
			if (selected.length) {
				e.preventDefault();
				selected = [];
			}
		} else if ((e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey)) {
			e.preventDefault();
			toggleAll(true);
		} else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
			e.preventDefault();
			menuOpenId = node.id;
		} else if (['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
			const els = itemElements();
			const cols = gridColumns(els);
			let next: number;
			if (e.key === 'Home') next = 0;
			else if (e.key === 'End') next = items.length - 1;
			else if (view === 'grid' && e.key === 'ArrowRight') next = index + 1;
			else if (view === 'grid' && e.key === 'ArrowLeft') next = index - 1;
			else if (e.key === 'ArrowDown') next = index + cols;
			else if (e.key === 'ArrowUp') next = index - cols;
			else return;
			next = Math.min(items.length - 1, Math.max(0, next));
			e.preventDefault();
			if (next === index) return;
			const target = items[next]!;
			if (e.shiftKey) selectWith(target, { additive: false, range: true });
			else if (!(e.ctrlKey || e.metaKey)) {
				selected = [target.id];
				anchorId = target.id;
			}
			focusIndex(next);
		}
	}

	// ---------- Drag & Drop (Verschieben) ----------

	/** Gerade gezogene IDs (nur aus dieser Liste; `getData` ist in `dragover` nicht lesbar) */
	let dragIds = $state<string[] | null>(null);
	let dropTargetId = $state<string | null>(null);

	function canDrag(node: FileNode): boolean {
		return canEdit && node.access === 'edit' && !isCoarse;
	}

	function onDragStart(e: DragEvent, node: FileNode) {
		if (!e.dataTransfer || !canDrag(node)) return;
		const ids = selectedSet.has(node.id)
			? selectedNodes.filter((n) => n.access === 'edit').map((n) => n.id)
			: [node.id];
		dragIds = ids;
		e.dataTransfer.setData(DRAG_MIME, JSON.stringify(ids));
		e.dataTransfer.effectAllowed = 'move';
		if (ids.length > 1) {
			const ghost = document.createElement('div');
			ghost.className =
				'fixed -top-96 left-0 rounded-md bg-primary px-2.5 py-1 text-sm font-medium text-primary-foreground shadow';
			ghost.textContent = `${ids.length} Einträge`;
			document.body.appendChild(ghost);
			e.dataTransfer.setDragImage(ghost, 12, 12);
			setTimeout(() => ghost.remove(), 0);
		}
	}

	function onDragEnd() {
		dragIds = null;
		dropTargetId = null;
	}

	function isDropTarget(node: FileNode): boolean {
		return (
			node.kind === 'folder' && node.access === 'edit' && !(dragIds?.includes(node.id) ?? false)
		);
	}

	function onDragOver(e: DragEvent, node: FileNode) {
		const types = e.dataTransfer?.types ?? [];
		if (!types.includes(DRAG_MIME) || !isDropTarget(node)) return; // externe Dateien: UploadDropzone
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
		dropTargetId = node.id;
	}

	function onDragLeave(e: DragEvent, node: FileNode) {
		const el = e.currentTarget as HTMLElement;
		if (e.relatedTarget instanceof Node && el.contains(e.relatedTarget)) return;
		if (dropTargetId === node.id) dropTargetId = null;
	}

	function onDrop(e: DragEvent, node: FileNode) {
		const raw = e.dataTransfer?.getData(DRAG_MIME);
		if (!raw || !isDropTarget(node)) return;
		e.preventDefault();
		e.stopPropagation();
		dropTargetId = null;
		dragIds = null;
		let ids: string[] = [];
		try {
			const parsed: unknown = JSON.parse(raw);
			if (Array.isArray(parsed)) ids = parsed.filter((v): v is string => typeof v === 'string');
		} catch {
			return;
		}
		ids = ids.filter((id) => id !== node.id);
		if (ids.length) onmove(ids, node.id);
	}

	// ---------- Darstellung ----------

	/** Vorschaubilder, die nicht geladen werden konnten */
	const failedThumbs = new SvelteSet<string>();

	function watchThumb(img: HTMLImageElement) {
		const fail = () => {
			const src = img.getAttribute('src');
			if (src) failedThumbs.add(src);
		};
		img.addEventListener('error', fail);
		if (img.complete && img.naturalWidth === 0) fail();
		return { destroy: () => img.removeEventListener('error', fail) };
	}

	function thumbOf(node: FileNode): string | null {
		const url = node.kind === 'file' ? thumbUrl(node) : null;
		return url && !failedThumbs.has(url) ? url : null;
	}

	function entriesText(count: number | null): string {
		const n = count ?? 0;
		if (n === 0) return 'Leer';
		return n === 1 ? '1 Eintrag' : `${n} Einträge`;
	}

	function sizeText(node: FileNode): string {
		return node.kind === 'folder' ? entriesText(node.childCount) : formatBytes(node.sizeBytes);
	}

	function pickColor(nodes: FileNode[], color: string | null) {
		menuOpenId = null;
		ctxOpen = false;
		oncolor?.(nodes, color);
	}

	/** Getönte Vorschaufläche eines farbigen Ordners */
	function tint(node: FileNode): string | undefined {
		return node.kind === 'folder' && node.color
			? `color-mix(in srgb, ${node.color} 12%, transparent)`
			: undefined;
	}

	function kindText(node: FileNode): string {
		return node.kind === 'folder' ? 'Ordner' : 'Datei';
	}
</script>

{#snippet badges(node: FileNode)}
	{#if node.stamm}
		<span class="inline-flex text-muted-foreground" title="Mit dem ganzen Stamm geteilt">
			<Users class="size-3.5" aria-hidden="true" />
			<span class="sr-only">Mit dem ganzen Stamm geteilt</span>
		</span>
	{:else if node.shared}
		<span class="inline-flex text-muted-foreground" title="Freigegeben">
			<Share2 class="size-3.5" aria-hidden="true" />
			<span class="sr-only">Freigegeben</span>
		</span>
	{/if}
	{#if node.linked}
		<span class="inline-flex text-muted-foreground" title="Öffentlicher Link aktiv">
			<Link class="size-3.5" aria-hidden="true" />
			<span class="sr-only">Öffentlicher Link aktiv</span>
		</span>
	{/if}
	{#if node.viaLink}
		{@const via = node.uploadedByName
			? `Über Link hochgeladen von „${node.uploadedByName}“ (eigene Angabe)`
			: 'Über Link hochgeladen'}
		<span class="inline-flex text-muted-foreground" title={via}>
			<Upload class="size-3.5" aria-hidden="true" />
			<span class="sr-only">{via}</span>
		</span>
	{/if}
{/snippet}

<!-- „von …“ bei fremden Einträgen -->
{#snippet ownerBadge(node: FileNode, extra: string)}
	{#if !node.own}
		<span
			class={[
				'inline-flex max-w-full min-w-0 items-center rounded bg-muted px-1.5 py-px text-xs text-muted-foreground',
				extra
			]}
			title={`Gehört ${node.owner.name}`}
		>
			<span class="truncate">von {node.owner.name}</span>
		</span>
	{/if}
{/snippet}

{#snippet swatch(color: string | null)}
	<span
		class={[
			'size-3.5 shrink-0 rounded-full border',
			color ? 'border-transparent' : 'border-muted-foreground/50 bg-background'
		]}
		style:background-color={color ?? undefined}
		aria-hidden="true"
	></span>
{/snippet}

{#snippet dropdownEntries(entries: MenuEntry[])}
	{#each entries as entry (entry.key)}
		{@const Icon = entry.icon}
		{#if entry.separator}<DropdownMenu.Separator />{/if}
		{#if entry.colors}
			{@const targets = entry.colors}
			{@const current = targets.length === 1 ? targets[0]!.color : undefined}
			<DropdownMenu.Sub>
				<DropdownMenu.SubTrigger>
					<Icon />
					{entry.label}
				</DropdownMenu.SubTrigger>
				<DropdownMenu.SubContent class="w-44">
					{#each FOLDER_COLORS as c (c.value)}
						<DropdownMenu.Item onclick={() => pickColor(targets, c.value)}>
							{@render swatch(c.value)}
							{c.label}
							{#if current === c.value}<span class="sr-only">(aktuell)</span>{/if}
						</DropdownMenu.Item>
					{/each}
					<DropdownMenu.Separator />
					<DropdownMenu.Item onclick={() => pickColor(targets, null)}>
						{@render swatch(null)}
						Keine Farbe
					</DropdownMenu.Item>
				</DropdownMenu.SubContent>
			</DropdownMenu.Sub>
		{:else}
			<DropdownMenu.Item
				variant={entry.destructive ? 'destructive' : 'default'}
				onclick={entry.run}
			>
				<Icon />
				{entry.label}
			</DropdownMenu.Item>
		{/if}
	{/each}
{/snippet}

{#snippet contextEntries(entries: MenuEntry[])}
	{#each entries as entry (entry.key)}
		{@const Icon = entry.icon}
		{#if entry.separator}<ContextMenu.Separator />{/if}
		{#if entry.colors}
			{@const targets = entry.colors}
			{@const current = targets.length === 1 ? targets[0]!.color : undefined}
			<ContextMenu.Sub>
				<ContextMenu.SubTrigger>
					<Icon />
					{entry.label}
				</ContextMenu.SubTrigger>
				<ContextMenu.SubContent class="w-44">
					{#each FOLDER_COLORS as c (c.value)}
						<ContextMenu.Item onclick={() => pickColor(targets, c.value)}>
							{@render swatch(c.value)}
							{c.label}
							{#if current === c.value}<span class="sr-only">(aktuell)</span>{/if}
						</ContextMenu.Item>
					{/each}
					<ContextMenu.Separator />
					<ContextMenu.Item onclick={() => pickColor(targets, null)}>
						{@render swatch(null)}
						Keine Farbe
					</ContextMenu.Item>
				</ContextMenu.SubContent>
			</ContextMenu.Sub>
		{:else}
			<ContextMenu.Item variant={entry.destructive ? 'destructive' : 'default'} onclick={entry.run}>
				<Icon />
				{entry.label}
			</ContextMenu.Item>
		{/if}
	{/each}
{/snippet}

{#snippet menu(node: FileNode, triggerClass: string, tabbable: boolean)}
	<DropdownMenu.Root
		bind:open={() => menuOpenId === node.id, (v) => (menuOpenId = v ? node.id : null)}
	>
		<DropdownMenu.Trigger>
			{#snippet child({ props })}
				<Button
					{...props}
					variant="ghost"
					size="icon-sm"
					class={triggerClass}
					tabindex={tabbable ? 0 : -1}
					aria-label={`Aktionen für ${node.name}`}
				>
					<Ellipsis />
				</Button>
			{/snippet}
		</DropdownMenu.Trigger>
		<DropdownMenu.Content align="end" class="w-52">
			{@render dropdownEntries(actionsFor([node]))}
		</DropdownMenu.Content>
	</DropdownMenu.Root>
{/snippet}

{#snippet selectBox(node: FileNode, extra: string)}
	<!-- Klicks auf die Checkbox nicht als Kachel-/Zeilenklick werten -->
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div class={extra} onclick={(e) => e.stopPropagation()} ondblclick={(e) => e.stopPropagation()}>
		<Checkbox
			bind:checked={() => selectedSet.has(node.id), (v) => setSelected(node.id, v)}
			tabindex={-1}
			aria-label={`${node.name} auswählen`}
		/>
	</div>
{/snippet}

<ContextMenu.Root bind:open={ctxOpen} onOpenChange={onCtxOpenChange}>
	<ContextMenu.Trigger
		oncontextmenu={onCtxMenu}
		onpointerdown={onCtxPointerDown}
		onclick={onBackgroundClick}
	>
		{#snippet child({ props })}
			<!-- Fläche für das Kontextmenü (auch leerer Bereich unter der Liste) -->
			<div {...props} class="min-h-64 pb-6 [-webkit-touch-callout:none]">
				{#if view === 'grid'}
					{#if loading && items.length === 0}
						<div
							class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6"
							aria-busy="true"
							aria-label="Lade Dateien"
						>
							{#each Array.from({ length: 12 }, (_, i) => i) as i (i)}
								<div class="space-y-2 rounded-lg border p-2">
									<Skeleton class="aspect-[4/3] w-full" />
									<Skeleton class="h-4 w-3/4" />
									<Skeleton class="h-3 w-1/2" />
								</div>
							{/each}
						</div>
					{:else if items.length === 0}
						<EmptyState title={emptyTitle} description={emptyDescription}>
							{#if emptyAction}{@render emptyAction()}{/if}
						</EmptyState>
					{:else}
						<div
							bind:this={container}
							role="listbox"
							tabindex="-1"
							aria-multiselectable="true"
							aria-label="Dateien und Ordner"
							aria-busy={loading}
							class="grid grid-cols-2 gap-3 transition-opacity select-none sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6"
							class:opacity-60={loading}
						>
							{#each items as node (node.id)}
								{@const thumb = thumbOf(node)}
								{@const isPdfThumb = !!thumb && previewKind(node.contentType) === 'pdf'}
								{@const isSel = selectedSet.has(node.id)}
								{@const isActive = node.id === activeId}
								<div
									data-node-item
									role="option"
									aria-selected={isSel}
									aria-label={`${node.name}, ${kindText(node)}`}
									tabindex={isActive ? 0 : -1}
									draggable={canDrag(node) ? 'true' : undefined}
									class={[
										'group relative flex min-w-0 cursor-default flex-col overflow-hidden rounded-lg border bg-card text-left transition-colors outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
										isSel && 'border-primary bg-primary/5 hover:bg-primary/10',
										dropTargetId === node.id && 'ring-2 ring-primary',
										dragIds?.includes(node.id) && 'opacity-50'
									]}
									onclick={(e) => onItemClick(e, node)}
									ondblclick={() => onItemDblClick(node)}
									data-node-id={node.id}
									onkeydown={(e) => onItemKeydown(e, node)}
									onfocus={() => (focusId = node.id)}
									ondragstart={(e) => onDragStart(e, node)}
									ondragend={onDragEnd}
									ondragover={(e) => onDragOver(e, node)}
									ondragleave={(e) => onDragLeave(e, node)}
									ondrop={(e) => onDrop(e, node)}
								>
									<div
										class={[
											'relative flex aspect-[4/3] justify-center overflow-hidden',
											isPdfThumb ? 'items-start px-[12%] pt-3' : 'items-center',
											node.kind === 'file' && !(thumb && !isPdfThumb)
												? fileTint(node.contentType, node.name)
												: 'bg-muted/50'
										]}
										style:background-color={tint(node)}
									>
										{#if thumb}
											<img
												src={thumb}
												alt=""
												loading="lazy"
												draggable="false"
												class={isPdfThumb
													? 'h-full w-full rounded-t-sm object-cover object-top shadow-sm ring-1 ring-border'
													: 'size-full object-cover'}
												use:watchThumb
											/>
											{#if isPdfThumb}
												<span
													class="absolute right-1.5 bottom-1.5 rounded border border-current/25 bg-card px-1.5 py-px text-xs leading-4 font-semibold tracking-wide text-file-pdf"
													aria-hidden="true"
												>
													PDF
												</span>
											{/if}
										{:else if node.kind === 'folder'}
											<FolderGlyph icon={node.icon} color={node.color} />
										{:else}
											<FileTypeGlyph contentType={node.contentType} name={node.name} />
										{/if}
										{@render selectBox(
											node,
											[
												'absolute top-1.5 left-1.5 flex rounded-md bg-background/90 p-1 shadow-sm transition-opacity',
												isSel || selected.length > 0 || isCoarse
													? 'opacity-100'
													: 'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100'
											].join(' ')
										)}
										<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
										<div
											class="absolute top-1.5 right-1.5"
											onclick={(e) => e.stopPropagation()}
											ondblclick={(e) => e.stopPropagation()}
										>
											{@render menu(
												node,
												'bg-background/90 shadow-sm hover:bg-background',
												isActive
											)}
										</div>
									</div>
									<div class="flex min-w-0 flex-1 flex-col gap-0.5 px-2.5 pt-2 pb-2.5">
										<!-- feste Höhe für zwei Zeilen: alle Karten einer Reihe bleiben gleich gegliedert -->
										<span
											class="line-clamp-2 h-10 text-sm leading-5 font-medium break-words"
											title={node.name}
										>
											{#each breakableName(node.name) as part, i (i)}{part}<wbr />{/each}
										</span>
										<span class="flex items-center gap-1.5 text-xs text-muted-foreground">
											<span class="truncate tabular-nums">
												{node.kind === 'folder'
													? folderMeta(node)
													: `${formatBytes(node.sizeBytes)} · ${formatDateTime(node.updatedAt)}`}
											</span>
											<span class="ml-auto flex shrink-0 items-center gap-1"
												>{@render badges(node)}</span
											>
										</span>
										{@render ownerBadge(node, 'mt-0.5 self-start')}
										{#if isSel}<span class="sr-only">ausgewählt</span>{/if}
									</div>
								</div>
							{/each}
						</div>
					{/if}
				{:else}
					{#snippet mobileToolbar()}
						<label class="flex items-center gap-2 text-sm">
							<Checkbox
								checked={allSelected}
								indeterminate={someSelected}
								onCheckedChange={(v) => toggleAll(v)}
							/>
							Alle auswählen
						</label>
						{#if selected.length}
							<span class="text-xs text-muted-foreground">{selected.length} ausgewählt</span>
						{/if}
					{/snippet}
					<div bind:this={container} class="select-none">
						<DataTable
							caption="Dateien und Ordner"
							mobile="cards"
							{loading}
							empty={items.length === 0}
							{emptyTitle}
							{emptyDescription}
							{emptyAction}
							skeletonRows={6}
							toolbar={isNarrow && items.length > 0 ? mobileToolbar : undefined}
						>
							{#snippet head()}
								<Table.Row>
									<Table.Head class="w-10">
										<Checkbox
											checked={allSelected}
											indeterminate={someSelected}
											onCheckedChange={(v) => toggleAll(v)}
											aria-label="Alle auswählen"
										/>
									</Table.Head>
									<Table.Head>Name</Table.Head>
									<Table.Head>Geändert</Table.Head>
									<Table.Head class="text-right">Größe</Table.Head>
									<Table.Head class="w-10"><span class="sr-only">Aktionen</span></Table.Head>
								</Table.Row>
							{/snippet}
							{#each items as node (node.id)}
								{@const thumb = thumbOf(node)}
								{@const isSel = selectedSet.has(node.id)}
								{@const isActive = node.id === activeId}
								<Table.Row
									data-node-item
									data-state={isSel ? 'selected' : undefined}
									tabindex={isActive ? 0 : -1}
									aria-label={`${node.name}, ${kindText(node)}${isSel ? ', ausgewählt' : ''}`}
									draggable={canDrag(node) ? 'true' : undefined}
									class={[
										'cursor-default outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
										dropTargetId === node.id && 'ring-2 ring-primary ring-inset',
										dragIds?.includes(node.id) && 'opacity-50'
									]}
									onclick={(e: MouseEvent) => onItemClick(e, node)}
									ondblclick={() => onItemDblClick(node)}
									data-node-id={node.id}
									onkeydown={(e: KeyboardEvent) => onItemKeydown(e, node)}
									onfocus={() => (focusId = node.id)}
									ondragstart={(e: DragEvent) => onDragStart(e, node)}
									ondragend={onDragEnd}
									ondragover={(e: DragEvent) => onDragOver(e, node)}
									ondragleave={(e: DragEvent) => onDragLeave(e, node)}
									ondrop={(e: DragEvent) => onDrop(e, node)}
								>
									<Table.Cell class="w-10">
										{@render selectBox(node, 'flex')}
									</Table.Cell>
									<Table.Cell class="max-w-0 min-w-40 sm:w-full">
										<span class="flex min-w-0 items-center gap-2">
											<span
												class={[
													'flex size-8 shrink-0 items-center justify-center overflow-hidden rounded',
													node.kind === 'file' && !thumb
														? fileTint(node.contentType, node.name)
														: 'bg-muted/50'
												]}
											>
												{#if thumb}
													<img
														src={thumb}
														alt=""
														loading="lazy"
														draggable="false"
														class="size-full object-cover"
														use:watchThumb
													/>
												{:else if node.kind === 'folder'}
													<FolderGlyph icon={node.icon} color={node.color} size="sm" />
												{:else}
													<FileTypeGlyph
														contentType={node.contentType}
														name={node.name}
														size="sm"
													/>
												{/if}
											</span>
											<span class="truncate font-medium" title={node.name}>{node.name}</span>
											<span class="flex shrink-0 items-center gap-1">{@render badges(node)}</span>
											{@render ownerBadge(node, 'shrink')}
										</span>
									</Table.Cell>
									<Table.Cell class="whitespace-nowrap text-muted-foreground tabular-nums">
										{formatDateTime(node.updatedAt)}
									</Table.Cell>
									<Table.Cell class="text-right whitespace-nowrap tabular-nums">
										{sizeText(node)}
									</Table.Cell>
									<Table.Cell
										class="w-10 text-right"
										onclick={(e: MouseEvent) => e.stopPropagation()}
										ondblclick={(e: MouseEvent) => e.stopPropagation()}
									>
										{@render menu(node, '', isActive)}
									</Table.Cell>
								</Table.Row>
							{/each}
						</DataTable>
					</div>
				{/if}
			</div>
		{/snippet}
	</ContextMenu.Trigger>
	<ContextMenu.Content class="w-56">
		{#if ctxTitle}
			<ContextMenu.Label>{ctxTitle}</ContextMenu.Label>
			<ContextMenu.Separator />
		{/if}
		{#if ctxEntries.length}
			{@render contextEntries(ctxEntries)}
		{:else}
			<ContextMenu.Label>Keine Aktionen verfügbar</ContextMenu.Label>
		{/if}
	</ContextMenu.Content>
</ContextMenu.Root>
