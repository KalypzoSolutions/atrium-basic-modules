<script lang="ts">
	// VERTRAG (Welle 0) – Props nicht ändern; Implementierung: Welle 4.3.
	import { onDestroy, untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import ArrowLeftIcon from '@lucide/svelte/icons/arrow-left';
	import ChevronRightIcon from '@lucide/svelte/icons/chevron-right';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import CircleCheckIcon from '@lucide/svelte/icons/circle-check';
	import ClockIcon from '@lucide/svelte/icons/clock';
	import DownloadIcon from '@lucide/svelte/icons/download';
	import RotateCcwIcon from '@lucide/svelte/icons/rotate-ccw';
	import UploadIcon from '@lucide/svelte/icons/upload';
	import EyeIcon from '@lucide/svelte/icons/eye';
	import FolderOpenIcon from '@lucide/svelte/icons/folder-open';
	import LinkIcon from '@lucide/svelte/icons/link-2-off';
	import LoaderCircleIcon from '@lucide/svelte/icons/loader-circle';
	import LockIcon from '@lucide/svelte/icons/lock';
	import RefreshCwIcon from '@lucide/svelte/icons/refresh-cw';
	import { PageTitle } from '$lib/components/layout';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import {
		MAX_UPLOADER_NAME,
		linkCanUpload,
		linkCanView,
		publicUploadFields,
		type PublicLinkInfo,
		type PublicListing,
		type PublicNode,
		type PublicUploadResult
	} from '../schemas';
	import FilePreview from './FilePreview.svelte';
	import {
		planBatches,
		precheck,
		publicUploadError,
		queueProgress,
		xhrUpload,
		type UploadStatus
	} from './upload-queue';
	import {
		API,
		RAW_API,
		breakableName,
		formatBytes,
		previewKind,
		type ContentUrlFn,
		type PreviewNode
	} from './helpers';
	import FolderGlyph from './FolderGlyph.svelte';
	import FileTypeGlyph from './FileTypeGlyph.svelte';
	import { fileTint } from './file-types';

	let { params }: { params: Record<string, string> } = $props();

	const token = $derived(params.token ?? '');
	const enc = (s: string) => encodeURIComponent(s);
	const apiBase = $derived(`${API}/public/links/${enc(token)}`);
	const rawBase = $derived(`${RAW_API}/public/links/${enc(token)}`);
	const systemName = $derived((page.data as { systemName?: string }).systemName || 'EP Intern');

	const BUSY_TEXT = 'Gerade sehr viele Zugriffe – bitte kurz warten und erneut versuchen.';
	const RELOCK_TEXT = 'Die Freischaltung ist abgelaufen. Bitte gib das Passwort erneut ein.';

	// ---------- Zugriffstoken (nach Passwort) je Link in sessionStorage ----------
	/** Sicherheitsabstand, damit das Token nicht mitten im Abruf abläuft */
	const EXPIRY_MARGIN_MS = 20_000;
	const storageKey = (t: string) => `ep-files-link:${t}`;

	let accessToken = $state<string | null>(null);
	let accessExp = 0;

	function readStoredToken(t: string): string | null {
		try {
			const raw = sessionStorage.getItem(storageKey(t));
			if (!raw) return null;
			const v = JSON.parse(raw) as { t?: unknown; exp?: unknown };
			if (typeof v.t !== 'string' || typeof v.exp !== 'number') return null;
			if (v.exp - EXPIRY_MARGIN_MS <= Date.now()) {
				sessionStorage.removeItem(storageKey(t));
				return null;
			}
			accessExp = v.exp;
			return v.t;
		} catch {
			return null;
		}
	}

	function storeToken(t: string, value: string, expiresInSec: number) {
		accessExp = Date.now() + expiresInSec * 1000;
		accessToken = value;
		try {
			sessionStorage.setItem(storageKey(t), JSON.stringify({ t: value, exp: accessExp }));
		} catch {
			// Ohne Speicher gilt die Freischaltung nur für diese Ansicht
		}
	}

	function clearToken(t: string) {
		accessToken = null;
		accessExp = 0;
		try {
			sessionStorage.removeItem(storageKey(t));
		} catch {
			// ignorieren
		}
	}

	/** Passwort erneut abfragen (Token abgelaufen oder vom Server abgelehnt) */
	function relock(message = RELOCK_TEXT) {
		clearToken(token);
		password = '';
		unlockError = message;
		listing = null;
		if (info) info = { ...info, node: null };
	}

	/** Vor Download/Vorschau: abgelaufenes Token erkennen, statt eine Fehlerseite zu öffnen */
	function tokenStillValid(): boolean {
		if (!info?.needsPassword) return true;
		if (accessToken && accessExp - EXPIRY_MARGIN_MS > Date.now()) return true;
		relock();
		return false;
	}

	// ---------- Link-Info ----------
	let info = $state<PublicLinkInfo | null>(null);
	let infoState = $state<'loading' | 'ready' | 'unavailable' | 'error'>('loading');
	let infoError = $state('');

	const locked = $derived(!!info?.needsPassword && !accessToken);
	/** Link-Art: Inhalt ansehen und/oder hochladen (Upload nur bei Ordnern) */
	const canView = $derived(!!info && linkCanView(info.mode));
	const uploadLimits = $derived(
		info && info.kind === 'folder' && info.upload && linkCanUpload(info.mode) ? info.upload : null
	);

	async function loadInfo() {
		infoState = 'loading';
		infoError = '';
		const t = token;
		const stored = readStoredToken(t);
		accessToken = stored;
		try {
			// `t` wird mitgeschickt, damit Datei-Links nach dem Freischalten die Datei liefern können
			const q = stored ? `?t=${enc(stored)}` : '';
			const data = await apiFetch<PublicLinkInfo>(`${apiBase}${q}`);
			if (t !== token) return;
			info = data;
			if (!data.needsPassword) clearToken(t);
			infoState = 'ready';
		} catch (e) {
			if (t !== token) return;
			if (e instanceof ApiClientError && (e.status === 404 || e.status === 422)) {
				infoState = 'unavailable';
			} else if (e instanceof ApiClientError && e.status === 429) {
				infoState = 'error';
				infoError = BUSY_TEXT;
			} else {
				infoState = 'error';
				infoError = 'Die Seite konnte nicht geladen werden. Bitte prüfe deine Verbindung.';
			}
		}
	}

	$effect(() => {
		void token;
		untrack(() => void loadInfo());
	});

	// ---------- Passwort ----------
	let password = $state('');
	let unlocking = $state(false);
	let unlockError = $state('');

	async function unlock(e: SubmitEvent) {
		e.preventDefault();
		if (unlocking) return;
		if (!password) {
			unlockError = 'Bitte gib das Passwort ein.';
			return;
		}
		unlocking = true;
		unlockError = '';
		const t = token;
		try {
			const res = await apiFetch<{ accessToken: string; expiresInSec: number }>(
				`${apiBase}/unlock`,
				{ method: 'POST', body: JSON.stringify({ password }) }
			);
			storeToken(t, res.accessToken, res.expiresInSec);
			password = '';
			// Datei-Links: Datei-Angaben mit dem Token nachladen
			if (info?.kind === 'file') await loadInfo();
			// Upload wurde wegen abgelaufener Freischaltung angehalten → weitermachen
			if (upItems.some((i) => i.status === 'waiting')) void runUploads();
		} catch (err) {
			if (err instanceof ApiClientError && err.status === 403) {
				unlockError = 'Das Passwort ist falsch.';
			} else if (err instanceof ApiClientError && err.status === 429) {
				unlockError = 'Zu viele Versuche – bitte später erneut versuchen.';
			} else if (err instanceof ApiClientError && err.status === 404) {
				infoState = 'unavailable';
			} else {
				unlockError = 'Das hat nicht geklappt. Bitte versuche es erneut.';
			}
		} finally {
			unlocking = false;
		}
	}

	// ---------- Ordner-Links ----------
	const folderId = $derived(page.url.searchParams.get('folder'));

	let listing = $state<PublicListing | null>(null);
	let listState = $state<'loading' | 'ready' | 'busy' | 'missing' | 'error'>('loading');
	let listError = $state('');
	let listSeq = 0;

	async function loadListing(folder: string | null, t: string | null) {
		const seq = ++listSeq;
		listState = 'loading';
		listError = '';
		const q = new URLSearchParams();
		if (folder) q.set('parent', folder);
		if (t) q.set('t', t);
		const qs = q.toString();
		try {
			const data = await apiFetch<PublicListing>(`${apiBase}/nodes${qs ? `?${qs}` : ''}`);
			if (seq !== listSeq) return;
			listing = data;
			listState = 'ready';
		} catch (e) {
			if (seq !== listSeq) return;
			const status = e instanceof ApiClientError ? e.status : 0;
			if (status === 403) {
				relock();
			} else if (status === 429) {
				listState = 'busy';
			} else if ((status === 404 || status === 422) && folder) {
				listState = 'missing';
			} else if (status === 404) {
				infoState = 'unavailable';
			} else {
				listState = 'error';
				listError = 'Der Ordner konnte nicht geladen werden. Bitte prüfe deine Verbindung.';
			}
		}
	}

	$effect(() => {
		const f = folderId;
		const t = accessToken;
		if (infoState !== 'ready' || info?.kind !== 'folder' || locked || !canView) return;
		untrack(() => void loadListing(f, t));
	});

	function openFolder(id: string | null) {
		const url = new URL(page.url);
		if (id) url.searchParams.set('folder', id);
		else url.searchParams.delete('folder');
		void goto(url, { keepFocus: true, noScroll: false });
	}

	const crumbs = $derived(listing?.breadcrumbs ?? []);
	const currentName = $derived(crumbs[crumbs.length - 1]?.name ?? info?.name ?? '');
	const parentCrumb = $derived(crumbs.length > 1 ? crumbs[crumbs.length - 2]! : null);
	const fileItems = $derived((listing?.items ?? []).filter((n) => n.kind === 'file'));
	const folderCount = $derived((listing?.items.length ?? 0) - fileItems.length);

	// ---------- Inhalte / Vorschau ----------
	const urlFor: ContentUrlFn = (node, opts) => {
		const q = new URLSearchParams();
		if (accessToken) q.set('t', accessToken);
		if (opts.download) q.set('download', '1');
		if (opts.thumb) q.set('thumb', '1');
		const qs = q.toString();
		return `${rawBase}/content/${enc(node.id)}${qs ? `?${qs}` : ''}`;
	};

	let previewOpen = $state(false);
	let previewCurrent = $state<PreviewNode | null>(null);
	let previewNodes = $state<PreviewNode[]>([]);

	function openPreview(node: PublicNode, all: PublicNode[]) {
		if (!tokenStillValid()) return;
		previewNodes = all;
		previewCurrent = node;
		previewOpen = true;
	}

	function guardDownload(e: MouseEvent) {
		if (!tokenStillValid()) e.preventDefault();
	}

	/** Vorschaubilder, die nicht geladen werden konnten → Icon */
	const failedImages = new SvelteSet<string>();

	/** Fehler-Listener per Action statt `onerror`-Attribut (CSP blockiert Inline-Handler aus dem SSR) */
	function watchImage(img: HTMLImageElement) {
		const fail = () => {
			const src = img.getAttribute('src');
			if (src) failedImages.add(src);
		};
		img.addEventListener('error', fail);
		if (img.complete && img.naturalWidth === 0 && img.getAttribute('src')) fail();
		return { destroy: () => img.removeEventListener('error', fail) };
	}

	function thumbOf(node: PublicNode): string | null {
		if (node.kind !== 'file' || !node.hasThumb) return null;
		const url = urlFor(node, { thumb: true });
		return failedImages.has(url) ? null : url;
	}

	/** Bild für die Karte eines Datei-Links: Thumbnail (Bild, erste PDF-Seite), sonst das Bild selbst */
	function heroImageOf(node: PublicNode): string | null {
		const kind = previewKind(node.contentType);
		if (kind === 'pdf' && node.hasThumb) {
			const url = urlFor(node, { thumb: true });
			return failedImages.has(url) ? null : url;
		}
		if (kind !== 'image') return null;
		const url = node.hasThumb ? urlFor(node, { thumb: true }) : urlFor(node, {});
		return failedImages.has(url) ? null : url;
	}

	/** „PDF“, „JPG“ … aus der Endung, sonst der MIME-Typ */
	function typeLabel(node: Pick<PublicNode, 'name' | 'contentType'>): string {
		const m = /\.([a-z0-9]{1,8})$/i.exec(node.name);
		if (m) return m[1]!.toUpperCase();
		return node.contentType?.split(';')[0]?.trim() || 'Datei';
	}

	function formatDateDe(iso: string | null): string {
		if (!iso) return '';
		const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
		return m ? `${m[3]}.${m[2]}.${m[1]}` : iso;
	}

	// ---------- Upload (Link-Arten `upload` und `view-upload`) ----------
	interface UpItem {
		key: string;
		file: File;
		name: string;
		size: number;
		status: UploadStatus;
		progress: number;
		message: string;
		/** abgelehnt (Vorprüfung, 413/422): erneuter Versuch sinnlos */
		rejected: boolean;
	}

	const NAME_KEY = 'ep-files-uploader-name';

	function readUploaderName(): string {
		try {
			return (sessionStorage.getItem(NAME_KEY) ?? '').slice(0, MAX_UPLOADER_NAME);
		} catch {
			return '';
		}
	}

	let uploaderName = $state(readUploaderName());
	let upItems = $state<UpItem[]>([]);
	let upRunning = $state(false);
	let upNotice = $state('');
	let uploaded = $state<PublicUploadResult['uploaded']>([]);
	let upDrag = $state(0);
	let upInput = $state<HTMLInputElement | null>(null);
	let upController: AbortController | null = null;
	let destroyed = false;

	const nameCheck = $derived(publicUploadFields.safeParse({ name: uploaderName }));
	const nameError = $derived(
		nameCheck.success ? '' : (nameCheck.error.issues[0]?.message ?? 'Ungültiger Name')
	);
	const upProgress = $derived(queueProgress(upItems));
	const upPercent = $derived(Math.round(upProgress.fraction * 100));
	const upRetryable = $derived(
		upItems.filter((i) => i.status === 'waiting' || (i.status === 'error' && !i.rejected))
	);
	const upRejected = $derived(upItems.filter((i) => i.status === 'error' && i.rejected));
	/** Fertig: etwas hochgeladen, nichts mehr offen → Dankeschön */
	const upFinished = $derived(!upRunning && uploaded.length > 0 && upRetryable.length === 0);
	/** `accept` für die Dateiauswahl (hilft mobilen Auswahldialogen), leer = alles */
	const acceptAttr = $derived(
		uploadLimits && uploadLimits.allowedContentTypes.length > 0
			? uploadLimits.allowedContentTypes.some((t) => t === '*' || t === '*/*')
				? undefined
				: uploadLimits.allowedContentTypes.join(',')
			: undefined
	);
	const upStatusText = $derived.by(() => {
		if (!upItems.length) return '';
		const total = upItems.length;
		const finished = upProgress.done + upProgress.failed + upProgress.rejected;
		if (upRunning) return `Lädt hoch … ${finished} von ${total}`;
		return '';
	});

	function saveUploaderName() {
		try {
			if (uploaderName.trim()) sessionStorage.setItem(NAME_KEY, uploaderName);
			else sessionStorage.removeItem(NAME_KEY);
		} catch {
			// ohne Speicher wird der Name nur nicht gemerkt
		}
	}

	const filesText = (n: number) => (n === 1 ? '1 Datei' : `${n} Dateien`);

	function addFiles(files: File[]) {
		if (!uploadLimits || !files.length) return;
		if (upFinished) {
			// neue Runde nach dem Dankeschön
			uploaded = [];
			upItems = [];
		}
		upNotice = '';
		const checked = precheck(
			files.map((file) => ({ file, relativePath: null })),
			uploadLimits
		);
		const added: UpItem[] = checked.map((c) => ({
			key: crypto.randomUUID(),
			file: c.file,
			name: c.file.name || 'Unbenannt',
			size: c.file.size,
			status: c.problem ? 'error' : 'waiting',
			progress: 0,
			message: c.problem ?? '',
			rejected: !!c.problem
		}));
		upItems = [...upItems, ...added];
		void runUploads();
	}

	type BatchOutcome = 'next' | 'stop';

	async function sendBatch(batch: UpItem[]): Promise<BatchOutcome> {
		const form = new FormData();
		const name = uploaderName.trim();
		if (name && nameCheck.success) form.append('name', name);
		if (accessToken) form.append('t', accessToken);
		for (const it of batch) {
			it.status = 'uploading';
			it.progress = 0;
			it.message = '';
			form.append('file', it.file, it.file.name);
		}
		upController = new AbortController();
		const r = await xhrUpload(
			`${rawBase}/upload`,
			form,
			(loaded, total) => {
				const p = Math.min(0.99, loaded / total);
				for (const it of batch) it.progress = p;
			},
			upController.signal
		);
		upController = null;
		if (r.status >= 200 && r.status < 300) {
			const list = (r.body as { data?: PublicUploadResult } | null)?.data?.uploaded;
			for (const it of batch) {
				it.status = 'done';
				it.progress = 1;
			}
			uploaded = [
				...uploaded,
				...(Array.isArray(list) ? list : batch.map((i) => ({ name: i.name, sizeBytes: i.size })))
			];
			return 'next';
		}
		if (r.aborted) {
			for (const it of batch) {
				it.status = 'waiting';
				it.progress = 0;
			}
			return 'stop';
		}
		const err = publicUploadError(r.status, r.body, !!info?.needsPassword);
		if (err.kind === 'rejected') {
			for (const it of batch) {
				it.status = 'error';
				it.rejected = true;
				it.message = err.message;
			}
			return 'next';
		}
		if (err.kind === 'relock') {
			for (const it of batch) {
				it.status = 'waiting';
				it.progress = 0;
			}
			relock();
			return 'stop';
		}
		if (err.kind === 'unavailable') {
			infoState = 'unavailable';
			return 'stop';
		}
		for (const it of batch) {
			it.status = 'error';
			it.rejected = false;
			it.message = err.message;
		}
		upNotice = err.message;
		return 'stop';
	}

	/** Wartende Dateien nacheinander in Paketen hochladen (≤ maxFiles Dateien und ≤ maxRequestBytes je Request) */
	async function runUploads() {
		if (upRunning || !uploadLimits) return;
		upRunning = true;
		upNotice = '';
		const before = uploaded.length;
		try {
			for (;;) {
				if (destroyed || !uploadLimits) return;
				const waiting = upItems.filter((i) => i.status === 'waiting');
				if (!waiting.length) break;
				// abgelaufene Freischaltung: Passwort erneut abfragen, danach geht es weiter
				if (!tokenStillValid()) break;
				const plan = planBatches(waiting, uploadLimits.maxFiles, uploadLimits.maxRequestBytes);
				const batch = (plan[0] ?? []).map((i) => waiting[i]!);
				if ((await sendBatch(batch)) === 'stop') break;
			}
		} finally {
			upRunning = false;
		}
		// „Ansehen und hochladen“: neue Dateien in der Liste zeigen
		if (uploaded.length > before && canView && !locked && infoState === 'ready') {
			void loadListing(folderId, accessToken);
		}
	}

	function retryUploads() {
		for (const it of upItems) {
			if (it.status === 'error' && !it.rejected) {
				it.status = 'waiting';
				it.progress = 0;
				it.message = '';
			}
		}
		void runUploads();
	}

	function resetUploads() {
		upController?.abort();
		upItems = [];
		uploaded = [];
		upNotice = '';
	}

	function openUploadPicker() {
		upInput?.click();
	}

	function onUploadPick(e: Event) {
		const el = e.currentTarget as HTMLInputElement;
		const files = el.files ? Array.from(el.files) : [];
		el.value = '';
		addFiles(files);
	}

	const hasFiles = (e: DragEvent) =>
		!!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');

	function onUpDragEnter(e: DragEvent) {
		if (!hasFiles(e)) return;
		e.preventDefault();
		upDrag++;
	}
	function onUpDragOver(e: DragEvent) {
		if (!hasFiles(e)) return;
		e.preventDefault();
		e.dataTransfer!.dropEffect = 'copy';
		if (upDrag === 0) upDrag = 1;
	}
	function onUpDragLeave(e: DragEvent) {
		if (!hasFiles(e)) return;
		upDrag = Math.max(0, upDrag - 1);
	}
	function onUpDrop(e: DragEvent) {
		if (!hasFiles(e)) return;
		e.preventDefault();
		upDrag = 0;
		const dt = e.dataTransfer!;
		const files: File[] = [];
		let folders = 0;
		const list = dt.items ? Array.from(dt.items).filter((i) => i.kind === 'file') : [];
		if (list.length) {
			for (const it of list) {
				const entry = typeof it.webkitGetAsEntry === 'function' ? it.webkitGetAsEntry() : null;
				if (entry?.isDirectory) {
					folders++;
					continue;
				}
				const f = it.getAsFile();
				if (f) files.push(f);
			}
		} else {
			files.push(...Array.from(dt.files));
		}
		addFiles(files);
		if (folders) {
			upNotice = 'Ordner können hier nicht hochgeladen werden – bitte die Dateien darin auswählen.';
		}
	}

	/** Außerhalb des Ablagebereichs fallen gelassene Dateien nicht im Browser öffnen */
	function guardWindowDrop(e: DragEvent) {
		if (uploadLimits && hasFiles(e)) e.preventDefault();
	}

	function onBeforeUnload(e: BeforeUnloadEvent) {
		if (upRunning) e.preventDefault();
	}

	onDestroy(() => {
		destroyed = true;
		upController?.abort();
	});

	const title = $derived(
		infoState === 'unavailable'
			? 'Link nicht verfügbar'
			: info
				? info.kind === 'folder' && !locked
					? canView
						? currentName || info.name
						: `Dateien hochladen – ${info.name}`
					: info.name
				: 'Geteilte Datei'
	);

	const countLabel = (folders: number, files: number) => {
		const parts: string[] = [];
		if (folders) parts.push(folders === 1 ? '1 Ordner' : `${folders} Ordner`);
		if (files) parts.push(files === 1 ? '1 Datei' : `${files} Dateien`);
		return parts.join(' · ');
	};
</script>

<svelte:head>
	<meta name="robots" content="noindex,nofollow" />
</svelte:head>
<PageTitle {title} />

<svelte:window
	ondragover={guardWindowDrop}
	ondrop={(e) => {
		upDrag = 0;
		guardWindowDrop(e);
	}}
	ondragend={() => (upDrag = 0)}
	onbeforeunload={onBeforeUnload}
/>

<main class="flex flex-col gap-6">
	{#if infoState === 'loading'}
		<div class="flex flex-col gap-4" aria-busy="true" aria-label="Seite wird geladen">
			<Skeleton class="h-8 w-2/3" />
			<Skeleton class="h-4 w-1/3" />
			<Skeleton class="h-56 w-full" />
		</div>
	{:else if infoState === 'unavailable'}
		<Card.Root>
			<Card.Content class="flex flex-col items-center gap-3 py-10 text-center">
				<LinkIcon class="size-10 text-muted-foreground" aria-hidden="true" />
				<h1 class="text-section">Dieser Link ist nicht (mehr) verfügbar.</h1>
				<p class="max-w-sm text-sm text-muted-foreground">
					Vielleicht ist er abgelaufen oder wurde zurückgezogen. Bitte wende dich an die Person, die
					ihn dir geschickt hat.
				</p>
			</Card.Content>
		</Card.Root>
	{:else if infoState === 'error' || !info}
		<Card.Root>
			<Card.Content class="flex flex-col items-center gap-3 py-10 text-center">
				<CircleAlertIcon class="size-10 text-muted-foreground" aria-hidden="true" />
				<p class="max-w-sm text-sm text-muted-foreground" role="alert">
					{infoError || 'Die Seite konnte nicht geladen werden.'}
				</p>
				<Button variant="outline" onclick={() => void loadInfo()}>
					<RefreshCwIcon class="size-4" aria-hidden="true" /> Erneut versuchen
				</Button>
			</Card.Content>
		</Card.Root>
	{:else if locked}
		<!-- Passwort -->
		<Card.Root>
			<Card.Header>
				<div class="flex items-center gap-3">
					<span
						class="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
					>
						<LockIcon class="size-5" aria-hidden="true" />
					</span>
					<div class="min-w-0">
						<Card.Title level={1} class="text-section break-words">{info.name}</Card.Title>
						<Card.Description>
							{info.kind === 'folder' ? 'Dieser Ordner' : 'Diese Datei'} ist mit einem Passwort geschützt.
						</Card.Description>
					</div>
				</div>
			</Card.Header>
			<Card.Content>
				<form class="flex flex-col gap-3" onsubmit={unlock} novalidate>
					<div class="flex flex-col gap-1.5">
						<Label for="link-password">Passwort</Label>
						<Input
							id="link-password"
							type="password"
							autocomplete="off"
							bind:value={password}
							aria-invalid={unlockError ? 'true' : undefined}
							aria-describedby={unlockError ? 'link-password-error' : undefined}
							disabled={unlocking}
						/>
						{#if unlockError}
							<p id="link-password-error" class="text-xs text-destructive" role="alert">
								{unlockError}
							</p>
						{/if}
					</div>
					<Button
						type="submit"
						size="lg"
						class="h-10 w-full sm:w-auto sm:self-start"
						disabled={unlocking}
					>
						{#if unlocking}
							<LoaderCircleIcon class="size-4 animate-spin" aria-hidden="true" /> Prüft …
						{:else}
							Öffnen
						{/if}
					</Button>
				</form>
			</Card.Content>
		</Card.Root>
	{:else if info.kind === 'file'}
		<!-- Datei-Link -->
		{#if info.node}
			{@const node = info.node}
			{@const hero = heroImageOf(node)}
			{@const canPreview = previewKind(node.contentType) !== null}
			<Card.Root class="overflow-hidden pt-0">
				{#if hero}
					<button
						type="button"
						class="block w-full bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
						onclick={() => openPreview(node, [node])}
						aria-label="{node.name} ansehen"
					>
						<img
							src={hero}
							alt=""
							class="mx-auto max-h-[60dvh] w-auto object-contain"
							use:watchImage
						/>
					</button>
				{:else}
					<div
						class={[
							'flex items-center justify-center py-10',
							fileTint(node.contentType, node.name)
						]}
					>
						<FileTypeGlyph contentType={node.contentType} name={node.name} size="lg" />
					</div>
				{/if}
				<Card.Header>
					<h1 class="text-section break-words">{node.name}</h1>
					<p class="text-sm text-muted-foreground tabular-nums">
						{typeLabel(node)} · {formatBytes(node.sizeBytes)}
					</p>
				</Card.Header>
				<Card.Content class="flex flex-col gap-2 sm:flex-row">
					<Button
						href={urlFor(node, { download: true })}
						download={node.name}
						size="lg"
						class="h-11 px-5 text-base"
						onclick={guardDownload}
					>
						<DownloadIcon class="size-5" aria-hidden="true" /> Herunterladen
					</Button>
					{#if canPreview}
						<Button
							variant="outline"
							size="lg"
							class="h-11 px-5 text-base"
							onclick={() => openPreview(node, [node])}
						>
							<EyeIcon class="size-5" aria-hidden="true" /> Ansehen
						</Button>
					{/if}
				</Card.Content>
			</Card.Root>
		{:else}
			<Card.Root>
				<Card.Content class="flex flex-col items-center gap-3 py-10 text-center">
					<CircleAlertIcon class="size-10 text-muted-foreground" aria-hidden="true" />
					<p class="max-w-sm text-sm text-muted-foreground" role="alert">
						Die Datei kann gerade nicht angezeigt werden.
					</p>
					<Button variant="outline" onclick={() => void loadInfo()}>
						<RefreshCwIcon class="size-4" aria-hidden="true" /> Erneut versuchen
					</Button>
				</Card.Content>
			</Card.Root>
		{/if}
	{:else if !canView}
		<!-- Upload-Link: nur hochladen, kein Inhalt -->
		{#if uploadLimits}
			{@render uploadArea(true)}
		{:else}
			<Card.Root>
				<Card.Content class="flex flex-col items-center gap-3 py-10 text-center">
					<CircleAlertIcon class="size-10 text-muted-foreground" aria-hidden="true" />
					<p class="max-w-sm text-sm text-muted-foreground" role="alert">
						Über diesen Link kann gerade nichts hochgeladen werden.
					</p>
				</Card.Content>
			</Card.Root>
		{/if}
	{:else}
		<!-- Ordner-Link -->
		<section class="flex flex-col gap-4" aria-labelledby="folder-title">
			<header class="flex flex-col gap-2">
				{#if crumbs.length > 1}
					<nav aria-label="Ordnerpfad" class="-mx-1 overflow-x-auto">
						<ol class="flex items-center gap-0.5 text-sm whitespace-nowrap">
							{#each crumbs as crumb, i (crumb.id ?? 'root')}
								<li class="flex min-w-0 items-center gap-0.5">
									{#if i > 0}
										<ChevronRightIcon
											class="size-3.5 shrink-0 text-muted-foreground"
											aria-hidden="true"
										/>
									{/if}
									{#if i === crumbs.length - 1}
										<span class="max-w-[12rem] truncate px-1 font-medium" aria-current="page">
											{crumb.name}
										</span>
									{:else}
										<button
											type="button"
											class="max-w-[10rem] truncate rounded px-1 py-0.5 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
											onclick={() => openFolder(crumb.id)}
										>
											{crumb.name}
										</button>
									{/if}
								</li>
							{/each}
						</ol>
					</nav>
				{/if}
				<div class="flex items-start gap-2">
					{#if parentCrumb}
						<Button
							variant="ghost"
							size="icon"
							class="mt-0.5 shrink-0"
							aria-label="Zurück zu {parentCrumb.name}"
							onclick={() => openFolder(parentCrumb.id)}
						>
							<ArrowLeftIcon class="size-4" aria-hidden="true" />
						</Button>
					{/if}
					<div class="min-w-0">
						<h1 id="folder-title" class="text-title break-words">
							{currentName}
						</h1>
						{#if listState === 'ready' && listing && listing.items.length > 0}
							<p class="text-sm text-muted-foreground">
								{countLabel(folderCount, fileItems.length)}
							</p>
						{/if}
					</div>
				</div>
			</header>

			{#if uploadLimits}
				{@render uploadArea(false)}
			{/if}

			{#if listState === 'loading'}
				<div
					class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4"
					aria-busy="true"
					aria-label="Ordner wird geladen"
				>
					{#each [0, 1, 2, 3, 4, 5] as i (i)}
						<Skeleton class="aspect-[4/5] w-full" />
					{/each}
				</div>
			{:else if listState === 'busy' || listState === 'error'}
				<Card.Root>
					<Card.Content class="flex flex-col items-center gap-3 py-8 text-center">
						<CircleAlertIcon class="size-8 text-muted-foreground" aria-hidden="true" />
						<p class="max-w-sm text-sm text-muted-foreground" role="alert">
							{listState === 'busy' ? BUSY_TEXT : listError}
						</p>
						<Button variant="outline" onclick={() => void loadListing(folderId, accessToken)}>
							<RefreshCwIcon class="size-4" aria-hidden="true" /> Erneut versuchen
						</Button>
					</Card.Content>
				</Card.Root>
			{:else if listState === 'missing'}
				<Card.Root>
					<Card.Content class="flex flex-col items-center gap-3 py-8 text-center">
						<CircleAlertIcon class="size-8 text-muted-foreground" aria-hidden="true" />
						<p class="max-w-sm text-sm text-muted-foreground" role="alert">
							Dieser Ordner wurde nicht gefunden.
						</p>
						<Button variant="outline" onclick={() => openFolder(null)}>Zum geteilten Ordner</Button>
					</Card.Content>
				</Card.Root>
			{:else if listing && listing.items.length === 0}
				<Card.Root>
					<Card.Content class="flex flex-col items-center gap-2 py-10 text-center">
						<FolderOpenIcon class="size-10 text-muted-foreground" aria-hidden="true" />
						<p class="text-sm text-muted-foreground">Dieser Ordner ist leer.</p>
					</Card.Content>
				</Card.Root>
			{:else if listing}
				<ul class="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
					{#each listing.items as node (node.id)}
						{@const thumb = thumbOf(node)}
						{@const isPdfThumb = !!thumb && previewKind(node.contentType) === 'pdf'}
						<li class="flex min-w-0">
							<button
								type="button"
								class="group flex h-full w-full flex-col overflow-hidden rounded-lg border bg-card text-left text-card-foreground transition-colors hover:border-primary/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
								onclick={() =>
									node.kind === 'folder' ? openFolder(node.id) : openPreview(node, fileItems)}
								aria-label={node.kind === 'folder'
									? `Ordner ${node.name} öffnen`
									: `${node.name} ansehen`}
							>
								<span
									class={[
										'relative flex aspect-[4/3] w-full justify-center overflow-hidden',
										isPdfThumb ? 'items-start px-[12%] pt-3' : 'items-center',
										node.kind === 'file' && !(thumb && !isPdfThumb)
											? fileTint(node.contentType, node.name)
											: 'bg-muted/50'
									]}
									style:background-color={node.kind === 'folder' && node.color
										? `color-mix(in srgb, ${node.color} 12%, transparent)`
										: undefined}
								>
									{#if thumb}
										<img
											src={thumb}
											alt=""
											loading="lazy"
											decoding="async"
											draggable="false"
											class={isPdfThumb
												? 'h-full w-full rounded-t-sm object-cover object-top shadow-sm ring-1 ring-border'
												: 'size-full object-cover'}
											use:watchImage
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
								</span>
								<span class="flex flex-col gap-0.5 px-2.5 pt-2 pb-2.5">
									<!-- feste Höhe für zwei Zeilen, Umbruch bevorzugt an _ - . -->
									<span
										class="line-clamp-2 h-10 text-sm leading-5 font-medium break-words"
										title={node.name}
									>
										{#each breakableName(node.name) as part, i (i)}{part}<wbr />{/each}
									</span>
									<span class="text-xs text-muted-foreground tabular-nums">
										{node.kind === 'folder'
											? 'Ordner'
											: `${typeLabel(node)} · ${formatBytes(node.sizeBytes)}`}
									</span>
								</span>
							</button>
						</li>
					{/each}
				</ul>
			{/if}
		</section>
	{/if}

	{#if infoState === 'ready' && info}
		<footer
			class="flex flex-col items-center gap-0.5 pt-2 text-center text-xs text-muted-foreground"
		>
			<span>Geteilt über {systemName}</span>
			{#if info.expiresOn}
				<span>Link gültig bis {formatDateDe(info.expiresOn)}</span>
			{/if}
		</footer>
	{/if}
</main>

{#snippet uploadArea(standalone: boolean)}
	{@const limits = uploadLimits!}
	<Card.Root aria-labelledby="upload-title">
		<Card.Header>
			<div class="flex items-start gap-3">
				<span
					class="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-link"
				>
					<UploadIcon class="size-5" aria-hidden="true" />
				</span>
				<div class="min-w-0">
					{#if standalone}
						<h1 id="upload-title" class="text-section break-words">
							Dateien hochladen in „{info?.name}“
						</h1>
						<Card.Description>
							Du kannst hier Dateien abgeben. Den Inhalt des Ordners siehst du nicht.
						</Card.Description>
					{:else}
						<h2 id="upload-title" class="font-semibold">Dateien hochladen</h2>
						<Card.Description>
							Neue Dateien landen immer direkt im geteilten Ordner „{info?.name}“, nicht in
							Unterordnern.
						</Card.Description>
					{/if}
				</div>
			</div>
		</Card.Header>
		<Card.Content class="flex flex-col gap-4">
			{#if upFinished}
				<div class="flex flex-col gap-3" role="status">
					<div class="flex items-center gap-2">
						<CircleCheckIcon class="size-6 shrink-0 text-success" aria-hidden="true" />
						<p class="font-semibold">Danke! {filesText(uploaded.length)} hochgeladen</p>
					</div>
					<ul class="flex flex-col gap-1 rounded-md border bg-muted/30 p-2 text-sm">
						{#each uploaded as u, i (i)}
							<li class="flex min-w-0 items-center gap-2">
								<span class="min-w-0 flex-1 truncate" title={u.name}>{u.name}</span>
								<span class="shrink-0 text-xs text-muted-foreground tabular-nums">
									{formatBytes(u.sizeBytes)}
								</span>
							</li>
						{/each}
					</ul>
					{#if upRejected.length > 0}
						<div class="flex flex-col gap-1 text-sm">
							<p class="font-medium text-destructive">
								{filesText(upRejected.length)} nicht hochgeladen:
							</p>
							<ul class="flex flex-col gap-0.5">
								{#each upRejected as it (it.key)}
									<li class="text-xs">
										<span class="break-all">{it.name}</span>
										<span class="text-destructive"> – {it.message}</span>
									</li>
								{/each}
							</ul>
						</div>
					{/if}
					<Button
						variant="outline"
						size="lg"
						class="h-11 w-full sm:w-auto sm:self-start"
						onclick={resetUploads}
					>
						<UploadIcon class="size-4" aria-hidden="true" /> Weitere Dateien hochladen
					</Button>
				</div>
			{:else}
				<div class="flex flex-col gap-1.5">
					<Label for="uploader-name"
						>Dein Name (optional, wird der Ordner-Eigentümer*in angezeigt)</Label
					>
					<Input
						id="uploader-name"
						autocomplete="name"
						maxlength={MAX_UPLOADER_NAME}
						bind:value={uploaderName}
						oninput={saveUploaderName}
						aria-invalid={nameError ? 'true' : undefined}
						aria-describedby={nameError ? 'uploader-name-error' : 'uploader-name-hint'}
						disabled={upRunning}
					/>
					{#if nameError}
						<p id="uploader-name-error" class="text-xs text-destructive" role="alert">
							{nameError}
						</p>
					{:else}
						<p id="uploader-name-hint" class="text-xs text-muted-foreground">
							Eigene Angabe, wird nicht geprüft – erscheint bei deinen Dateien als „hochgeladen von
							…“.
						</p>
					{/if}
				</div>

				<button
					type="button"
					class={[
						'flex w-full flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed px-4 text-center transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
						standalone ? 'min-h-48 py-8' : 'min-h-32 py-6',
						upDrag > 0
							? 'border-primary bg-primary/5'
							: 'border-muted-foreground/30 hover:border-primary/60 hover:bg-muted/40'
					]}
					onclick={openUploadPicker}
					ondragenter={onUpDragEnter}
					ondragover={onUpDragOver}
					ondragleave={onUpDragLeave}
					ondrop={onUpDrop}
					aria-describedby="upload-limits"
				>
					<UploadIcon
						class={['size-8', upDrag > 0 ? 'text-link' : 'text-muted-foreground']}
						aria-hidden="true"
					/>
					<span class="font-medium">
						{upDrag > 0 ? 'Zum Hochladen loslassen' : 'Dateien auswählen'}
					</span>
					<span class="hidden text-xs text-muted-foreground sm:inline">
						oder hierher ziehen – mehrere Dateien auf einmal möglich
					</span>
					<span class="text-xs text-muted-foreground sm:hidden">
						Mehrere Dateien auf einmal möglich
					</span>
				</button>
				<input
					bind:this={upInput}
					type="file"
					multiple
					accept={acceptAttr}
					class="sr-only"
					tabindex="-1"
					aria-hidden="true"
					onchange={onUploadPick}
				/>
				<div id="upload-limits" class="flex flex-col gap-1 text-xs text-muted-foreground">
					<p>
						Bis zu {limits.maxFiles} Dateien je Vorgang, je Datei max. {formatBytes(
							limits.maxFileBytes
						)}. Größere Auswahlen werden automatisch nacheinander hochgeladen.
					</p>
					{#if acceptAttr}
						<details>
							<summary class="cursor-pointer select-none">Erlaubte Dateitypen</summary>
							<p class="mt-1 break-words">{limits.allowedContentTypes.join(', ')}</p>
						</details>
					{/if}
				</div>

				{#if upNotice}
					<p
						class="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
						role="alert"
					>
						<CircleAlertIcon class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
						<span>{upNotice}</span>
					</p>
				{/if}

				{#if upItems.length > 0}
					<div class="flex flex-col gap-2">
						<div class="flex items-center justify-between gap-2 text-sm">
							<span class="font-medium">
								{upRunning ? 'Lädt hoch …' : `${upProgress.done} von ${upItems.length} hochgeladen`}
							</span>
							{#if upProgress.totalBytes > 0}
								<span class="text-xs text-muted-foreground tabular-nums">{upPercent} %</span>
							{/if}
						</div>
						<div
							class="h-2 overflow-hidden rounded-full bg-muted"
							role="progressbar"
							aria-label="Gesamtfortschritt"
							aria-valuemin={0}
							aria-valuemax={100}
							aria-valuenow={upPercent}
						>
							<div class="h-full bg-primary transition-all" style="width: {upPercent}%"></div>
						</div>
						<ul
							class="flex max-h-72 flex-col gap-1 overflow-y-auto rounded-md border p-2"
							aria-label="Ausgewählte Dateien"
						>
							{#each upItems as it (it.key)}
								<li class="flex min-h-9 items-center gap-2 text-sm">
									{#if it.status === 'waiting'}
										<ClockIcon class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
									{:else if it.status === 'uploading'}
										<LoaderCircleIcon
											class="size-4 shrink-0 animate-spin text-link"
											aria-hidden="true"
										/>
									{:else if it.status === 'done'}
										<CircleCheckIcon class="size-4 shrink-0 text-success" aria-hidden="true" />
									{:else}
										<CircleAlertIcon class="size-4 shrink-0 text-destructive" aria-hidden="true" />
									{/if}
									<div class="min-w-0 flex-1">
										<p class="truncate" title={it.name}>{it.name}</p>
										{#if it.status === 'error'}
											<p class="text-xs text-destructive">{it.message}</p>
										{:else if it.status === 'uploading'}
											<div
												class="mt-1 h-1 overflow-hidden rounded-full bg-muted"
												aria-hidden="true"
											>
												<div
													class="h-full bg-primary transition-all"
													style="width: {Math.round(it.progress * 100)}%"
												></div>
											</div>
										{/if}
									</div>
									<span class="shrink-0 text-xs text-muted-foreground tabular-nums">
										{formatBytes(it.size)}
									</span>
								</li>
							{/each}
						</ul>
						{#if !upRunning}
							<div class="flex flex-col gap-2 sm:flex-row">
								{#if upRetryable.length > 0}
									<Button size="lg" class="h-11" onclick={retryUploads}>
										<RotateCcwIcon class="size-4" aria-hidden="true" /> Erneut versuchen
									</Button>
								{/if}
								<Button variant="outline" size="lg" class="h-11" onclick={resetUploads}>
									Liste leeren
								</Button>
							</div>
						{/if}
					</div>
				{/if}
			{/if}
			<p class="sr-only" aria-live="polite">{upStatusText}</p>
		</Card.Content>
	</Card.Root>
{/snippet}

<FilePreview bind:open={previewOpen} nodes={previewNodes} bind:current={previewCurrent} {urlFor} />
