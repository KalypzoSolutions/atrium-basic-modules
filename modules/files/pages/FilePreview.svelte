<script lang="ts">
	// VERTRAG (Welle 0) – Props nicht ändern; Implementierung: Welle 3.4.
	import ChevronLeftIcon from '@lucide/svelte/icons/chevron-left';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import ExternalLinkIcon from '@lucide/svelte/icons/external-link';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import ScanIcon from '@lucide/svelte/icons/scan';
	import XIcon from '@lucide/svelte/icons/x';
	import ZoomInIcon from '@lucide/svelte/icons/zoom-in';
	import ZoomOutIcon from '@lucide/svelte/icons/zoom-out';
	import type { Attachment } from 'svelte/attachments';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Button } from '$lib/components/ui/button';
	import { MAX_TEXT_PREVIEW_BYTES } from '../schemas';
	import { FILE_KIND_CLASSES, fileTypeOf } from './file-types';
	import {
		formatBytes,
		iconFor,
		internalUrl,
		previewKind,
		type ContentUrlFn,
		type PreviewNode
	} from './helpers';

	let {
		open = $bindable(false),
		nodes,
		current = $bindable(null),
		urlFor = internalUrl
	}: {
		open?: boolean;
		/** Dateien des Ordners (Blättern mit ←/→ über alle, die eine Vorschau haben oder nicht) */
		nodes: PreviewNode[];
		current?: PreviewNode | null;
		/** URLs für Inhalt/Download/Thumbnail (öffentliche Seite übergibt eigene) */
		urlFor?: ContentUrlFn;
	} = $props();

	const index = $derived(current ? nodes.findIndex((n) => n.id === current?.id) : -1);
	const kind = $derived(current ? previewKind(current.contentType) : null);
	/** Schlüssel des angezeigten Inhalts (neu laden bei anderer Datei oder neuer Version) */
	const nodeKey = $derived(current ? `${current.id}|${current.updatedAt}` : '');
	const typeLabel = $derived(current?.contentType?.split(';')[0]?.trim() || 'Unbekannter Typ');
	const FileIcon = $derived(iconFor('file', current?.contentType, current?.name));
	const fileColor = $derived(
		FILE_KIND_CLASSES[fileTypeOf(current?.contentType, current?.name).kind].text
	);
	const textTooLarge = $derived(
		kind === 'text' && (current?.sizeBytes ?? 0) > MAX_TEXT_PREVIEW_BYTES
	);

	let reloadKey = $state(0);

	// ---------- PDF / Text (per fetch) ----------
	type FetchState =
		| { status: 'idle' }
		| { status: 'loading' }
		| { status: 'error'; message: string }
		| { status: 'pdf'; url: string }
		| { status: 'text'; text: string };
	let fetched = $state.raw<FetchState>({ status: 'idle' });

	function statusMessage(status: number): string {
		if (status === 404) return 'Die Datei wurde nicht gefunden.';
		if (status === 403) return 'Du hast keinen Zugriff auf diese Datei.';
		if (status === 401) return 'Bitte melde dich erneut an.';
		if (status === 503) return 'Der Dateispeicher ist gerade nicht erreichbar.';
		return 'Die Vorschau konnte nicht geladen werden.';
	}

	async function readError(res: Response): Promise<string> {
		const body = (await res.json().catch(() => null)) as {
			error?: { message?: string };
		} | null;
		return body?.error?.message || statusMessage(res.status);
	}

	$effect(() => {
		const node = open ? current : null;
		const k = kind;
		const tooLarge = textTooLarge;
		void nodeKey;
		void reloadKey;
		if (!node || (k !== 'pdf' && k !== 'text') || (k === 'text' && tooLarge)) {
			fetched = { status: 'idle' };
			return;
		}
		const url = urlFor(node, {});
		const ctrl = new AbortController();
		let blobUrl: string | null = null;
		fetched = { status: 'loading' };
		void (async () => {
			try {
				const res = await fetch(url, { credentials: 'same-origin', signal: ctrl.signal });
				if (!res.ok) {
					const message = await readError(res);
					if (!ctrl.signal.aborted) fetched = { status: 'error', message };
					return;
				}
				if (k === 'pdf') {
					const buf = await res.arrayBuffer();
					if (ctrl.signal.aborted) return;
					// Typ fest setzen statt ihn vom Server zu übernehmen
					blobUrl = URL.createObjectURL(new Blob([buf], { type: 'application/pdf' }));
					fetched = { status: 'pdf', url: blobUrl };
				} else {
					const text = await res.text();
					if (!ctrl.signal.aborted) fetched = { status: 'text', text };
				}
			} catch {
				if (!ctrl.signal.aborted) {
					fetched = { status: 'error', message: 'Die Vorschau konnte nicht geladen werden.' };
				}
			}
		})();
		return () => {
			ctrl.abort();
			if (blobUrl) URL.revokeObjectURL(blobUrl);
		};
	});

	/** Kann der Browser PDFs eingebettet anzeigen? (mobil meist nicht) */
	const canEmbedPdf = $derived.by(() => {
		if (typeof navigator === 'undefined') return true;
		const nav = navigator as Navigator & { pdfViewerEnabled?: boolean };
		// Touch-Geräte: iOS zeigt im iframe nur die erste Seite, Android-Chrome nichts
		if (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) return false;
		return typeof nav.pdfViewerEnabled === 'boolean' ? nav.pdfViewerEnabled : true;
	});

	// ---------- Bild ----------
	let imgStatus = $state<{ key: string; status: 'loaded' | 'error' } | null>(null);
	const imageState = $derived(
		imgStatus && imgStatus.key === `${nodeKey}|${reloadKey}` ? imgStatus.status : 'loading'
	);

	const MIN_SCALE = 1;
	const MAX_SCALE = 8;
	let scale = $state(1);
	let tx = $state(0);
	let ty = $state(0);
	let dragging = $state(false);
	let drag: { id: number; x: number; y: number; tx: number; ty: number; moved: boolean } | null =
		null;

	function clampScale(s: number): number {
		return Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
	}
	function setScale(s: number) {
		scale = clampScale(s);
		if (scale === 1) {
			tx = 0;
			ty = 0;
		}
	}
	function fit() {
		scale = 1;
		tx = 0;
		ty = 0;
	}
	const zoomIn = () => setScale(scale * 1.5);
	const zoomOut = () => setScale(scale / 1.5);

	// Wechsel der Datei setzt den Zoom zurück
	let zoomKey = '';
	$effect(() => {
		const key = open ? nodeKey : '';
		if (key !== zoomKey) {
			zoomKey = key;
			fit();
		}
	});

	/** Strg + Mausrad zoomt (eigener Listener, damit `preventDefault` greift) */
	const wheelZoom: Attachment<HTMLElement> = (el) => {
		const onwheel = (e: WheelEvent) => {
			if (!e.ctrlKey && !e.metaKey) return;
			e.preventDefault();
			setScale(scale * Math.exp(-e.deltaY * 0.002));
		};
		el.addEventListener('wheel', onwheel, { passive: false });
		return () => el.removeEventListener('wheel', onwheel);
	};

	function onpointerdown(e: PointerEvent) {
		if (scale <= 1 || e.button !== 0) return;
		drag = { id: e.pointerId, x: e.clientX, y: e.clientY, tx, ty, moved: false };
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		dragging = true;
	}
	function onpointermove(e: PointerEvent) {
		if (!drag || drag.id !== e.pointerId) return;
		const dx = e.clientX - drag.x;
		const dy = e.clientY - drag.y;
		if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
		tx = drag.tx + dx;
		ty = drag.ty + dy;
	}
	function onpointerup(e: PointerEvent) {
		if (!drag || drag.id !== e.pointerId) return;
		drag = null;
		dragging = false;
	}
	function ondblclick() {
		if (scale > 1) fit();
		else setScale(2.5);
	}

	// Nächstes (und vorheriges) Bild vorladen
	$effect(() => {
		if (!open || index < 0) return;
		for (const i of [index + 1, index - 1]) {
			const n = nodes[i];
			if (n && previewKind(n.contentType) === 'image') {
				const pre = new Image();
				pre.decoding = 'async';
				pre.src = urlFor(n, {});
			}
		}
	});

	// ---------- Blättern ----------
	const hasPrev = $derived(index > 0);
	const hasNext = $derived(index >= 0 && index < nodes.length - 1);
	function prev() {
		if (hasPrev) current = nodes[index - 1] ?? current;
	}
	function next() {
		if (hasNext) current = nodes[index + 1] ?? current;
	}
	function retry() {
		reloadKey++;
	}

	function isTypingTarget(target: EventTarget | null): boolean {
		if (!(target instanceof HTMLElement)) return false;
		if (target.isContentEditable) return true;
		const tag = target.tagName;
		return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
	}

	function onwindowkeydown(e: KeyboardEvent) {
		if (!open || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
		const active = typeof document !== 'undefined' ? document.activeElement : null;
		if (isTypingTarget(e.target) || isTypingTarget(active)) return;
		if (e.key === 'ArrowLeft') {
			e.preventDefault();
			prev();
		} else if (e.key === 'ArrowRight') {
			e.preventDefault();
			next();
		} else if (kind === 'image' && (e.key === '+' || e.key === '=')) {
			e.preventDefault();
			zoomIn();
		} else if (kind === 'image' && e.key === '-') {
			e.preventDefault();
			zoomOut();
		} else if (kind === 'image' && e.key === '0') {
			e.preventDefault();
			fit();
		}
	}

	// Wischgesten (nur ungezoomt, nur waagerecht)
	let touchStart: { x: number; y: number } | null = null;
	function ontouchstart(e: TouchEvent) {
		const t = e.touches[0];
		touchStart = e.touches.length === 1 && t && scale === 1 ? { x: t.clientX, y: t.clientY } : null;
	}
	function ontouchend(e: TouchEvent) {
		const t = e.changedTouches[0];
		const start = touchStart;
		touchStart = null;
		if (!start || !t || scale !== 1) return;
		const dx = t.clientX - start.x;
		const dy = t.clientY - start.y;
		if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
		if (dx < 0) next();
		else prev();
	}

	const darkStage = $derived(kind === 'image');
	const navBtn =
		'absolute top-1/2 z-10 -translate-y-1/2 rounded-full bg-black/40 text-zinc-50 shadow hover:bg-black/60 hover:text-white dark:hover:bg-black/60 sm:size-11';
</script>

<svelte:window onkeydown={onwindowkeydown} />

{#snippet errorBox(message: string, dark: boolean)}
	<div
		class="flex max-w-sm flex-col items-center gap-3 p-6 text-center {dark ? 'text-zinc-100' : ''}"
		role="alert"
	>
		<p class="text-sm">{message}</p>
		<Button
			variant="outline"
			size="sm"
			class={dark ? 'border-white/30 bg-transparent text-zinc-50 hover:bg-white/10' : ''}
			onclick={retry}
		>
			<RefreshCwIcon />
			Erneut versuchen
		</Button>
	</div>
{/snippet}

{#snippet spinner(dark: boolean)}
	<div
		class="flex items-center gap-2 text-sm {dark ? 'text-zinc-300' : 'text-muted-foreground'}"
		role="status"
	>
		<LoaderCircleIcon class="size-5 animate-spin" aria-hidden="true" />
		Lädt …
	</div>
{/snippet}

<Dialog.Root bind:open>
	<Dialog.Content
		showCloseButton={false}
		class="top-0 left-0 flex h-dvh max-h-dvh w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none p-0 ring-0 sm:max-w-none"
	>
		{#if current}
			<!-- Kopfzeile -->
			<header class="bg-background flex shrink-0 items-center gap-2 border-b px-2 py-2 sm:px-4">
				<FileIcon class={['hidden size-5 shrink-0 sm:block', fileColor]} aria-hidden="true" />
				<div class="min-w-0 flex-1">
					<Dialog.Title class="truncate text-sm font-semibold" title={current.name}>
						{current.name}
					</Dialog.Title>
					<Dialog.Description class="text-muted-foreground truncate text-xs">
						{formatBytes(current.sizeBytes)} · {typeLabel}
					</Dialog.Description>
				</div>
				{#if index >= 0 && nodes.length > 1}
					<span class="text-muted-foreground shrink-0 text-xs tabular-nums" aria-live="polite">
						{index + 1} / {nodes.length}
					</span>
				{/if}
				<Button
					variant="ghost"
					size="icon-lg"
					href={urlFor(current, { download: true })}
					download={current.name}
					aria-label="Herunterladen"
					title="Herunterladen"
				>
					<DownloadIcon class="size-5" />
				</Button>
				<Button
					variant="ghost"
					size="icon-lg"
					aria-label="Schließen"
					title="Schließen (Esc)"
					onclick={() => (open = false)}
				>
					<XIcon class="size-5" />
				</Button>
			</header>

			<!-- Inhalt -->
			<div
				class="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden {darkStage
					? 'bg-zinc-950 text-zinc-50'
					: 'bg-muted/40'}"
				role="group"
				aria-roledescription="Dateivorschau"
				aria-label={index >= 0 ? `Datei ${index + 1} von ${nodes.length}` : current.name}
				ontouchstart={kind === 'image' || kind === null ? ontouchstart : undefined}
				ontouchend={kind === 'image' || kind === null ? ontouchend : undefined}
			>
				{#if kind === 'image'}
					<div
						class="flex size-full items-center justify-center overflow-hidden select-none {scale > 1
							? dragging
								? 'cursor-grabbing'
								: 'cursor-grab'
							: 'cursor-zoom-in'}"
						style="touch-action: {scale > 1 ? 'none' : 'pan-y'}"
						{@attach wheelZoom}
						{onpointerdown}
						{onpointermove}
						{onpointerup}
						onpointercancel={onpointerup}
						{ondblclick}
						role="presentation"
					>
						{#key `${nodeKey}|${reloadKey}`}
							{@const key = `${nodeKey}|${reloadKey}`}
							<img
								src={urlFor(current, {})}
								alt={current.name}
								decoding="async"
								draggable="false"
								class="max-h-full max-w-full object-contain {dragging
									? ''
									: 'transition-transform duration-100'} {imageState === 'loaded'
									? ''
									: 'invisible'}"
								style="transform: translate({tx}px, {ty}px) scale({scale})"
								onload={() => (imgStatus = { key, status: 'loaded' })}
								onerror={() => (imgStatus = { key, status: 'error' })}
							/>
						{/key}
					</div>
					{#if imageState === 'loading'}
						<div class="pointer-events-none absolute inset-0 flex items-center justify-center">
							{@render spinner(true)}
						</div>
					{:else if imageState === 'error'}
						<div class="absolute inset-0 flex items-center justify-center">
							{@render errorBox('Das Bild konnte nicht geladen werden.', true)}
						</div>
					{:else}
						<!-- Zoom-Leiste -->
						<div
							class="absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full bg-black/60 px-1.5 py-1 text-zinc-50 shadow"
						>
							<Button
								variant="ghost"
								size="icon-sm"
								class="text-zinc-50 hover:bg-white/15 hover:text-white dark:hover:bg-white/15"
								aria-label="Verkleinern"
								disabled={scale <= MIN_SCALE}
								onclick={zoomOut}
							>
								<ZoomOutIcon />
							</Button>
							<span class="w-12 text-center text-xs tabular-nums" aria-live="polite">
								{Math.round(scale * 100)} %
							</span>
							<Button
								variant="ghost"
								size="icon-sm"
								class="text-zinc-50 hover:bg-white/15 hover:text-white dark:hover:bg-white/15"
								aria-label="Vergrößern"
								disabled={scale >= MAX_SCALE}
								onclick={zoomIn}
							>
								<ZoomInIcon />
							</Button>
							<Button
								variant="ghost"
								size="icon-sm"
								class="text-zinc-50 hover:bg-white/15 hover:text-white dark:hover:bg-white/15"
								aria-label="Einpassen"
								disabled={scale === 1}
								onclick={fit}
							>
								<ScanIcon />
							</Button>
						</div>
					{/if}
				{:else if kind === 'pdf'}
					{#if fetched.status === 'pdf'}
						{#if canEmbedPdf}
							<iframe title={current.name} src={fetched.url} class="size-full border-0 bg-white"
							></iframe>
						{:else}
							<div
								class="bg-card flex max-w-sm flex-col items-center gap-3 rounded-lg border p-6 text-center"
							>
								<FileIcon class={['size-12', fileColor]} aria-hidden="true" />
								<p class="text-sm">
									Dein Browser kann PDFs hier nicht direkt anzeigen. Öffne die Datei in einem neuen
									Tab oder lade sie herunter.
								</p>
								<div class="flex flex-wrap justify-center gap-2">
									<Button href={fetched.url} target="_blank" rel="noopener">
										<ExternalLinkIcon />
										In neuem Tab öffnen
									</Button>
									<Button
										variant="outline"
										href={urlFor(current, { download: true })}
										download={current.name}
									>
										<DownloadIcon />
										Herunterladen
									</Button>
								</div>
							</div>
						{/if}
					{:else if fetched.status === 'error'}
						{@render errorBox(fetched.message, false)}
					{:else}
						{@render spinner(false)}
					{/if}
				{:else if kind === 'text' && !textTooLarge}
					{#if fetched.status === 'text'}
						<div class="size-full overflow-auto">
							<pre
								class="bg-background mx-auto min-h-full max-w-5xl p-4 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap sm:p-6 sm:text-sm">{fetched.text}</pre>
						</div>
					{:else if fetched.status === 'error'}
						{@render errorBox(fetched.message, false)}
					{:else}
						{@render spinner(false)}
					{/if}
				{:else}
					<!-- Keine Vorschau -->
					<div
						class="bg-card mx-4 flex w-full max-w-sm flex-col items-center gap-3 rounded-lg border p-6 text-center"
					>
						<FileIcon class={['size-16', fileColor]} aria-hidden="true" />
						<div class="min-w-0 space-y-1">
							<p class="font-semibold break-words">{current.name}</p>
							<p class="text-muted-foreground text-xs">
								{formatBytes(current.sizeBytes)} · {typeLabel}
							</p>
						</div>
						<p class="text-muted-foreground text-sm">
							{textTooLarge
								? `Die Datei ist zu groß für die Vorschau (höchstens ${formatBytes(MAX_TEXT_PREVIEW_BYTES)}).`
								: 'Für diesen Dateityp gibt es keine Vorschau.'}
						</p>
						<Button href={urlFor(current, { download: true })} download={current.name}>
							<DownloadIcon />
							Herunterladen
						</Button>
					</div>
				{/if}

				{#if hasPrev}
					<Button
						variant="ghost"
						size="icon-lg"
						class="{navBtn} left-2"
						aria-label="Vorherige Datei"
						onclick={prev}
					>
						<ChevronLeftIcon class="size-6" />
					</Button>
				{/if}
				{#if hasNext}
					<Button
						variant="ghost"
						size="icon-lg"
						class="{navBtn} right-2"
						aria-label="Nächste Datei"
						onclick={next}
					>
						<ChevronRightIcon class="size-6" />
					</Button>
				{/if}
			</div>
		{:else}
			<Dialog.Title class="sr-only">Vorschau</Dialog.Title>
		{/if}
	</Dialog.Content>
</Dialog.Root>
