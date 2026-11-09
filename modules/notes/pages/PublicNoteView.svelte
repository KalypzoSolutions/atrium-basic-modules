<script lang="ts">
	// Eine Seite über einen öffentlichen Link: Live-Verbindung als Gast (eigene Endpunkte unter `/public/links/…`),
	// Titel nur lesend, Editor im Gastmodus (nur Text). Wird je Seite neu aufgebaut ({#key}).
	import { onDestroy, onMount } from 'svelte';
	import { toast } from 'svelte-sonner';
	import Lock from '@lucide/svelte/icons/lock';
	import PanelLeft from '@lucide/svelte/icons/panel-left';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { API_BASE, presenceColor, type PublicNoteNode, type ShareLevel } from '../schemas';
	import { noteTitle } from './helpers';
	import NoteEditor from './editor/NoteEditor.svelte';
	import { NoteSync } from './editor/sync.svelte';
	import NoteIcon from './NoteIcon.svelte';
	import PeerAvatars from './PeerAvatars.svelte';

	let {
		token,
		page,
		level,
		guestKey,
		guestName,
		accessToken,
		pageIds,
		onmeta,
		ongone,
		onreset,
		onopen,
		ontoggletree
	}: {
		token: string;
		page: PublicNoteNode;
		level: ShareLevel;
		guestKey: string;
		guestName: string;
		accessToken: () => string | null;
		/** Seiten dieses Links (interne Links auf sie bleiben auf der Link-Seite) */
		pageIds: ReadonlySet<string>;
		onmeta: (m: Pick<PublicNoteNode, 'id' | 'title' | 'icon' | 'color'>) => void;
		ongone: () => void;
		/** Seite neu aufbauen (Änderung abgelehnt → Serverstand laden) */
		onreset?: () => void;
		onopen: (id: string) => void;
		/** Seitenbaum ein-/ausblenden (nur bei Unterseiten) */
		ontoggletree?: () => void;
	} = $props();

	// svelte-ignore state_referenced_locally
	const sync = new NoteSync(
		page.id,
		{
			onMeta: (m) => onmeta(m),
			onAccess: (l) =>
				toast.info(
					l === 'edit' ? 'Du darfst jetzt mitbearbeiten.' : 'Du kannst die Notiz nur noch ansehen.'
				),
			onGone: () => ongone(),
			onReset: () => onreset?.(),
			onRejected: (message) => toast.error(message)
		},
		level,
		{ token, key: guestKey, name: guestName, accessToken }
	);

	// svelte-ignore state_referenced_locally
	const user = {
		name: guestName ? `${guestName} (Gast)` : 'Gast',
		color: presenceColor(guestKey)
	};

	const canEdit = $derived(level === 'edit' && !sync.readonly);
	const peers = $derived([...sync.peers.values()]);
	const status = $derived(
		sync.status === 'offline'
			? 'Offline – Änderungen werden nachgeholt'
			: !sync.synced
				? sync.status === 'connecting'
					? 'Verbindet …'
					: 'Lädt …'
				: sync.saving
					? 'Speichert …'
					: canEdit
						? 'Gespeichert'
						: 'Live'
	);

	const assetSrc = (assetId: string, variant: 'thumb' | 'web' | 'file') => {
		const t = accessToken();
		return `${API_BASE}/public/links/${encodeURIComponent(token)}/assets/${assetId}/${variant}${t ? `?t=${encodeURIComponent(t)}` : ''}`;
	};

	/** Interne Links auf Seiten dieses Links öffnen hier; alles andere bleibt beim Standard */
	function openHref(href: string): boolean {
		const m = /^\/modules\/notes\/([0-9a-f-]{36})(?:[?#].*)?$/i.exec(href);
		if (m && pageIds.has(m[1]!.toLowerCase())) {
			onopen(m[1]!.toLowerCase());
			return true;
		}
		return false;
	}

	onMount(() => {
		sync.connect();
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
	onDestroy(() => sync.dispose());
</script>

<div class="flex items-center gap-2 px-2 pt-2 sm:pr-10">
	{#if ontoggletree}
		<Button
			variant="ghost"
			size="icon-sm"
			aria-label="Seitenbaum ein- oder ausblenden"
			title="Seiten"
			onclick={ontoggletree}
		>
			<PanelLeft />
		</Button>
	{/if}
	<span class="flex-1"></span>
	{#if !canEdit}
		<Badge variant="secondary"><Lock class="size-3" /> Nur Ansicht</Badge>
	{/if}
	<span
		class="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
		role="status"
		aria-live="polite"
	>
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
		{status}
	</span>
	<PeerAvatars {peers} myId={null} />
</div>

<NoteEditor {sync} noteId={page.id} {canEdit} {user} guest={{ assetSrc, openHref }}>
	{#snippet header()}
		<div class="mb-4 flex flex-col gap-2">
			<NoteIcon icon={page.icon} color={page.color} class="size-9" />
			<h1 class="text-3xl leading-tight font-bold tracking-tight sm:text-4xl">
				{noteTitle(page.title)}
			</h1>
		</div>
	{/snippet}
</NoteEditor>
