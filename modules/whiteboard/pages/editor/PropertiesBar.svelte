<script lang="ts">
	// Eigenschaftsleiste über der Fläche: passt sich der Auswahl an (Farben, Linie, Text, Verbinder, Reihenfolge …);
	// ohne Auswahl beim Stift/Marker: Farbe und Stärke.
	import ArrowDownToLine from '@lucide/svelte/icons/arrow-down-to-line';
	import ArrowUpToLine from '@lucide/svelte/icons/arrow-up-to-line';
	import Bold from '@lucide/svelte/icons/bold';
	import Copy from '@lucide/svelte/icons/copy';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import ExternalLink from '@lucide/svelte/icons/external-link';
	import Italic from '@lucide/svelte/icons/italic';
	import Lock from '@lucide/svelte/icons/lock';
	import LockOpen from '@lucide/svelte/icons/lock-open';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { Button } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import * as Popover from '$lib/components/ui/popover';
	import { Slider } from '$lib/components/ui/slider';
	import {
		ARROW_HEADS,
		FILL_COLORS,
		SHAPE_KINDS,
		SHAPE_LABELS,
		STROKE_COLORS,
		type ArrowHead,
		type ConnectorRoute,
		type ShapeKind,
		type StrokeStyle,
		type WbElement
	} from '../../schemas';
	import ColorButton from './ColorButton.svelte';
	import TextSettings from './TextSettings.svelte';
	import type { EditorController } from './controller.svelte';

	let {
		ctrl,
		onopen,
		onedit
	}: {
		ctrl: EditorController;
		onopen: (el: WbElement) => void;
		onedit: (el: WbElement) => void;
	} = $props();

	const store = $derived(ctrl.store);
	const selected = $derived(
		[...store.selection].map((id) => store.get(id)).filter((x): x is WbElement => !!x)
	);
	const first = $derived(selected[0]);
	const shapes = $derived(selected.filter((e) => e.type === 'shape'));
	const connectors = $derived(selected.filter((e) => e.type === 'connector'));
	const freehands = $derived(selected.filter((e) => e.type === 'freehand'));
	const textShapes = $derived(shapes.filter((e) => e.type === 'shape'));
	const allLocked = $derived(selected.length > 0 && selected.every((e) => e.data.locked));
	const penMode = $derived(!selected.length && (ctrl.tool === 'pen' || ctrl.tool === 'marker'));
	/** Notiz-Werkzeug ohne Auswahl: Farbe der nächsten Notiz wählen */
	const noteMode = $derived(!selected.length && ctrl.tool === 'note');
	const show = $derived(
		store.canEdit && (selected.length > 0 || penMode || noteMode) && !ctrl.editing
	);

	type Patch = (el: WbElement) => WbElement | null;
	const update = (patch: Patch) => ctrl.updateSelected(patch);
	/** Datenfelder für passende Typen setzen */
	function set(types: WbElement['type'][], values: Record<string, unknown>) {
		update((el) =>
			types.includes(el.type) && !el.data.locked
				? ({ ...el, data: { ...el.data, ...values } } as WbElement)
				: null
		);
	}

	const firstShape = $derived(shapes[0]?.type === 'shape' ? shapes[0].data : null);
	const firstConnector = $derived(connectors[0]?.type === 'connector' ? connectors[0].data : null);
	const firstFreehand = $derived(freehands[0]?.type === 'freehand' ? freehands[0].data : null);
	const colorable = $derived(
		selected.filter(
			(e) => e.type === 'frame' || e.type === 'link' || e.type === 'ref' || e.type === 'file'
		)
	);
	const firstColor = $derived.by(() => {
		const el = colorable[0];
		if (!el) return null;
		return 'color' in el.data ? (el.data.color as string | null) : null;
	});

	const ROUTES: { value: ConnectorRoute; label: string }[] = [
		{ value: 'straight', label: 'Gerade' },
		{ value: 'elbow', label: 'Gewinkelt' },
		{ value: 'curve', label: 'Gebogen' }
	];
	const STYLES: { value: StrokeStyle; label: string }[] = [
		{ value: 'solid', label: 'Durchgezogen' },
		{ value: 'dashed', label: 'Gestrichelt' },
		{ value: 'dotted', label: 'Gepunktet' }
	];
	const HEAD_LABELS: Record<ArrowHead, string> = {
		none: 'Ohne',
		arrow: 'Pfeil',
		triangle: 'Dreieck',
		dot: 'Punkt',
		bar: 'Strich'
	};
	const openable = $derived(
		selected.length === 1 &&
			first &&
			(first.type === 'link' || first.type === 'ref' || first.type === 'file')
	);
