<script lang="ts">
	// Whiteboard-Editor: Kopfzeile (Name, Status, Anwesende, Teilen, Menü), Zeichenfläche, Werkzeuge, Eigenschaften,
	// Zoom/Minikarte, Kontextmenü, Tastatur, Zwischenablage, Drag & Drop, Upload und Dialoge.
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onDestroy, onMount, untrack } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import { toast } from 'svelte-sonner';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import Backpack from '@lucide/svelte/icons/backpack';
	import ClipboardPaste from '@lucide/svelte/icons/clipboard-paste';
	import Copy from '@lucide/svelte/icons/copy';
	import Download from '@lucide/svelte/icons/download';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import History from '@lucide/svelte/icons/history';
	import Lock from '@lucide/svelte/icons/lock';
	import Maximize from '@lucide/svelte/icons/maximize';
	import Minus from '@lucide/svelte/icons/minus';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Plus from '@lucide/svelte/icons/plus';
	import Redo2 from '@lucide/svelte/icons/redo-2';
	import Scan from '@lucide/svelte/icons/scan';
	import SquareDashedMousePointer from '@lucide/svelte/icons/square-dashed-mouse-pointer';
	import StickyNote from '@lucide/svelte/icons/sticky-note';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import Undo2 from '@lucide/svelte/icons/undo-2';
	import { apiFetch } from '$lib/sdk/client';
	import type { PrincipalInfo } from '$lib/sdk/types/sharing';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as ContextMenu from '$lib/components/ui/context-menu';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import {
		ConfirmDialog,
		EntityAvatar,
		PageTitle,
		ShareMenu,
		type ShareCandidate,
		type ShareEntry
	} from '$lib/components/layout';
	import { shareKey } from '$lib/components/layout/share-types';
	import {
		MAX_ASSET_BYTES,
		type Asset,
		type Board,
		type BoardDetail,
		type BoardShares,
		DEFAULT_USER_PREFS,
		type UserPrefs,
		type RefCard,
		type RefType,
		type WbElement
	} from '../../schemas';
	import BoardDialog from '../BoardDialog.svelte';
	import { BASE, errMsg } from '../helpers';
	import { boundsOfElements } from './bounds';
	import Canvas from './Canvas.svelte';
	import { EditorController } from './controller.svelte';
	import ExportDialog from './ExportDialog.svelte';
	import HistoryDialog from './HistoryDialog.svelte';
	import LinkDialog from './LinkDialog.svelte';
	import PropertiesBar from './PropertiesBar.svelte';
	import RefPicker from './RefPicker.svelte';
	import { assetUrl, fixedPalette, LIGHT, readPalette, type Palette } from './render';
	import SurfaceMenu from './SurfaceMenu.svelte';
	import { BoardStore } from './store.svelte';
	import { BoardSync } from './sync.svelte';
	import { browserMeasure } from './text-layout';
	import Toolbar from './Toolbar.svelte';
	import { refKey, type RenderContext } from './types';

	/**
	 * `embedded`: im iframe einer anderen Seite (`/embed/whiteboard/<id>`) – Kopf ohne Rücklink, Freigabe,
	 * Eigenschaften und Löschen; „Vollbild öffnen“ und Links in die App öffnen im obersten Fenster.
	 */
	let { initial, embedded = false }: { initial: BoardDetail; embedded?: boolean } = $props();

	const boardId = untrack(() => initial.id);
	let board = $state<Board>(untrack(() => initial));
	const store = new BoardStore();
	const refs = new SvelteMap<string, RefCard>();
	let gone = $state<'revoked' | 'deleted' | null>(null);

	const ctrl = new EditorController(store, {
		open: openElement,
		cursor: (p) => sync.presence({ cursor: p }),
		notice: (m) => toast.info(m)
	});

	const sync = new BoardSync(boardId, {
		onElements: (list) => store.applyRemote(list),
		onAck: (applied) => store.ack(applied),
		onReset: () => void reload(),
		onBoard: (b) => (board = { ...board, ...b }),
		onAccess: (level) => {
			if (level === store.level) return;
			store.level = level;
			board = { ...board, access: { ...board.access, level } };
			sync.setReadonly(level === 'read');
			if (level === 'read') {
				ctrl.finishEditing();
				ctrl.tool = 'select';
				toast.info('Du kannst dieses Whiteboard jetzt nur noch ansehen');
			} else {
				toast.success('Du kannst dieses Whiteboard jetzt bearbeiten');
			}
		},
		onGone: (reason) => (gone = reason),
		onRejected: (message) => {
			toast.error(message);
			void reload();
		}
	});
	store.sync = sync;
	untrack(() => {
		store.load(initial);
		sync.setReadonly(initial.access.level === 'read');
	});

	async function reload() {
		try {
			const detail = await apiFetch<BoardDetail>(`${BASE}/boards/${boardId}`);
			store.load(detail);
			board = detail;
			sync.resetSeq(detail.seq);
		} catch (e) {
			toast.error(errMsg(e, 'Whiteboard konnte nicht neu geladen werden'));
		}
	}

	// --- Darstellung ---------------------------------------------------------------
	const measure = browserMeasure();
	/** Farben aus Dunkelmodus/Theme; bei jedem Wechsel (Klasse/Stil am <html>) neu gelesen */
	let themePalette = $state<Palette>(LIGHT);
	/** Persönliche Ansicht (Standard: feste weiße Fläche) */
	let prefs = $state<UserPrefs>(DEFAULT_USER_PREFS);
	const fixedSurface = $derived(prefs.surface.mode === 'fixed' ? prefs.surface.color : null);
	const palette = $derived(fixedSurface ? fixedPalette(fixedSurface) : themePalette);

	let prefsTimer: ReturnType<typeof setTimeout> | null = null;
	/** Fläche ändern: sofort zeigen, kurz gebündelt speichern */
	function setSurface(surface: UserPrefs['surface']) {
		const before = prefs;
		prefs = { ...prefs, surface };
		if (prefsTimer) clearTimeout(prefsTimer);
		prefsTimer = setTimeout(() => {
			prefsTimer = null;
			apiFetch<UserPrefs>(`${BASE}/me/prefs`, { method: 'PUT', body: JSON.stringify(prefs) }).catch(
				(e) => {
					prefs = before;
					toast.error(errMsg(e, 'Einstellung konnte nicht gespeichert werden'));
				}
			);
		}, 400);
	}
	const rc: RenderContext = $derived({
		lookup: (id) => store.get(id),
		assets: store.assets,
		refs,
		measure,
		zoom: ctrl.view.zoom,
		editingId: ctrl.editing?.id ?? null,
		assetHref: (assetId, variant) => assetUrl(boardId, assetId, variant),
		palette,
		exporting: false
	});
	const peers = $derived([...sync.peers.values()]);
	/** Anwesende je Konto (mehrere Tabs = eine Person) */
	const myId = $derived((page.data.user as { id?: string } | null | undefined)?.id ?? null);
	/** Andere Personen (eigene weitere Tabs zählen nicht) */
	const people = $derived.by(() => {
		const map = new Map<string, (typeof peers)[number]>();
		for (const p of peers) if (p.userId !== myId && !map.has(p.userId)) map.set(p.userId, p);
		return [...map.values()];
	});

	let coarse = $state(false);
	let container = $state<HTMLDivElement | null>(null);
	let fullscreen = $state(false);

	// --- Karten auflösen (je Betrachter*in, gebündelt) ---
	let refTimer: ReturnType<typeof setTimeout> | null = null;
	const requested = new Set<string>();
	$effect(() => {
		const missing: { type: RefType; id: string }[] = [];
		for (const el of store.elements.values()) {
			if (el.type !== 'ref') continue;
			const k = refKey(el.data.refType, el.data.refId);
			if (!refs.has(k) && !requested.has(k))
				missing.push({ type: el.data.refType, id: el.data.refId });
		}
		if (!missing.length) return;
		if (refTimer) clearTimeout(refTimer);
		refTimer = setTimeout(() => void describe(missing), 120);
	});

	async function describe(items: { type: RefType; id: string }[]) {
		const list = items.filter((i) => !requested.has(refKey(i.type, i.id))).slice(0, 500);
		if (!list.length) return;
		for (const i of list) requested.add(refKey(i.type, i.id));
		try {
			const cards = await apiFetch<RefCard[]>(`${BASE}/refs/describe`, {
				method: 'POST',
				body: JSON.stringify({ items: list })
			});
			for (const c of cards) refs.set(refKey(c.type, c.id), c);
		} catch {
			for (const i of list) requested.delete(refKey(i.type, i.id));
		}
	}

	// --- Anwesenheit ---
	$effect(() => {
		const selection = [...store.selection];
		untrack(() => sync.presence({ selection }));
	});
	$effect(() => {
		const editing = ctrl.editing?.id ?? null;
		untrack(() => sync.presence({ editing }));
	});
	/** Wer bearbeitet gerade den Text, den ich bearbeite? */
	const editingByOther = $derived.by(() => {
		const id = ctrl.editing?.id;
		return id ? (peers.find((p) => p.editing === id)?.name ?? null) : null;
	});
	$effect(() => {
		if (editingByOther) toast.warning(`${editingByOther} bearbeitet diesen Text gerade auch`);
	});

	// --- Öffnen, Einfügen -------------------------------------------------------------
	function openUrl(url: string) {
		window.open(url, '_blank', 'noopener,noreferrer');
	}

	function openElement(el: WbElement) {
		if (el.type === 'link') openUrl(el.data.url);
		else if (el.type === 'file') openUrl(assetUrl(boardId, el.data.assetId, 'file'));
		else if (el.type === 'ref') {
			const card = refs.get(refKey(el.data.refType, el.data.refId));
			if (card?.available && card.href) openUrl(card.href);
			else toast.info('Kein Zugriff auf diesen Eintrag');
		}
	}

	/** Neues Kartenelement mittig im sichtbaren Bereich (leicht versetzt, wenn dort schon etwas liegt) */
	let insertCount = 0;
	function insertPoint(w: number, h: number) {
		const c = ctrl.viewCenter();
		const off = (insertCount++ % 6) * 24;
		return { x: Math.round(c.x - w / 2 + off), y: Math.round(c.y - h / 2 + off) };
	}

	function addElement(el: Omit<WbElement, 'id' | 'z' | 'version'> & { id?: string }) {
		const full = {
			...el,
			id: el.id ?? crypto.randomUUID(),
			z: store.maxZ() + 1,
			version: 0
		} as WbElement;
		store.apply([full]);
		store.selection.clear();
		store.selection.add(full.id);
		ctrl.tool = 'select';
		return full;
	}

	const base = { rotation: 0, locked: false };

	// Link
	let linkOpen = $state(false);
	let linkEdit = $state<WbElement | null>(null);
	function saveLink(v: { url: string; title: string; note: string }) {
		if (linkEdit?.type === 'link') {
			const el = store.get(linkEdit.id);
			if (el?.type === 'link') store.apply([{ ...el, data: { ...el.data, ...v } }]);
		} else {
			const p = insertPoint(280, 96);
			addElement({ type: 'link', data: { ...base, ...p, w: 280, h: 96, color: null, ...v } });
		}
		linkEdit = null;
	}

	// Karten
	let refOpen = $state(false);
	let refType = $state<RefType | null>(null);
	function insertRef(card: RefCard) {
		refs.set(refKey(card.type, card.id), card);
		requested.add(refKey(card.type, card.id));
		const tall = !!card.imageUrl;
		const w = 280;
		const h = tall ? 230 : 110;
		addElement({
			type: 'ref',
			data: { ...base, ...insertPoint(w, h), w, h, refType: card.type, refId: card.id, color: null }
		});
	}

	// Upload
	let fileInput = $state<HTMLInputElement | null>(null);
	let uploading = $state(0);

	async function uploadFiles(files: File[], at?: { x: number; y: number }) {
		if (!store.canEdit) return;
		let offset = 0;
		for (const file of files) {
			if (file.size > MAX_ASSET_BYTES) {
				toast.error(`„${file.name}“ ist größer als 25 MB`);
				continue;
			}
			uploading++;
			try {
				const form = new FormData();
				form.set('file', file);
				const asset = await apiFetch<Asset>(`${BASE}/boards/${boardId}/assets`, {
					method: 'POST',
					body: form
				});
				store.assets.set(asset.id, asset);
				placeAsset(asset, at ? { x: at.x + offset, y: at.y + offset } : undefined);
				offset += 32;
			} catch (e) {
				toast.error(errMsg(e, `„${file.name}“ konnte nicht hochgeladen werden`));
			} finally {
				uploading--;
			}
		}
	}

	function placeAsset(asset: Asset, at?: { x: number; y: number }) {
		if (asset.kind === 'image' && asset.width && asset.height) {
			const scale = Math.min(1, 480 / Math.max(asset.width, asset.height));
			const w = Math.max(40, Math.round(asset.width * scale));
			const h = Math.max(40, Math.round(asset.height * scale));
			const p = at
				? { x: Math.round(at.x - w / 2), y: Math.round(at.y - h / 2) }
				: insertPoint(w, h);
			addElement({
				type: 'image',
				data: {
					...base,
					...p,
					w,
					h,
					assetId: asset.id,
					alt: '',
					stroke: 'transparent',
					strokeWidth: 0
				}
			});
		} else {
			const w = 260;
			const h = asset.hasThumb ? 240 : 96;
			const p = at
				? { x: Math.round(at.x - w / 2), y: Math.round(at.y - h / 2) }
				: insertPoint(w, h);
			addElement({ type: 'file', data: { ...base, ...p, w, h, assetId: asset.id, color: null } });
		}
	}

	function onFilesPicked(e: Event) {
		const input = e.currentTarget as HTMLInputElement;
		const files = [...(input.files ?? [])];
		input.value = '';
		void uploadFiles(files);
	}

	// Drag & Drop von Dateien
	let dragOver = $state(false);
	function onDragOver(e: DragEvent) {
		if (!store.canEdit || !e.dataTransfer?.types.includes('Files')) return;
		e.preventDefault();
		e.dataTransfer.dropEffect = 'copy';
		dragOver = true;
	}
	function onDrop(e: DragEvent) {
		dragOver = false;
		if (!store.canEdit || !e.dataTransfer?.files.length) return;
		e.preventDefault();
		void uploadFiles([...e.dataTransfer.files], ctrl.world(e));
	}

	// --- Zwischenablage ---
	const CLIP_MARK = 'ep-whiteboard/v1';
	function isTyping(t: EventTarget | null): boolean {
		const el = t as HTMLElement | null;
		return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
	}
	function onCopy(e: ClipboardEvent, cut = false) {
		if (isTyping(e.target) || !store.selection.size || ctrl.editing) return;
		const list = ctrl.copy();
		e.clipboardData?.setData('text/plain', JSON.stringify({ [CLIP_MARK]: list }));
		e.preventDefault();
		if (cut) ctrl.deleteSelected();
	}
	function onPaste(e: ClipboardEvent) {
		if (isTyping(e.target) || ctrl.editing || !store.canEdit) return;
		const data = e.clipboardData;
		if (!data) return;
		const files = [...data.files];
		if (files.length) {
			e.preventDefault();
			void uploadFiles(files);
			return;
		}
		const text = data.getData('text/plain');
		if (!text) return;
		e.preventDefault();
		try {
			const parsed = JSON.parse(text) as Record<string, unknown>;
			const list = parsed?.[CLIP_MARK];
			if (Array.isArray(list)) {
				ctrl.paste(list as WbElement[]);
				return;
			}
		} catch {
			// kein eigenes Format
		}
		const t = text.trim();
		if (/^https?:\/\/\S+$/i.test(t) && t.length <= 2000) {
			const p = insertPoint(280, 96);
			addElement({
				type: 'link',
				data: { ...base, ...p, w: 280, h: 96, url: t, title: '', note: '', color: null }
			});
			return;
		}
		const p = insertPoint(220, 220);
		const el = ctrl.createElement('note', { ...p, w: 220, h: 220 }, { text: t.slice(0, 5000) });
		if (el) ctrl.tool = 'select';
	}

	// --- Tastatur ---
	function onKeyDown(e: KeyboardEvent) {
		if (gone || isTyping(e.target) || document.querySelector('[role="dialog"][data-state="open"]'))
			return;
		const mod = e.ctrlKey || e.metaKey;
		const key = e.key.toLowerCase();
		if (e.key === ' ' && !ctrl.spaceDown) {
			ctrl.spaceDown = true;
			e.preventDefault();
			return;
		}
		if (mod && key === 'z') {
			e.preventDefault();
			if (e.shiftKey) store.redo();
			else store.undo();
			return;
		}
		if (mod && key === 'y') {
			e.preventDefault();
			store.redo();
			return;
		}
		if (mod && key === 'a') {
			e.preventDefault();
			ctrl.selectAll();
			return;
		}
		if (mod && key === 'd') {
			e.preventDefault();
			ctrl.duplicate();
			return;
		}
		if (mod && (key === '+' || key === '=')) {
			e.preventDefault();
			ctrl.zoomStep(1);
			return;
		}
		if (mod && key === '-') {
			e.preventDefault();
			ctrl.zoomStep(-1);
			return;
		}
		if (mod || e.altKey) return;
		if (e.key === 'Delete' || e.key === 'Backspace') {
			if (store.selection.size && store.canEdit) {
				e.preventDefault();
				ctrl.deleteSelected();
			}
			return;
		}
		if (e.key === 'Escape') {
			if (store.selection.size) store.selection.clear();
			ctrl.tool = 'select';
			return;
		}
		if (e.key === 'Enter' && store.selection.size === 1) {
			const el = store.get([...store.selection][0]!);
			if (el?.type === 'shape') {
				e.preventDefault();
				ctrl.startEditing(el.id, 'text');
			}
			return;
		}
		if (e.key.startsWith('Arrow') && store.selection.size) {
			e.preventDefault();
			const step = e.shiftKey ? 10 : 1;
			const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
			const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
			ctrl.nudge(dx, dy);
			return;
		}
		if (e.key === '0') return ctrl.zoomTo(1);
		if (e.key === '1') return ctrl.fit();
		const tools: Record<string, typeof ctrl.tool> = {
			v: 'select',
			h: 'hand',
			n: 'note',
			r: 'shape',
			t: 'text',
			l: 'connector',
			p: 'pen',
			m: 'marker',
			e: 'eraser',
			f: 'frame'
		};
		const tool = tools[key];
		if (tool && (store.canEdit || tool === 'select' || tool === 'hand')) ctrl.tool = tool;
	}
	function onKeyUp(e: KeyboardEvent) {
		if (e.key === ' ') ctrl.spaceDown = false;
	}

	// --- Kontextmenü ---
	let ctxTarget = $state<string | null>(null);
	let ctxPoint = { x: 0, y: 0 };
	function onCtxMenu(e: MouseEvent) {
		ctxPoint = ctrl.world(e);
		const id = ctrl.elementAt(e.clientX, e.clientY);
		ctxTarget = id;
		if (id && !store.selection.has(id)) {
			store.selection.clear();
			store.selection.add(id);
		}
	}
	function onCtxPointerDown(e: PointerEvent) {
		if (e.pointerType !== 'mouse') {
			ctxPoint = ctrl.world(e);
			ctxTarget = ctrl.elementAt(e.clientX, e.clientY);
		}
	}
	const ctxEl = $derived(ctxTarget ? store.get(ctxTarget) : undefined);

	// --- Teilen ---
	let shares = $state<BoardShares | null>(null);
	const shareLevels = [
		{ value: 'read', label: 'Ansehen' },
		{ value: 'edit', label: 'Bearbeiten' }
	];
	async function loadShares() {
		try {
			shares = await apiFetch<BoardShares>(`${BASE}/boards/${boardId}/shares`);
		} catch {
			shares = null;
		}
	}
	async function searchPrincipals(q: string): Promise<ShareCandidate[]> {
		const found = await apiFetch<PrincipalInfo[]>(
			`${BASE}/principals?search=${encodeURIComponent(q)}`
		);
		return found
			.filter((p) => !(p.type === 'user' && p.id === board.owner.id))
			.map((p) => ({
				id: p.id,
				type: p.type,
				name: p.name,
				detail: p.detail ?? null,
				color: p.color ?? null,
				image: p.image ?? null
			}));
	}
	async function saveShares(next: ShareEntry[]) {
		try {
			shares = await apiFetch<BoardShares>(`${BASE}/boards/${boardId}/shares`, {
				method: 'PUT',
				body: JSON.stringify({
					shares: next.map((s) => ({ type: s.type ?? 'user', id: s.userId, level: s.level }))
				})
			});
		} catch (e) {
			throw new Error(errMsg(e, 'Freigabe fehlgeschlagen'), { cause: e });
		}
	}
	async function addShare(c: ShareCandidate, level: string) {
		const current = shares?.shares ?? [];
		const entry: ShareEntry = {
			userId: c.id,
			type: c.type ?? 'user',
			name: c.name,
			detail: c.detail ?? null,
			color: c.color ?? null,
			image: c.image ?? null,
			level
		};
		if (current.some((s) => shareKey(s) === shareKey(entry))) return;
		await saveShares([...current, entry]);
	}

	// --- Menü ---
	let settingsOpen = $state(false);
	let historyOpen = $state(false);
	let exportOpen = $state(false);
	let deleteOpen = $state(false);

	async function deleteBoard() {
		try {
			await apiFetch(`${BASE}/boards/${boardId}`, { method: 'DELETE' });
			toast.success('Whiteboard gelöscht');
			sync.dispose();
			await goto(BASE);
		} catch (e) {
			toast.error(errMsg(e, 'Löschen fehlgeschlagen'));
		}
	}

	async function toggleFullscreen() {
		try {
			if (document.fullscreenElement) await document.exitFullscreen();
			else await container?.requestFullscreen();
		} catch {
			toast.error('Vollbild wird von diesem Browser nicht unterstützt');
		}
	}

	// --- Minikarte (nur Desktop) ---
	const MINI = { w: 180, h: 120 };
	const world = $derived(boundsOfElements(store.ordered, (id) => store.get(id)));
	const mini = $derived.by(() => {
		const vis = ctrl.visible();
		const r = world
			? {
					x: Math.min(world.x, vis.x),
					y: Math.min(world.y, vis.y),
					w: Math.max(world.x + world.w, vis.x + vis.w) - Math.min(world.x, vis.x),
					h: Math.max(world.y + world.h, vis.y + vis.h) - Math.min(world.y, vis.y)
				}
			: vis;
		const s = Math.min(MINI.w / (r.w || 1), MINI.h / (r.h || 1));
		return { r, s, vis };
	});
	function miniJump(e: PointerEvent) {
		const t = e.currentTarget as SVGSVGElement;
		const b = t.getBoundingClientRect();
		const x = mini.r.x + (e.clientX - b.left) / mini.s;
		const y = mini.r.y + (e.clientY - b.top) / mini.s;
		const z = ctrl.view.zoom;
		ctrl.view = { zoom: z, panX: ctrl.size.w / 2 - x * z, panY: ctrl.size.h / 2 - y * z };
	}

	// --- Lebenszyklus ---
	let observer: ResizeObserver | null = null;
	onMount(() => {
		themePalette = readPalette();
		void apiFetch<UserPrefs>(`${BASE}/me/prefs`)
			.then((p) => (prefs = p))
			.catch(() => undefined);
		const themeObserver = new MutationObserver(() => {
			// erst nach dem Umschalten der Klassen/Variablen lesen
			requestAnimationFrame(() => (themePalette = readPalette()));
		});
		themeObserver.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ['class', 'style', 'data-app-theme']
		});
		const mq = window.matchMedia('(pointer: coarse)');
		coarse = mq.matches;
		const onMq = () => (coarse = mq.matches);
		mq.addEventListener('change', onMq);
		if (ctrl.svg) {
			observer = new ResizeObserver(([entry]) => {
				if (!entry) return;
				const first = ctrl.size.w === 0;
				ctrl.size = { w: entry.contentRect.width, h: entry.contentRect.height };
				if (first) {
					const focus = page.url.searchParams.get('focus');
					if (focus && store.get(focus)) ctrl.focus(focus);
					else ctrl.fit();
				}
			});
			observer.observe(ctrl.svg);
		}
		sync.connect(initial.seq);
		if (!embedded) void loadShares();
		const onFs = () => (fullscreen = !!document.fullscreenElement);
		document.addEventListener('fullscreenchange', onFs);
		const onUnload = () => {
			if (sync.hasUnsaved()) void sync.flush(true);
		};
		window.addEventListener('pagehide', onUnload);
		return () => {
			themeObserver.disconnect();
			mq.removeEventListener('change', onMq);
			document.removeEventListener('fullscreenchange', onFs);
			window.removeEventListener('pagehide', onUnload);
		};
	});
	onDestroy(() => {
		observer?.disconnect();
		if (refTimer) clearTimeout(refTimer);
		sync.dispose();
	});

	const status = $derived(
		gone
			? null
			: sync.status === 'live'
				? sync.saving
					? 'Speichert …'
					: people.length
						? `Live · ${people.length + 1} hier`
						: 'Live'
				: sync.status === 'offline'
					? 'Offline – Änderungen werden nachgeholt'
					: 'Verbindet …'
	);
