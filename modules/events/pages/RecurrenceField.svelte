<script lang="ts">
	import { Button } from '$lib/components/ui/button';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import { FormField, NumberStepper } from '$lib/components/layout';
	import {
		MAX_RECURRENCE_COUNT,
		RECURRENCE_FREQS,
		RECURRENCE_FREQ_LABELS,
		isRealDate,
		type MonthlyMode,
		type RecurrenceFreq,
		type RecurrenceRule
	} from '../schemas';
	import { describeRecurrence, isoWeekday } from '../recurrence';

	let {
		value = $bindable(null),
		startsOn,
		disabled = false,
		readonly = false,
		errors = {},
		idPrefix = 'recurrence',
		onchange
	}: {
		/** `null` = einmaliger Termin */
		value?: RecurrenceRule | null;
		/** Startdatum des Termins (`YYYY-MM-DD`, darf leer sein) */
		startsOn: string;
		disabled?: boolean;
		/** Nur die Zusammenfassung als Text anzeigen */
		readonly?: boolean;
		/** Feldfehler mit Pfaden wie `recurrence.end.date` */
		errors?: Record<string, string>;
		idPrefix?: string;
		onchange?: (value: RecurrenceRule | null) => void;
	} = $props();

	const WEEKDAYS = [
		{ n: 1, short: 'Mo', long: 'Montag' },
		{ n: 2, short: 'Di', long: 'Dienstag' },
		{ n: 3, short: 'Mi', long: 'Mittwoch' },
		{ n: 4, short: 'Do', long: 'Donnerstag' },
		{ n: 5, short: 'Fr', long: 'Freitag' },
		{ n: 6, short: 'Sa', long: 'Samstag' },
		{ n: 7, short: 'So', long: 'Sonntag' }
	] as const;
	const MONTHS = [
		'Januar',
		'Februar',
		'März',
		'April',
		'Mai',
		'Juni',
		'Juli',
		'August',
		'September',
		'Oktober',
		'November',
		'Dezember'
	];
	const UNITS: Record<RecurrenceFreq, [string, string]> = {
		daily: ['Tag', 'Tage'],
		weekly: ['Woche', 'Wochen'],
		monthly: ['Monat', 'Monate'],
		yearly: ['Jahr', 'Jahre']
	};
	const NONE = 'none';
	const DEFAULT_COUNT = 10;

	const ids = $derived({
		freq: `${idPrefix}-freq`,
		interval: `${idPrefix}-interval`,
		weekdays: `${idPrefix}-weekdays`,
		monthlyMode: `${idPrefix}-monthly-mode`,
		endType: `${idPrefix}-end-type`,
		endDate: `${idPrefix}-end-date`,
		endCount: `${idPrefix}-end-count`
	});

	/** Startdatum zerlegt (nur bei gültigem Datum) */
	const start = $derived.by(() => {
		if (!startsOn || !isRealDate(startsOn)) return null;
		const [y, m, d] = startsOn.split('-').map(Number) as [number, number, number];
		let weekday: number;
		try {
			weekday = isoWeekday(startsOn);
		} catch {
			// Fallback, solange recurrence.ts noch nicht fertig ist
			const js = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
			weekday = js === 0 ? 7 : js;
		}
		const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
		return { year: y, month: m, day: d, weekday, daysInMonth };
	});

	const summary = $derived.by(() => {
		if (!value) return '';
		try {
			return describeRecurrence(value, startsOn);
		} catch {
			return '';
		}
	});

	const freqOptions = [
		{ value: NONE, label: 'Keine' },
		...RECURRENCE_FREQS.map((f) => ({ value: f, label: RECURRENCE_FREQ_LABELS[f] }))
	];

	const monthlyOptions = $derived.by(() => {
		const yearly = value?.freq === 'yearly';
		if (!start) {
			return [
				{ value: 'day', label: 'am gleichen Tag' },
				{ value: 'nth-weekday', label: 'am gleichen Wochentag (n-ter)' },
				{ value: 'last-weekday', label: 'am letzten Wochentag' }
			];
		}
		const wd = WEEKDAYS[start.weekday - 1]!.long;
		const month = MONTHS[start.month - 1]!;
		const inMonth = yearly ? ` im ${month}` : '';
		const n = Math.ceil(start.day / 7);
		const opts: { value: MonthlyMode; label: string }[] = [
			{ value: 'day', label: yearly ? `am ${start.day}. ${month}` : `am ${start.day}.` },
			{ value: 'nth-weekday', label: `am ${n}. ${wd}${inMonth}` }
		];
		if (start.day > start.daysInMonth - 7) {
			opts.push({ value: 'last-weekday', label: `am letzten ${wd}${inMonth}` });
		}
		return opts;
	});

	const endOptions = [
		{ value: 'never', label: 'Nie' },
		{ value: 'until', label: 'Am Datum' },
		{ value: 'count', label: 'Nach Anzahl' }
	];

	const selectedWeekdays = $derived.by(() => {
		if (!value || value.freq !== 'weekly') return [] as number[];
		if (value.byWeekday?.length) return value.byWeekday;
		return start ? [start.weekday] : [];
	});

	const intervalUnit = $derived(
		value ? UNITS[value.freq][value.interval === 1 ? 0 : 1] : UNITS.daily[1]
	);

	function err(...keys: string[]): string | undefined {
		for (const k of keys) {
			const e = errors[`recurrence.${k}`];
			if (e) return e;
		}
		return undefined;
	}

	function emit(next: RecurrenceRule | null) {
		value = next;
		onchange?.(next);
	}

	function setFreq(v: string | null) {
		if (!v || v === NONE) {
			if (value !== null) emit(null);
			return;
		}
		const freq = v as RecurrenceFreq;
		if (value?.freq === freq) return;
		const next: RecurrenceRule = {
			freq,
			interval: value?.interval ?? 1,
			byWeekday: freq === 'weekly' && start ? [start.weekday] : undefined,
			end: value?.end ?? { type: 'never' }
		};
		if (freq === 'monthly' || freq === 'yearly') {
			const keep = value?.monthlyMode;
			next.monthlyMode = keep && monthlyOptionsFor(freq).some((o) => o === keep) ? keep : 'day';
		}
		emit(next);
	}

	function monthlyOptionsFor(freq: RecurrenceFreq): MonthlyMode[] {
		if (freq !== 'monthly' && freq !== 'yearly') return [];
		if (!start) return ['day', 'nth-weekday', 'last-weekday'];
		const modes: MonthlyMode[] = ['day', 'nth-weekday'];
		if (start.day > start.daysInMonth - 7) modes.push('last-weekday');
		return modes;
	}

	function setInterval(n: number) {
		if (!value) return;
		emit({ ...value, interval: n });
	}

	function toggleWeekday(n: number) {
		if (!value || disabled) return;
		const current = selectedWeekdays;
		let next: number[];
		if (current.includes(n)) {
			if (current.length <= 1) return; // mindestens ein Tag bleibt aktiv
			next = current.filter((d) => d !== n);
		} else {
			next = [...current, n].sort((a, b) => a - b);
		}
		emit({ ...value, byWeekday: next });
	}

	function setMonthlyMode(v: string | null) {
		if (!value || !v) return;
		emit({ ...value, monthlyMode: v as MonthlyMode });
	}

	function setEndType(v: string | null) {
		if (!value || !v || v === value.end.type) return;
		if (v === 'until') emit({ ...value, end: { type: 'until', date: startsOn || '' } });
		else if (v === 'count') emit({ ...value, end: { type: 'count', count: DEFAULT_COUNT } });
		else emit({ ...value, end: { type: 'never' } });
	}

	function setEndDate(e: Event) {
		if (!value) return;
		const date = (e.currentTarget as HTMLInputElement).value;
		emit({ ...value, end: { type: 'until', date } });
	}

	function setEndCount(count: number) {
		if (!value) return;
		emit({ ...value, end: { type: 'count', count } });
	}
