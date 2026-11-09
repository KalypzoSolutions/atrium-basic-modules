<script lang="ts">
	// Öffentliche Seite `/p/notes/link/<token>`: Passwort (falls gesetzt), bei Bearbeiten-Links einmal der Name
	// („Wie heißt du?“, optional, im Browser gemerkt), dann Seitenbaum (Link-Seite + Unterseiten, `?seite=<id>`) und Editor.
	// Zugriffstoken nach dem Passwort je Link in `sessionStorage`, Geheimnis je Tab für die Anwesenheit.
	import { untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import Link2Off from '@lucide/svelte/icons/link-2-off';
	import Lock from '@lucide/svelte/icons/lock';
	import Pencil from '@lucide/svelte/icons/pencil';
	import {
		BottomSheet,
		deviceLayout,
		ErrorState,
		LoadingState,
		PageTitle
	} from '$lib/components/layout';
	import { Button } from '$lib/components/ui/button';
	import * as Card from '$lib/components/ui/card';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { MAX_GUEST_NAME, type PublicLinkInfo, type PublicNoteNode } from '../schemas';
	import { randomClient } from './editor/sync.svelte';
	import { API, noteTitle } from './helpers';
	import NoteIcon from './NoteIcon.svelte';
	import PublicNoteView from './PublicNoteView.svelte';

	let { params }: { params: Record<string, string> } = $props();

	const token = $derived(params.token ?? '');
	const apiBase = $derived(`${API}/public/links/${encodeURIComponent(token)}`);
	const phone = $derived(deviceLayout() === 'phone');

	const NAME_KEY = 'ep-notes-guest-name';
	const tokenKey = (t: string) => `ep-notes-link:${t}`;
	const EXPIRY_MARGIN_MS = 60_000;

	/** Geheimnis dieses Tabs (Identität der Anwesenheit, nie ein Konto) */
	const guestKey = randomClient();

	// ---------- Zugriffstoken ----------
	let accessToken = $state<string | null>(null);

	function readStoredToken(t: string): string | null {
		try {
			const raw = sessionStorage.getItem(tokenKey(t));
			if (!raw) return null;
			const v = JSON.parse(raw) as { t?: unknown; exp?: unknown };
			if (typeof v.t !== 'string' || typeof v.exp !== 'number') return null;
			if (v.exp - EXPIRY_MARGIN_MS <= Date.now()) {
				sessionStorage.removeItem(tokenKey(t));
				return null;
			}
			return v.t;
		} catch {
			return null;
		}
	}

	function storeToken(t: string, value: string, expiresInSec: number) {
		accessToken = value;
		try {
			sessionStorage.setItem(
				tokenKey(t),
				JSON.stringify({ t: value, exp: Date.now() + expiresInSec * 1000 })
			);
		} catch {
			// ohne Speicher gilt die Freischaltung nur für diese Ansicht
		}
	}

	// ---------- Name des Gasts ----------
	let guestName = $state('');
	let nameAsked = $state(false);
	let nameDraft = $state('');

	function loadName() {
		try {
			const v = localStorage.getItem(NAME_KEY);
			if (v !== null) {
				guestName = v.slice(0, MAX_GUEST_NAME);
				nameAsked = true;
			}
		} catch {
			// ohne Speicher jedes Mal fragen
		}
		nameDraft = guestName;
	}

	function saveName(e?: SubmitEvent) {
		e?.preventDefault();
		guestName = nameDraft.trim().slice(0, MAX_GUEST_NAME);
		nameAsked = true;
		try {
			localStorage.setItem(NAME_KEY, guestName);
		} catch {
			// egal
		}
	}

	// ---------- Link-Info ----------
	let info = $state<PublicLinkInfo | null>(null);
	let infoState = $state<'loading' | 'ready' | 'unavailable' | 'error'>('loading');
	let infoError = $state('');

	async function loadInfo() {
		infoState = 'loading';
		const t = token;
		const stored = readStoredToken(t);
		accessToken = stored;
		try {
			const q = stored ? `?t=${encodeURIComponent(stored)}` : '';
			const data = await apiFetch<PublicLinkInfo>(`${apiBase}${q}`);
			if (t !== token) return;
			info = data;
			infoState = 'ready';
		} catch (e) {
			if (t !== token) return;
			if (e instanceof ApiClientError && [400, 404, 422].includes(e.status)) {
				infoState = 'unavailable';
			} else {
				infoState = 'error';
				infoError =
					e instanceof ApiClientError && e.status === 429
						? 'Gerade sehr viele Zugriffe – bitte kurz warten und erneut versuchen.'
						: 'Die Seite konnte nicht geladen werden. Bitte prüfe deine Verbindung.';
			}
		}
	}

	$effect(() => {
		void token;
		untrack(() => {
			loadName();
			void loadInfo();
		});
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
			await loadInfo();
		} catch (err) {
			unlockError =
				err instanceof ApiClientError && err.status === 403
					? 'Das Passwort stimmt nicht.'
					: err instanceof ApiClientError && err.status === 429
						? 'Zu viele Versuche – bitte später erneut versuchen.'
						: err instanceof ApiClientError && err.status === 404
							? 'Dieser Link ist nicht mehr verfügbar.'
							: 'Freischalten fehlgeschlagen. Bitte erneut versuchen.';
		} finally {
			unlocking = false;
		}
	}

	// ---------- Seiten ----------
	/** Seiten des Links; Titel/Icons folgen live den `meta`-Ereignissen (`patchPage`) */
	let pages = $derived<PublicNoteNode[]>(info?.pages ?? []);
	const pageIds = $derived(new Set(pages.map((p) => p.id)));
	const requested = $derived(page.url.searchParams.get('seite'));
	const current = $derived(pages.find((p) => p.id === requested) ?? pages[0] ?? null);
	const depthOf = $derived.by(() => {
		const byId = new Map(pages.map((p) => [p.id, p]));
		const depth = new Map<string, number>();
		for (const p of pages) {
			let d = 0;
			let parent = p.parentId ? byId.get(p.parentId) : undefined;
			while (parent && d < 12) {
				d++;
				parent = parent.parentId ? byId.get(parent.parentId) : undefined;
			}
			depth.set(p.id, d);
		}
		return depth;
	});
	let treeOpen = $state(true);
	let sheetOpen = $state(false);
	/** steigt, wenn die Seite neu geladen werden muss (abgelehnte Änderung) */
	let resetKey = $state(0);
	const showTree = $derived(pages.length > 1);

	function openPage(id: string) {
		sheetOpen = false;
		const url = new URL(page.url);
		if (id === pages[0]?.id) url.searchParams.delete('seite');
		else url.searchParams.set('seite', id);
		void goto(`${url.pathname}${url.search}`, { keepFocus: true, noScroll: true });
	}

	function patchPage(m: Pick<PublicNoteNode, 'id' | 'title' | 'icon' | 'color'>) {
		pages = pages.map((p) =>
			p.id === m.id ? { ...p, title: m.title, icon: m.icon, color: m.color } : p
		);
	}

	const needsName = $derived(info?.level === 'edit' && !nameAsked);
</script>

<PageTitle title={current ? noteTitle(current.title) : 'Notiz'} />

{#snippet tree()}
	<nav aria-label="Seiten" class="grid gap-0.5 p-2">
		{#each pages as p (p.id)}
			<button
				type="button"
				class={[
					'flex min-w-0 items-center gap-2 rounded-md py-1.5 pr-2 text-left text-sm hover:bg-muted',
					p.id === current?.id && 'bg-muted font-medium'
				]}
				style={`padding-left: ${0.5 + (depthOf.get(p.id) ?? 0) * 1}rem`}
				aria-current={p.id === current?.id ? 'page' : undefined}
				onclick={() => openPage(p.id)}
			>
				<NoteIcon icon={p.icon} color={p.color} class="size-4 shrink-0" />
				<span class="truncate">{noteTitle(p.title)}</span>
			</button>
		{/each}
	</nav>
{/snippet}

{#if infoState === 'loading' && !info}
	<div class="mx-auto w-full max-w-2xl px-4 py-8">
		<LoadingState label="Notiz" rows={6} />
	</div>
{:else if infoState === 'unavailable'}
	<div class="mx-auto w-full max-w-md px-4 py-12">
		<Card.Root>
			<Card.Header class="items-center text-center">
				<Link2Off class="mx-auto size-8 text-muted-foreground" aria-hidden="true" />
				<Card.Title level={1}>Link nicht verfügbar</Card.Title>
				<Card.Description>
					Der Link ist abgelaufen, wurde widerrufen oder die Notiz gibt es nicht mehr. Frag die
					Person, die ihn dir geschickt hat.
				</Card.Description>
			</Card.Header>
		</Card.Root>
	</div>
{:else if infoState === 'error'}
	<div class="mx-auto w-full max-w-md px-4 py-12">
		<ErrorState message={infoError} onretry={loadInfo} />
	</div>
{:else if info?.needsPassword}
	<div class="mx-auto w-full max-w-md px-4 py-12">
		<Card.Root>
			<Card.Header>
				<Card.Title level={1} class="flex items-center gap-2">
					<Lock class="size-5" aria-hidden="true" /> Passwort erforderlich
				</Card.Title>
				<Card.Description>Diese Notiz ist mit einem Passwort geschützt.</Card.Description>
			</Card.Header>
			<Card.Content>
				<form class="grid gap-3" onsubmit={unlock} novalidate>
					<div class="grid gap-1.5">
						<Label for="notes-link-unlock">Passwort</Label>
						<Input
							id="notes-link-unlock"
							type="password"
							autocomplete="current-password"
							bind:value={password}
							aria-invalid={unlockError ? 'true' : undefined}
							aria-describedby={unlockError ? 'notes-link-unlock-error' : undefined}
						/>
						{#if unlockError}
							<p id="notes-link-unlock-error" role="alert" class="text-xs text-destructive">
								{unlockError}
							</p>
						{/if}
					</div>
					<Button type="submit" disabled={unlocking}>
						{unlocking ? 'Prüft …' : 'Öffnen'}
					</Button>
				</form>
			</Card.Content>
		</Card.Root>
	</div>
{:else if info && needsName}
	<div class="mx-auto w-full max-w-md px-4 py-12">
		<Card.Root>
			<Card.Header>
				<Card.Title level={1} class="flex items-center gap-2">
					<Pencil class="size-5" aria-hidden="true" /> Wie heißt du?
				</Card.Title>
				<Card.Description>
					Du kannst „{noteTitle(info.title)}“ live mitbearbeiten. Dein Name erscheint bei deinem
					Cursor, damit die anderen sehen, wer schreibt. Du kannst das Feld auch leer lassen.
				</Card.Description>
			</Card.Header>
			<Card.Content>
				<form class="grid gap-3" onsubmit={saveName} novalidate>
					<div class="grid gap-1.5">
						<Label for="notes-guest-name">Dein Name (optional)</Label>
						<Input
							id="notes-guest-name"
							bind:value={nameDraft}
							maxlength={MAX_GUEST_NAME}
							autocomplete="given-name"
						/>
					</div>
					<Button type="submit">Weiter</Button>
				</form>
			</Card.Content>
		</Card.Root>
	</div>
{:else if info && current}
	<div class="flex min-h-[calc(100dvh-6rem)] border-y">
		{#if showTree && !phone && treeOpen}
			<aside
				class="w-60 shrink-0 overflow-y-auto border-r bg-sidebar-surface"
				aria-label="Seitenbaum"
			>
				{@render tree()}
			</aside>
		{/if}
		<div class="min-w-0 flex-1">
			{#key `${current.id}:${resetKey}`}
				<PublicNoteView
					{token}
					page={current}
					level={info.level}
					{guestKey}
					{guestName}
					accessToken={() => accessToken}
					{pageIds}
					onmeta={patchPage}
					ongone={() => void loadInfo()}
					onreset={() => resetKey++}
					onopen={openPage}
					ontoggletree={showTree
						? () => (phone ? (sheetOpen = !sheetOpen) : (treeOpen = !treeOpen))
						: undefined}
				/>
			{/key}
		</div>
	</div>
	{#if phone && showTree}
		<BottomSheet bind:open={sheetOpen} title="Seiten" size="tall">
			{@render tree()}
		</BottomSheet>
	{/if}
{/if}