</script>

{#snippet divider()}
	<div class="mx-0.5 h-6 w-px shrink-0 bg-border" aria-hidden="true"></div>
{/snippet}

{#if show}
	<div
		class="pointer-events-auto absolute top-3 left-1/2 z-10 flex max-w-[calc(100%-1.5rem)] -translate-x-1/2 items-center gap-0.5 overflow-x-auto rounded-xl border bg-popover p-1 shadow-lg"
		role="toolbar"
		aria-label="Eigenschaften"
	>
		{#if noteMode}
			<div class="flex items-center gap-1 px-1" role="group" aria-label="Farbe der neuen Notiz">
				{#each FILL_COLORS.slice(0, 8) as c (c)}
					<button
						type="button"
						class={[
							'size-7 shrink-0 rounded-md border focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
							ctrl.noteColor === c && 'ring-2 ring-ring ring-offset-1 ring-offset-background'
						]}
						style:background-color={c}
						aria-label={`Notizfarbe ${c}`}
						aria-pressed={ctrl.noteColor === c}
						onclick={() => (ctrl.noteColor = c)}
					></button>
				{/each}
			</div>
			<span class="hidden px-2 text-xs whitespace-nowrap text-muted-foreground sm:inline">
				Auf die Fläche tippen, um die Notiz zu setzen
			</span>
		{:else if penMode}
			<ColorButton
				label={ctrl.tool === 'marker' ? 'Markerfarbe' : 'Stiftfarbe'}
				value={ctrl.tool === 'marker' ? ctrl.markerColor : ctrl.penColor}
				palette={ctrl.tool === 'marker'
					? ['#facc15', '#4ade80', '#60a5fa', '#f472b6', '#fb923c']
					: STROKE_COLORS}
				variant="stroke"
				onchange={(c) => (ctrl.tool === 'marker' ? (ctrl.markerColor = c) : (ctrl.penColor = c))}
			/>
			<div class="flex w-36 items-center gap-2 px-2">
				<span class="text-xs text-muted-foreground">Stärke</span>
				<Slider label="Strichstärke" min={1} max={24} bind:value={ctrl.penSize} />
			</div>
		{:else}
			{#if allLocked}
				<span class="px-2 text-xs text-muted-foreground">Gesperrt</span>
			{:else}
				{#if firstShape}
					{#if firstShape.kind !== 'text'}
						<ColorButton
							label="Füllfarbe"
							value={firstShape.fill}
							palette={FILL_COLORS}
							allowNone
							onchange={(c) => {
								set(['shape'], { fill: c });
								if (firstShape?.kind === 'note' && c !== 'transparent') ctrl.noteColor = c;
								else if (c !== 'transparent') ctrl.shapeFill = c;
							}}
						/>
						<ColorButton
							label="Randfarbe"
							value={firstShape.stroke}
							palette={STROKE_COLORS}
							allowNone
							variant="stroke"
							onchange={(c) =>
								set(['shape'], { stroke: c, strokeWidth: firstShape?.strokeWidth || 2 })}
						/>
						<Popover.Root>
							<Popover.Trigger>
								{#snippet child({ props })}
									<Button
										{...props}
										variant="ghost"
										size="sm"
										aria-label="Rand und Form"
										title="Rand und Form"
									>
										{SHAPE_LABELS[firstShape!.kind]}
									</Button>
								{/snippet}
							</Popover.Trigger>
							<Popover.Content class="w-64 space-y-3 p-3">
								<div>
									<p class="mb-1 text-xs font-medium text-muted-foreground">Form</p>
									<div class="grid grid-cols-3 gap-1">
										{#each SHAPE_KINDS.filter((k) => k !== 'text') as k (k)}
											<Button
												size="sm"
												variant={firstShape?.kind === k ? 'secondary' : 'ghost'}
												onclick={() => set(['shape'], { kind: k as ShapeKind })}
												>{SHAPE_LABELS[k]}</Button
											>
										{/each}
									</div>
								</div>
								<div>
									<p class="mb-1 text-xs font-medium text-muted-foreground">Randstärke</p>
									<Slider
										label="Randstärke"
										min={0}
										max={16}
										value={firstShape?.strokeWidth ?? 2}
										onchange={(v) => set(['shape'], { strokeWidth: v })}
									/>
								</div>
								<div class="flex gap-1">
									{#each STYLES as s (s.value)}
										<Button
											size="sm"
											variant={firstShape?.strokeStyle === s.value ? 'secondary' : 'ghost'}
											onclick={() => set(['shape'], { strokeStyle: s.value })}>{s.label}</Button
										>
									{/each}
								</div>
							</Popover.Content>
						</Popover.Root>
						{@render divider()}
					{/if}
					<ColorButton
						label="Textfarbe"
						value={firstShape.textColor}
						palette={STROKE_COLORS}
						variant="text"
						onchange={(c) => set(['shape'], { textColor: c === 'transparent' ? null : c })}
					/>
					<TextSettings data={firstShape} onchange={(v) => set(['shape'], v)} />
					<Button
						variant={firstShape.bold ? 'secondary' : 'ghost'}
						size="icon"
						aria-label="Fett"
						aria-pressed={firstShape.bold}
						title="Fett"
						onclick={() => set(['shape'], { bold: !firstShape?.bold })}><Bold /></Button
					>
					<Button
						variant={firstShape.italic ? 'secondary' : 'ghost'}
						size="icon"
						aria-label="Kursiv"
						aria-pressed={firstShape.italic}
						title="Kursiv"
						onclick={() => set(['shape'], { italic: !firstShape?.italic })}><Italic /></Button
					>
					{#if textShapes.length === 1 && selected.length === 1}
						<Button
							variant="ghost"
							size="icon"
							aria-label="Text bearbeiten"
							title="Text bearbeiten"
							onclick={() => ctrl.startEditing(first!.id, 'text')}
						>
							<Pencil />
						</Button>
					{/if}
					{@render divider()}
				{/if}

				{#if firstConnector}
					<ColorButton
						label="Linienfarbe"
						value={firstConnector.stroke}
						palette={STROKE_COLORS}
						variant="stroke"
						onchange={(c) => c !== 'transparent' && set(['connector'], { stroke: c })}
					/>
					<Popover.Root>
						<Popover.Trigger>
							{#snippet child({ props })}
								<Button {...props} variant="ghost" size="sm" title="Linie">Linie</Button>
							{/snippet}
						</Popover.Trigger>
						<Popover.Content class="w-72 space-y-3 p-3">
							<div>
								<p class="mb-1 text-xs font-medium text-muted-foreground">Verlauf</p>
								<div class="flex gap-1">
									{#each ROUTES as r (r.value)}
										<Button
											size="sm"
											variant={firstConnector?.route === r.value ? 'secondary' : 'ghost'}
											onclick={() => {
												set(['connector'], { route: r.value, bend: 0 });
												ctrl.connectorRoute = r.value;
											}}>{r.label}</Button
										>
									{/each}
								</div>
							</div>
							<div>
								<p class="mb-1 text-xs font-medium text-muted-foreground">Stärke</p>
								<Slider
									label="Linienstärke"
									min={1}
									max={12}
									value={firstConnector?.strokeWidth ?? 2}
									onchange={(v) => set(['connector'], { strokeWidth: v })}
								/>
							</div>
							<div class="flex gap-1">
								{#each STYLES as s (s.value)}
									<Button
										size="sm"
										variant={firstConnector?.strokeStyle === s.value ? 'secondary' : 'ghost'}
										onclick={() => set(['connector'], { strokeStyle: s.value })}>{s.label}</Button
									>
								{/each}
							</div>
							{#each [['startHead', 'Anfang'], ['endHead', 'Ende']] as const as [key, label] (key)}
								<div>
									<p class="mb-1 text-xs font-medium text-muted-foreground">{label}</p>
									<div class="flex flex-wrap gap-1">
										{#each ARROW_HEADS as h (h)}
											<Button
												size="sm"
												variant={firstConnector?.[key] === h ? 'secondary' : 'ghost'}
												onclick={() => set(['connector'], { [key]: h })}>{HEAD_LABELS[h]}</Button
											>
										{/each}
									</div>
								</div>
							{/each}
						</Popover.Content>
					</Popover.Root>
					{#if connectors.length === 1 && selected.length === 1}
						<Button variant="ghost" size="sm" onclick={() => ctrl.startEditing(first!.id, 'label')}
							>Beschriften</Button
						>
					{/if}
					{@render divider()}
				{/if}

				{#if firstFreehand}
					<ColorButton
						label="Strichfarbe"
						value={firstFreehand.color}
						palette={STROKE_COLORS}
						variant="stroke"
						onchange={(c) => c !== 'transparent' && set(['freehand'], { color: c })}
					/>
					{@render divider()}
				{/if}

				{#if colorable.length}
					<ColorButton
						label="Farbe"
						value={firstColor}
						palette={[...STROKE_COLORS.slice(0, 9)]}
						onchange={(c) =>
							set(['frame', 'link', 'ref', 'file'], { color: c === 'transparent' ? null : c })}
					/>
					{@render divider()}
				{/if}
			{/if}

			{#if openable && first}
				<Button variant="ghost" size="sm" onclick={() => onopen(first!)}
					><ExternalLink /> Öffnen</Button
				>
				{#if first.type === 'link' && !allLocked}
					<Button
						variant="ghost"
						size="icon"
						aria-label="Link bearbeiten"
						title="Link bearbeiten"
						onclick={() => onedit(first!)}
					>
						<Pencil />
					</Button>
				{/if}
				{@render divider()}
			{/if}

			<Button
				variant="ghost"
				size="icon"
				aria-label="Duplizieren (Strg+D)"
				title="Duplizieren (Strg+D)"
				onclick={() => ctrl.duplicate()}
			>
				<Copy />
			</Button>
			<Button
				variant="ghost"
				size="icon"
				aria-label="Löschen (Entf)"
				title="Löschen (Entf)"
				disabled={allLocked}
				onclick={() => ctrl.deleteSelected()}
			>
				<Trash2 />
			</Button>
			<DropdownMenu.Root>
				<DropdownMenu.Trigger>
					{#snippet child({ props })}
						<Button
							{...props}
							variant="ghost"
							size="icon"
							aria-label="Weitere Aktionen"
							title="Weitere Aktionen"
						>
							<Ellipsis />
						</Button>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content align="end">
					<DropdownMenu.Item onclick={() => ctrl.bringToFront()}
						><ArrowUpToLine /> Nach vorne</DropdownMenu.Item
					>
					<DropdownMenu.Item onclick={() => ctrl.sendToBack()}
						><ArrowDownToLine /> Nach hinten</DropdownMenu.Item
					>
					<DropdownMenu.Item onclick={() => ctrl.toggleLock()}>
						{#if allLocked}<LockOpen /> Entsperren{:else}<Lock /> Sperren{/if}
					</DropdownMenu.Item>
				</DropdownMenu.Content>
			</DropdownMenu.Root>
		{/if}
	</div>
{/if}
