<script lang="ts">
	// Eine geöffnete Notiz: Live-Verbindung (Yjs über SSE), Kopf mit Brotkrumen/Anwesenheit/Status/Teilen/Menü,
	// Titel direkt über dem Text, Editor und optional die Quelltext-Ansicht. Wird je Notiz neu aufgebaut ({#key}).
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onDestroy, onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import type { Editor } from '@tiptap/core';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Download from '@lucide/svelte/icons/download';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import FileCode from '@lucide/svelte/icons/file-code';
	import FilePlus from '@lucide/svelte/icons/file-plus';
	import FolderInput from '@lucide/svelte/icons/folder-input';
	import Globe from '@lucide/svelte/icons/globe';
	import History from '@lucide/svelte/icons/history';
	import Lock from '@lucide/svelte/icons/lock';
	import Palette from '@lucide/svelte/icons/palette';
	import PanelLeft from '@lucide/svelte/icons/panel-left';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { apiFetch, can } from '$lib/sdk/client';
	import { ConfirmDialog, PageTitle, ShareMenu, type ShareCandidate } from '$lib/components/layout';
	import { shareKey } from '$lib/components/layout/share-types';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import {
		DEFAULT_USER_PREFS,
		MAX_TITLE,
		PERM,
		presenceColor,
		type NoteDetail,
		type NoteShares,
		type UserPrefs
	} from '../schemas';
	import NoteEditor from './editor/NoteEditor.svelte';
	import SourcePanel from './editor/SourcePanel.svelte';
	import { NoteSync } from './editor/sync.svelte';
	import ExportDialog from './ExportDialog.svelte';
	import {
		API,
		BASE,
		createNote,
		errMsg,
		loadShares,
		noteTitle,
		notePath,
		saveShares,
		searchPrincipals,
		SHARE_LEVELS_UI,
		shareCandidateEntry,
		shareDescription,
		shareEntries
	} from './helpers';
	import MoveDialog from './MoveDialog.svelte';
	import NoteLinkDialog from './NoteLinkDialog.svelte';
	import NoteIcon from './NoteIcon.svelte';
	import PeerAvatars from './PeerAvatars.svelte';
	import StyleDialog from './StyleDialog.svelte';
	import SurfaceMenu from './SurfaceMenu.svelte';
	import { surfaceStyle } from './surface';
	import type { NoteTreeState } from './tree/tree-state.svelte';
	import VersionsDialog from './VersionsDialog.svelte';

	let {
		initial,
		tree,
		ontoggletree,
		onreset
	}: {
		initial: NoteDetail;
		tree: NoteTreeState;
		ontoggletree: () => void;
		/** Dokument komplett neu laden (z. B. nach `reset`) */
		onreset: () => void;
	} = $props();

	// svelte-ignore state_referenced_locally
	let note = $state<NoteDetail>(initial);
	// svelte-ignore state_referenced_locally
	let title = $state(initial.title);
	let titleFocused = $state(false);
	let titleTimer: ReturnType<typeof setTimeout> | null = null;
	let gone = $state<'revoked' | 'deleted' | null>(null);
	let editor = $state.raw<Editor | null>(null);
	let sourceOpen = $state(false);
	let shares = $state<NoteShares | null>(null);
	let versionsOpen = $state(false);
	let exportOpen = $state(false);
	let styleOpen = $state(false);
	let moveOpen = $state(false);
	let deleteOpen = $state(false);
	let linkOpen = $state(false);
	const canLink = $derived(
		can((page.data.permissions as string[] | undefined) ?? [], PERM.linkCreate)
	);
	/** Persönlicher Hintergrund (gilt für alle Notizen) */
	let prefs = $state<UserPrefs>(DEFAULT_USER_PREFS);
	const surface = $derived(surfaceStyle(prefs));

	async function loadPrefs() {
		try {
			prefs = await apiFetch<UserPrefs>('/modules/notes/me/prefs');
		} catch {
			// Standard behalten (Hintergrund wie Modus/Theme)
		}
	}

	async function changeSurface(next: UserPrefs['surface']) {
		const before = prefs;
		prefs = { ...prefs, surface: next };
		try {
			prefs = await apiFetch<UserPrefs>('/modules/notes/me/prefs', {
				method: 'PUT',
				body: JSON.stringify(prefs)
			});
		} catch {
			prefs = before;
			toast.error('Hintergrund konnte nicht gespeichert werden');
		}
	}

	const me = $derived(
		(page.data.user as { id?: string; name?: string } | null | undefined) ?? null
	);
	// svelte-ignore state_referenced_locally
	const user = {
		name: me?.name ?? 'Unbekannt',
		color: presenceColor(me?.id ?? 'x')
	};

	// svelte-ignore state_referenced_locally
	const sync = new NoteSync(
		note.id,
		{
			onMeta: (m) => {
				note = { ...note, icon: m.icon, color: m.color, title: m.title };
				if (!titleFocused && !titleTimer) title = m.title;
				tree.patch(m.id, { title: m.title, icon: m.icon, color: m.color });
			},
			onAccess: (level) => {
				note = { ...note, level };
				toast.info(
					level === 'edit'
						? 'Du darfst jetzt mitbearbeiten.'
						: 'Du kannst diese Notiz nur noch ansehen.'
				);
			},
			onGone: (reason) => (gone = reason),
			onReset: () => onreset(),
			onRejected: (message) => toast.error(message)
		},
		note.level
	);

	const canEdit = $derived(note.level === 'edit' && !sync.readonly && !gone);
	const peers = $derived([...sync.peers.values()]);
	const status = $derived(
		gone
			? null
			: sync.status === 'offline'
				? 'Offline – Änderungen werden nachgeholt'
				: sync.status === 'connecting' && !sync.synced
					? 'Verbindet …'
					: sync.saving
						? 'Speichert …'
						: 'Gespeichert'
	);

	// --- Titel ---
	async function saveTitle() {
		if (titleTimer) clearTimeout(titleTimer);
		titleTimer = null;
		const next = title.trim();
		if (next === note.title.trim() || !canEdit) return;
		try {
			const updated = await apiFetch<NoteDetail>(`${API}/notes/${note.id}`, {
				method: 'PATCH',
				body: JSON.stringify({ title: next })
			});
			note = { ...note, title: updated.title, updatedAt: updated.updatedAt };
			tree.patch(note.id, { title: updated.title });
		} catch (e) {
			toast.error(errMsg(e, 'Titel konnte nicht gespeichert werden'));
		}
	}
	function onTitleInput() {
		if (titleTimer) clearTimeout(titleTimer);
		titleTimer = setTimeout(() => void saveTitle(), 600);
	}

	// --- Teilen ---
	async function reloadShares() {
		try {
			shares = await loadShares(note.id);
		} catch {
			shares = null;
		}
	}
	const entries = $derived(shares ? shareEntries(shares) : []);
	async function putShares(next: typeof entries) {
		shares = await saveShares(note.id, next);
	}

	// --- Aktionen ---
	async function createSubpage(): Promise<{ id: string; title: string } | null> {
		try {
			const child = await createNote({ parentId: note.id, title: 'Neue Seite' });
			await tree.expand(note.id);
			await tree.refresh(note.id);
			note = { ...note, hasChildren: true };
			toast.success('Unterseite angelegt', {
				action: { label: 'Öffnen', onClick: () => void goto(notePath(child.id)) }
			});
			return { id: child.id, title: child.title };
		} catch (e) {
			toast.error(errMsg(e, 'Unterseite konnte nicht angelegt werden'));
			return null;
		}
	}

	async function trash() {
		try {
			await apiFetch(`${API}/notes/${note.id}`, { method: 'DELETE' });
			toast.success('In den Papierkorb gelegt');
			await tree.refresh(note.parentId);
			sync.dispose();
			await goto(note.parentId ? notePath(note.parentId) : BASE);
		} catch (e) {
			toast.error(errMsg(e, 'Löschen fehlgeschlagen'));
		}
	}

	function applyDetail(updated: NoteDetail) {
		note = { ...note, ...updated, level: note.level };
		if (!titleFocused) title = updated.title;
	}

	// --- Lebenszyklus ---
	onMount(() => {
		sync.connect();
		void reloadShares();
		void loadPrefs();
		const beforeUnload = (e: BeforeUnloadEvent) => {
			if (sync.hasUnsaved()) {
				e.preventDefault();
				e.returnValue = '';
			}
		};
		const pageHide = () => {
			if (sync.hasUnsaved()) void sync.flush(true);
		};
		window.addEventListener('beforeunload', beforeUnload);
		window.addEventListener('pagehide', pageHide);
		return () => {
			window.removeEventListener('beforeunload', beforeUnload);
			window.removeEventListener('pagehide', pageHide);
		};
	});
	onDestroy(() => {
		if (titleTimer) void saveTitle();
		sync.dispose();
	});
