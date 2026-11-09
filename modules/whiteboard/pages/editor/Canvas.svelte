<script lang="ts">
	// Zeichenfläche: Hintergrund (Punkte/Raster), Elemente (nur sichtbare), eigene Auswahl mit Griffen,
	// Entwürfe beim Zeichnen/Verbinden/Erstellen, Auswahl und Cursor der anderen, Text-Eingabe als Überlagerung.
	import Lock from '@lucide/svelte/icons/lock';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import type { Background, PresenceUser, WbElement } from '../../schemas';
	import { elementBounds } from './bounds';
	import { arrowHeadPath, connectorGeometry, resolveConnector, resolveEnds } from './connectors';
	import type { EditorController } from './controller.svelte';
	import ElementView from './ElementView.svelte';
	import { strokePath } from './freehand';
	import {
		boxOf,
		center,
		inflate,
		intersects,
		isBoxElement,
		textArea,
		unionRects
	} from './geometry';
	import { ink, SELECTION, textOn } from './render';
	import { FONT_FAMILY, FONT_STACKS, fitFontSize } from './text-layout';
	import type { RenderContext } from './types';
	import { toScreen } from './viewport';

	let {
		ctrl,
		rc,
		background,
		peers,
		coarse,
		ariaLabel,
		surface = null
	}: {
		ctrl: EditorController;
		rc: RenderContext;
		background: Background;
		peers: PresenceUser[];
		coarse: boolean;
		ariaLabel: string;
		/** Feste Flächenfarbe (persönliche Einstellung) – `null` = durchsichtig, Modus/Theme scheint durch */
		surface?: string | null;
	} = $props();

	const store = $derived(ctrl.store);
	const view = $derived(ctrl.view);
	const lookup = (id: string) => store.get(id);

	// --- sichtbare Elemente (Hüllrechtecke je Objekt gemerkt) ---
	const boundsCache = new WeakMap<WbElement, ReturnType<typeof elementBounds>>();
	function boundsOf(el: WbElement) {
		if (el.type === 'connector') return elementBounds(el, lookup);
		let b = boundsCache.get(el);
		if (!b) {
			b = elementBounds(el, lookup);
			boundsCache.set(el, b);
		}
		return b;
	}
	const visibleArea = $derived(inflate(ctrl.visible(), 200 / view.zoom));
	const shown = $derived(
		store.ordered.filter((el) => el.type === 'connector' || intersects(visibleArea, boundsOf(el)))
	);

	// --- Raster ---
	const gridSize = $derived.by(() => {
		let s = 24;
		while (s * view.zoom < 12) s *= 2;
		return s;
	});
	const patternSize = $derived(gridSize * view.zoom);

	// --- Auswahl ---
	const selected = $derived(
		[...store.selection].map((id) => store.get(id)).filter((x): x is WbElement => !!x)
	);
	const single = $derived(selected.length === 1 ? selected[0]! : null);
	const handlePx = $derived(coarse ? 22 : 10);
	const hs = $derived(handlePx / view.zoom);
	const showHandles = $derived(
		!!single && store.canEdit && !single.data.locked && !ctrl.editing && ctrl.tool === 'select'
	);
	const corners = ['nw', 'ne', 'se', 'sw'] as const;
	const edges = ['n', 'e', 's', 'w'] as const;
	function handlePos(b: { x: number; y: number; w: number; h: number }, h: string) {
		const x = h.includes('w') ? b.x : h.includes('e') ? b.x + b.w : b.x + b.w / 2;
		const y = h.startsWith('n') ? b.y : h.startsWith('s') ? b.y + b.h : b.y + b.h / 2;
		return { x, y };
	}
	const cursorFor: Record<string, string> = {
		nw: 'nwse-resize',
		se: 'nwse-resize',
		ne: 'nesw-resize',
		sw: 'nesw-resize',
		n: 'ns-resize',
		s: 'ns-resize',
		e: 'ew-resize',
		w: 'ew-resize'
	};
	const multiBounds = $derived(
		selected.length > 1 ? unionRects(selected.map((el) => boundsOf(el))) : null
	);
	const canLink = $derived(
		!!single &&
			isBoxElement(single) &&
			single.type !== 'frame' &&
			single.type !== 'freehand' &&
			showHandles
	);

	// --- Anwesende ---
	const peerSelections = $derived(
		peers.flatMap((p) =>
			p.selection
				.map((id) => store.get(id))
				.filter((x): x is WbElement => !!x)
				.map((el) => ({ peer: p, el, rect: inflate(boundsOf(el), 4) }))
		)
	);

	// --- Text-Eingabe ---
	const editingEl = $derived(ctrl.editing ? store.get(ctrl.editing.id) : undefined);
	const editor = $derived.by(() => {
		const ed = ctrl.editing;
		const el = editingEl;
		if (!ed || !el) return null;
		if (el.type === 'shape' && ed.field === 'text') {
			const area = textArea(el.data.kind, el.data.w, el.data.h);
			const tl = toScreen(view, { x: el.data.x + area.x, y: el.data.y + area.y });
			return {
				kind: 'area' as const,
				value: el.data.text,
				left: tl.x,
				top: tl.y,
				width: area.w * view.zoom,
				height: area.h * view.zoom,
				// automatisch angepasste Schrift wie in der Ansicht
				fontSize:
					(el.data.autoFit
						? fitFontSize(
								el.data.text,
								area,
								{ ...el.data, fontFamily: el.data.fontFamily ?? 'sans' },
								rc.measure
							)
						: el.data.fontSize) * view.zoom,
				family: FONT_STACKS[el.data.fontFamily ?? 'sans'],
				decoration:
					[el.data.underline && 'underline', el.data.strike && 'line-through']
						.filter(Boolean)
						.join(' ') || 'none',
				/** Tab legt die nächste Notiz daneben an (nicht bei reinen Textfeldern) */
				canSpawn: el.data.kind !== 'text',
				align: el.data.align,
				valign: el.data.valign,
				color: el.data.textColor
					? el.data.fill === 'transparent'
						? ink(el.data.textColor, rc.palette)
						: el.data.textColor
					: textOn(el.data.fill, rc.palette),
				bold: el.data.bold,
				italic: el.data.italic
			};
		}
		if (el.type === 'frame') {
			const tl = toScreen(view, { x: el.data.x, y: el.data.y - 34 });
			return {
				kind: 'line' as const,
				value: el.data.title,
				left: tl.x,
				top: tl.y,
				width: Math.max(180, el.data.w * view.zoom * 0.6),
				label: 'Titel des Rahmens'
			};
		}
		if (el.type === 'connector') {
			const geo = resolveConnector(el.data, lookup);
			const m = toScreen(view, geo.mid);
			return {
				kind: 'line' as const,
				value: el.data.label,
				left: m.x - 100,
				top: m.y - 18,
				width: 200,
				label: 'Beschriftung der Verbindung'
			};
		}
		return null;
	});

	function focusOnMount(node: HTMLElement) {
		queueMicrotask(() => {
			node.focus();
			if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
				const len = node.value.length;
				node.setSelectionRange(len, len);
			}
		});
	}

	function editorKey(e: KeyboardEvent) {
		e.stopPropagation();
		if (e.key === 'Tab' && editor?.kind === 'area' && editor.canSpawn && ctrl.editing) {
			// nächste Notiz rechts daneben (Umschalt+Tab: darunter)
			e.preventDefault();
			const id = ctrl.editing.id;
			ctrl.finishEditing();
			ctrl.spawnNext(id, e.shiftKey ? 'bottom' : 'right', false);
			return;
		}
		if (
			e.key === 'Escape' ||
			(e.key === 'Enter' && (editor?.kind === 'line' || e.ctrlKey || e.metaKey))
		) {
			e.preventDefault();
			ctrl.finishEditing();
		}
	}

	// --- Entwürfe ---
	const draftPath = $derived(
		ctrl.draft
			? strokePath(ctrl.draft.points, {
					size: ctrl.draft.size,
					marker: ctrl.draft.marker,
					simulatePressure: ctrl.draft.mouse,
					last: false
				})
			: ''
	);
	const connectGeo = $derived(
		ctrl.connectDraft
			? connectorGeometry(ctrl.connectDraft.route, resolveEnds(ctrl.connectDraft, lookup), 0)
			: null
	);
	const connectHead = $derived(
		connectGeo ? arrowHeadPath('arrow', connectGeo.b, connectGeo.endAngle, 2) : null
	);
	const hoverEl = $derived(ctrl.hoverTarget ? store.get(ctrl.hoverTarget) : undefined);

	const cursor = $derived(
		ctrl.panning
			? 'grabbing'
			: ctrl.tool === 'hand' || ctrl.spaceDown
				? 'grab'
				: ctrl.tool === 'select'
					? 'default'
					: ctrl.tool === 'eraser'
						? 'cell'
						: 'crosshair'
	);

	$effect(() => {
		const svg = ctrl.svg;
		if (!svg) return;
		const onWheel = (e: WheelEvent) => ctrl.onWheel(e);
		svg.addEventListener('wheel', onWheel, { passive: false });
		return () => svg.removeEventListener('wheel', onWheel);
	});
