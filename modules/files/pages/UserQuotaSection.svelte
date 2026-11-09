<script lang="ts">
	// Reiter „Speicherplatz“ im Dialog „Benutzer bearbeiten“ (`userAdminSections`):
	// Belegung, Auswahl Standard / eigenes Limit / unbegrenzt, Warnung unter der Belegung. Speichert selbst.
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import { BUSY_SAVE, ErrorState, LoadingState } from '$lib/components/layout';
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import { apiFetch } from '$lib/sdk/client';
	import type { UserAdminSectionProps } from '$lib/sdk/types/module-ui';
	import { MAX_USER_QUOTA_MB, type QuotaMode, type UserQuota } from '../schemas';
	import QuotaBar from './QuotaBar.svelte';
	import { API, errorText, formatBytes } from './helpers';

	let { userId, userName }: UserAdminSectionProps = $props();

	const uid = $props.id();

	let data = $state<UserQuota | null>(null);
	let loadError = $state<string | null>(null);
	let busy = $state(false);
	let mode = $state<QuotaMode>('default');
	let amount = $state('');
	let unit = $state<'MB' | 'GB'>('GB');
	let fieldError = $state<string | null>(null);

	const UNIT_ITEMS = [
		{ value: 'MB', label: 'MB' },
		{ value: 'GB', label: 'GB' }
	];

	function applyData(q: UserQuota) {
		data = q;
		mode = q.mode;
		if (q.customMb !== null) {
			const gb = q.customMb / 1024;
			if (Number.isInteger(gb)) {
				amount = String(gb);
				unit = 'GB';
			} else {
				amount = String(q.customMb);
				unit = 'MB';
			}
		} else {
			amount = '';
			unit = 'GB';
		}
		fieldError = null;
	}

	async function load() {
		loadError = null;
		try {
			applyData(await apiFetch<UserQuota>(`${API}/quotas/${encodeURIComponent(userId)}`));
		} catch (e) {
			loadError = errorText(e, 'Speicherkontingent konnte nicht geladen werden.');
		}
	}

	$effect(() => {
		void userId;
		untrack(() => void load());
	});

	/** Eingabe in ganze MB (`null` = ungültig) */
	const customMb = $derived.by(() => {
		const n = Number(amount.replace(',', '.'));
		if (!amount.trim() || !Number.isFinite(n) || n <= 0) return null;
		const mb = Math.round(unit === 'GB' ? n * 1024 : n);
		return mb >= 1 && mb <= MAX_USER_QUOTA_MB ? mb : null;
	});

	/** Limit, das nach dem Speichern gälte (`null` = unbegrenzt, `undefined` = Eingabe unvollständig) */
	const nextLimit = $derived.by((): number | null | undefined => {
		if (!data) return undefined;
		if (mode === 'default') return data.defaultBytes;
		if (mode === 'unlimited') return null;
		return customMb === null ? undefined : customMb * 1024 * 1024;
	});

	const belowUsage = $derived(
		!!data && typeof nextLimit === 'number' && data.usedBytes > nextLimit
	);

	const dirty = $derived(
		!!data && (mode !== data.mode || (mode === 'custom' && customMb !== data.customMb))
	);

	const defaultText = $derived(
		data ? (data.defaultBytes === null ? 'unbegrenzt' : formatBytes(data.defaultBytes)) : ''
	);

	const options = $derived<{ value: QuotaMode; label: string; hint: string }[]>([
		{
			value: 'default',
			label: `Standard (${defaultText})`,
			hint: 'Folgt der Einstellung des Moduls.'
		},
		{ value: 'custom', label: 'Eigenes Limit', hint: 'Fester Wert nur für dieses Konto.' },
		{
			value: 'unlimited',
			label: 'Unbegrenzt',
			hint: 'Nur durch den Speicher des Servers begrenzt.'
		}
	]);

	async function save() {
		if (!data) return;
		if (mode === 'custom' && customMb === null) {
			fieldError = `Bitte eine Zahl zwischen 1 MB und ${formatBytes(MAX_USER_QUOTA_MB * 1024 * 1024)} angeben.`;
			document.getElementById(`${uid}-amount`)?.focus();
			return;
		}
		busy = true;
		fieldError = null;
		try {
			const saved = await apiFetch<UserQuota>(`${API}/quotas/${encodeURIComponent(userId)}`, {
				method: 'PUT',
				body: JSON.stringify({ mode, mb: mode === 'custom' ? customMb : null })
			});
			applyData(saved);
			toast.success(`Speicherkontingent von ${userName} gespeichert`);
		} catch (e) {
			toast.error(errorText(e, 'Speichern fehlgeschlagen'));
		} finally {
			busy = false;
		}
	}
</script>

{#if loadError}
	<ErrorState compact message={loadError} onretry={() => void load()} />
{:else if !data}
	<LoadingState label="Speicherkontingent" rows={2} rowClass="h-8 w-full" />
{:else}
	<div class="grid gap-3">
		<QuotaBar quota={{ usedBytes: data.usedBytes, limitBytes: data.limitBytes }} />

		<div class="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Speicherkontingent">
			{#each options as opt (opt.value)}
				<button
					type="button"
					role="radio"
					aria-checked={mode === opt.value}
					class="flex flex-col items-start gap-0.5 rounded-lg border p-2.5 text-left transition-colors outline-none hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring {mode ===
					opt.value
						? 'border-primary bg-primary/5 ring-1 ring-primary'
						: ''}"
					onclick={() => {
						mode = opt.value;
						fieldError = null;
					}}
				>
					<span class="text-sm font-medium">{opt.label}</span>
					<span class="text-xs text-muted-foreground">{opt.hint}</span>
				</button>
			{/each}
		</div>

		{#if mode === 'custom'}
			<div class="grid gap-1">
				<label for="{uid}-amount" class="text-sm font-medium">Limit</label>
				<div class="flex gap-2">
					<Input
						id="{uid}-amount"
						inputmode="decimal"
						class="w-32 text-right tabular-nums"
						bind:value={amount}
						aria-invalid={fieldError ? true : undefined}
						aria-describedby={fieldError ? `${uid}-amount-error` : undefined}
						oninput={() => (fieldError = null)}
					/>
					<SelectField
						value={unit}
						onchange={(v) => (unit = v === 'MB' ? 'MB' : 'GB')}
						options={UNIT_ITEMS}
						label="Einheit"
						class="w-24"
					/>
				</div>
				{#if fieldError}
					<p id="{uid}-amount-error" class="text-xs text-destructive" role="alert">{fieldError}</p>
				{/if}
			</div>
		{/if}

		{#if belowUsage && typeof nextLimit === 'number'}
			<div
				class="flex items-start gap-2 rounded-md border border-warning-border bg-warning-muted p-2.5 text-xs text-warning"
				role="status"
			>
				<TriangleAlert class="mt-px size-4 shrink-0" aria-hidden="true" />
				<span>
					<b
						>Das Limit ({formatBytes(nextLimit)}) liegt unter der Belegung ({formatBytes(
							data.usedBytes
						)}).</b
					>
					Vorhandene Dateien bleiben erhalten, aber Uploads sind gesperrt, bis Platz frei ist.
				</span>
			</div>
		{/if}

		<p class="text-xs text-muted-foreground">
			Zählt eigene Dateien inklusive Papierkorb und Uploads anderer in freigegebene Ordner.
		</p>

		<div class="flex justify-end">
			<Button type="button" size="sm" disabled={busy || !dirty} onclick={save}>
				{busy ? BUSY_SAVE : 'Kontingent speichern'}
			</Button>
		</div>
	</div>
{/if}