</script>

{#if readonly}
	{#if value}
		<p class="text-sm">
			<span class="text-muted-foreground">Wiederholung:</span>
			{summary || RECURRENCE_FREQ_LABELS[value.freq]}
		</p>
	{/if}
{:else}
	<fieldset class="grid gap-4" {disabled}>
		<legend class="sr-only">Wiederholung</legend>
		<div class="grid gap-4 sm:grid-cols-2">
			<FormField label="Wiederholung" id={ids.freq} error={err('freq') ?? errors['recurrence']}>
				<SelectField
					id={ids.freq}
					label="Wiederholung"
					options={freqOptions}
					value={value?.freq ?? NONE}
					onchange={setFreq}
					{disabled}
					invalid={!!err('freq')}
				/>
			</FormField>
			{#if value}
				<FormField label="Alle" id={ids.interval} error={err('interval')}>
					<NumberStepper
						id={ids.interval}
						label="Abstand in {UNITS[value.freq][1]}"
						min={1}
						max={99}
						value={value.interval}
						unit={intervalUnit}
						onchange={setInterval}
						{disabled}
						invalid={!!err('interval')}
					/>
				</FormField>
			{/if}
		</div>

		{#if value?.freq === 'weekly'}
			<div class="grid gap-1.5">
				<span id={ids.weekdays} class="text-sm leading-none font-medium">An Wochentagen</span>
				<div class="flex flex-wrap gap-1.5" role="group" aria-labelledby={ids.weekdays}>
					{#each WEEKDAYS as wd (wd.n)}
						{@const pressed = selectedWeekdays.includes(wd.n)}
						<Button
							type="button"
							size="sm"
							variant={pressed ? 'default' : 'outline'}
							class="w-11"
							aria-pressed={pressed}
							aria-label={wd.long}
							{disabled}
							onclick={() => toggleWeekday(wd.n)}
						>
							{wd.short}
						</Button>
					{/each}
				</div>
				{#if err('byWeekday')}
					<p role="alert" class="text-xs text-destructive">{err('byWeekday')}</p>
				{/if}
			</div>
		{/if}

		{#if value && (value.freq === 'monthly' || value.freq === 'yearly')}
			<div class="grid gap-4 sm:grid-cols-2">
				<FormField label="Termin" id={ids.monthlyMode} error={err('monthlyMode')}>
					<SelectField
						id={ids.monthlyMode}
						label="Termin im {value.freq === 'yearly' ? 'Jahr' : 'Monat'}"
						options={monthlyOptions}
						value={value.monthlyMode ?? 'day'}
						onchange={setMonthlyMode}
						{disabled}
						invalid={!!err('monthlyMode')}
					/>
				</FormField>
			</div>
		{/if}

		{#if value}
			<div class="grid gap-4 sm:grid-cols-2">
				<FormField label="Ende" id={ids.endType} error={err('end.type', 'end')}>
					<SelectField
						id={ids.endType}
						label="Ende der Serie"
						options={endOptions}
						value={value.end.type}
						onchange={setEndType}
						{disabled}
						invalid={!!err('end.type', 'end')}
					/>
				</FormField>
				{#if value.end.type === 'until'}
					<FormField label="Letzter Termin am" id={ids.endDate} error={err('end.date')}>
						<Input
							id={ids.endDate}
							type="date"
							value={value.end.date}
							min={startsOn || undefined}
							onchange={setEndDate}
							{disabled}
							aria-invalid={!!err('end.date')}
							aria-describedby={err('end.date') ? `${ids.endDate}-error` : undefined}
						/>
					</FormField>
				{:else if value.end.type === 'count'}
					<FormField label="Anzahl" id={ids.endCount} error={err('end.count')}>
						<NumberStepper
							id={ids.endCount}
							label="Anzahl der Termine"
							min={1}
							max={MAX_RECURRENCE_COUNT}
							value={value.end.count}
							unit={value.end.count === 1 ? 'Termin' : 'Termine'}
							onchange={setEndCount}
							{disabled}
							invalid={!!err('end.count')}
						/>
					</FormField>
				{/if}
			</div>
		{/if}

		<p class="text-xs text-muted-foreground empty:hidden" aria-live="polite">{summary}</p>
	</fieldset>
{/if}
