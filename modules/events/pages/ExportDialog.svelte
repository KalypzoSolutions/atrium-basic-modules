<script lang="ts">
	// Termine als PDF exportieren: Ausführung (Terminliste, Monatskalender, Jahresplan), Zeitraum
	// (Monat, Jahr, frei) und Optionen. Übernimmt die Filter der Terminseite (Suche, Gruppe, Tag).
	import { toast } from 'svelte-sonner';
	import { apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { SegmentedSlider } from '$lib/components/ui/segmented-slider';
	import { SelectField } from '$lib/components/ui/select-field';
	import { FormField } from '$lib/components/layout';
	import { downloadPdf } from '$lib/components/layout/download';
	import { formatMonthLabel } from '$lib/components/layout/month-calendar';
	import { daysBetween } from '../recurrence';
	import {
		EXPORT_LAYOUT_LABELS,
		EXPORT_LAYOUTS,
		MAX_EXPORT_DAYS,
		type ExportLayout,
		type ExportOptions
	} from '../schemas';

	let {
		open = $bindable(false),
		month,
		search = '',
		groupId = null,
		groupName = null,
		tag = null
	}: {
		open?: boolean;
		/** Monat der Terminseite (`JJJJ-MM`), Vorbelegung */
		month: string;
		search?: string;
		groupId?: string | null;
		groupName?: string | null;
		tag?: string | null;
	} = $props();

	type Period = 'month' | 'year' | 'range';

	const LAYOUT_HINTS: Record<ExportLayout, string> = {
		list: 'Alle Termine untereinander, je Monat ein Abschnitt (A4 hoch).',
		calendar: 'Ein Kalenderblatt Mo–So je Monat (A4 quer).',
		year: 'Tage 1–31 als Zeilen, Monate als Spalten – ohne Briefkopf das ganze Jahr auf einer Seite (A4 quer), mit Briefkopf je Halbjahr eine Seite.'
	};

	let layout = $state<ExportLayout>('list');
	let period = $state<Period>('month');
	let selMonth = $state('');
	let selYear = $state('');
	let rangeFrom = $state('');
	let rangeTo = $state('');
	let includeActions = $state(true);
	let letterhead = $state(true);
	let withDescription = $state(false);
	let options = $state<ExportOptions | null>(null);
	let busy = $state(false);

	const baseYear = $derived(Number(month.slice(0, 4)));

	// Beim Öffnen aus der aktuellen Ansicht vorbelegen und die Auswahl laden
	$effect(() => {
		if (!open) return;
		selMonth = month;
		selYear = month.slice(0, 4);
		rangeFrom = `${month.slice(0, 4)}-08-01`;
		rangeTo = `${Number(month.slice(0, 4)) + 1}-07-31`;
		apiFetch<ExportOptions>('/modules/events/events/export/options')
			.then((o) => (options = o))
			.catch(() => (options = { actionsAvailable: false, maxDays: MAX_EXPORT_DAYS }));
	});

	function setLayout(v: ExportLayout) {
		layout = v;
		letterhead = v === 'list';
		if (v === 'year' && period === 'month') period = 'year';
	}

	const monthOptions = $derived.by(() => {
		const out: { value: string; label: string }[] = [];
		for (let y = baseYear - 1; y <= baseYear + 1; y++) {
			for (let m = 1; m <= 12; m++) {
				const value = `${y}-${String(m).padStart(2, '0')}`;
				out.push({ value, label: formatMonthLabel(value) });
			}
		}
		return out;
	});
	const yearOptions = $derived(
		Array.from({ length: 5 }, (_, i) => String(baseYear - 2 + i)).map((y) => ({
			value: y,
			label: y
		}))
	);

	function lastDay(m: string): string {
		const d = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).getUTCDate();
		return `${m}-${String(d).padStart(2, '0')}`;
	}

	const range = $derived.by((): { from: string; to: string } | null => {
		if (period === 'month')
			return selMonth ? { from: `${selMonth}-01`, to: lastDay(selMonth) } : null;
		if (period === 'year')
			return selYear ? { from: `${selYear}-01-01`, to: `${selYear}-12-31` } : null;
		return rangeFrom && rangeTo ? { from: rangeFrom, to: rangeTo } : null;
	});

	const rangeError = $derived.by(() => {
		if (period !== 'range') return '';
		if (!rangeFrom || !rangeTo) return 'Bitte Beginn und Ende angeben.';
		if (rangeTo < rangeFrom) return 'Das Ende liegt vor dem Beginn.';
		if (daysBetween(rangeFrom, rangeTo) >= MAX_EXPORT_DAYS) {
			return `Höchstens ${MAX_EXPORT_DAYS} Tage.`;
		}
		return '';
	});

	const filtered = $derived(!!(groupId || tag));
	const actionsPossible = $derived(!!options?.actionsAvailable && !filtered);
	const filterNote = $derived(
		[
			groupName || groupId ? `Gruppe „${groupName ?? groupId}“` : null,
			tag ? `Tag „${tag}“` : null,
			search ? `Suche „${search}“` : null
		]
			.filter(Boolean)
			.join(', ')
	);

	async function exportPdf() {
		if (!range || rangeError) return;
		const q = new URLSearchParams({ layout, from: range.from, to: range.to });
		if (search) q.set('search', search);
		if (groupId) q.set('groupId', groupId);
		if (tag) q.set('tag', tag);
		q.set('includeActions', String(actionsPossible && includeActions));
		q.set('letterhead', String(letterhead));
		if (layout === 'list') q.set('withDescription', String(withDescription));
		busy = true;
		try {
			await downloadPdf(`/api/v1/modules/events/events/export.pdf?${q}`, {}, 'termine.pdf');
			open = false;
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'PDF konnte nicht erstellt werden.');
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Termine exportieren</Dialog.Title>
			<Dialog.Description>
				Monats- oder Jahresplan als PDF – zum Ausdrucken, Aushängen oder Verschicken.
			</Dialog.Description>
		</Dialog.Header>

		<div class="space-y-5">
			<div class="space-y-2">
				<p class="text-sm font-medium">Ausführung</p>
				<SegmentedSlider
					value={layout}
					label="Ausführung"
					class="max-w-none"
					options={EXPORT_LAYOUTS.map((v) => ({ value: v, label: EXPORT_LAYOUT_LABELS[v] }))}
					onchange={setLayout}
				/>
				<p class="text-xs text-muted-foreground">{LAYOUT_HINTS[layout]}</p>
			</div>

			<div class="space-y-2">
				<p class="text-sm font-medium">Zeitraum</p>
				<SegmentedSlider
					bind:value={period}
					label="Zeitraum"
					class="max-w-none"
					options={[
						{ value: 'month', label: 'Monat' },
						{ value: 'year', label: 'Jahr' },
						{ value: 'range', label: 'Zeitraum' }
					]}
				/>
				{#if period === 'month'}
					<SelectField
						label="Monat"
						options={monthOptions}
						value={selMonth}
						onchange={(v) => (selMonth = v ?? month)}
					/>
				{:else if period === 'year'}
					<SelectField
						label="Jahr"
						options={yearOptions}
						value={selYear}
						onchange={(v) => (selYear = v ?? month.slice(0, 4))}
					/>
				{:else}
					<div class="grid gap-3 sm:grid-cols-2">
						<FormField label="Von" id="export-from">
							<Input id="export-from" type="date" bind:value={rangeFrom} />
						</FormField>
						<FormField label="Bis" id="export-to" error={rangeError}>
							<Input id="export-to" type="date" bind:value={rangeTo} aria-invalid={!!rangeError} />
						</FormField>
					</div>
					{#if !rangeError}
						<p class="text-xs text-muted-foreground">
							Zum Beispiel ein Schuljahr von August bis Juli (höchstens {MAX_EXPORT_DAYS} Tage).
						</p>
					{/if}
				{/if}
			</div>

			<div class="space-y-3">
				{#if options?.actionsAvailable}
					<div class="flex items-start gap-2">
						<Checkbox
							id="export-actions"
							checked={actionsPossible && includeActions}
							disabled={!actionsPossible}
							onCheckedChange={(v) => (includeActions = v === true)}
						/>
						<div class="grid gap-0.5">
							<Label for="export-actions" class="font-normal">Aktionen einbeziehen</Label>
							{#if filtered}
								<span class="text-xs text-muted-foreground">
									Nicht mit Gruppen- oder Tag-Filter (Aktionen haben keine Gruppen und Tags).
								</span>
							{/if}
						</div>
					</div>
				{/if}
				<div class="flex items-center gap-2">
					<Checkbox
						id="export-letterhead"
						checked={letterhead}
						onCheckedChange={(v) => (letterhead = v === true)}
					/>
					<Label for="export-letterhead" class="font-normal">Mit Briefkopf</Label>
				</div>
				{#if layout === 'list'}
					<div class="flex items-center gap-2">
						<Checkbox
							id="export-description"
							checked={withDescription}
							onCheckedChange={(v) => (withDescription = v === true)}
						/>
						<Label for="export-description" class="font-normal">Beschreibungen mitdrucken</Label>
					</div>
				{/if}
			</div>

			{#if filterNote}
				<p class="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
					Es gelten die Filter der Terminseite: {filterNote}.
				</p>
			{/if}
		</div>

		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
			<Button onclick={exportPdf} disabled={busy || !range || !!rangeError}>
				{busy ? 'PDF wird erstellt …' : 'PDF erstellen'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
