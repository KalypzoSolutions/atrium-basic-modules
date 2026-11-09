<script lang="ts">
	import { onMount } from 'svelte';
	import { todayBerlin } from '$lib/sdk/dates';
	import * as Tabs from '$lib/components/ui/tabs';
	import { deviceLayout } from '$lib/components/layout';
	import { startsBeforeBlocker } from '../../dependencies';
	import { taskRange } from '../../phases';
	import type { BoardDetail, Phase, TaskCard } from '../../schemas';
	import {
		DAY_WIDTH,
		dayIndex,
		monthTicks,
		moveRange,
		pxToDays,
		rangeDays,
		resizeRange,
		timelineRange,
		weekTicks,
		type DateRange,
		type TimelineScale,
		type TimelineTarget
	} from '../../timeline';
	import { shortDate } from '../helpers';

	/**
	 * Zeitleiste: Phasen als Bänder, Aufgaben als Balken (Meilensteine als Raute), Heute-Linie, Pfeile für
	 * „wartet auf“. Desktop mit Bearbeiten-Recht: Balken ziehen (Mitte verschiebt, Ränder ändern Beginn/Ende),
	 * Tastatur ←/→ (Umschalt = 7 Tage, Alt = nur Ende). Touch: nur ansehen.
	 */
	let {
		board,
		visible,
		isDone,
		canEdit,
		onopen,
		onchange
	}: {
		board: BoardDetail;
		visible: TaskCard[];
		isDone: (t: TaskCard) => boolean;
		canEdit: boolean;
		onopen: (taskId: string) => void;
		onchange: (target: TimelineTarget, next: DateRange, prev: DateRange) => void;
	} = $props();

	const ROW = 32;
	const today = todayBerlin();
	let scale = $state<TimelineScale>('week');
	let scroller = $state<HTMLDivElement | null>(null);

	const editable = $derived(canEdit && deviceLayout() === 'desktop');
	const dayW = $derived(DAY_WIDTH[scale]);

	const phaseRange = (p: Phase): DateRange | null => {
		const from = p.startsOn ?? p.endsOn;
		const to = p.endsOn ?? p.startsOn;
		return from && to ? { from, to } : null;
	};

	const range = $derived(
		timelineRange(
			[
				...board.phases.flatMap((p) => [p.startsOn, p.endsOn]),
				...visible.flatMap((t) => [t.startsOn, t.dueOn])
			],
			today
		)
	);
	const width = $derived(rangeDays(range) * dayW);
	const months = $derived(monthTicks(range));
	const weeks = $derived(scale === 'week' ? weekTicks(range) : []);

	type Row =
		| { type: 'phase'; key: string; phase: Phase }
		| { type: 'group'; key: string; label: string }
		| { type: 'task'; key: string; task: TaskCard };

	const rows = $derived.by((): Row[] => {
		const list: Row[] = [];
		const dated = visible.filter((t) => taskRange(t));
		const byStart = (a: TaskCard, b: TaskCard) =>
			taskRange(a)!.from.localeCompare(taskRange(b)!.from) || a.position - b.position;
		for (const p of board.phases) {
			list.push({ type: 'phase', key: `p-${p.id}`, phase: p });
			for (const t of dated.filter((t) => t.phaseId === p.id).sort(byStart)) {
				list.push({ type: 'task', key: t.id, task: t });
			}
		}
		const rest = dated
			.filter((t) => !t.phaseId || !board.phases.some((p) => p.id === t.phaseId))
			.sort(byStart);
		if (rest.length && board.phases.length) {
			list.push({ type: 'group', key: 'g-none', label: 'Ohne Phase' });
		}
		for (const t of rest) list.push({ type: 'task', key: t.id, task: t });
		return list;
	});
	const undated = $derived(visible.filter((t) => !taskRange(t)).length);
	const rowIndex = $derived(new Map(rows.map((r, i) => [r.key, i])));
	const phaseColor = (id: string | null) => board.phases.find((p) => p.id === id)?.color ?? null;

	// --- Ziehen ---
	type Mode = 'move' | 'start' | 'end';
	let drag = $state<{
		target: TimelineTarget;
		mode: Mode;
		orig: DateRange;
		x0: number;
		days: number;
	} | null>(null);

	function preview(target: TimelineTarget, r: DateRange): DateRange {
		if (!drag || drag.target.id !== target.id || !drag.days) return r;
		return drag.mode === 'move' ? moveRange(r, drag.days) : resizeRange(r, drag.mode, drag.days);
	}

	function down(e: PointerEvent, target: TimelineTarget, r: DateRange, mode: Mode) {
		if (!editable || e.button !== 0) return;
		e.stopPropagation();
		(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
		drag = { target, mode, orig: r, x0: e.clientX, days: 0 };
	}

	function moveDrag(e: PointerEvent) {
		if (drag) drag.days = pxToDays(e.clientX - drag.x0, scale);
	}

	let suppressClick = false;
	function up() {
		if (!drag) return;
		const d = drag;
		drag = null;
		if (!d.days) return;
		suppressClick = true;
		setTimeout(() => (suppressClick = false), 0);
		const next =
			d.mode === 'move' ? moveRange(d.orig, d.days) : resizeRange(d.orig, d.mode, d.days);
		onchange(d.target, next, d.orig);
	}

	function keydown(e: KeyboardEvent, target: TimelineTarget, r: DateRange) {
		if (!editable || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
		e.preventDefault();
		const days = (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 7 : 1);
		onchange(target, e.altKey ? resizeRange(r, 'end', days) : moveRange(r, days), r);
	}

	const left = (date: string) => dayIndex(range, date) * dayW;
	const barWidth = (r: DateRange) => (dayIndex(range, r.to) - dayIndex(range, r.from) + 1) * dayW;

	function label(r: DateRange): string {
		return r.from === r.to ? shortDate(r.from) : `${shortDate(r.from)}–${shortDate(r.to)}`;
	}

	// Pfeile „wartet auf“: Ende des Vorgängers → Beginn der Aufgabe
	const arrows = $derived.by(() => {
		const list: { key: string; d: string; conflict: boolean }[] = [];
		for (const r of rows) {
			if (r.type !== 'task') continue;
			const to = taskRange(r.task)!;
			for (const bid of r.task.blockedBy) {
				const bi = rowIndex.get(bid);
				const blocker = visible.find((t) => t.id === bid);
				const br = blocker ? taskRange(blocker) : null;
				if (bi === undefined || !br || !blocker) continue;
				const x1 = left(br.to) + dayW;
				const y1 = bi * ROW + ROW / 2;
				const x2 = left(to.from);
				const y2 = rowIndex.get(r.key)! * ROW + ROW / 2;
				const mid = Math.max(x1 + 8, Math.min(x2 - 8, x1 + 16));
				list.push({
					key: `${bid}-${r.key}`,
					d: `M ${x1} ${y1} H ${mid} V ${y2} H ${x2 - 2}`,
					conflict: startsBeforeBlocker(r.task, blocker)
				});
			}
		}
		return list;
	});

	onMount(() => {
		// zum heutigen Tag scrollen (etwas Vorlauf links)
		if (scroller) scroller.scrollLeft = Math.max(0, left(today) - 120);
	});
</script>

<svelte:window onpointermove={moveDrag} onpointerup={up} onpointercancel={() => (drag = null)} />

<div class="space-y-3">
	<div class="flex flex-wrap items-center justify-between gap-2">
		<p class="text-xs text-muted-foreground">
			{#if editable}
				Balken ziehen verschiebt, die Ränder ändern Beginn oder Ende. Tastatur: ←/→, mit Umschalt
				eine Woche, mit Alt nur das Ende.
			{:else if canEdit}
				Zum Ändern eine Aufgabe antippen.
			{/if}
			{#if undated}
				{undated} {undated === 1 ? 'Aufgabe' : 'Aufgaben'} ohne Datum (in der Liste).
			{/if}
		</p>
		<Tabs.Root value={scale} onValueChange={(v) => (scale = v as TimelineScale)}>
			<Tabs.List aria-label="Maßstab">
				<Tabs.Trigger value="week">Wochen</Tabs.Trigger>
				<Tabs.Trigger value="month">Monate</Tabs.Trigger>
			</Tabs.List>
		</Tabs.Root>
	</div>

	{#if !rows.length}
		<p class="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
			Noch nichts mit Datum. Gib Phasen oder Aufgaben einen Zeitraum, dann erscheinen sie hier.
		</p>
	{:else}
		<div class="flex overflow-hidden rounded-lg border bg-card">
			<!-- Beschriftungen -->
			<div class="w-44 shrink-0 border-r sm:w-56" aria-hidden="true">
				<div class="h-12 border-b bg-muted/40"></div>
				{#each rows as r (r.key)}
					<div
						class="flex items-center gap-1.5 truncate border-b px-3 text-sm last:border-b-0"
						style:height={`${ROW}px`}
					>
						{#if r.type === 'phase'}
							<span
								class="size-2.5 shrink-0 rounded-full bg-muted-foreground/40"
								style:background-color={r.phase.color ?? undefined}
							></span>
							<span class="truncate font-semibold">{r.phase.name}</span>
						{:else if r.type === 'group'}
							<span class="truncate text-xs font-semibold text-muted-foreground">{r.label}</span>
						{:else}
							<span
								class="truncate pl-4"
								class:text-muted-foreground={isDone(r.task)}
								class:line-through={isDone(r.task)}
								>{r.task.isMilestone ? '◆ ' : ''}{r.task.title}</span
							>
						{/if}
					</div>
				{/each}
			</div>

			<!-- Zeitachse -->
			<div class="min-w-0 flex-1 overflow-x-auto" bind:this={scroller}>
				<div class="relative" style:width={`${width}px`}>
					<div class="sticky top-0 h-12 border-b bg-muted/40 text-xs text-muted-foreground">
						{#each months as m (m.date)}
							<span
								class="absolute top-0 h-6 truncate border-l px-1.5 leading-6 font-medium text-foreground"
								style:left={`${m.offset * dayW}px`}
								style:width={`${m.days * dayW}px`}>{m.label}</span
							>
						{/each}
						{#each weeks as w (w.date)}
							<span
								class="absolute top-6 h-6 truncate border-l px-1 leading-6"
								style:left={`${w.offset * dayW}px`}
								style:width={`${7 * dayW}px`}>{w.label}</span
							>
						{/each}
					</div>

					<div class="relative" style:height={`${rows.length * ROW}px`}>
						<!-- Raster -->
						{#each scale === 'week' ? weeks : months as t (t.date)}
							<span
								class="pointer-events-none absolute inset-y-0 border-l border-border/60"
								style:left={`${t.offset * dayW}px`}
								aria-hidden="true"
							></span>
						{/each}
						{#each rows as r, i (r.key)}
							<span
								class="pointer-events-none absolute inset-x-0 border-b border-border/60"
								style:top={`${(i + 1) * ROW - 1}px`}
								aria-hidden="true"
							></span>
						{/each}
						{#if today >= range.from && today <= range.to}
							<span
								class="pointer-events-none absolute inset-y-0 z-20 border-l-2 border-primary"
								style:left={`${left(today) + dayW / 2}px`}
								aria-hidden="true"
							>
								<span class="absolute -top-0 left-1 text-xs font-semibold text-link">heute</span>
							</span>
						{/if}

						<!-- Pfeile -->
						{#if arrows.length}
							<svg
								class="pointer-events-none absolute inset-0 z-10 overflow-visible"
								{width}
								height={rows.length * ROW}
								aria-hidden="true"
							>
								<defs>
									<marker
										id="tl-arrow"
										viewBox="0 0 8 8"
										refX="7"
										refY="4"
										markerWidth="6"
										markerHeight="6"
										orient="auto"
									>
										<path d="M0,0 L8,4 L0,8 z" class="fill-muted-foreground" />
									</marker>
								</defs>
								{#each arrows as a (a.key)}
									<path
										d={a.d}
										fill="none"
										stroke-width="1.5"
										class={a.conflict ? 'stroke-destructive' : 'stroke-muted-foreground'}
										marker-end="url(#tl-arrow)"
									/>
								{/each}
							</svg>
						{/if}

						<!-- Balken -->
						{#each rows as r, i (r.key)}
							{#if r.type === 'phase'}
								{@const base = phaseRange(r.phase)}
								{#if base}
									{@const pr = preview({ kind: 'phase', id: r.phase.id }, base)}
									{@render bar({
										target: { kind: 'phase', id: r.phase.id },
										r: pr,
										base,
										top: i * ROW + 4,
										height: ROW - 8,
										color: r.phase.color,
										tint: true,
										name: `Phase ${r.phase.name}`,
										milestone: false,
										done: false,
										onclick: null
									})}
								{/if}
							{:else if r.type === 'task'}
								{@const base = taskRange(r.task)!}
								{@const tr = preview({ kind: 'task', id: r.task.id }, base)}
								{@render bar({
									target: { kind: 'task', id: r.task.id },
									r: tr,
									base,
									top: i * ROW + 8,
									height: ROW - 16,
									color: phaseColor(r.task.phaseId),
									tint: false,
									name: r.task.title,
									milestone: r.task.isMilestone,
									done: isDone(r.task),
									onclick: () => onopen(r.task.id)
								})}
							{/if}
						{/each}
					</div>
				</div>
			</div>
		</div>
	{/if}
</div>

{#snippet bar(b: {
	target: TimelineTarget;
	r: DateRange;
	base: DateRange;
	top: number;
	height: number;
	color: string | null;
	tint: boolean;
	name: string;
	milestone: boolean;
	done: boolean;
	onclick: (() => void) | null;
})}
	{@const dragging = drag?.target.id === b.target.id}
	{#if b.milestone}
		<button
			type="button"
			class="absolute z-10 size-3.5 rotate-45 rounded-[2px] bg-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:outline-none"
			class:opacity-40={b.done}
			class:cursor-grab={editable}
			style:left={`${left(b.r.from) + dayW / 2 - 7}px`}
			style:top={`${b.top - 1}px`}
			aria-label={`${b.name}, Meilenstein am ${label(b.r)}`}
			title={`${b.name} · ${label(b.r)}`}
			onpointerdown={(e) => down(e, b.target, b.base, 'move')}
			onkeydown={(e) => keydown(e, b.target, b.base)}
			onclick={() => !suppressClick && b.onclick?.()}
		></button>
	{:else}
		<div
			class="group/bar absolute z-10 rounded-md"
			class:ring-2={dragging}
			class:ring-ring={dragging}
			style:left={`${left(b.r.from)}px`}
			style:top={`${b.top}px`}
			style:width={`${Math.max(barWidth(b.r), 6)}px`}
			style:height={`${b.height}px`}
		>
			<button
				type="button"
				class="absolute inset-0 rounded-md border text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:outline-none {b.color
					? ''
					: b.tint
						? 'border-border bg-muted'
						: 'border-transparent bg-muted-foreground/60'}"
				class:opacity-40={b.done}
				class:cursor-grab={editable}
				class:cursor-pointer={!editable && !!b.onclick}
				class:cursor-default={!editable && !b.onclick}
				style:background-color={b.color
					? b.tint
						? `color-mix(in oklab, ${b.color} 18%, var(--card))`
						: b.color
					: undefined}
				style:border-color={b.color ?? undefined}
				aria-label={`${b.name}, ${label(b.r)}`}
				title={`${b.name} · ${label(b.r)}`}
				onpointerdown={(e) => down(e, b.target, b.base, 'move')}
				onkeydown={(e) => keydown(e, b.target, b.base)}
				onclick={() => !suppressClick && b.onclick?.()}
			></button>
			{#if editable}
				<span
					class="absolute inset-y-0 left-0 w-2 cursor-ew-resize rounded-l-md opacity-0 group-hover/bar:bg-foreground/20 group-hover/bar:opacity-100"
					onpointerdown={(e) => down(e, b.target, b.base, 'start')}
					aria-hidden="true"
				></span>
				<span
					class="absolute inset-y-0 right-0 w-2 cursor-ew-resize rounded-r-md opacity-0 group-hover/bar:bg-foreground/20 group-hover/bar:opacity-100"
					onpointerdown={(e) => down(e, b.target, b.base, 'end')}
					aria-hidden="true"
				></span>
			{/if}
		</div>
		{#if dragging && drag?.days}
			<span
				class="absolute z-30 rounded bg-popover px-1.5 py-0.5 text-xs shadow-md tabular-nums"
				style:left={`${left(b.r.from)}px`}
				style:top={`${b.top - 22}px`}>{label(b.r)}</span
			>
		{/if}
	{/if}
{/snippet}
