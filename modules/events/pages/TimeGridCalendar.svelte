<script lang="ts">
	import ChevronLeft from '@lucide/svelte/icons/chevron-left';
	import ChevronRight from '@lucide/svelte/icons/chevron-right';
	import Plus from '@lucide/svelte/icons/plus';
	import Repeat from '@lucide/svelte/icons/repeat';
	import {
		addDays,
		type CalendarItem,
		calendarItemKey,
		contrastTextColor,
		describeItem,
		formatDayLabel,
		formatItemTime,
		formatLongDate,
		formatShortDate,
		isValidDate,
		itemRange,
		itemsOnDay,
		layoutWeek,
		localToday,
		type WeekSegment,
		weekdayLabels
	} from '$lib/components/layout/month-calendar';
	import { Button } from '$lib/components/ui/button';
	import {
		allDayItems,
		hourRange,
		isoWeek,
		layoutDay,
		type TimedBlock,
		weekDays
	} from '../time-grid';

	interface Props {
		items: CalendarItem[];
		view: 'day' | 'week';
		/** Angezeigter Tag `YYYY-MM-DD` (Woche: beliebiger Tag der Woche), bindbar */
		date?: string;
		today?: string;
		onselect?: (item: CalendarItem) => void;
		/** Wenn gesetzt: „Termin anlegen“ je Tag (Knopf im Kopf, Klick in eine freie Fläche) */
		onday?: (date: string) => void;
		/** Klick auf den Tageskopf in der Woche → Tagesansicht */
		onopenday?: (date: string) => void;
		loading?: boolean;
	}

	let {
		items,
		view,
		date = $bindable(),
		today = localToday(),
		onselect,
		onday,
		onopenday,
		loading = false
	}: Props = $props();

	/** Höhe einer Stunde im Raster (rem) und einer Spur in der Ganztagsleiste (rem) */
	const HOUR = 3;
	const LANE = 1.5;

	const current = $derived(isValidDate(date) ? date : today);
	const days = $derived(view === 'week' ? weekDays(current) : [current]);
	const allDay = $derived(layoutWeek(days, allDayItems(items), 99));
	const lanes = $derived(allDay.segments.reduce((n, s) => Math.max(n, s.lane + 1), 0));
	const range = $derived(hourRange(items, days));
	const hours = $derived(Array.from({ length: range.to - range.from }, (_, i) => range.from + i));
	const blocks = $derived(new Map(days.map((d) => [d, layoutDay(items, d)])));
	const weekdays = weekdayLabels();

	const label = $derived.by(() => {
		if (view === 'day') return formatLongDate(current);
		const first = days[0]!;
		const last = days[6]!;
		const month = new Intl.DateTimeFormat('de-DE', { month: 'long', timeZone: 'UTC' });
		const d = (s: string) => new Date(`${s}T00:00:00Z`);
		const span =
			first.slice(0, 7) === last.slice(0, 7)
				? `${Number(first.slice(8))}.–${Number(last.slice(8))}. ${month.format(d(last))} ${last.slice(0, 4)}`
				: first.slice(0, 4) === last.slice(0, 4)
					? `${Number(first.slice(8))}. ${month.format(d(first))} – ${Number(last.slice(8))}. ${month.format(d(last))} ${last.slice(0, 4)}`
					: `${formatShortDate(first)}${first.slice(0, 4)} – ${formatShortDate(last)}${last.slice(0, 4)}`;
		return `${span} · KW ${isoWeek(first)}`;
	});

	// Jetzt-Linie: Minuten seit Mitternacht in Europe/Berlin, jede Minute neu
	let nowMinutes = $state(berlinMinutes());
	function berlinMinutes(): number {
		const parts = new Intl.DateTimeFormat('de-DE', {
			hour: '2-digit',
			minute: '2-digit',
			hourCycle: 'h23',
			timeZone: 'Europe/Berlin'
		}).formatToParts(new Date());
		const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
		return get('hour') * 60 + get('minute');
	}
	$effect(() => {
		const timer = setInterval(() => (nowMinutes = berlinMinutes()), 60_000);
		return () => clearInterval(timer);
	});
	const showNow = $derived(
		days.includes(today) && nowMinutes >= range.from * 60 && nowMinutes <= range.to * 60
	);

	function go(delta: number) {
		date = addDays(current, delta * (view === 'week' ? 7 : 1));
	}

	function goToday() {
		date = today;
	}

	function colorStyle(item: CalendarItem): string {
		const fg = contrastTextColor(item.color);
		return fg ? `background-color: ${item.color}; color: ${fg}` : '';
	}

	function colorClass(item: CalendarItem): string {
		return item.color && contrastTextColor(item.color) ? '' : 'bg-primary text-primary-foreground';
	}

	function barStyle(seg: WeekSegment): string {
		return [
			`grid-column: ${seg.startCol + 1} / span ${seg.span}`,
			`grid-row: ${seg.lane + 1}`,
			colorStyle(seg.item)
		]
			.filter(Boolean)
			.join('; ');
	}

	function blockStyle(b: TimedBlock): string {
		const top = ((b.start - range.from * 60) / 60) * HOUR;
		const height = Math.max(((b.end - b.start) / 60) * HOUR, 1.25);
		return [
			`top: ${top}rem`,
			`height: calc(${height}rem - 2px)`,
			`left: calc(${(b.col / b.cols) * 100}% + 2px)`,
			`width: calc(${100 / b.cols}% - 4px)`,
			colorStyle(b.item)
		]
			.filter(Boolean)
			.join('; ');
	}

	function rangeText(item: CalendarItem): string {
		const r = itemRange(item);
		if (!r || r.start === r.end) return '';
		return `${formatShortDate(r.start)}–${formatShortDate(r.end)}`;
	}

	const pad = (n: number) => String(n).padStart(2, '0');
