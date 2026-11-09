<script lang="ts">
	// VERTRAG (Welle 0) – Props nicht ändern; Implementierung: Welle 4.2.
	import { tick } from 'svelte';
	import { toast } from 'svelte-sonner';
	import Check from '@lucide/svelte/icons/check';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Copy from '@lucide/svelte/icons/copy';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import Eye from '@lucide/svelte/icons/eye';
	import EyeOff from '@lucide/svelte/icons/eye-off';
	import LinkIcon from '@lucide/svelte/icons/link';
	import Lock from '@lucide/svelte/icons/lock';
	import LockOpen from '@lucide/svelte/icons/lock-open';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import Upload from '@lucide/svelte/icons/upload';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { Switch } from '$lib/components/ui/switch';
	import { ConfirmDialog, FormField } from '$lib/components/layout';
	import {
		LINK_MODES,
		LINK_MODE_DESCRIPTIONS,
		LINK_MODE_LABELS,
		MAX_PASSWORD,
		MIN_PASSWORD,
		linkCanUpload,
		linkCreateInput,
		type FileNode,
		type LinkMode,
		type ShareLink
	} from '../schemas';
	import { addDays, formatDateDe, todayBerlin } from '$lib/sdk/dates';
	import { API, errorText, formatDateTime } from './helpers';

	let {
		open = $bindable(false),
		node,
		onchanged
	}: {
		open?: boolean;
		node: FileNode | null;
		onchanged: () => void;
	} = $props();

	type Expiry = '1' | '7' | '30' | 'custom' | 'never';
	const EXPIRY_OPTIONS: { value: Expiry; label: string }[] = [
		{ value: '1', label: '1 Tag' },
		{ value: '7', label: '7 Tage' },
		{ value: '30', label: '30 Tage' },
		{ value: 'custom', label: 'Datum wählen' },
		{ value: 'never', label: 'Unbegrenzt' }
	];

	const UPLOAD_HINT = 'Hochgeladene Dateien zählen zu deinem Speicherplatz.';
	const dateId = 'files-link-date';
	const pwId = 'files-link-password';

	let links = $state<ShareLink[]>([]);
	let loading = $state(false);
	let loadError = $state<string | null>(null);

	let mode = $state<LinkMode>('view');
	let expiry = $state<Expiry>('7');
	let customDate = $state('');
	let usePassword = $state(false);
	let password = $state('');
	let showPassword = $state(false);
	let dateError = $state<string | null>(null);
	let passwordError = $state<string | null>(null);
	let formError = $state<string | null>(null);
	let busy = $state(false);

	/** Zuletzt erstellter Link (Hervorhebung „Neu“ in der Liste) */
	let createdId = $state<string | null>(null);
	/** Link, dessen Adresse gerade kopiert wurde */
	let copiedId = $state<string | null>(null);

	let showInactive = $state(false);
	let revokeTarget = $state<ShareLink | null>(null);
	let revokeOpen = $state(false);
	let revokingId = $state<string | null>(null);

	let dateEl = $state<HTMLInputElement | null>(null);
	let passwordEl = $state<HTMLInputElement | null>(null);

	const isFolder = $derived(node?.kind === 'folder');
	/** Bei Dateien gibt es nur „Ansehen“ */
	const effectiveMode = $derived<LinkMode>(isFolder ? mode : 'view');
	const activeLinks = $derived(links.filter((l) => l.active));
	const inactiveLinks = $derived(links.filter((l) => !l.active));

	/** Heute + n Tage (Europe/Berlin) als `YYYY-MM-DD` */
	const localDate = (offsetDays = 0): string => addDays(todayBerlin(), offsetDays);

	/** `YYYY-MM-DD` → „TT.MM.JJJJ“ */
	const formatDate = (iso: string | null): string => formatDateDe(iso);

	function expiresOnValue(): string | null {
		if (expiry === 'never') return null;
		if (expiry === 'custom') return customDate || '';
		return localDate(Number(expiry));
	}

	function statusOf(l: ShareLink): 'active' | 'revoked' | 'expired' {
		if (l.revokedAt) return 'revoked';
		return l.active ? 'active' : 'expired';
	}

	function expiryText(l: ShareLink): string {
		if (l.revokedAt) return `widerrufen am ${formatDateTime(l.revokedAt)}`;
		if (!l.expiresOn) return 'unbegrenzt';
		return l.active ? `läuft ab am ${formatDate(l.expiresOn)}` : 'abgelaufen';
	}

	function resetForm() {
		mode = 'view';
		expiry = '7';
		customDate = localDate(7);
		usePassword = false;
		password = '';
		showPassword = false;
		dateError = null;
		passwordError = null;
		formError = null;
	}

	async function loadLinks() {
		if (!node) return;
		loading = true;
		loadError = null;
		try {
			links = await apiFetch<ShareLink[]>(`${API}/nodes/${node.id}/links`);
		} catch (err) {
			loadError = errorText(err, 'Links konnten nicht geladen werden');
		} finally {
			loading = false;
		}
	}

	/** Beim Öffnen zurücksetzen und Links laden */
	let wasOpen = false;
	$effect(() => {
		if (open && !wasOpen) {
			resetForm();
			createdId = null;
			copiedId = null;
			busy = false;
			showInactive = false;
			links = [];
			void loadLinks();
		}
		wasOpen = open;
	});

	function issuesOf(details: unknown): { path?: unknown[]; message?: unknown }[] {
		const issues = Array.isArray(details)
			? details
			: (details as { issues?: unknown[] } | null)?.issues;
		return Array.isArray(issues) ? (issues as { path?: unknown[]; message?: unknown }[]) : [];
	}

	/** Feldfehler setzen; `true`, wenn mindestens ein Feld betroffen war */
	function applyIssues(issues: { path?: unknown[]; message?: unknown }[]): boolean {
		let hit = false;
		for (const issue of issues) {
			const field = issue.path?.[0];
			const msg = typeof issue.message === 'string' ? issue.message : 'Ungültige Eingabe';
			if (field === 'expiresOn' && !dateError) {
				dateError = msg;
				hit = true;
			} else if (field === 'password' && !passwordError) {
				passwordError = msg;
				hit = true;
			} else if (field === 'mode' && !formError) {
				formError = msg;
				hit = true;
			}
		}
		return hit;
	}

	async function focusFirstError() {
		await tick();
		if (dateError) dateEl?.focus();
		else if (passwordError) passwordEl?.focus();
	}

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (busy || !node) return;
		dateError = null;
		passwordError = null;
		formError = null;

		const input = {
			expiresOn: expiresOnValue(),
			password: usePassword ? password : null,
			mode: effectiveMode
		};
		if (expiry === 'custom' && !customDate) dateError = 'Bitte ein Datum wählen';
		else if (expiry === 'custom' && customDate < localDate(0))
			dateError = 'Das Datum darf nicht in der Vergangenheit liegen';
		const parsed = linkCreateInput.safeParse(input);
		if (!parsed.success) applyIssues(parsed.error.issues);
		if (dateError || passwordError) {
			if (expiry !== 'custom' && dateError) formError = dateError;
			void focusFirstError();
			return;
		}
		if (!parsed.success) return;

		busy = true;
		try {
			const link = await apiFetch<ShareLink>(`${API}/nodes/${node.id}/links`, {
				method: 'POST',
				body: JSON.stringify(parsed.data)
			});
			createdId = link.id;
			copiedId = null;
			toast.success('Link erstellt', {
				description: link.hasPassword
					? 'Er steht jetzt in der Liste. Teile das Passwort getrennt vom Link.'
					: 'Er steht jetzt in der Liste.'
			});
			resetForm();
			links = [link, ...links.filter((l) => l.id !== link.id)];
			onchanged();
			void loadLinks();
		} catch (err) {
			if (err instanceof ApiClientError && err.status === 403) {
				formError = 'Du darfst keine öffentlichen Links anlegen.';
			} else if (err instanceof ApiClientError && err.status === 409) {
				formError =
					err.message || 'Zu viele aktive Links. Widerrufe zuerst einen vorhandenen Link.';
			} else if (err instanceof ApiClientError && err.status === 422) {
				if (applyIssues(issuesOf(err.details))) {
					if (expiry !== 'custom' && dateError) formError = dateError;
					void focusFirstError();
				} else formError = errorText(err, 'Link konnte nicht erstellt werden');
			} else {
				formError = errorText(err, 'Link konnte nicht erstellt werden');
			}
		} finally {
			busy = false;
		}
	}

	async function copyLink(l: ShareLink) {
		if (!l.url) return;
		try {
			await navigator.clipboard.writeText(l.url);
			copiedId = l.id;
			toast.success('Link kopiert');
		} catch {
			const el = document.getElementById(`files-link-url-${l.id}`);
			if (el instanceof HTMLInputElement) el.select();
			toast.error('Kopieren nicht möglich – markiere den Link und kopiere ihn von Hand.');
		}
	}

	function askRevoke(l: ShareLink) {
		revokeTarget = l;
		revokeOpen = true;
	}

	async function revoke() {
		const target = revokeTarget;
		if (!target) return;
		revokingId = target.id;
		try {
			const updated = await apiFetch<ShareLink>(`${API}/links/${target.id}`, {
				method: 'DELETE'
			});
			links = links.map((l) => (l.id === updated.id ? updated : l));
			toast.success('Link widerrufen');
			onchanged();
		} catch (err) {
			toast.error(errorText(err, 'Widerrufen fehlgeschlagen'));
		} finally {
			revokingId = null;
			revokeTarget = null;
		}
	}