</script>

<svelte:window
	onkeydown={onKeyDown}
	onkeyup={onKeyUp}
	oncopy={(e) => onCopy(e)}
	oncut={(e) => onCopy(e, true)}
	onpaste={onPaste}
/>

<PageTitle title={board.name} />

<div bind:this={container} class="flex h-full min-h-0 flex-col">
	<!-- Kopfzeile -->
	<header
		class="app-glass flex h-12 shrink-0 items-center gap-2 border-b bg-topbar-surface px-2 sm:px-3"
	>
		{#if !embedded}
			<Button
				variant="ghost"
				size="icon"
				href={BASE}
				aria-label="Zurück zu allen Whiteboards"
				title="Alle Whiteboards"
			>
				<ArrowLeft />
			</Button>
		{/if}
		<div class="flex min-w-0 flex-1 items-center gap-2">
			<span
				class="size-2.5 shrink-0 rounded-full bg-muted-foreground/40"
				style:background-color={board.color ?? undefined}
				aria-hidden="true"
			></span>
			<h1 class="truncate text-sm font-semibold sm:text-base">{board.name}</h1>
			{#if board.actionId && board.actionName}
				<Badge variant="outline" class="hidden sm:inline-flex">
					<a
						href={`/modules/actions/${board.actionId}`}
						target={embedded ? '_top' : undefined}
						class="inline-flex items-center gap-1 hover:underline"
					>
						<Backpack aria-hidden="true" class="size-3" />
						{board.actionName}
					</a>
				</Badge>
			{/if}
			{#if !store.canEdit}
				<Badge variant="secondary"><Lock aria-hidden="true" class="size-3" /> Nur Ansicht</Badge>
			{/if}
			<span
				class="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground"
				role="status"
				aria-live="polite"
				title={status ?? undefined}
			>
				{#if status}
					<span
						class={[
							'size-2 rounded-full',
							sync.status === 'live'
								? 'bg-success'
								: sync.status === 'offline'
									? 'bg-warning'
									: 'bg-muted-foreground/50'
						]}
						aria-hidden="true"
					></span>
					<span class="sr-only md:not-sr-only">{status}</span>
				{/if}
				{#if uploading}· Lädt {uploading} {uploading === 1 ? 'Datei' : 'Dateien'} hoch …{/if}
			</span>
		</div>
		{#if people.length}
			<div
				class="flex -space-x-2"
				aria-label={`Gerade hier: ${people.map((p) => p.name).join(', ')}`}
			>
				{#each people.slice(0, 5) as p (p.userId)}
					<!-- farbiger Rand kommt von EntityAvatar (`color`), der Ring trennt überlappende Bilder -->
					<span class="inline-flex rounded-full ring-2 ring-background" title={p.name}>
						<EntityAvatar name={p.name} src={p.image} color={p.color} size={28} />
					</span>
				{/each}
				{#if people.length > 5}
					<span
						class="flex size-7 items-center justify-center rounded-full bg-muted text-xs ring-2 ring-background"
						>+{people.length - 5}</span
					>
				{/if}
			</div>
		{/if}
		{#if shares && !embedded}
			<ShareMenu
				shares={shares.shares}
				owner={{
					name: board.owner.id === myId ? `${shares.owner.name} (du)` : shares.owner.name,
					image: shares.owner.image
				}}
				levels={shareLevels}
				defaultLevel="edit"
				canManage={shares.canManage}
				search={searchPrincipals}
				onadd={addShare}
				onchange={(key, level) =>
					saveShares(
						(shares?.shares ?? []).map((s) => (shareKey(s) === key ? { ...s, level } : s))
					)}
				onremove={(key) => saveShares((shares?.shares ?? []).filter((s) => shareKey(s) !== key))}
				description={board.actionId
					? 'Wer das Whiteboard sehen oder mitbearbeiten darf – zusätzlich alle mit Zugriff auf die Aktion.'
					: 'Wer das Whiteboard sehen oder mitbearbeiten darf.'}
				everyoneLabel={shares.everyoneLabel}
				placeholder="Gruppe, Rolle, Person suchen …"
				searchLabel="Freigabe hinzufügen"
				emptyResultText="Niemand gefunden"
			/>
		{/if}
		{#if embedded}
			<Button
				variant="outline"
				size="sm"
				href={`${BASE}/${encodeURIComponent(boardId)}`}
				target="_top"
				title="Whiteboard in der App öffnen"
			>
				<ExternalLink /> <span class="hidden sm:inline">Vollbild öffnen</span>
			</Button>
		{/if}
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Button {...props} variant="ghost" size="icon" aria-label="Whiteboard-Menü" title="Menü">
						<Ellipsis />
					</Button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="end">
				{#if store.canEdit && !embedded}
					<DropdownMenu.Item onclick={() => (settingsOpen = true)}
						><Pencil /> Eigenschaften …</DropdownMenu.Item
					>
				{/if}
				<DropdownMenu.Item onclick={() => (historyOpen = true)}
					><History /> Versionen …</DropdownMenu.Item
				>
				<DropdownMenu.Item onclick={() => (exportOpen = true)}
					><Download /> Exportieren …</DropdownMenu.Item
				>
				<DropdownMenu.Item onclick={toggleFullscreen}
					><Maximize /> {fullscreen ? 'Vollbild beenden' : 'Vollbild'}</DropdownMenu.Item
				>
				{#if board.access.canShare && !embedded}
					<DropdownMenu.Separator />
					<DropdownMenu.Item variant="destructive" onclick={() => (deleteOpen = true)}
						><Trash2 /> Löschen …</DropdownMenu.Item
					>
				{/if}
			</DropdownMenu.Content>
		</DropdownMenu.Root>
	</header>

	<!-- Fläche -->
	<div
		class="relative min-h-0 flex-1"
		role="presentation"
		ondragover={onDragOver}
		ondragleave={() => (dragOver = false)}
		ondrop={onDrop}
	>
		<ContextMenu.Root>
			<ContextMenu.Trigger oncontextmenu={onCtxMenu} onpointerdown={onCtxPointerDown}>
				{#snippet child({ props })}
					<div {...props} class="absolute inset-0 [-webkit-touch-callout:none]">
						<Canvas
							{ctrl}
							{rc}
							background={board.background}
							surface={fixedSurface}
							{peers}
							{coarse}
							ariaLabel={`Whiteboard „${board.name}“. Werkzeuge über die Leiste oder Tasten (V Auswählen, N Notiz, R Form, T Text, L Verbinden, P Stift). Strg+Z rückgängig.`}
						/>
					</div>
				{/snippet}
			</ContextMenu.Trigger>
			<ContextMenu.Content class="w-56">
				{#if ctxEl}
					{#if ctxEl.type === 'link' || ctxEl.type === 'ref' || ctxEl.type === 'file'}
						<ContextMenu.Item onclick={() => ctxEl && openElement(ctxEl)}
							><ExternalLink /> Öffnen</ContextMenu.Item
						>
					{/if}
					{#if store.canEdit}
						{#if ctxEl.type === 'shape' && !ctxEl.data.locked}
							<ContextMenu.Item onclick={() => ctxEl && ctrl.startEditing(ctxEl.id, 'text')}
								><Pencil /> Text bearbeiten</ContextMenu.Item
							>
						{/if}
						{#if ctxEl.type === 'link' && !ctxEl.data.locked}
							<ContextMenu.Item
								onclick={() => {
									linkEdit = ctxEl ?? null;
									linkOpen = true;
								}}><Pencil /> Link bearbeiten</ContextMenu.Item
							>
						{/if}
						<ContextMenu.Item onclick={() => ctrl.duplicate()}
							><Copy /> Duplizieren <ContextMenu.Shortcut>Strg+D</ContextMenu.Shortcut
							></ContextMenu.Item
						>
						<ContextMenu.Item onclick={() => ctrl.bringToFront()}>Nach vorne</ContextMenu.Item>
						<ContextMenu.Item onclick={() => ctrl.sendToBack()}>Nach hinten</ContextMenu.Item>
						<ContextMenu.Item onclick={() => ctrl.toggleLock()}
							><Lock /> {ctxEl.data.locked ? 'Entsperren' : 'Sperren'}</ContextMenu.Item
						>
						<ContextMenu.Separator />
						<ContextMenu.Item
							variant="destructive"
							disabled={ctxEl.data.locked}
							onclick={() => ctrl.deleteSelected()}
						>
							<Trash2 /> Löschen <ContextMenu.Shortcut>Entf</ContextMenu.Shortcut>
						</ContextMenu.Item>
					{/if}
				{:else}
					{#if store.canEdit}
						<ContextMenu.Item
							onclick={() => {
								const el = ctrl.createElement('note', {
									x: ctxPoint.x - 100,
									y: ctxPoint.y - 100,
									w: 200,
									h: 200
								});
								if (el) ctrl.startEditing(el.id, 'text');
							}}><StickyNote /> Notiz hier</ContextMenu.Item
						>
						<ContextMenu.Item onclick={() => ctrl.paste(undefined, ctxPoint)}
							><ClipboardPaste /> Einfügen</ContextMenu.Item
						>
					{/if}
					<ContextMenu.Item onclick={() => ctrl.selectAll()}
						><SquareDashedMousePointer /> Alles auswählen</ContextMenu.Item
					>
					<ContextMenu.Item onclick={() => ctrl.fit()}><Scan /> Alles zeigen</ContextMenu.Item>
				{/if}
			</ContextMenu.Content>
		</ContextMenu.Root>

		<div class="pointer-events-none absolute inset-0">
			<Toolbar
				{ctrl}
				canEdit={store.canEdit && !gone}
				onupload={() => fileInput?.click()}
				onlink={() => {
					linkEdit = null;
					linkOpen = true;
				}}
				onref={(type) => {
					refType = type ?? null;
					refOpen = true;
				}}
			/>
			<PropertiesBar
				{ctrl}
				onopen={openElement}
				onedit={(el) => {
					linkEdit = el;
					linkOpen = true;
				}}
			/>

			<!-- Rückgängig + Zoom -->
			<div
				class="pointer-events-auto absolute right-3 bottom-16 z-10 flex items-center gap-0.5 rounded-xl border bg-popover p-1 shadow-lg sm:bottom-3"
			>
				{#if store.canEdit}
					<Button
						variant="ghost"
						size="icon"
						aria-label="Rückgängig (Strg+Z)"
						title="Rückgängig (Strg+Z)"
						disabled={!store.canUndo}
						onclick={() => store.undo()}
					>
						<Undo2 />
					</Button>
					<Button
						variant="ghost"
						size="icon"
						aria-label="Wiederholen (Strg+Y)"
						title="Wiederholen (Strg+Y)"
						disabled={!store.canRedo}
						onclick={() => store.redo()}
					>
						<Redo2 />
					</Button>
					<div class="mx-0.5 h-6 w-px bg-border" aria-hidden="true"></div>
				{/if}
				<SurfaceMenu {prefs} onchange={setSurface} />
				<div class="mx-0.5 h-6 w-px bg-border" aria-hidden="true"></div>
				<Button
					variant="ghost"
					size="icon"
					aria-label="Verkleinern"
					title="Verkleinern"
					onclick={() => ctrl.zoomStep(-1)}><Minus /></Button
				>
				<button
					type="button"
					class="min-w-12 rounded-md px-1 text-xs tabular-nums hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
					title="Auf 100 % setzen (0)"
					onclick={() => ctrl.zoomTo(1)}
				>
					{Math.round(ctrl.view.zoom * 100)} %
				</button>
				<Button
					variant="ghost"
					size="icon"
					aria-label="Vergrößern"
					title="Vergrößern"
					onclick={() => ctrl.zoomStep(1)}><Plus /></Button
				>
				<Button
					variant="ghost"
					size="icon"
					aria-label="Alles zeigen (1)"
					title="Alles zeigen (1)"
					onclick={() => ctrl.fit()}><Scan /></Button
				>
			</div>

			<!-- Minikarte -->
			{#if world && ctrl.size.w > 900}
				<div
					class="pointer-events-auto absolute right-3 bottom-16 z-10 hidden overflow-hidden rounded-lg border bg-card shadow-md lg:block"
				>
					<svg
						width={MINI.w}
						height={MINI.h}
						role="img"
						aria-label="Übersichtskarte (klicken, um dorthin zu springen)"
						class="cursor-pointer"
						onpointerdown={miniJump}
					>
						<g transform={`scale(${mini.s}) translate(${-mini.r.x} ${-mini.r.y})`}>
							{#each store.ordered as el (el.id)}
								{#if el.type !== 'connector'}
									<rect
										x={el.data.x}
										y={el.data.y}
										width={el.data.w}
										height={el.data.h}
										fill={el.type === 'shape' && el.data.fill !== 'transparent'
											? el.data.fill
											: el.type === 'frame'
												? 'none'
												: palette.cardBorder}
										stroke={el.type === 'frame' ? '#94a3b8' : 'none'}
										stroke-width={1 / mini.s}
									/>
								{/if}
							{/each}
							<rect
								x={mini.vis.x}
								y={mini.vis.y}
								width={mini.vis.w}
								height={mini.vis.h}
								fill="#2563eb"
								fill-opacity="0.08"
								stroke="#2563eb"
								stroke-width={1.5 / mini.s}
							/>
						</g>
					</svg>
				</div>
			{/if}

			{#if dragOver}
				<div
					class="absolute inset-3 flex items-center justify-center rounded-xl border-2 border-dashed border-ring bg-background/60 text-sm font-medium"
				>
					Dateien hier ablegen
				</div>
			{/if}

			{#if gone}
				<div
					class="pointer-events-auto absolute inset-0 z-20 flex items-center justify-center bg-background/80 p-6"
				>
					<div class="max-w-sm space-y-3 rounded-xl border bg-card p-6 text-center shadow-lg">
						<p class="text-section">
							{gone === 'deleted' ? 'Whiteboard gelöscht' : 'Kein Zugriff mehr'}
						</p>
						<p class="text-sm text-muted-foreground">
							{gone === 'deleted'
								? 'Jemand hat dieses Whiteboard gelöscht.'
								: 'Die Freigabe für dich wurde entfernt.'}
						</p>
						{#if !embedded}
							<Button href={BASE}><ArrowLeft /> Zu den Whiteboards</Button>
						{/if}
					</div>
				</div>
			{/if}
		</div>
	</div>
</div>

<input
	bind:this={fileInput}
	type="file"
	multiple
	class="hidden"
	aria-hidden="true"
	tabindex="-1"
	onchange={onFilesPicked}
/>

<LinkDialog
	bind:open={linkOpen}
	link={linkEdit?.type === 'link' ? linkEdit.data : null}
	onsave={saveLink}
/>
<RefPicker bind:open={refOpen} initialType={refType} onpick={insertRef} />
<HistoryDialog bind:open={historyOpen} {boardId} canEdit={store.canEdit} onrestored={reload} />
<ExportDialog
	bind:open={exportOpen}
	{boardId}
	boardName={board.name}
	elements={store.ordered}
	selection={[...store.selection]}
	{rc}
	lookup={(id) => store.get(id)}
/>
<BoardDialog bind:open={settingsOpen} {board} onsaved={(b) => (board = { ...board, ...b })} />
<ConfirmDialog
	bind:open={deleteOpen}
	title="Whiteboard löschen?"
	description="Alle Elemente, Bilder, Dateien und Versionen werden endgültig gelöscht – auch für alle, mit denen es geteilt ist."
	confirmLabel="Löschen"
	destructive
	onconfirm={deleteBoard}
/>

<!-- Bildschirmpunkt-Helfer für Tests/Barrierefreiheit: aktuelle Auswahl -->
<span class="sr-only" aria-live="polite">
	{store.selection.size
		? `${store.selection.size} ${store.selection.size === 1 ? 'Element' : 'Elemente'} ausgewählt`
		: ''}
</span>