</script>

<div class="space-y-3">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<h2 class="text-section" aria-live="polite">{label}</h2>
		<div class="flex items-center gap-1">
			{#if loading}
				<span class="text-muted-foreground mr-2 text-xs" role="status">Lädt …</span>
			{/if}
			<Button variant="outline" size="sm" onclick={goToday}>Heute</Button>
			<Button
				variant="outline"
				size="icon-sm"
				onclick={() => go(-1)}
				aria-label={view === 'week' ? 'Vorherige Woche' : 'Vorheriger Tag'}
			>
				<ChevronLeft />
			</Button>
			<Button
				variant="outline"
				size="icon-sm"
				onclick={() => go(1)}
				aria-label={view === 'week' ? 'Nächste Woche' : 'Nächster Tag'}
			>
				<ChevronRight />
			</Button>
		</div>
	</div>

	<!-- Zeitraster (Woche ab 640 px, Tag immer) -->
	<div
		class="bg-card overflow-hidden rounded-lg border transition-opacity {view === 'week'
			? 'hidden sm:block'
			: ''}"
		class:opacity-60={loading}
		aria-busy={loading}
		role="region"
		aria-label={view === 'week' ? `Wochenansicht ${label}` : `Tagesansicht ${label}`}
	>
		<!-- Kopf: Wochentage -->
		<div class="bg-muted/40 flex border-b">
			<div class="w-14 shrink-0" aria-hidden="true"></div>
			<div class="grid flex-1" style="grid-template-columns: repeat({days.length}, minmax(0, 1fr))">
				{#each days as d (d)}
					{@const isToday = d === today}
					<div class="group flex items-center justify-between gap-1 border-l px-2 py-1.5">
						{#if view === 'week' && onopenday}
							<button
								type="button"
								class="hover:bg-muted focus-visible:ring-ring flex items-center gap-1.5 rounded-md px-1 text-left outline-none focus-visible:ring-3"
								aria-label={`${formatLongDate(d)}${isToday ? ' (heute)' : ''} – Tagesansicht öffnen`}
								onclick={() => onopenday?.(d)}
							>
								{@render dayHead(d, isToday)}
							</button>
						{:else}
							<span class="flex items-center gap-1.5 px-1">{@render dayHead(d, isToday)}</span>
						{/if}
						{#if onday}
							<button
								type="button"
								class="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring inline-flex size-6 shrink-0 items-center justify-center rounded-md opacity-0 outline-none group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-3"
								aria-label={`Termin am ${formatLongDate(d)} anlegen`}
								onclick={() => onday?.(d)}
							>
								<Plus class="size-3.5" />
							</button>
						{/if}
					</div>
				{/each}
			</div>
		</div>

		<!-- Ganztägige und mehrtägige Termine -->
		{#if lanes > 0}
			<div class="flex border-b">
				<div
					class="text-muted-foreground flex w-14 shrink-0 items-start justify-end px-1.5 py-1 text-[0.7rem]"
				>
					ganztags
				</div>
				<div
					class="grid flex-1 gap-y-0.5 py-1"
					style="grid-template-columns: repeat({days.length}, minmax(0, 1fr)); grid-auto-rows: {LANE -
						0.125}rem"
				>
					{#each allDay.segments as seg (calendarItemKey(seg.item))}
						<button
							type="button"
							class="focus-visible:ring-ring mx-0.5 flex min-w-0 items-center gap-1 overflow-hidden px-1.5 text-left text-xs leading-none outline-none hover:brightness-95 focus-visible:ring-2 focus-visible:ring-offset-1 {colorClass(
								seg.item
							)} {seg.continuesBefore ? 'rounded-l-none' : 'rounded-l-md'} {seg.continuesAfter
								? 'rounded-r-none'
								: 'rounded-r-md'}"
							style={barStyle(seg)}
							aria-label={describeItem(seg.item)}
							title={describeItem(seg.item)}
							onclick={() => onselect?.(seg.item)}
						>
							{#if !seg.continuesBefore && formatItemTime(seg.item)}
								<span class="shrink-0 tabular-nums opacity-80">{formatItemTime(seg.item)}</span>
							{/if}
							{#if seg.item.recurring}
								<Repeat class="size-3 shrink-0 opacity-80" aria-hidden="true" />
							{/if}
							<span class="truncate font-medium">{seg.item.title}</span>
						</button>
					{/each}
				</div>
			</div>
		{/if}

		<!-- Stundenraster -->
		<div class="flex">
			<div
				class="relative w-14 shrink-0"
				style="height: {hours.length * HOUR}rem"
				aria-hidden="true"
			>
				{#each hours as h, i (h)}
					<span
						class="text-muted-foreground absolute right-1.5 text-[0.7rem] tabular-nums {i === 0
							? 'translate-y-0.5'
							: '-translate-y-1/2'}"
						style="top: {i * HOUR}rem"
						>{pad(h)}:00</span
					>
				{/each}
			</div>
			<div
				class="relative grid flex-1"
				style="grid-template-columns: repeat({days.length}, minmax(0, 1fr)); height: {hours.length *
					HOUR}rem"
			>
				<!-- Stundenlinien -->
				{#each hours as h, i (h)}
					{#if i > 0}
						<div
							class="pointer-events-none absolute inset-x-0 border-t"
							style="top: {i * HOUR}rem"
							aria-hidden="true"
						></div>
					{/if}
				{/each}
				{#each days as d (d)}
					{@const isToday = d === today}
					<div class="relative border-l {isToday ? 'bg-primary/5' : ''}">
						{#if onday}
							<button
								type="button"
								class="absolute inset-0 z-0 cursor-default outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
								tabindex={-1}
								aria-hidden="true"
								onclick={() => onday?.(d)}
							></button>
						{/if}
						{#each blocks.get(d) ?? [] as b (calendarItemKey(b.item))}
							{@const time = formatItemTime(b.item)}
							{@const short = b.end - b.start < 45}
							<button
								type="button"
								class="focus-visible:ring-ring absolute z-10 flex overflow-hidden rounded-md px-1.5 py-0.5 text-left text-xs leading-tight shadow-xs outline-none hover:brightness-95 focus-visible:ring-2 focus-visible:ring-offset-1 {short
									? 'items-center gap-1'
									: 'flex-col'} {colorClass(b.item)}"
								style={blockStyle(b)}
								aria-label={describeItem(b.item)}
								title={describeItem(b.item)}
								onclick={() => onselect?.(b.item)}
							>
								<span class="flex min-w-0 items-center gap-1 font-medium">
									{#if b.item.recurring}
										<Repeat class="size-3 shrink-0 opacity-80" aria-hidden="true" />
									{/if}
									<span class="truncate">{b.item.title}</span>
								</span>
								{#if time}
									<span class="shrink-0 tabular-nums opacity-80">{time}</span>
								{/if}
							</button>
						{/each}
						{#if showNow && isToday}
							<div
								class="pointer-events-none absolute inset-x-0 z-20 border-t-2 border-destructive"
								style="top: {((nowMinutes - range.from * 60) / 60) * HOUR}rem"
								aria-hidden="true"
							>
								<span
									class="bg-destructive absolute -top-[5px] -left-[5px] size-2 rounded-full"
								></span>
							</div>
						{/if}
					</div>
				{/each}
			</div>
		</div>
	</div>

	<!-- Woche unter 640 px: Liste je Tag -->
	{#if view === 'week'}
		<ul class="space-y-3 sm:hidden" class:opacity-60={loading} aria-label={`Woche ${label}`}>
			{#each days as d (d)}
				{@const dayItems = itemsOnDay(items, d)}
				{@const isToday = d === today}
				<li class="bg-card rounded-lg border">
					<div class="flex items-center justify-between gap-2 border-b px-3 py-1.5">
						<h3 class="text-sm font-semibold">
							{#if onopenday}
								<button type="button" class="text-left" onclick={() => onopenday?.(d)}
									>{formatDayLabel(d)}</button
								>
							{:else}
								{formatDayLabel(d)}
							{/if}
							{#if isToday}
								<span
									class="bg-primary text-primary-foreground ml-1 rounded-full px-1.5 py-0.5 text-[0.7rem] font-medium"
									>Heute</span
								>
							{/if}
						</h3>
						{#if onday}
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label={`Termin am ${formatLongDate(d)} anlegen`}
								onclick={() => onday?.(d)}
							>
								<Plus />
							</Button>
						{/if}
					</div>
					{#if dayItems.length}
						<ul class="divide-y">
							{#each dayItems as item (calendarItemKey(item))}
								<li>
									<button
										type="button"
										class="hover:bg-muted/50 focus-visible:ring-ring flex w-full items-center gap-3 px-3 py-2 text-left text-sm outline-none focus-visible:ring-3 focus-visible:ring-inset"
										aria-label={describeItem(item)}
										onclick={() => onselect?.(item)}
									>
										<span
											class="bg-primary h-8 w-1 shrink-0 rounded-full"
											style={contrastTextColor(item.color) ? `background-color: ${item.color}` : ''}
											aria-hidden="true"
										></span>
										<span class="min-w-0 flex-1">
											<span class="flex min-w-0 items-center gap-1.5 font-medium">
												{#if item.recurring}
													<Repeat
														class="text-muted-foreground size-3.5 shrink-0"
														aria-hidden="true"
													/>
												{/if}
												<span class="truncate">{item.title}</span>
											</span>
											{#if formatItemTime(item) || rangeText(item)}
												<span class="text-muted-foreground block text-xs tabular-nums">
													{[rangeText(item), formatItemTime(item)].filter(Boolean).join(' · ')}
												</span>
											{/if}
										</span>
									</button>
								</li>
							{/each}
						</ul>
					{:else}
						<p class="text-muted-foreground px-3 py-2 text-sm">Keine Termine</p>
					{/if}
				</li>
			{/each}
		</ul>
	{/if}
</div>

{#snippet dayHead(d: string, isToday: boolean)}
	<span class="text-muted-foreground text-xs font-medium"
		>{weekdays[(new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7]}</span
	>
	<span
		class="inline-flex size-6 items-center justify-center rounded-full text-xs tabular-nums {isToday
			? 'bg-primary text-primary-foreground font-semibold'
			: 'text-foreground'}"
		>{Number(d.slice(8, 10))}</span
	>
{/snippet}