</script>

{#snippet modeIcon(m: LinkMode, cls: string)}
	{#if linkCanUpload(m)}
		<Upload class={cls} aria-hidden="true" />
	{:else}
		<Eye class={cls} aria-hidden="true" />
	{/if}
{/snippet}

{#snippet linkRow(l: ShareLink)}
	{@const status = statusOf(l)}
	<li class="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:justify-between">
		<div class="min-w-0 flex-1 space-y-1">
			<div class="flex flex-wrap items-center gap-2">
				<Badge variant="secondary" class="font-normal">
					{@render modeIcon(l.mode, 'size-3')}
					{LINK_MODE_LABELS[l.mode] ?? l.mode}
				</Badge>
				{#if status === 'active'}
					<Badge variant="outline" class="border-success-border text-success">Aktiv</Badge>
				{:else if status === 'revoked'}
					<Badge variant="secondary">Widerrufen</Badge>
				{:else}
					<Badge variant="destructive">Abgelaufen</Badge>
				{/if}
				{#if createdId === l.id}
					<Badge>Neu</Badge>
				{/if}
				<span class="text-sm">{expiryText(l)}</span>
				{#if l.hasPassword}
					<span
						class="inline-flex items-center gap-1 text-xs text-muted-foreground"
						title="Mit Passwort geschützt"
					>
						<Lock class="size-3.5" aria-hidden="true" /> Passwort
					</span>
				{:else}
					<span
						class="inline-flex items-center gap-1 text-xs text-muted-foreground"
						title="Ohne Passwort"
					>
						<LockOpen class="size-3.5" aria-hidden="true" /> ohne Passwort
					</span>
				{/if}
			</div>
			{#if status === 'active'}
				{#if l.url}
					<div class="flex flex-col gap-2 pt-1 sm:flex-row">
						<Label for="files-link-url-{l.id}" class="sr-only">Link-Adresse</Label>
						<Input
							id="files-link-url-{l.id}"
							value={l.url}
							readonly
							class="h-8 min-w-0 font-mono text-xs"
							onfocus={(e) => (e.currentTarget as HTMLInputElement).select()}
						/>
						<div class="flex shrink-0 gap-2">
							<Button size="sm" variant="outline" onclick={() => copyLink(l)}>
								{#if copiedId === l.id}
									<Check class="size-4" aria-hidden="true" /> Kopiert
								{:else}
									<Copy class="size-4" aria-hidden="true" /> Kopieren
								{/if}
							</Button>
							<Button
								size="sm"
								variant="outline"
								href={l.url}
								target="_blank"
								rel="noopener noreferrer"
							>
								<ExternalLink class="size-4" aria-hidden="true" /> Öffnen
							</Button>
						</div>
					</div>
				{:else}
					<p class="flex items-start gap-1.5 pt-1 text-xs text-warning">
						<TriangleAlert class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
						Link-Adresse nicht mehr abrufbar – neuen Link erstellen.
					</p>
				{/if}
				{#if linkCanUpload(l.mode)}
					<p class="text-xs text-muted-foreground">{UPLOAD_HINT}</p>
				{/if}
			{/if}
			<p class="text-xs text-muted-foreground">
				Erstellt am {formatDateTime(l.createdAt)}{l.createdBy ? ` von ${l.createdBy.name}` : ''}
			</p>
			<p class="text-xs text-muted-foreground">
				<span class="tabular-nums">{l.accessCount}</span>
				{l.accessCount === 1 ? 'Aufruf' : 'Aufrufe'}{l.lastAccessAt
					? ` · zuletzt ${formatDateTime(l.lastAccessAt)}`
					: ''}
			</p>
		</div>
		{#if status === 'active'}
			<Button
				variant="outline"
				size="sm"
				class="shrink-0 self-start text-destructive"
				disabled={revokingId === l.id}
				onclick={() => askRevoke(l)}
			>
				{revokingId === l.id ? 'Widerruft …' : 'Widerrufen'}
			</Button>
		{/if}
	</li>
{/snippet}

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-xl">
		<Dialog.Header>
			<Dialog.Title class="break-words">
				Öffentlicher Link für „{node?.name ?? ''}“
			</Dialog.Title>
			<Dialog.Description>
				{isFolder
					? 'Jede*r mit dem Link kann – je nach Art – den Ordner ansehen und herunterladen oder Dateien hineinladen, ganz ohne Konto.'
					: 'Jede*r mit dem Link kann die Datei ansehen und herunterladen – ohne Konto.'}
			</Dialog.Description>
		</Dialog.Header>

		<div class="grid gap-6">
			<form class="grid gap-4" onsubmit={submit} novalidate>
				{#if isFolder}
					<fieldset class="grid gap-2">
						<legend class="mb-1.5 text-sm font-medium">Art</legend>
						<div class="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Art des Links">
							{#each LINK_MODES as m (m)}
								<button
									type="button"
									role="radio"
									aria-checked={mode === m}
									class="flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring {mode ===
									m
										? 'border-primary bg-primary/5 ring-1 ring-primary'
										: ''}"
									onclick={() => {
										mode = m;
										formError = null;
									}}
								>
									<span class="flex items-center gap-1.5 text-sm font-medium">
										{@render modeIcon(m, 'size-4')}
										{LINK_MODE_LABELS[m]}
									</span>
									<span class="text-xs text-muted-foreground">{LINK_MODE_DESCRIPTIONS[m]}</span>
								</button>
							{/each}
						</div>
						{#if linkCanUpload(mode)}
							<p class="text-xs text-muted-foreground">{UPLOAD_HINT}</p>
						{/if}
					</fieldset>
				{/if}

				<fieldset class="grid gap-2">
					<legend class="mb-1.5 text-sm font-medium">Gültig für</legend>
					<div class="flex flex-wrap gap-2" role="radiogroup" aria-label="Gültig für">
						{#each EXPIRY_OPTIONS as opt (opt.value)}
							<Button
								type="button"
								size="sm"
								variant={expiry === opt.value ? 'default' : 'outline'}
								role="radio"
								aria-checked={expiry === opt.value}
								onclick={() => {
									expiry = opt.value;
									dateError = null;
									if (opt.value === 'custom') {
										if (!customDate) customDate = localDate(7);
										void tick().then(() => dateEl?.focus());
									}
								}}
							>
								{opt.label}
							</Button>
						{/each}
					</div>
					{#if expiry === 'custom'}
						<FormField label="Gültig bis einschließlich *" id={dateId} error={dateError}>
							<Input
								id={dateId}
								type="date"
								bind:ref={dateEl}
								bind:value={customDate}
								min={localDate(0)}
								class="sm:max-w-48"
								aria-invalid={dateError ? 'true' : undefined}
								aria-describedby={dateError ? `${dateId}-error` : undefined}
								oninput={() => (dateError = null)}
							/>
						</FormField>
					{:else if expiry === 'never'}
						<p class="text-xs text-muted-foreground">
							Der Link bleibt gültig, bis du ihn widerrufst.
						</p>
					{:else}
						<p class="text-xs text-muted-foreground">
							Gültig bis einschließlich {formatDate(localDate(Number(expiry)))}.
						</p>
					{/if}
				</fieldset>

				<div class="grid gap-3">
					<div class="flex items-center gap-3">
						<Switch
							id="files-link-use-password"
							bind:checked={usePassword}
							onCheckedChange={(v) => {
								passwordError = null;
								if (v) void tick().then(() => passwordEl?.focus());
							}}
						/>
						<Label for="files-link-use-password">Mit Passwort schützen</Label>
					</div>
					{#if usePassword}
						<FormField
							label="Passwort *"
							id={pwId}
							error={passwordError}
							hint="Mindestens {MIN_PASSWORD} Zeichen."
						>
							<div class="flex gap-2">
								<Input
									id={pwId}
									bind:ref={passwordEl}
									bind:value={password}
									type={showPassword ? 'text' : 'password'}
									autocomplete="new-password"
									maxlength={MAX_PASSWORD}
									aria-invalid={passwordError ? 'true' : undefined}
									aria-describedby={passwordError ? `${pwId}-error` : `${pwId}-hint`}
									oninput={() => (passwordError = null)}
								/>
								<Button
									type="button"
									variant="outline"
									size="icon"
									class="shrink-0"
									aria-label={showPassword ? 'Passwort verbergen' : 'Passwort anzeigen'}
									aria-pressed={showPassword}
									onclick={() => (showPassword = !showPassword)}
								>
									{#if showPassword}
										<EyeOff class="size-4" aria-hidden="true" />
									{:else}
										<Eye class="size-4" aria-hidden="true" />
									{/if}
								</Button>
							</div>
						</FormField>
					{/if}
				</div>

				{#if formError}
					<p role="alert" class="text-sm text-destructive">{formError}</p>
				{/if}

				<div class="flex justify-end">
					<Button type="submit" disabled={busy || !node}>
						<LinkIcon class="size-4" aria-hidden="true" />
						{busy ? 'Erstellt …' : 'Link erstellen'}
					</Button>
				</div>
			</form>

			<section class="grid gap-2" aria-labelledby="files-link-list-title">
				<h3 id="files-link-list-title" class="font-semibold">
					{#if !loading && !loadError}
						Aktive Links <span class="font-normal text-muted-foreground"
							>({activeLinks.length})</span
						>
					{:else}
						Aktive Links
					{/if}
				</h3>
				{#if loading && links.length === 0}
					<div class="grid gap-2">
						<Skeleton class="h-14 w-full" />
						<Skeleton class="h-14 w-full" />
					</div>
				{:else if loadError}
					<div class="flex flex-wrap items-center gap-2 text-sm">
						<span role="alert" class="text-destructive">{loadError}</span>
						<Button variant="outline" size="sm" onclick={loadLinks}>Erneut versuchen</Button>
					</div>
				{:else}
					{#if activeLinks.length === 0}
						<p class="text-sm text-muted-foreground">Es gibt keinen aktiven öffentlichen Link.</p>
					{:else}
						<ul class="divide-y rounded-lg border px-3">
							{#each activeLinks as l (l.id)}
								{@render linkRow(l)}
							{/each}
						</ul>
					{/if}

					{#if inactiveLinks.length > 0}
						<div class="grid gap-2">
							<Button
								variant="ghost"
								size="sm"
								class="justify-start self-start px-1"
								aria-expanded={showInactive}
								aria-controls="files-link-inactive"
								onclick={() => (showInactive = !showInactive)}
							>
								<ChevronRight
									class="size-4 transition-transform {showInactive ? 'rotate-90' : ''}"
									aria-hidden="true"
								/>
								Inaktive Links ({inactiveLinks.length})
							</Button>
							{#if showInactive}
								<ul id="files-link-inactive" class="divide-y rounded-lg border px-3 opacity-80">
									{#each inactiveLinks as l (l.id)}
										{@render linkRow(l)}
									{/each}
								</ul>
							{/if}
						</div>
					{/if}
				{/if}
			</section>
		</div>

		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)}>Schließen</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<ConfirmDialog
	bind:open={revokeOpen}
	title="Link widerrufen?"
	description={isFolder
		? 'Der Link funktioniert danach sofort nicht mehr: Wer ihn hat, kann den Ordner nicht mehr öffnen und nichts mehr hochladen. Das lässt sich nicht rückgängig machen.'
		: 'Der Link funktioniert danach sofort nicht mehr: Wer ihn hat, kann die Datei nicht mehr öffnen. Das lässt sich nicht rückgängig machen.'}
	confirmLabel="Widerrufen"
	destructive
	onconfirm={revoke}
/>
