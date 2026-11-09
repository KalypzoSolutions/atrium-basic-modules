<script lang="ts">
	// VERTRAG (Welle 0) – Props nicht ändern; Implementierung: Welle 3.3.
	import { onDestroy, type Snippet } from 'svelte';
	import { beforeNavigate } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import Ban from '@lucide/svelte/icons/ban';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronUp from '@lucide/svelte/icons/chevron-up';
	import CircleAlert from '@lucide/svelte/icons/circle-alert';
	import CircleCheck from '@lucide/svelte/icons/circle-check';
	import Clock from '@lucide/svelte/icons/clock';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import Upload from '@lucide/svelte/icons/upload';
	import X from '@lucide/svelte/icons/x';
	import { Button } from '$lib/components/ui/button';
	import { ROOT_LABEL, UPLOAD_CONCURRENCY, type FilesMeta } from '../schemas';
	import { RAW_API } from './helpers';
	import {
		STATUS_LABELS,
		collectEntries,
		fromFileList,
		makeItems,
		pendingBytes,
		precheck,
		queueProgress,
		sizeText,
		summaryToast,
		uploadError,
		xhrUpload,
		type EntryLike,
		type QueueInput,
		type UploadItem
	} from './upload-queue';

	let {
		parentId,
		disabled = false,
		meta,
		onuploaded,
		children
	}: {
		/** Zielordner (`null` = eigene Wurzel) */
		parentId: string | null;
		/** Kein Bearbeiten-Recht: Ablegen zeigt einen Hinweis statt hochzuladen */
		disabled?: boolean;
		/** Grenzen (Größe, Typen, Kontingent) für die Vorprüfung */
		meta: FilesMeta | null;
		/** Nach jeder fertigen Datei (gebündelt) – Liste neu laden */
		onuploaded: () => void;
		/** Die Ordneransicht; die ganze Fläche ist Ablageziel für Dateien und Ordner von außen */
		children: Snippet;
	} = $props();

	/** Dateiauswahl öffnen (Button „Hochladen“ im Seitenkopf) */
	export function openFilePicker(): void {
		if (disabled) {
			toast.error('Hier darfst du nichts hochladen');
			return;
		}
		fileInput?.click();
	}
	/** Ordnerauswahl öffnen (`webkitdirectory`) */
	export function openFolderPicker(): void {
		if (disabled) {
			toast.error('Hier darfst du nichts hochladen');
			return;
		}
		folderInput?.click();
	}

	/** Liste höchstens so oft neu laden (ms) */
	const REFRESH_MS = 800;

	let items = $state<UploadItem[]>([]);
	let panelOpen = $state(true);
	let dragDepth = $state(0);
	let fileInput = $state<HTMLInputElement | null>(null);
	let folderInput = $state<HTMLInputElement | null>(null);

	let active = 0;
	const aborts = new Map<string, AbortController>();
	let batch = { ok: 0, failed: 0, rejected: 0 };
	let refreshTimer: ReturnType<typeof setTimeout> | null = null;
	let lastRefresh = 0;
	let dirty = false;
	let destroyed = false;

	const progress = $derived(queueProgress(items));
	const percent = $derived(Math.round(progress.fraction * 100));
	const retryable = $derived(items.filter((i) => i.status === 'error' && !i.rejected));
	const dragging = $derived(dragDepth > 0);
	const targetLabel = $derived(parentId ? 'diesen Ordner' : `„${ROOT_LABEL}“`);
	const statusText = $derived.by(() => {
		if (!items.length) return '';
		const total = items.length;
		const finished = progress.done + progress.failed + progress.rejected;
		if (progress.busy) return `Lädt hoch … ${finished} von ${total}`;
		const bad = progress.failed + progress.rejected;
		if (bad) return `${progress.done} von ${total} hochgeladen, ${bad} mit Fehler`;
		return total === 1 ? '1 Datei hochgeladen' : `${total} Dateien hochgeladen`;
	});

	// ---------------------------------------------------------------- Einreihen

	function enqueue(inputs: QueueInput[]) {
		if (disabled || destroyed) return;
		if (!inputs.length) {
			toast.info('Keine Dateien gefunden (leere Ordner werden nicht hochgeladen)');
			return;
		}
		const wasBusy = progress.busy;
		// Kontingent nur in der eigenen Wurzel sicher bekannt; in (evtl. fremden) Ordnern prüft der Server
		const own = parentId === null;
		const checked = precheck(inputs, meta, {
			checkQuota: own,
			pendingBytes: own ? pendingBytes(items.filter((i) => i.parentId === null)) : 0
		});
		const added = makeItems(checked, { parentId });
		if (!wasBusy) batch = { ok: 0, failed: 0, rejected: 0 };
		batch.rejected += added.filter((i) => i.rejected).length;
		items = [...items, ...added];
		panelOpen = true;
		pump();
		// nur abgelehnte Dateien: es läuft nichts, Ergebnis sofort melden
		if (active === 0 && !items.some((i) => i.status === 'waiting')) finishBatch();
	}

	function pump() {
		while (active < UPLOAD_CONCURRENCY && !destroyed) {
			const next = items.find((i) => i.status === 'waiting');
			if (!next) break;
			next.status = 'uploading';
			next.progress = 0;
			next.message = '';
			active++;
			upload(next);
		}
	}

	function upload(item: UploadItem) {
		const controller = new AbortController();
		aborts.set(item.key, controller);
		const form = new FormData();
		if (item.relativePath) form.append('relativePath', item.relativePath);
		form.append('conflict', 'rename');
		form.append('file', item.file, item.file.name);

		const settle = (ok: boolean, status: number, body: unknown, aborted = false) => {
			aborts.delete(item.key);
			active = Math.max(0, active - 1);
			if (ok) {
				item.status = 'done';
				item.progress = 1;
				item.message = '';
				batch.ok++;
				dirty = true;
				scheduleRefresh();
			} else {
				const err = aborted
					? { message: 'Abgebrochen', rejected: false }
					: uploadError(status, body);
				item.status = 'error';
				item.message = err.message;
				item.rejected = err.rejected;
				if (err.rejected) batch.rejected++;
				else batch.failed++;
			}
			pump();
			if (active === 0 && !items.some((i) => i.status === 'waiting')) finishBatch();
		};

		void xhrUpload(
			`${RAW_API}/nodes/${item.parentId ?? 'root'}/upload`,
			form,
			(loaded, total) => (item.progress = Math.min(0.99, loaded / total)),
			controller.signal
		).then((r) => settle(r.status >= 200 && r.status < 300, r.status, r.body, r.aborted));
	}

	// ---------------------------------------------------------------- Neu laden (gebündelt)

	function scheduleRefresh() {
		if (refreshTimer || destroyed) return;
		const wait = Math.max(0, REFRESH_MS - (Date.now() - lastRefresh));
		refreshTimer = setTimeout(() => {
			refreshTimer = null;
			refreshNow();
		}, wait);
	}

	function refreshNow() {
		if (refreshTimer) clearTimeout(refreshTimer);
		refreshTimer = null;
		if (!dirty || destroyed) return;
		dirty = false;
		lastRefresh = Date.now();
		onuploaded();
	}

	function finishBatch() {
		refreshNow();
		const result = summaryToast(batch);
		batch = { ok: 0, failed: 0, rejected: 0 };
		if (!result) return;
		if (result.kind === 'success') toast.success(result.message);
		else if (result.kind === 'warning') toast.warning(result.message);
		else toast.error(result.message);
	}

	// ---------------------------------------------------------------- Aktionen im Panel

	function retry(list: UploadItem[]) {
		if (!list.length) return;
		if (!progress.busy) batch = { ok: 0, failed: 0, rejected: 0 };
		for (const i of list) {
			i.status = 'waiting';
			i.progress = 0;
			i.message = '';
		}
		pump();
	}

	function cancelItem(item: UploadItem) {
		if (item.status === 'uploading') {
			aborts.get(item.key)?.abort();
		} else if (item.status === 'waiting') {
			item.status = 'error';
			item.message = 'Abgebrochen';
			batch.failed++;
			if (active === 0 && !items.some((i) => i.status === 'waiting')) finishBatch();
		}
	}

	function cancelAll() {
		for (const i of items) if (i.status === 'waiting') cancelItem(i);
		for (const c of [...aborts.values()]) c.abort();
	}

	function removeItem(key: string) {
		items = items.filter(
			(i) => i.key !== key || i.status === 'uploading' || i.status === 'waiting'
		);
	}

	function closePanel() {
		if (progress.busy) return;
		items = [];
	}

	// ---------------------------------------------------------------- Ablegen

	function isExternalFiles(e: DragEvent): boolean {
		// internes Verschieben (DRAG_MIME) bleibt unberührt – nur Dateien von außen
		return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
	}

	function onDragEnter(e: DragEvent) {
		if (!isExternalFiles(e)) return;
		e.preventDefault();
		dragDepth++;
	}
	function onDragOver(e: DragEvent) {
		if (!isExternalFiles(e)) return;
		e.preventDefault();
		e.dataTransfer!.dropEffect = disabled ? 'none' : 'copy';
		if (dragDepth === 0) dragDepth = 1;
	}
	function onDragLeave(e: DragEvent) {
		if (!isExternalFiles(e)) return;
		dragDepth = Math.max(0, dragDepth - 1);
	}
	function onDrop(e: DragEvent) {
		if (!isExternalFiles(e)) return;
		e.preventDefault();
		dragDepth = 0;
		if (disabled) {
			toast.error('Hier darfst du nichts hochladen');
			return;
		}
		const dt = e.dataTransfer!;
		// Einträge müssen synchron im Drop-Ereignis geholt werden
		const entries: EntryLike[] = [];
		const loose: File[] = [];
		const list = dt.items ? Array.from(dt.items).filter((i) => i.kind === 'file') : [];
		for (const it of list) {
			const entry =
				typeof it.webkitGetAsEntry === 'function'
					? (it.webkitGetAsEntry() as EntryLike | null)
					: null;
			if (entry) entries.push(entry);
			else {
				const f = it.getAsFile();
				if (f) loose.push(f);
			}
		}
		if (!entries.length && !loose.length) {
			enqueue(fromFileList(Array.from(dt.files)));
			return;
		}
		const looseInputs: QueueInput[] = loose.map((file) => ({ file, relativePath: null }));
		if (!entries.length) {
			enqueue(looseInputs);
			return;
		}
		void collectEntries<File>(entries)
			.then((found) => enqueue([...found, ...looseInputs]))
			.catch(() => toast.error('Ordner konnte nicht gelesen werden'));
	}

	function resetDrag() {
		dragDepth = 0;
	}

	function onPick(e: Event) {
		const el = e.currentTarget as HTMLInputElement;
		const files = el.files ? Array.from(el.files) : [];
		el.value = '';
		if (files.length) enqueue(fromFileList(files));
	}

	// ---------------------------------------------------------------- Verlassen

	beforeNavigate((nav) => {
		if (!progress.busy) return;
		if (nav.type === 'leave') {
			nav.cancel();
			return;
		}
		if (nav.to && nav.to.url.pathname === location.pathname) return;
		if (!confirm('Es werden noch Dateien hochgeladen. Seite trotzdem verlassen?')) nav.cancel();
	});

	onDestroy(() => {
		destroyed = true;
		if (refreshTimer) clearTimeout(refreshTimer);
		for (const c of [...aborts.values()]) c.abort();
	});