</script>

<PageTitle title={noteTitle(note.title)} />

<div class="flex h-full min-h-0 flex-col">
	<header class="flex h-12 shrink-0 items-center gap-2 border-b bg-background px-2 sm:px-3">
		<Button
			variant="ghost"
			size="icon-sm"
			aria-label="Seitenbaum ein- oder ausblenden"
			title="Seitenbaum"
			onclick={ontoggletree}
		>
			<PanelLeft />
		</Button>
		<nav class="flex min-w-0 flex-1 items-center gap-1 text-sm" aria-label="Brotkrumen">
			<a href={BASE} class="hidden shrink-0 text-muted-foreground hover:underline sm:inline"
				>Notizen</a
			>
			{#each note.breadcrumbs as b (b.id)}
				<ChevronRight
					class="hidden size-3.5 shrink-0 text-muted-foreground sm:block"
					aria-hidden="true"
				/>
				<a
					href={notePath(b.id)}
					class="hidden max-w-40 min-w-0 items-center gap-1 truncate text-muted-foreground hover:underline sm:flex"
				>
					<NoteIcon icon={b.icon} color={null} class="size-3.5" />
					<span class="truncate">{noteTitle(b.title)}</span>
				</a>
			{/each}
			<ChevronRight
				class="hidden size-3.5 shrink-0 text-muted-foreground sm:block"
				aria-hidden="true"
			/>
			<span class="flex min-w-0 items-center gap-1 font-medium">
				<NoteIcon icon={note.icon} color={note.color} class="size-4" />
				<span class="truncate">{noteTitle(title)}</span>
			</span>
			{#if !canEdit && !gone}
				<Badge variant="secondary" class="ml-1 shrink-0"><Lock class="size-3" /> Nur Ansicht</Badge>
			{/if}
		</nav>
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
		</span>
		<PeerAvatars {peers} myId={me?.id ?? null} />
		{#if shares}
			<ShareMenu
				shares={entries}
				owner={shares.owner
					? {
							name: shares.owner.id === me?.id ? `${shares.owner.name} (du)` : shares.owner.name,
							image: shares.owner.image
						}
					: undefined}
				levels={SHARE_LEVELS_UI}
				defaultLevel="edit"
				canManage={shares.canManage && !gone}
				search={(q) => searchPrincipals(q, note.ownerId)}
				onadd={async (c: ShareCandidate, level: string) => {
					const entry = shareCandidateEntry(c, level);
					if (entries.some((s) => shareKey(s) === shareKey(entry))) return;
					await putShares([...entries, entry]);
				}}
				onchange={(key, level) =>
					putShares(entries.map((s) => (shareKey(s) === key ? { ...s, level } : s)))}
				onremove={(key) => putShares(entries.filter((s) => shareKey(s) !== key))}
				description={shareDescription(shares, !!note.actionId)}
				everyoneLabel={shares.everyoneLabel}
				placeholder="Gruppe, Rolle, Person suchen …"
				searchLabel="Freigabe hinzufügen"
				emptyResultText="Niemand gefunden"
			/>
		{/if}
		<SurfaceMenu {prefs} onchange={changeSurface} />
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Button {...props} variant="ghost" size="icon-sm" aria-label="Notiz-Menü" title="Menü">
						<Ellipsis />
					</Button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content align="end" class="w-60">
				<DropdownMenu.Item onclick={() => (sourceOpen = !sourceOpen)}>
					<FileCode />
					{sourceOpen ? 'Quelltext ausblenden' : 'Quelltext (Markdown)'}
				</DropdownMenu.Item>
				<DropdownMenu.Item onclick={() => (versionsOpen = true)}
					><History /> Versionen …</DropdownMenu.Item
				>
				<DropdownMenu.Item onclick={() => (exportOpen = true)}
					><Download /> Exportieren …</DropdownMenu.Item
				>
				{#if canEdit}
					<DropdownMenu.Separator />
					{#if note.canCreateChild}
						<DropdownMenu.Item onclick={() => void createSubpage()}>
							<FilePlus /> Unterseite anlegen
						</DropdownMenu.Item>
					{/if}
					<DropdownMenu.Item onclick={() => (styleOpen = true)}
						><Palette /> Aussehen …</DropdownMenu.Item
					>
					<DropdownMenu.Item onclick={() => (moveOpen = true)}>
						<FolderInput /> Verschieben …
					</DropdownMenu.Item>
				{/if}
				{#if note.canShare && canLink && !gone}
					<DropdownMenu.Separator />
					<DropdownMenu.Item onclick={() => (linkOpen = true)}>
						<Globe /> Öffentlicher Link …
					</DropdownMenu.Item>
				{/if}
				{#if note.canShare && !gone}
					<DropdownMenu.Separator />
					<DropdownMenu.Item variant="destructive" onclick={() => (deleteOpen = true)}>
						<Trash2 /> In den Papierkorb …
					</DropdownMenu.Item>
				{/if}
			</DropdownMenu.Content>
		</DropdownMenu.Root>
	</header>

	{#if gone}
		<div class="shrink-0 p-3">
			<Alert variant="warning">
				<AlertDescription class="flex flex-wrap items-center gap-2">
					<span class="flex-1">
						{gone === 'deleted'
							? 'Diese Notiz wurde gelöscht oder in den Papierkorb gelegt.'
							: 'Du hast keinen Zugriff mehr auf diese Notiz.'}
					</span>
					<Button size="sm" variant="outline" href={BASE}>Zu den Notizen</Button>
				</AlertDescription>
			</Alert>
		</div>
	{/if}

	<div class={['grid min-h-0 flex-1', sourceOpen && 'lg:grid-cols-2']} style={surface}>
		<div class={['min-h-0 overflow-y-auto', sourceOpen && 'hidden lg:block']}>
			<NoteEditor
				{sync}
				noteId={note.id}
				{canEdit}
				{user}
				bind:editor
				oncreatesubpage={note.canCreateChild ? createSubpage : undefined}
			>
				{#snippet header()}
					<div class="mb-4 flex flex-col gap-2">
						<button
							type="button"
							class="flex size-12 items-center justify-center rounded-lg hover:bg-muted disabled:hover:bg-transparent"
							aria-label="Aussehen ändern"
							title={canEdit ? 'Icon und Farbe ändern' : undefined}
							disabled={!canEdit}
							onclick={() => (styleOpen = true)}
						>
							<NoteIcon icon={note.icon} color={note.color} class="size-9" />
						</button>
						<input
							bind:value={title}
							class="w-full bg-transparent text-3xl leading-tight font-bold tracking-tight outline-none placeholder:text-muted-foreground/60 sm:text-4xl"
							placeholder="Ohne Titel"
							aria-label="Titel der Notiz"
							maxlength={MAX_TITLE}
							readonly={!canEdit}
							oninput={onTitleInput}
							onfocus={() => (titleFocused = true)}
							onblur={() => {
								titleFocused = false;
								void saveTitle();
							}}
							onkeydown={(e) => {
								if (e.key === 'Enter' || (e.key === 'ArrowDown' && !e.shiftKey)) {
									e.preventDefault();
									void saveTitle();
									editor?.chain().focus('start').run();
								}
							}}
						/>
						{#if note.actionName}
							<p class="text-sm text-muted-foreground">Notiz zur Aktion „{note.actionName}“</p>
						{/if}
					</div>
				{/snippet}
			</NoteEditor>
		</div>
		{#if sourceOpen && editor}
			<div class="min-h-0 border-l">
				<SourcePanel {editor} {canEdit} onclose={() => (sourceOpen = false)} />
			</div>
		{/if}
	</div>
</div>

<VersionsDialog bind:open={versionsOpen} noteId={note.id} {canEdit} onrestored={() => undefined} />
<NoteLinkDialog bind:open={linkOpen} {note} />
<ExportDialog bind:open={exportOpen} noteId={note.id} hasChildren={note.hasChildren} />
<StyleDialog
	bind:open={styleOpen}
	node={note}
	onsaved={(u) => {
		applyDetail(u);
		tree.patch(u.id, { icon: u.icon, color: u.color });
	}}
/>
<MoveDialog
	bind:open={moveOpen}
	node={note}
	onmoved={async (u, oldParent) => {
		applyDetail(u);
		await tree.refresh(oldParent);
		await tree.refresh(u.parentId);
	}}
/>
<ConfirmDialog
	bind:open={deleteOpen}
	title="In den Papierkorb legen?"
	description={`„${noteTitle(note.title)}“${note.hasChildren ? ' und alle Unterseiten werden' : ' wird'} in den Papierkorb gelegt. Dort lässt sich alles wiederherstellen.`}
	confirmLabel="In den Papierkorb"
	destructive
	onconfirm={trash}
/>