</script>

<!-- feste Farbe oder durchsichtig (Seitenhintergrund bzw. Theme scheint durch) -->
<div class="relative h-full w-full overflow-hidden" style:background-color={surface ?? undefined}>
	<!-- Zeichenfläche als Anwendung: Tastenkürzel siehe aria-label, Fokus für die Tastatur -->
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<svg
		bind:this={ctrl.svg}
		class="absolute inset-0 h-full w-full touch-none select-none outline-none [-webkit-touch-callout:none]"
		style={`cursor:${cursor}`}
		role="application"
		aria-label={ariaLabel}
		tabindex="0"
		onpointerdown={(e) => ctrl.onPointerDown(e)}
		onpointermove={(e) => ctrl.onPointerMove(e)}
		onpointerup={(e) => ctrl.onPointerUp(e)}
		onpointercancel={(e) => ctrl.onPointerUp(e)}
		onpointerleave={() => ctrl.onPointerLeave()}
	>
		<defs>
			<pattern
				id="wb-dots"
				width={patternSize}
				height={patternSize}
				patternUnits="userSpaceOnUse"
				x={view.panX % patternSize}
				y={view.panY % patternSize}
			>
				<circle cx={1} cy={1} r={1.1} fill={rc.palette.pattern} />
			</pattern>
			<pattern
				id="wb-grid"
				width={patternSize}
				height={patternSize}
				patternUnits="userSpaceOnUse"
				x={view.panX % patternSize}
				y={view.panY % patternSize}
			>
				<path
					d={`M${patternSize} 0 L0 0 0 ${patternSize}`}
					fill="none"
					stroke={rc.palette.pattern}
					stroke-width="0.8"
				/>
			</pattern>
		</defs>
		{#if background !== 'none'}
			<rect
				width="100%"
				height="100%"
				fill={`url(#wb-${background === 'grid' ? 'grid' : 'dots'})`}
			/>
		{/if}

		<g transform={`translate(${view.panX} ${view.panY}) scale(${view.zoom})`}>
			{#each shown as el (el.id)}
				<ElementView {el} {rc} />
			{/each}

			<!-- Auswahl der anderen -->
			{#each peerSelections as s (`${s.peer.client}:${s.el.id}`)}
				<rect
					x={s.rect.x}
					y={s.rect.y}
					width={s.rect.w}
					height={s.rect.h}
					fill="none"
					stroke={s.peer.color}
					stroke-width={2 / view.zoom}
					rx={4 / view.zoom}
					pointer-events="none"
				/>
			{/each}

			<!-- Ziel beim Verbinden -->
			{#if hoverEl && isBoxElement(hoverEl)}
				{@const r = inflate(boundsOf(hoverEl), 6 / view.zoom)}
				<rect
					x={r.x}
					y={r.y}
					width={r.w}
					height={r.h}
					rx={6 / view.zoom}
					fill={SELECTION}
					fill-opacity="0.06"
					stroke={SELECTION}
					stroke-width={2 / view.zoom}
					pointer-events="none"
				/>
			{/if}

			<!-- eigene Auswahl -->
			{#each selected as el (el.id)}
				{#if isBoxElement(el)}
					{@const b = boxOf(el)}
					{@const c = center(b)}
					<g transform={`rotate(${b.rotation} ${c.x} ${c.y})`} pointer-events="none">
						<rect
							x={b.x - 3 / view.zoom}
							y={b.y - 3 / view.zoom}
							width={b.w + 6 / view.zoom}
							height={b.h + 6 / view.zoom}
							fill="none"
							stroke={SELECTION}
							stroke-width={1.5 / view.zoom}
							stroke-dasharray={el.data.locked ? `${4 / view.zoom} ${3 / view.zoom}` : undefined}
						/>
						{#if el.data.locked}
							<g style={`color:${SELECTION}`}>
								<Lock
									x={b.x + b.w - 14 / view.zoom}
									y={b.y - 22 / view.zoom}
									width={16 / view.zoom}
									height={16 / view.zoom}
								/>
							</g>
						{/if}
					</g>
				{:else}
					{@const geo = resolveConnector(el.data, lookup)}
					<path
						d={geo.path}
						fill="none"
						stroke={SELECTION}
						stroke-opacity="0.35"
						stroke-width={el.data.strokeWidth + 8}
						pointer-events="none"
					/>
				{/if}
			{/each}

			{#if multiBounds}
				<rect
					x={multiBounds.x - 6 / view.zoom}
					y={multiBounds.y - 6 / view.zoom}
					width={multiBounds.w + 12 / view.zoom}
					height={multiBounds.h + 12 / view.zoom}
					fill="none"
					stroke={SELECTION}
					stroke-width={1 / view.zoom}
					stroke-dasharray={`${5 / view.zoom} ${4 / view.zoom}`}
					pointer-events="none"
				/>
			{/if}

			<!-- Griffe -->
			{#if showHandles && single}
				{#if isBoxElement(single)}
					{@const b = boxOf(single)}
					{@const c = center(b)}
					<g transform={`rotate(${b.rotation} ${c.x} ${c.y})`}>
						<line
							x1={c.x}
							y1={b.y}
							x2={c.x}
							y2={b.y - 28 / view.zoom}
							stroke={SELECTION}
							stroke-width={1.5 / view.zoom}
							pointer-events="none"
						/>
						<circle
							data-handle="rotate"
							data-for={single.id}
							cx={c.x}
							cy={b.y - 28 / view.zoom}
							r={hs / 2 + 1 / view.zoom}
							fill={rc.palette.card}
							stroke={SELECTION}
							stroke-width={1.5 / view.zoom}
							style="cursor:grab"
						>
							<title>Drehen</title>
						</circle>
						{#each coarse ? corners : [...corners, ...edges] as h (h)}
							{@const p = handlePos(b, h)}
							<rect
								data-handle={h}
								data-for={single.id}
								x={p.x - hs / 2}
								y={p.y - hs / 2}
								width={hs}
								height={hs}
								rx={2 / view.zoom}
								fill={rc.palette.card}
								stroke={SELECTION}
								stroke-width={1.5 / view.zoom}
								style={`cursor:${cursorFor[h]}`}
							/>
						{/each}
						{#if canLink}
							<!-- oben sitzt der Drehgriff, daher nur rechts/unten/links -->
							{#each [['link-right', b.x + b.w + 18 / view.zoom + hs, c.y], ['link-bottom', c.x, b.y + b.h + 18 / view.zoom + hs], ['link-left', b.x - 18 / view.zoom - hs, c.y]] as const as [h, x, y] (h)}
								{@const r = Math.max(hs * 0.7, 9 / view.zoom)}
								<g data-handle={h} data-for={single.id} style="cursor:pointer">
									<circle cx={x} cy={y} r={r * 1.35} fill={SELECTION} fill-opacity="0.1" />
									<circle cx={x} cy={y} {r} fill={SELECTION} />
									<path
										d={`M${x - r * 0.5} ${y} H${x + r * 0.5} M${x} ${y - r * 0.5} V${y + r * 0.5}`}
										stroke="#ffffff"
										stroke-width={Math.max(1.5, r * 0.22)}
										stroke-linecap="round"
									/>
									<title>Klicken: neue verbundene Notiz · Ziehen: verbinden</title>
								</g>
							{/each}
						{/if}
					</g>
				{:else}
					{@const geo = resolveConnector(single.data, lookup)}
					{#each [['from', geo.a], ['to', geo.b]] as const as [h, p] (h)}
						<circle
							data-handle={h}
							data-for={single.id}
							cx={p.x}
							cy={p.y}
							r={hs * 0.65}
							fill={rc.palette.card}
							stroke={SELECTION}
							stroke-width={2 / view.zoom}
							style="cursor:move"
						/>
					{/each}
					{#if single.data.route !== 'straight'}
						<rect
							data-handle="bend"
							data-for={single.id}
							x={geo.mid.x - hs / 2}
							y={geo.mid.y - hs / 2}
							width={hs}
							height={hs}
							transform={`rotate(45 ${geo.mid.x} ${geo.mid.y})`}
							fill={SELECTION}
							style="cursor:move"
						>
							<title>Biegung ändern</title>
						</rect>
					{/if}
				{/if}
			{/if}

			<!-- Entwürfe -->
			{#if ctrl.createDraft}
				<rect
					x={ctrl.createDraft.x}
					y={ctrl.createDraft.y}
					width={ctrl.createDraft.w}
					height={ctrl.createDraft.h}
					fill={SELECTION}
					fill-opacity="0.06"
					stroke={SELECTION}
					stroke-width={1.5 / view.zoom}
					stroke-dasharray={`${5 / view.zoom} ${4 / view.zoom}`}
					pointer-events="none"
				/>
			{/if}
			{#if ctrl.draft}
				<path
					d={draftPath}
					fill={ctrl.draft.color}
					opacity={ctrl.draft.marker ? 0.4 : 1}
					pointer-events="none"
				/>
			{/if}
			{#if connectGeo}
				<g pointer-events="none">
					<path
						d={connectGeo.path}
						fill="none"
						stroke={rc.palette.ink}
						stroke-width="2"
						stroke-dasharray="6 4"
					/>
					{#if connectHead}
						<path
							d={connectHead.d}
							fill="none"
							stroke={rc.palette.ink}
							stroke-width="2"
							stroke-linecap="round"
						/>
					{/if}
				</g>
			{/if}
			{#if ctrl.marquee}
				<rect
					x={ctrl.marquee.x}
					y={ctrl.marquee.y}
					width={ctrl.marquee.w}
					height={ctrl.marquee.h}
					fill={SELECTION}
					fill-opacity="0.08"
					stroke={SELECTION}
					stroke-width={1 / view.zoom}
					pointer-events="none"
				/>
			{/if}

			<!-- Cursor der anderen -->
			{#each peers as p (p.client)}
				{#if p.cursor}
					<g
						transform={`translate(${p.cursor.x} ${p.cursor.y}) scale(${1 / view.zoom})`}
						pointer-events="none"
					>
						<path
							d="M0,0 L0,17 L4.5,13 L8,20.5 L11,19 L7.6,11.8 L13,11.8 Z"
							fill={p.color}
							stroke="#ffffff"
							stroke-width="1.2"
						/>
						<rect x="14" y="16" width={p.name.length * 7 + 12} height="20" rx="10" fill={p.color} />
						<text
							x="20"
							y="30"
							font-family={FONT_FAMILY}
							font-size="12"
							font-weight="600"
							fill="#ffffff">{p.name}</text
						>
					</g>
				{/if}
			{/each}
		</g>
	</svg>

	{#if editor}
		{#if editor.kind === 'area'}
			<div
				class="absolute flex"
				style={`left:${editor.left}px;top:${editor.top}px;width:${editor.width}px;height:${editor.height}px;align-items:${editor.valign === 'top' ? 'flex-start' : editor.valign === 'bottom' ? 'flex-end' : 'center'}`}
			>
				<Textarea
					{@attach focusOnMount}
					aria-label="Text bearbeiten"
					value={editor.value}
					oninput={(e) => ctrl.updateText((e.currentTarget as HTMLTextAreaElement).value)}
					onkeydown={editorKey}
					onblur={() => ctrl.finishEditing()}
					class="max-h-full min-h-0 resize-none overflow-hidden rounded-none border-0 bg-transparent p-0 leading-tight shadow-none focus-visible:ring-0 dark:bg-transparent"
					style={`font-size:${editor.fontSize}px;font-family:${editor.family};text-decoration:${editor.decoration};color:${editor.color};text-align:${editor.align};font-weight:${editor.bold ? 700 : 400};font-style:${editor.italic ? 'italic' : 'normal'};line-height:1.25`}
				/>
			</div>
		{:else}
			<div
				class="absolute"
				style={`left:${editor.left}px;top:${editor.top}px;width:${editor.width}px`}
			>
				<Input
					{@attach focusOnMount}
					aria-label={editor.label}
					value={editor.value}
					maxlength={200}
					oninput={(e) => ctrl.updateText((e.currentTarget as HTMLInputElement).value)}
					onkeydown={editorKey}
					onblur={() => ctrl.finishEditing()}
					class="h-8 bg-background shadow-md"
				/>
			</div>
		{/if}
	{/if}
</div>
