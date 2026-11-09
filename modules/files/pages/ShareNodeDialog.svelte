<script lang="ts">
	// VERTRAG (Welle 0) – Props nicht ändern; Implementierung: Welle 4.1.
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import FolderTree from '@lucide/svelte/icons/folder-tree';
	import Info from '@lucide/svelte/icons/info';
	import Tent from '@lucide/svelte/icons/tent';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { PRINCIPAL_TYPE_LABELS, type PrincipalInfo } from '$lib/sdk/types/sharing';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Label } from '$lib/components/ui/label';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { Switch } from '$lib/components/ui/switch';
	import { SharePanel } from '$lib/components/layout';
	import type { ShareCandidate, ShareEntry } from '$lib/components/layout';
	import { shareKey } from '$lib/components/layout/share-types';
	import {
		SHARE_LEVELS,
		SHARE_LEVEL_LABELS,
		type FileNode,
		type NodeShare,
		type NodeShares,
		type ShareLevel
	} from '../schemas';
	import { API, errorText } from './helpers';

	let {
		open = $bindable(false),
		node,
		onchanged
	}: {
		open?: boolean;
		node: FileNode | null;
		onchanged: () => void;
	} = $props();

	const EVERYONE_LABEL = 'Stamm';
	const LEVELS = SHARE_LEVELS.map((value) => ({ value, label: SHARE_LEVEL_LABELS[value] }));

	let data = $state<NodeShares | null>(null);
	let loading = $state(false);
	let loadError = $state('');
	let seq = 0;

	const canManage = $derived(!!node?.canShare);
	const isFolder = $derived(node?.kind === 'folder');
	const sharesUrl = $derived(node ? `${API}/nodes/${encodeURIComponent(node.id)}/shares` : '');
	/** Freigaben an Einzelne (ohne „Stamm“ – der hat eine eigene Karte) */
	const entries = $derived<ShareEntry[]>(
		(data?.shares ?? []).filter((s) => s.type !== 'everyone').map(toEntry)
	);
	/** Eigene Stamm-Freigabe an diesem Eintrag */
	const stammOwn = $derived(data?.shares.find((s) => s.type === 'everyone') ?? null);
	/** Von einem Oberordner geerbte Stamm-Freigabe (höchste Stufe) */
	const stammInherited = $derived.by(() => {
		const list = (data?.inherited ?? []).filter((s) => s.type === 'everyone');
		return list.find((s) => s.level === 'edit') ?? list[0] ?? null;
	});
	const inheritedOthers = $derived((data?.inherited ?? []).filter((s) => s.type !== 'everyone'));
	const owner = $derived(
		node ? { name: node.own ? `${node.owner.name} (du)` : node.owner.name } : undefined
	);

	/** Gewählte Stufe für die Stamm-Freigabe (bleibt beim Ausschalten erhalten) */
	let stammLevel = $state<ShareLevel>('read');
	let stammBusy = $state(false);
	const stammOn = $derived(!!stammOwn);
	const stammLocked = $derived(!canManage || stammBusy || (!stammOwn && !!stammInherited));

	$effect(() => {
		if (stammOwn) stammLevel = stammOwn.level;
	});

	// Beim Öffnen (bzw. Wechsel des Knotens) Freigaben laden
	$effect(() => {
		if (!open || !node) return;
		const id = node.id;
		untrack(() => void load(id));
	});

	function toEntry(s: NodeShare): ShareEntry {
		return {
			userId: s.id,
			type: s.type,
			name: s.name,
			detail: s.detail ?? null,
			color: s.color ?? null,
			image: s.image ?? null,
			level: s.level
		};
	}

	async function load(id: string) {
		const mine = ++seq;
		loading = true;
		loadError = '';
		data = null;
		stammLevel = 'read';
		try {
			const r = await apiFetch<NodeShares>(`${API}/nodes/${encodeURIComponent(id)}/shares`);
			if (mine === seq) data = r;
		} catch (e) {
			if (mine === seq) loadError = errorText(e, 'Freigaben konnten nicht geladen werden.');
		} finally {
			if (mine === seq) loading = false;
		}
	}

	async function searchPrincipals(q: string): Promise<ShareCandidate[]> {
		const found = await apiFetch<PrincipalInfo[]>(`${API}/principals?q=${encodeURIComponent(q)}`);
		return found.map((p) => ({
			id: p.id,
			type: p.type,
			name: p.name,
			detail: p.detail ?? null,
			color: p.color ?? null,
			image: p.image ?? null
		}));
	}

	type Issue = { path?: PropertyKey[]; message?: string };

	/** Erste Feldmeldung aus den 422-Details (Pfad `shares.<i>.id`) mit Namen des Ziels */
	function validationText(details: unknown, list: ShareEntry[]): string | null {
		let issues: Issue[] = [];
		if (Array.isArray(details)) issues = details as Issue[];
		else if (Array.isArray((details as { issues?: Issue[] } | null)?.issues)) {
			issues = (details as { issues: Issue[] }).issues;
		} else if (details && typeof details === 'object') {
			issues = Object.entries(details as Record<string, unknown>).map(([k, v]) => ({
				path: k.split('.').map((p) => (/^\d+$/.test(p) ? Number(p) : p)),
				message: Array.isArray(v) ? v.join(', ') : typeof v === 'string' ? v : ''
			}));
		}
		for (const i of issues) {
			if (!i.message) continue;
			const index = i.path?.[1];
			const target = typeof index === 'number' ? list[index] : undefined;
			return target ? `„${target.name}“: ${i.message}` : i.message;
		}
		return null;
	}

	/** Stamm-Eintrag (falls vorhanden) als `ShareEntry` für die komplette Liste */
	function stammEntry(level: ShareLevel | null): ShareEntry[] {
		return level
			? [{ userId: '*', type: 'everyone', name: EVERYONE_LABEL, detail: null, level }]
			: [];
	}

	/** Komplette Liste speichern: `others` = Einzelne, `stamm` = Stufe der Stamm-Freigabe oder `null` */
	async function save(others: ShareEntry[], stamm: ShareLevel | null = stammOwn?.level ?? null) {
		if (!node) return;
		const next = [...stammEntry(stamm), ...others];
		const body = {
			shares: next.map((s) => ({
				type: s.type ?? 'user',
				id: s.userId,
				level: s.level as ShareLevel
			}))
		};
		try {
			data = await apiFetch<NodeShares>(sharesUrl, { method: 'PUT', body: JSON.stringify(body) });
		} catch (e) {
			if (e instanceof ApiClientError && e.status === 404) {
				// Zugriff verloren (z. B. eigene Freigabe entfernt) oder Eintrag gelöscht
				toast.error(errorText(e, 'Eintrag nicht gefunden'));
				open = false;
				onchanged();
				return;
			}
			const msg =
				e instanceof ApiClientError && e.status === 422
					? (validationText(e.details, next) ?? errorText(e, 'Ungültige Freigabe'))
					: errorText(e, 'Freigabe konnte nicht gespeichert werden.');
			toast.error(msg);
			// SharePanel zeigt die Meldung zusätzlich direkt im Dialog an
			throw new Error(msg, { cause: e });
		}
		toast.success('Freigabe gespeichert');
		onchanged();
	}

	async function addShare(c: ShareCandidate, level: string) {
		const entry: ShareEntry = {
			userId: c.id,
			type: c.type ?? 'user',
			name: c.name,
			detail: c.detail ?? null,
			color: c.color ?? null,
			image: c.image ?? null,
			level
		};
		if (entries.some((s) => shareKey(s) === shareKey(entry))) return;
		await save([...entries, entry]);
	}

	async function changeShare(key: string, level: string) {
		await save(entries.map((s) => (shareKey(s) === key ? { ...s, level } : s)));
	}

	async function removeShare(key: string) {
		await save(entries.filter((s) => shareKey(s) !== key));
	}

	async function setStamm(level: ShareLevel | null) {
		if (stammBusy) return;
		stammBusy = true;
		try {
			await save(entries, level);
		} catch {
			// Meldung kam bereits als Toast
		} finally {
			stammBusy = false;
		}
	}

	function toggleStamm(on: boolean) {
		void setStamm(on ? stammLevel : null);
	}

	function pickStammLevel(level: ShareLevel) {
		stammLevel = level;
		if (stammOwn && stammOwn.level !== level) void setStamm(level);
	}

	const levelLabel = (l: ShareLevel) => SHARE_LEVEL_LABELS[l] ?? l;
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="flex flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
		<Dialog.Header class="border-b p-4 pr-12">
			<Dialog.Title class="break-words">„{node?.name ?? ''}“ freigeben</Dialog.Title>
			<Dialog.Description>
				{isFolder
					? 'Wer diesen Ordner und alle Inhalte sehen oder bearbeiten darf.'
					: 'Wer diese Datei sehen oder bearbeiten darf.'}
			</Dialog.Description>
		</Dialog.Header>

		<div class="min-h-0 flex-1 space-y-6 overflow-y-auto overscroll-contain p-4">
			{#if loading}
				<div class="space-y-3" aria-busy="true" aria-label="Freigaben werden geladen">
					<Skeleton class="h-9 w-full" />
					<Skeleton class="h-12 w-full" />
					<Skeleton class="h-12 w-full" />
				</div>
			{:else if loadError}
				<div class="space-y-3 rounded-lg border border-destructive/40 p-4" role="alert">
					<p class="text-sm text-destructive">{loadError}</p>
					<Button variant="outline" size="sm" onclick={() => node && load(node.id)}>
						Erneut versuchen
					</Button>
				</div>
			{:else if data}
				<section
					class="space-y-3 rounded-lg border p-4 {stammOn || stammInherited
						? 'border-primary/40 bg-primary/5'
						: 'bg-muted/30'}"
					aria-labelledby="files-share-stamm"
				>
					<div class="flex items-start gap-3">
						<div
							class="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-link"
						>
							<Tent class="size-5" aria-hidden="true" />
						</div>
						<div class="min-w-0 flex-1 space-y-1">
							<div class="flex items-center justify-between gap-3">
								<Label
									id="files-share-stamm"
									for="files-share-stamm-switch"
									class="text-sm font-semibold"
								>
									Mit dem ganzen Stamm teilen
								</Label>
								<Switch
									id="files-share-stamm-switch"
									bind:checked={() => stammOn || !!stammInherited, toggleStamm}
									disabled={stammLocked}
									aria-describedby="files-share-stamm-hint"
								/>
							</div>
							<p id="files-share-stamm-hint" class="text-xs text-muted-foreground">
								Alle Mitglieder mit Konto sehen {isFolder ? 'den Ordner' : 'die Datei'} dann direkt unter
								„Dateien“.
							</p>
							{#if !stammOwn && stammInherited}
								<p class="flex items-center gap-1 text-xs text-muted-foreground">
									<FolderTree class="size-3 shrink-0" aria-hidden="true" />
									<span class="min-w-0 truncate">
										Geerbt von „{stammInherited.fromName}“ ({levelLabel(stammInherited.level)}) –
										ändern lässt sich das nur am Ordner.
									</span>
								</p>
							{/if}
						</div>
					</div>
					{#if stammOwn || (!stammInherited && canManage)}
						<div
							class="flex flex-wrap items-center gap-2 sm:pl-12"
							role="radiogroup"
							aria-label="Stufe für den ganzen Stamm"
						>
							{#each LEVELS as l (l.value)}
								<Button
									type="button"
									size="sm"
									variant={stammLevel === l.value ? 'default' : 'outline'}
									role="radio"
									aria-checked={stammLevel === l.value}
									disabled={!canManage || stammBusy}
									onclick={() => pickStammLevel(l.value)}
								>
									{l.label}
								</Button>
							{/each}
							{#if stammBusy}
								<span class="text-xs text-muted-foreground" aria-live="polite">Speichert …</span>
							{:else if !stammOn}
								<span class="text-xs text-muted-foreground">Gilt, sobald der Schalter an ist.</span>
							{/if}
						</div>
					{/if}
				</section>

				<section class="space-y-3" aria-labelledby="files-share-own">
					<h3 id="files-share-own" class="text-sm font-semibold">Einzelne Personen und Gruppen</h3>
					{#if !canManage}
						<p class="text-xs text-muted-foreground">
							Nur Ansicht – du darfst die Freigaben dieses Eintrags nicht ändern.
						</p>
					{/if}
					<SharePanel
						shares={entries}
						{owner}
						levels={LEVELS}
						defaultLevel="read"
						{canManage}
						placeholder="Name, Gruppe, Rolle oder Mitglied suchen …"
						searchLabel="Freigabe hinzufügen"
						emptyResultText="Niemand gefunden"
						search={searchPrincipals}
						onadd={addShare}
						onchange={changeShare}
						onremove={removeShare}
					/>
					<p class="flex gap-2 text-xs text-muted-foreground">
						<Info class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
						<span>
							{#if isFolder}
								Freigaben an Ordnern gelten für alle enthaltenen Ordner und Dateien.
							{:else}
								Personen, Gruppen, Rollen und Mitglieder lassen sich einzeln hinzufügen.
							{/if}
						</span>
					</p>
				</section>

				{#if inheritedOthers.length > 0}
					<section class="space-y-2" aria-labelledby="files-share-inherited">
						<div>
							<h3 id="files-share-inherited" class="text-sm font-semibold">Geerbte Freigaben</h3>
							<p class="text-xs text-muted-foreground">
								Freigaben an übergeordneten Ordnern gelten für alle Inhalte. Ändern lassen sie sich
								nur am jeweiligen Ordner.
							</p>
						</div>
						<ul class="divide-y rounded-lg border">
							{#each inheritedOthers as s (`${s.fromId}:${s.type}:${s.id}`)}
								<li class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
									<div class="min-w-0 flex-1">
										<div class="flex flex-wrap items-center gap-2">
											<span class="truncate font-medium">{s.name}</span>
											<Badge variant="outline" class="text-xs font-normal">
												{PRINCIPAL_TYPE_LABELS[s.type] ?? s.type}
											</Badge>
										</div>
										<p class="flex items-center gap-1 text-xs text-muted-foreground">
											<FolderTree class="size-3 shrink-0" aria-hidden="true" />
											<span class="truncate">Geerbt von „{s.fromName}“</span>
										</p>
									</div>
									<Badge variant="secondary">{levelLabel(s.level)}</Badge>
								</li>
							{/each}
						</ul>
					</section>
				{/if}
			{/if}
		</div>

		<Dialog.Footer class="mx-0 mb-0">
			<Button type="button" variant="outline" onclick={() => (open = false)}>Schließen</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