</script>

<svelte:window ondragend={resetDrag} ondrop={resetDrag} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="relative min-h-full"
	ondragenter={onDragEnter}
	ondragover={onDragOver}
	ondragleave={onDragLeave}
	ondrop={onDrop}
>
	{@render children()}

	{#if dragging}
		<div
			class={[
				'pointer-events-none absolute inset-0 z-30 flex justify-center rounded-lg border-2 border-dashed p-4',
				disabled ? 'border-destructive/60 bg-destructive/5' : 'border-primary bg-primary/5'
			]}
			aria-hidden="true"
		>
			<div
				class="sticky top-24 flex h-fit max-w-sm flex-col items-center gap-2 rounded-lg border bg-background px-6 py-4 text-center shadow-lg"
			>
				{#if disabled}
					<Ban class="size-8 text-destructive" />
					<p class="font-semibold">Hier darfst du nichts hochladen</p>
					<p class="text-xs text-muted-foreground">Dir fehlt das Recht zum Bearbeiten.</p>
				{:else}
					<Upload class="size-8 text-link" />
					<p class="font-semibold">Zum Hochladen loslassen</p>
					<p class="text-xs text-muted-foreground">Ziel: {targetLabel}</p>
				{/if}
			</div>
		</div>
	{/if}

	<input
		bind:this={fileInput}
		type="file"
		multiple
		class="sr-only"
		tabindex="-1"
		aria-hidden="true"
		{disabled}
		onchange={onPick}
	/>
	<input
		bind:this={folderInput}
		type="file"
		multiple
		webkitdirectory
		class="sr-only"
		tabindex="-1"
		aria-hidden="true"
		{disabled}
		onchange={onPick}
	/>
</div>

<p class="sr-only" aria-live="polite">{statusText}</p>

{#if items.length > 0}
	<section
		aria-label="Hochladen"
		class="fixed inset-x-0 bottom-0 z-40 rounded-t-lg border bg-background shadow-lg sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-96 sm:rounded-lg"
	>
		<div class="flex items-center gap-2 px-3 py-2">
			<div class="min-w-0 flex-1">
				<p class="truncate text-sm font-medium">{statusText}</p>
				{#if progress.totalBytes > 0}
					<p class="text-xs text-muted-foreground tabular-nums">
						{sizeText(progress.loadedBytes)} von {sizeText(progress.totalBytes)}
					</p>
				{/if}
			</div>
			<Button
				type="button"
				size="icon-sm"
				variant="ghost"
				aria-expanded={panelOpen}
				aria-controls="files-upload-list"
				aria-label={panelOpen ? 'Liste einklappen' : 'Liste aufklappen'}
				onclick={() => (panelOpen = !panelOpen)}
			>
				{#if panelOpen}<ChevronDown />{:else}<ChevronUp />{/if}
			</Button>
			{#if !progress.busy}
				<Button
					type="button"
					size="icon-sm"
					variant="ghost"
					aria-label="Schließen"
					onclick={closePanel}
				>
					<X />
				</Button>
			{/if}
		</div>
		<div
			class="mx-3 mb-2 h-1.5 overflow-hidden rounded-full bg-muted"
			role="progressbar"
			aria-label="Gesamtfortschritt"
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={percent}
		>
			<div
				class={[
					'h-full transition-all',
					!progress.busy && progress.failed + progress.rejected > 0 ? 'bg-warning' : 'bg-primary'
				]}
				style="width: {percent}%"
			></div>
		</div>

		{#if panelOpen}
			<ul
				id="files-upload-list"
				class="max-h-[40dvh] space-y-1 overflow-y-auto border-t px-2 py-2 sm:max-h-72"
				aria-label="Dateien in der Warteschlange"
			>
				{#each items as item (item.key)}
					<li class="flex min-h-9 items-center gap-2 rounded-md px-1 text-sm">
						{#if item.status === 'waiting'}
							<Clock class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
						{:else if item.status === 'uploading'}
							<LoaderCircle class="size-4 shrink-0 animate-spin text-link" aria-hidden="true" />
						{:else if item.status === 'done'}
							<CircleCheck class="size-4 shrink-0 text-success" aria-hidden="true" />
						{:else}
							<CircleAlert class="size-4 shrink-0 text-destructive" aria-hidden="true" />
						{/if}
						<div class="min-w-0 flex-1">
							<p class="truncate" title={item.name}>{item.name}</p>
							{#if item.status === 'uploading'}
								<div class="mt-1 h-1 overflow-hidden rounded-full bg-muted" aria-hidden="true">
									<div
										class="h-full bg-primary transition-all"
										style="width: {Math.round(item.progress * 100)}%"
									></div>
								</div>
							{:else if item.status === 'error'}
								<p class="text-xs text-destructive">{item.message}</p>
							{/if}
						</div>
						<span class="shrink-0 text-xs text-muted-foreground tabular-nums">
							<span class="hidden sm:inline">{sizeText(item.size)} · </span>
							{item.status === 'uploading'
								? `${Math.round(item.progress * 100)} %`
								: STATUS_LABELS[item.status]}
						</span>
						{#if item.status === 'uploading' || item.status === 'waiting'}
							<Button
								type="button"
								size="icon-sm"
								variant="ghost"
								aria-label="Hochladen von {item.name} abbrechen"
								onclick={() => cancelItem(item)}
							>
								<X />
							</Button>
						{:else if item.status === 'error' && !item.rejected}
							<Button
								type="button"
								size="icon-sm"
								variant="ghost"
								aria-label="{item.name} erneut hochladen"
								onclick={() => retry([item])}
							>
								<RotateCcw />
							</Button>
						{:else}
							<Button
								type="button"
								size="icon-sm"
								variant="ghost"
								aria-label="{item.name} aus der Liste entfernen"
								onclick={() => removeItem(item.key)}
							>
								<X />
							</Button>
						{/if}
					</li>
				{/each}
			</ul>
			<div class="flex flex-wrap justify-end gap-2 border-t px-3 py-2">
				{#if progress.busy}
					<Button type="button" size="sm" variant="outline" onclick={cancelAll}>
						Alle abbrechen
					</Button>
				{/if}
				{#if retryable.length > 0}
					<Button type="button" size="sm" variant="outline" onclick={() => retry(retryable)}>
						<RotateCcw /> Alle wiederholen
					</Button>
				{/if}
				{#if !progress.busy}
					<Button type="button" size="sm" variant="ghost" onclick={closePanel}>Schließen</Button>
				{/if}
			</div>
		{/if}
	</section>
{/if}
