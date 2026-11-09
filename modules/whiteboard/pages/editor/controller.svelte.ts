/**
 * Bedienung des Whiteboards: Werkzeuge, Zeiger-/Touch-/Stift-Gesten (nur Pointer Events), Auswahl, Erstellen,
 * Verschieben (Rahmen mit Inhalt), Größe/Drehung, Verbinden (auch über Griffe an der Form), Freihand, Radierer,
 * Zwei-Finger-Zoom, Doppeltippen, Zwischenablage. Die Darstellung liest den Zustand reaktiv (`$state`).
 *
 * Touch: ein Finger auf leerer Fläche verschiebt die Ansicht, zwei Finger zoomen/verschieben; mit Stift wird
 * Touch kurz ignoriert (Handballen). Maus: leere Fläche zieht ein Auswahlrechteck, Mausrad verschiebt,
 * Strg + Mausrad (bzw. Trackpad-Pinch) zoomt.
 */
import {
	FILL_COLORS,
	parseElementData,
	type ConnectorData,
	type ConnectorEnd,
	type ConnectorRoute,
	type ShapeKind,
	type WbElement
} from '../../schemas';
import { elementBounds } from './bounds';
import { resolveConnector } from './connectors';
import { finalizeStroke, type StrokePoint } from './freehand';
import {
	boxOf,
	center,
	frameChildren,
	intersects,
	isBoxElement,
	rectFromPoints,
	rotatePoint,
	toLocal,
	type Point,
	type Rect
} from './geometry';
import type { BoardStore } from './store.svelte';
import { clampZoom, fitRect, stepZoom, toWorld, visibleRect, zoomAt, type View } from './viewport';
import { boundsOfElements } from './bounds';
import { browserMeasure, textHeight } from './text-layout';

export type Tool =
	| 'select'
	| 'hand'
	| 'note'
	| 'shape'
	| 'text'
	| 'connector'
	| 'pen'
	| 'marker'
	| 'eraser'
	| 'frame';

export type HandleName =
	| 'nw'
	| 'n'
	| 'ne'
	| 'e'
	| 'se'
	| 's'
	| 'sw'
	| 'w'
	| 'rotate'
	| 'from'
	| 'to'
	| 'bend'
	| 'link-top'
	| 'link-right'
	| 'link-bottom'
	| 'link-left';

type Gesture =
	| { kind: 'pan'; start: Point; panX: number; panY: number }
	| { kind: 'marquee'; start: Point; additive: boolean }
	| {
			kind: 'move';
			start: Point;
			ids: string[];
			origins: Map<string, WbElement>;
			started: boolean;
			screenStart: Point;
	  }
	| {
			kind: 'resize';
			id: string;
			handle: HandleName;
			origin: WbElement & { type: Exclude<WbElement['type'], 'connector'> };
	  }
	| { kind: 'rotate'; id: string; origin: WbElement; startAngle: number }
	| { kind: 'end'; id: string; end: 'from' | 'to'; origin: WbElement }
	| { kind: 'bend'; id: string; origin: WbElement }
	| { kind: 'create'; tool: 'note' | 'shape' | 'text' | 'frame'; start: Point; screenStart: Point }
	| {
			kind: 'connect';
			started: boolean;
			screenStart: Point;
			/** Start an einem „+“-Griff: ohne Ziehen = neue verbundene Notiz in diese Richtung */
			spawn?: { id: string; dir: SpawnDir };
	  }
	| { kind: 'draw' }
	| { kind: 'erase' };

const MIN_SIZE = 16;
const DRAG_THRESHOLD = 4;
const TAP_MS = 320;

export interface ControllerHooks {
	/** Element öffnen (Link, Karte, Datei) */
	open(el: WbElement): void;
	/** Cursor in Board-Koordinaten (`null` = verlassen) */
	cursor(p: Point | null): void;
	/** Hinweis an die Person (z. B. gesperrtes Element) */
	notice(message: string): void;
}

const uuid = () => crypto.randomUUID();

export type SpawnDir = 'top' | 'right' | 'bottom' | 'left';
/** Abstand neuer Notizen zur Ausgangsnotiz */
const SPAWN_GAP = 80;

export class EditorController {
	view = $state<View>({ panX: 0, panY: 0, zoom: 1 });
	size = $state({ w: 0, h: 0 });
	tool = $state<Tool>('select');
	shapeKind = $state<ShapeKind>('rect');
	noteColor = $state<string>(FILL_COLORS[0]);
	shapeFill = $state('#ffffff');
	shapeStroke = $state('#1f2937');
	penColor = $state('#1f2937');
	penSize = $state(4);
	markerColor = $state('#facc15');
	connectorRoute = $state<ConnectorRoute>('curve');

	/** Überlagerungen für die Darstellung */
	marquee = $state<Rect | null>(null);
	draft = $state<{
		points: StrokePoint[];
		color: string;
		size: number;
		marker: boolean;
		mouse: boolean;
	} | null>(null);
	connectDraft = $state<Pick<ConnectorData, 'from' | 'to' | 'route'> | null>(null);
	createDraft = $state<Rect | null>(null);
	hoverTarget = $state<string | null>(null);
	editing = $state<{ id: string; field: 'text' | 'title' | 'label' } | null>(null);
	spaceDown = $state(false);
	panning = $state(false);

	svg: SVGSVGElement | null = null;
	private gesture: Gesture | null = null;
	private pointers = new Map<number, Point>();
	private pinch: { dist: number; mid: Point; view: View } | null = null;
	private lastPen = 0;
	private lastTap: { at: number; p: Point; id: string | null } | null = null;
	private downInfo: {
		at: number;
		p: Point;
		id: string | null;
		moved: boolean;
		/** Element war schon allein ausgewählt (Antippen → Text bearbeiten) */
		wasSelected: boolean;
	} | null = null;
	private clipboard: WbElement[] = [];

	constructor(
		readonly store: BoardStore,
		private readonly hooks: ControllerHooks
	) {}

	// --- Koordinaten -----------------------------------------------------------------

	local(e: { clientX: number; clientY: number }): Point {
		const r = this.svg?.getBoundingClientRect();
		return { x: e.clientX - (r?.left ?? 0), y: e.clientY - (r?.top ?? 0) };
	}

	world(e: { clientX: number; clientY: number }): Point {
		return toWorld(this.view, this.local(e));
	}

	/** Mitte des sichtbaren Bereichs */
	viewCenter(): Point {
		return toWorld(this.view, { x: this.size.w / 2, y: this.size.h / 2 });
	}

	visible(): Rect {
		return visibleRect(this.view, this.size);
	}

	// --- Ansicht ---------------------------------------------------------------------

	zoomTo(z: number, at?: Point): void {
		this.view = zoomAt(this.view, at ?? { x: this.size.w / 2, y: this.size.h / 2 }, z);
	}

	zoomStep(dir: 1 | -1): void {
		this.zoomTo(stepZoom(this.view.zoom, dir));
	}

	fit(rect?: Rect | null): void {
		const r = rect ?? boundsOfElements(this.store.ordered, (id) => this.store.get(id));
		if (!r) {
			this.view = { zoom: 1, panX: this.size.w / 2, panY: this.size.h / 2 };
			return;
		}
		// Rand für Werkzeug- und Eigenschaftsleiste
		this.view = fitRect(r, this.size, {
			maxZoom: rect ? 2 : 1,
			padding: this.size.w < 640 ? 32 : 80
		});
	}

	/** Element in die Mitte holen */
	focus(id: string): void {
		const el = this.store.get(id);
		if (!el) return;
		this.fit(elementBounds(el, (x) => this.store.get(x)));
		this.store.selection.clear();
		this.store.selection.add(id);
	}

	// --- Treffer ----------------------------------------------------------------------

	private targetOf(e: Event): {
		id: string | null;
		handle: HandleName | null;
		handleFor: string | null;
	} {
		const t = e.target as Element | null;
		const h = t?.closest?.('[data-handle]');
		if (h) {
			return {
				id: null,
				handle: h.getAttribute('data-handle') as HandleName,
				handleFor: h.getAttribute('data-for')
			};
		}
		const el = t?.closest?.('[data-el]');
		return { id: el?.getAttribute('data-el') ?? null, handle: null, handleFor: null };
	}

	/** Element unter dem Zeiger (für Verbinder-Ziele, Radierer), ohne `exclude` */
	elementAt(clientX: number, clientY: number, exclude?: string): string | null {
		if (typeof document === 'undefined') return null;
		for (const node of document.elementsFromPoint(clientX, clientY)) {
			if (!this.svg?.contains(node)) continue;
			const el = node.closest('[data-el]');
			const id = el?.getAttribute('data-el');
			if (id && id !== exclude) return id;
		}
		return null;
	}

	private canMove(el: WbElement): boolean {
		return this.store.canEdit && !el.data.locked;
	}

	// --- Pointer -------------------------------------------------------------------------

	onPointerDown(e: PointerEvent): void {
		if (e.button === 2) return; // Kontextmenü
		if (e.pointerType === 'pen') this.lastPen = Date.now();
		// Handballen: Touch kurz nach Stifteingabe ignorieren
		if (e.pointerType === 'touch' && Date.now() - this.lastPen < 800) return;
		const p = this.local(e);
		this.pointers.set(e.pointerId, p);
		try {
			this.svg?.setPointerCapture(e.pointerId);
		} catch {
			// z. B. synthetische Events in Tests
		}
		if (this.pointers.size === 2 && e.pointerType === 'touch') {
			this.cancelGesture();
			const [a, b] = [...this.pointers.values()] as [Point, Point];
			this.pinch = {
				dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
				mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
				view: { ...this.view }
			};
			return;
		}
		if (this.pointers.size > 1) return;

		const w = toWorld(this.view, p);
		const target = this.targetOf(e);
		this.downInfo = {
			at: Date.now(),
			p,
			id: target.id,
			moved: false,
			wasSelected:
				!!target.id && this.store.selection.size === 1 && this.store.selection.has(target.id)
		};

		if (e.button === 1 || this.tool === 'hand' || this.spaceDown) {
			this.startPan(p);
			return;
		}
		if (this.editing && target.id !== this.editing.id) this.finishEditing();

		if (target.handle && target.handleFor) {
			this.startHandle(target.handle, target.handleFor, w, e);
			return;
		}

		switch (this.tool) {
			case 'select': {
				if (target.id) {
					const el = this.store.get(target.id);
					if (!el) return;
					if (e.shiftKey || e.ctrlKey || e.metaKey) {
						if (this.store.selection.has(el.id)) this.store.selection.delete(el.id);
						else this.store.selection.add(el.id);
					} else if (!this.store.selection.has(el.id)) {
						this.store.selection.clear();
						this.store.selection.add(el.id);
					}
					const ids = [...this.store.selection]
						.map((id) => this.store.get(id))
						.filter((x): x is WbElement => !!x && this.canMove(x));
					if (!ids.length) return;
					const all = new Set(ids.map((x) => x.id));
					for (const x of ids) {
						if (x.type === 'frame')
							for (const c of frameChildren(x, this.store.elements.values())) all.add(c);
					}
					const origins = new Map<string, WbElement>();
					for (const id of all) {
						const o = this.store.get(id);
						if (o && this.canMove(o)) origins.set(id, o);
					}
					this.gesture = {
						kind: 'move',
						start: w,
						ids: [...origins.keys()],
						origins,
						started: false,
						screenStart: p
					};
				} else if (e.pointerType === 'touch') {
					this.startPan(p);
				} else {
					if (!e.shiftKey) this.store.selection.clear();
					this.gesture = { kind: 'marquee', start: w, additive: e.shiftKey };
					this.marquee = { x: w.x, y: w.y, w: 0, h: 0 };
				}
				return;
			}
			case 'note':
			case 'shape':
			case 'text':
			case 'frame':
				if (!this.store.canEdit) return;
				this.gesture = { kind: 'create', tool: this.tool, start: w, screenStart: p };
				return;
			case 'connector': {
				if (!this.store.canEdit) return;
				const from = this.endAt(w, target.id);
				this.connectDraft = { from, to: { ...from, elementId: null }, route: this.connectorRoute };
				this.gesture = { kind: 'connect', started: false, screenStart: p };
				return;
			}
			case 'pen':
			case 'marker': {
				if (!this.store.canEdit) return;
				const marker = this.tool === 'marker';
				this.draft = {
					points: [[w.x, w.y, e.pointerType === 'pen' ? e.pressure || 0.5 : 0.5]],
					color: marker ? this.markerColor : this.penColor,
					size: marker ? Math.max(6, this.penSize * 2) : this.penSize,
					marker,
					mouse: e.pointerType !== 'pen'
				};
				this.gesture = { kind: 'draw' };
				return;
			}
			case 'eraser':
				if (!this.store.canEdit) return;
				this.store.begin([]);
				this.gesture = { kind: 'erase' };
				this.eraseAt(e.clientX, e.clientY);
				return;
		}
	}

	onPointerMove(e: PointerEvent): void {
		const p = this.local(e);
		if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, p);
		const w = toWorld(this.view, p);
		if (e.pointerType !== 'touch') this.hooks.cursor(w);

		if (this.pinch && this.pointers.size >= 2) {
			const [a, b] = [...this.pointers.values()] as [Point, Point];
			const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
			const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
			const start = this.pinch.view;
			const zoom = clampZoom(start.zoom * (dist / this.pinch.dist));
			// Board-Punkt unter der Start-Mitte bleibt unter der aktuellen Mitte
			const anchor = toWorld(start, this.pinch.mid);
			this.view = { zoom, panX: mid.x - anchor.x * zoom, panY: mid.y - anchor.y * zoom };
			return;
		}
		if (
			this.downInfo &&
			Math.hypot(p.x - this.downInfo.p.x, p.y - this.downInfo.p.y) > DRAG_THRESHOLD
		) {
			this.downInfo.moved = true;
		}
		const g = this.gesture;
		if (!g) return;
		switch (g.kind) {
			case 'pan':
				this.view = {
					...this.view,
					panX: g.panX + p.x - g.start.x,
					panY: g.panY + p.y - g.start.y
				};
				return;
			case 'marquee':
				this.marquee = rectFromPoints(g.start, w);
				return;
			case 'move': {
				if (!g.started) {
					if (Math.hypot(p.x - g.screenStart.x, p.y - g.screenStart.y) < DRAG_THRESHOLD) return;
					g.started = true;
					this.store.begin(g.ids);
				}
				const dx = w.x - g.start.x;
				const dy = w.y - g.start.y;
				const next: WbElement[] = [];
				for (const [, o] of g.origins) next.push(this.translate(o, dx, dy, g.origins));
				this.store.preview(next);
				return;
			}
			case 'resize':
				this.store.preview([this.resized(g.origin, g.handle, w, e.shiftKey)]);
				return;
			case 'rotate': {
				const o = g.origin;
				if (!isBoxElement(o)) return;
				const c = center(boxOf(o));
				let deg =
					o.data.rotation + ((Math.atan2(w.y - c.y, w.x - c.x) * 180) / Math.PI - g.startAngle);
				deg = ((((deg + 180) % 360) + 360) % 360) - 180;
				const step = e.shiftKey ? 15 : 90;
				const snapped = Math.round(deg / step) * step;
				if (e.shiftKey || Math.abs(deg - snapped) < 4) deg = snapped;
				this.store.preview([
					{ ...o, data: { ...o.data, rotation: Math.round(deg * 10) / 10 } } as WbElement
				]);
				return;
			}
			case 'end': {
				const o = g.origin;
				if (o.type !== 'connector') return;
				const target = this.elementAt(e.clientX, e.clientY, o.id);
				const other = g.end === 'from' ? o.data.to : o.data.from;
				const end = this.endAt(w, target && target !== other.elementId ? target : null);
				this.hoverTarget = end.elementId;
				this.store.preview([{ ...o, data: { ...o.data, [g.end]: end } }]);
				return;
			}
			case 'bend': {
				const o = g.origin;
				if (o.type !== 'connector') return;
				const geo = resolveConnector(o.data, (x) => this.store.get(x));
				const dx = geo.b.x - geo.a.x;
				const dy = geo.b.y - geo.a.y;
				let bend: number;
				if (o.data.route === 'elbow') {
					const horizontal = Math.abs(dx) >= Math.abs(dy);
					bend = horizontal
						? (w.x - (geo.a.x + dx / 2)) / (Math.abs(dx) / 2 || 1)
						: (w.y - (geo.a.y + dy / 2)) / (Math.abs(dy) / 2 || 1);
				} else {
					const len = Math.hypot(dx, dy) || 1;
					const nx = -dy / len;
					const ny = dx / len;
					const mx = geo.a.x + dx / 2;
					const my = geo.a.y + dy / 2;
					bend = (((w.x - mx) * nx + (w.y - my) * ny) / (len * 0.5)) * (4 / 3);
				}
				bend = Math.max(-1, Math.min(1, Math.round(bend * 100) / 100));
				this.store.preview([{ ...o, data: { ...o.data, bend } }]);
				return;
			}
			case 'create':
				this.createDraft = rectFromPoints(g.start, w);
				return;
			case 'connect': {
				const d = this.connectDraft;
				if (!d) return;
				if (
					!g.started &&
					Math.hypot(p.x - g.screenStart.x, p.y - g.screenStart.y) > DRAG_THRESHOLD
				) {
					g.started = true;
				}
				const target = this.elementAt(e.clientX, e.clientY);
				const to = this.endAt(w, target && target !== d.from.elementId ? target : null);
				this.hoverTarget = to.elementId;
				this.connectDraft = { ...d, to };
				return;
			}
			case 'draw': {
				const d = this.draft;
				if (!d) return;
				const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
				const list = events.length ? events : [e];
				const points = [...d.points];
				for (const ev of list) {
					const q = this.world(ev);
					points.push([q.x, q.y, ev.pointerType === 'pen' ? ev.pressure || 0.5 : 0.5]);
				}
				this.draft = { ...d, points };
				return;
			}
			case 'erase':
				this.eraseAt(e.clientX, e.clientY);
				return;
		}
	}

	onPointerUp(e: PointerEvent): void {
		const wasPinch = !!this.pinch;
		this.pointers.delete(e.pointerId);
		if (this.pinch) {
			if (this.pointers.size < 2) this.pinch = null;
			return;
		}
		if (wasPinch) return;
		const p = this.local(e);
		const w = toWorld(this.view, p);
		const g = this.gesture;
		this.gesture = null;
		this.panning = false;
		const tap = this.downInfo && !this.downInfo.moved ? this.downInfo : null;
		this.downInfo = null;
		if (e.type === 'pointercancel') {
			this.cancelGesture(g);
			return;
		}
		if (g) {
			switch (g.kind) {
				case 'marquee': {
					const r = this.marquee;
					this.marquee = null;
					if (r && (r.w > 2 || r.h > 2)) {
						for (const el of this.store.ordered) {
							if (
								intersects(
									r,
									elementBounds(el, (x) => this.store.get(x))
								)
							) {
								this.store.selection.add(el.id);
							}
						}
					}
					break;
				}
				case 'move':
					if (g.started) this.store.end();
					break;
				case 'resize':
				case 'rotate':
				case 'bend':
					this.store.end();
					break;
				case 'end':
					this.hoverTarget = null;
					this.store.end();
					break;
				case 'create':
					this.finishCreate(g, w);
					break;
				case 'connect':
					if (!g.started && g.spawn) {
						this.connectDraft = null;
						this.hoverTarget = null;
						this.spawnNext(g.spawn.id, g.spawn.dir, true);
					} else this.finishConnect(g.started);
					break;
				case 'draw':
					this.finishDraw();
					break;
				case 'erase':
					this.store.end();
					break;
			}
		}
		if (tap && !this.handleTap(tap, e) && tap.wasSelected && tap.id && this.tool === 'select') {
			this.tapEdit(tap.id);
		}
	}

	/** Antippen einer schon ausgewählten Form/Notiz: Text bearbeiten */
	private tapEdit(id: string): void {
		const el = this.store.get(id);
		if (!el || el.type !== 'shape' || el.data.locked || !this.store.canEdit) return;
		if (this.editing?.id === id) return;
		this.startEditing(id, 'text');
	}

	/** Doppeltippen/-klicken selbst erkennen (Touch löst `dblclick` nicht verlässlich aus) */
	private handleTap(tap: { at: number; p: Point; id: string | null }, e: PointerEvent): boolean {
		const last = this.lastTap;
		const now = Date.now();
		if (
			last &&
			now - last.at < TAP_MS &&
			Math.hypot(last.p.x - tap.p.x, last.p.y - tap.p.y) < 24 &&
			last.id === tap.id
		) {
			this.lastTap = null;
			this.onDoubleTap(tap.id, toWorld(this.view, tap.p), e);
			return true;
		}
		this.lastTap = { at: now, p: tap.p, id: tap.id };
		return false;
	}

	private onDoubleTap(id: string | null, w: Point, e: PointerEvent): void {
		void e;
		if (this.tool !== 'select' && this.tool !== 'hand') return;
		if (!id) {
			if (!this.store.canEdit) return;
			// Doppelklick/-tippen auf leere Fläche: Notiz anlegen
			const el = this.createElement('note', { x: w.x - 100, y: w.y - 100, w: 200, h: 200 });
			if (el) this.startEditing(el.id, 'text');
			return;
		}
		const el = this.store.get(id);
		if (!el) return;
		if (el.type === 'link' || el.type === 'ref' || el.type === 'file') {
			this.hooks.open(el);
			return;
		}
		if (!this.store.canEdit) return;
		if (el.data.locked) {
			this.hooks.notice('Das Element ist gesperrt');
			return;
		}
		if (el.type === 'shape') this.startEditing(id, 'text');
		else if (el.type === 'frame') this.startEditing(id, 'title');
		else if (el.type === 'connector') this.startEditing(id, 'label');
	}

	onWheel(e: WheelEvent): void {
		e.preventDefault();
		const p = this.local(e);
		if (e.ctrlKey || e.metaKey) {
			this.view = zoomAt(this.view, p, this.view.zoom * Math.exp(-e.deltaY * 0.01));
			return;
		}
		const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
		const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
		this.view = { ...this.view, panX: this.view.panX - dx, panY: this.view.panY - dy };
	}

	onPointerLeave(): void {
		this.hooks.cursor(null);
	}

	private startPan(p: Point): void {
		this.gesture = { kind: 'pan', start: p, panX: this.view.panX, panY: this.view.panY };
		this.panning = true;
	}

	private cancelGesture(g: Gesture | null = this.gesture): void {
		this.gesture = null;
		this.panning = false;
		if (!g) return;
		if (['move', 'resize', 'rotate', 'end', 'bend', 'erase'].includes(g.kind)) this.store.cancel();
		this.marquee = null;
		this.draft = null;
		this.connectDraft = null;
		this.createDraft = null;
		this.hoverTarget = null;
	}

	// --- Griffe -------------------------------------------------------------------------

	private startHandle(handle: HandleName, id: string, w: Point, e: PointerEvent): void {
		const el = this.store.get(id);
		if (!el || !this.store.canEdit) return;
		if (el.data.locked) {
			this.hooks.notice('Das Element ist gesperrt');
			return;
		}
		if (handle.startsWith('link-')) {
			const anchor = handle.slice(5) as 'top' | 'right' | 'bottom' | 'left';
			const from: ConnectorEnd = { elementId: id, anchor, x: w.x, y: w.y };
			this.connectDraft = {
				from,
				to: { elementId: null, anchor: 'auto', x: w.x, y: w.y },
				route: this.connectorRoute
			};
			this.gesture = {
				kind: 'connect',
				started: false,
				screenStart: this.local(e),
				spawn: { id, dir: anchor }
			};
			return;
		}
		this.store.begin([id]);
		if (handle === 'rotate' && isBoxElement(el)) {
			const c = center(boxOf(el));
			this.gesture = {
				kind: 'rotate',
				id,
				origin: el,
				startAngle: (Math.atan2(w.y - c.y, w.x - c.x) * 180) / Math.PI
			};
		} else if ((handle === 'from' || handle === 'to') && el.type === 'connector') {
			this.gesture = { kind: 'end', id, end: handle, origin: el };
		} else if (handle === 'bend' && el.type === 'connector') {
			this.gesture = { kind: 'bend', id, origin: el };
		} else if (isBoxElement(el)) {
			this.gesture = { kind: 'resize', id, handle, origin: el };
		}
	}

	/** Ende eines Verbinders: an Element gebunden (Anker automatisch) oder frei */
	private endAt(w: Point, elementId: string | null): ConnectorEnd {
		const el = elementId ? this.store.get(elementId) : undefined;
		if (el && isBoxElement(el)) return { elementId: el.id, anchor: 'auto', x: w.x, y: w.y };
		return { elementId: null, anchor: 'auto', x: Math.round(w.x), y: Math.round(w.y) };
	}

	private translate(
		o: WbElement,
		dx: number,
		dy: number,
		moving: Map<string, WbElement>
	): WbElement {
		if (o.type === 'connector') {
			const move = (end: ConnectorEnd): ConnectorEnd =>
				end.elementId && moving.has(end.elementId)
					? end
					: {
							...end,
							x: Math.round(end.x + dx),
							y: Math.round(end.y + dy),
							elementId: end.elementId
						};
			// gebundene Enden folgen ihrem Element; freie Enden wandern mit
			const from = o.data.from.elementId ? o.data.from : move(o.data.from);
			const to = o.data.to.elementId ? o.data.to : move(o.data.to);
			return { ...o, data: { ...o.data, from, to } };
		}
		return {
			...o,
			data: { ...o.data, x: Math.round(o.data.x + dx), y: Math.round(o.data.y + dy) }
		} as WbElement;
	}

	private resized(
		o: WbElement & { type: Exclude<WbElement['type'], 'connector'> },
		handle: HandleName,
		w: Point,
		shift: boolean
	): WbElement {
		const b = boxOf(o);
		const l = toLocal(w, b);
		let L = b.x;
		let T = b.y;
		let R = b.x + b.w;
		let B = b.y + b.h;
		if (handle.includes('w')) L = Math.min(l.x, R - MIN_SIZE);
		if (handle.includes('e')) R = Math.max(l.x, L + MIN_SIZE);
		if (handle === 'n' || handle === 'nw' || handle === 'ne') T = Math.min(l.y, B - MIN_SIZE);
		if (handle === 's' || handle === 'sw' || handle === 'se') B = Math.max(l.y, T + MIN_SIZE);
		// Seitenverhältnis halten: Bilder immer (außer mit Umschalt), sonst mit Umschalt; nur an Ecken
		const corner = handle.length === 2;
		const keep = corner && (o.type === 'image' || o.type === 'freehand' ? !shift : shift);
		if (keep) {
			const ratio = b.w / b.h;
			const nw = R - L;
			const nh = B - T;
			if (nw / nh > ratio) {
				const fixed = nh * ratio;
				if (handle.includes('w')) L = R - fixed;
				else R = L + fixed;
			} else {
				const fixed = nw / ratio;
				if (handle.startsWith('n')) T = B - fixed;
				else B = T + fixed;
			}
		}
		const nw = R - L;
		const nh = B - T;
		// neue Mitte (lokal) zurück in Board-Koordinaten drehen; gegenüberliegende Seite bleibt stehen
		const c = rotatePoint({ x: (L + R) / 2, y: (T + B) / 2 }, center(b), b.rotation);
		return {
			...o,
			data: {
				...o.data,
				x: Math.round(c.x - nw / 2),
				y: Math.round(c.y - nh / 2),
				w: Math.round(nw),
				h: Math.round(nh)
			}
		} as WbElement;
	}

	// --- Erstellen ----------------------------------------------------------------------

	/** Neues Element mit Standardwerten anlegen und auswählen */
	createElement(
		kind: 'note' | 'shape' | 'text' | 'frame',
		r: Rect,
		extra: Record<string, unknown> = {}
	): WbElement | null {
		if (!this.store.canEdit) return null;
		const id = uuid();
		const z = kind === 'frame' ? this.store.minZ() - 1 : this.store.maxZ() + 1;
		const base = {
			x: Math.round(r.x),
			y: Math.round(r.y),
			w: Math.round(r.w),
			h: Math.round(r.h),
			rotation: 0,
			locked: false
		};
		let el: WbElement;
		if (kind === 'frame') {
			const n = [...this.store.elements.values()].filter((e) => e.type === 'frame').length + 1;
			el = {
				id,
				z,
				version: 0,
				type: 'frame',
				data: { ...base, title: `Rahmen ${n}`, color: null, fill: 'transparent', ...extra }
			};
		} else {
			const style =
				kind === 'note'
					? {
							kind: 'note' as const,
							fill: this.noteColor,
							stroke: 'transparent',
							fontSize: 24,
							autoFit: true
						}
					: kind === 'text'
						? {
								kind: 'text' as const,
								fill: 'transparent',
								stroke: 'transparent',
								fontSize: 20,
								align: 'left' as const,
								valign: 'top' as const,
								autoHeight: true
							}
						: {
								kind: this.shapeKind,
								fill: this.shapeFill,
								stroke: this.shapeStroke,
								fontSize: 18
							};
			// Standardwerte aller Felder über das Schema
			const data = parseElementData('shape', { ...base, strokeWidth: 2, ...style, ...extra });
			if (!data) return null;
			el = { id, z, version: 0, type: 'shape', data };
		}
		this.store.apply([el]);
		this.store.selection.clear();
		this.store.selection.add(id);
		return el;
	}

	private finishCreate(g: Extract<Gesture, { kind: 'create' }>, w: Point): void {
		const drag = this.createDraft;
		this.createDraft = null;
		const dragged = drag && drag.w * this.view.zoom > 8 && drag.h * this.view.zoom > 8;
		const defaults = {
			note: { w: 200, h: 200 },
			shape: { w: 180, h: 120 },
			text: { w: 260, h: 44 },
			frame: { w: 640, h: 420 }
		}[g.tool];
		const r: Rect = dragged
			? drag!
			: { x: w.x - defaults.w / 2, y: w.y - defaults.h / 2, w: defaults.w, h: defaults.h };
		const el = this.createElement(g.tool, r);
		this.tool = 'select';
		if (el && (g.tool === 'note' || g.tool === 'text')) this.startEditing(el.id, 'text');
	}

	/**
	 * Neue Notiz neben `id` – gleiche Art, Farbe und Größe, wenn es eine Form/Notiz ist –, optional mit Pfeil
	 * verbunden; danach sofort Text eingeben (ein Rückgängig-Schritt). Für die „+“-Griffe und Tab beim Schreiben.
	 */
	spawnNext(id: string, dir: SpawnDir, connect: boolean): WbElement | null {
		const src = this.store.get(id);
		if (!src || !isBoxElement(src) || !this.store.canEdit) return null;
		const like = src.type === 'shape' && src.data.kind !== 'text' ? src.data : null;
		const w = like ? like.w : 200;
		const h = like ? like.h : 200;
		const d = src.data;
		const pos =
			dir === 'right'
				? { x: d.x + d.w + SPAWN_GAP, y: d.y + (d.h - h) / 2 }
				: dir === 'left'
					? { x: d.x - SPAWN_GAP - w, y: d.y + (d.h - h) / 2 }
					: dir === 'bottom'
						? { x: d.x + (d.w - w) / 2, y: d.y + d.h + SPAWN_GAP }
						: { x: d.x + (d.w - w) / 2, y: d.y - SPAWN_GAP - h };
		const box = { x: Math.round(pos.x), y: Math.round(pos.y), w, h, rotation: 0, locked: false };
		const raw = like
			? { ...like, ...box, text: '' }
			: {
					...box,
					kind: 'note',
					fill: this.noteColor,
					stroke: 'transparent',
					fontSize: 24,
					autoFit: true
				};
		const data = parseElementData('shape', raw);
		if (!data) return null;
		let z = this.store.maxZ();
		const note: WbElement = { id: uuid(), type: 'shape', z: ++z, version: 0, data };
		const items: WbElement[] = [note];
		if (connect) {
			const opposite = ({ top: 'bottom', bottom: 'top', left: 'right', right: 'left' } as const)[
				dir
			];
			const line = parseElementData('connector', {
				from: { elementId: id, anchor: dir, x: box.x, y: box.y },
				to: { elementId: note.id, anchor: opposite, x: box.x, y: box.y },
				route: this.connectorRoute,
				endHead: 'arrow'
			});
			if (line) items.push({ id: uuid(), type: 'connector', z: z + 1, version: 0, data: line });
		}
		this.store.apply(items);
		this.store.selection.clear();
		this.store.selection.add(note.id);
		this.startEditing(note.id, 'text');
		return note;
	}

	private finishConnect(started: boolean): void {
		const d = this.connectDraft;
		this.connectDraft = null;
		this.hoverTarget = null;
		if (!d || !started) return;
		const same = d.from.elementId && d.from.elementId === d.to.elementId;
		const dist = Math.hypot(d.to.x - d.from.x, d.to.y - d.from.y);
		if (same || (!d.to.elementId && dist < 10)) return;
		const id = uuid();
		const z = this.store.maxZ() + 1;
		this.store.apply([
			{
				id,
				z,
				version: 0,
				type: 'connector',
				data: {
					from: d.from,
					to: d.to,
					route: d.route,
					stroke: '#1f2937',
					strokeWidth: 2,
					strokeStyle: 'solid',
					startHead: 'none',
					endHead: 'arrow',
					label: '',
					bend: 0,
					locked: false
				}
			}
		]);
		this.store.selection.clear();
		this.store.selection.add(id);
		if (this.tool === 'connector') this.tool = 'select';
	}

	private finishDraw(): void {
		const d = this.draft;
		this.draft = null;
		if (!d || !d.points.length) return;
		const f = finalizeStroke(d.points, d.size);
		this.store.apply([
			{
				id: uuid(),
				z: this.store.maxZ() + 1,
				version: 0,
				type: 'freehand',
				data: {
					x: Math.round(f.box.x * 10) / 10,
					y: Math.round(f.box.y * 10) / 10,
					w: f.box.w,
					h: f.box.h,
					rotation: 0,
					locked: false,
					points: d.mouse ? f.points.map(([x, y]) => [x, y, 0.5] as StrokePoint) : f.points,
					vw: f.vw,
					vh: f.vh,
					color: d.color,
					size: d.size,
					opacity: d.marker ? 0.4 : 1,
					marker: d.marker
				}
			}
		]);
	}

	private eraseAt(clientX: number, clientY: number): void {
		const id = this.elementAt(clientX, clientY);
		if (!id) return;
		const el = this.store.get(id);
		if (el?.type === 'freehand' && !el.data.locked) this.store.previewRemove(id);
	}

	// --- Text bearbeiten -----------------------------------------------------------------

	startEditing(id: string, field: 'text' | 'title' | 'label'): void {
		if (!this.store.canEdit) return;
		this.finishEditing();
		this.store.begin([id]);
		this.editing = { id, field };
	}

	/** Text während der Eingabe (sofort live für andere) */
	updateText(value: string): void {
		const ed = this.editing;
		if (!ed) return;
		const el = this.store.get(ed.id);
		if (!el) return;
		if (el.type === 'shape' && ed.field === 'text') {
			let h = el.data.h;
			if (el.data.autoHeight) {
				// Textfeld wächst/schrumpft mit (Innenabstand 4 px oben und unten)
				const inner = textHeight(value, Math.max(1, el.data.w - 8), el.data, browserMeasure());
				h = Math.max(24, Math.min(100_000, inner + 8));
			}
			this.store.preview([{ ...el, data: { ...el.data, text: value, h } }]);
		} else if (el.type === 'frame' && ed.field === 'title')
			this.store.preview([{ ...el, data: { ...el.data, title: value } }]);
		else if (el.type === 'connector' && ed.field === 'label')
			this.store.preview([{ ...el, data: { ...el.data, label: value } }]);
	}

	finishEditing(): void {
		const ed = this.editing;
		if (!ed) return;
		this.editing = null;
		const el = this.store.get(ed.id);
		// leere Textfelder verschwinden wieder
		if (el?.type === 'shape' && el.data.kind === 'text' && !el.data.text.trim()) {
			this.store.previewRemove(el.id);
		}
		this.store.end();
	}

	// --- Bearbeiten ---------------------------------------------------------------------

	selected(): WbElement[] {
		return [...this.store.selection]
			.map((id) => this.store.get(id))
			.filter((x): x is WbElement => !!x);
	}

	/** Daten der ausgewählten Elemente ändern (ein Rückgängig-Schritt) */
	updateSelected(patch: (el: WbElement) => WbElement | null): void {
		const next: WbElement[] = [];
		for (const el of this.selected()) {
			const n = patch(el);
			if (n && n !== el) next.push(n);
		}
		this.store.apply(next);
	}

	deleteSelected(): void {
		const ids = this.selected()
			.filter((el) => !el.data.locked)
			.map((el) => el.id);
		if (!ids.length) {
			if (this.store.selection.size) this.hooks.notice('Gesperrte Elemente zuerst entsperren');
			return;
		}
		const gone = new Set(ids);
		const changes: (WbElement | { id: string; deleted: true })[] = ids.map((id) => ({
			id,
			deleted: true as const
		}));
		// Verbinder an gelöschten Elementen lösen (Ende bleibt an der letzten Stelle stehen)
		for (const el of this.store.elements.values()) {
			if (el.type !== 'connector' || gone.has(el.id)) continue;
			const ends = ['from', 'to'] as const;
			if (!ends.some((k) => el.data[k].elementId && gone.has(el.data[k].elementId!))) continue;
			const geo = resolveConnector(el.data, (x) => this.store.get(x));
			const data = { ...el.data };
			if (data.from.elementId && gone.has(data.from.elementId)) {
				data.from = {
					elementId: null,
					anchor: 'auto',
					x: Math.round(geo.a.x),
					y: Math.round(geo.a.y)
				};
			}
			if (data.to.elementId && gone.has(data.to.elementId)) {
				data.to = {
					elementId: null,
					anchor: 'auto',
					x: Math.round(geo.b.x),
					y: Math.round(geo.b.y)
				};
			}
			changes.push({ ...el, data });
		}
		this.store.apply(changes);
	}

	selectAll(): void {
		this.store.selection.clear();
		for (const id of this.store.elements.keys()) this.store.selection.add(id);
	}

	nudge(dx: number, dy: number): void {
		const sel = this.selected().filter((el) => this.canMove(el));
		const map = new Map(sel.map((el) => [el.id, el]));
		this.store.apply(sel.map((el) => this.translate(el, dx, dy, map)));
	}

	bringToFront(): void {
		let z = this.store.maxZ();
		this.store.apply(
			this.selected()
				.sort((a, b) => a.z - b.z)
				.map((el) => ({ ...el, z: ++z }) as WbElement)
		);
	}

	sendToBack(): void {
		let z = this.store.minZ();
		this.store.apply(
			this.selected()
				.sort((a, b) => b.z - a.z)
				.map((el) => ({ ...el, z: --z }) as WbElement)
		);
	}

	toggleLock(): void {
		const sel = this.selected();
		const lock = sel.some((el) => !el.data.locked);
		this.store.apply(sel.map((el) => ({ ...el, data: { ...el.data, locked: lock } }) as WbElement));
	}

	copy(): WbElement[] {
		const sel = this.selected();
		const ids = new Set(sel.map((e) => e.id));
		// Rahmen nehmen ihren Inhalt mit
		for (const el of sel) {
			if (el.type === 'frame')
				for (const c of frameChildren(el, this.store.elements.values())) ids.add(c);
		}
		this.clipboard = [...ids].map((id) => this.store.get(id)).filter((x): x is WbElement => !!x);
		return this.clipboard;
	}

	/** Elemente einfügen (neue IDs, Verbindungen innerhalb der Kopie bleiben erhalten) */
	paste(list: WbElement[] = this.clipboard, at?: Point): void {
		if (!list.length || !this.store.canEdit) return;
		const map = new Map(list.map((el) => [el.id, uuid()]));
		const box = boundsOfElements(list, (id) => list.find((x) => x.id === id) ?? this.store.get(id));
		const offset =
			at && box
				? { x: at.x - (box.x + box.w / 2), y: at.y - (box.y + box.h / 2) }
				: { x: 24, y: 24 };
		let z = this.store.maxZ();
		const copies: WbElement[] = [...list]
			.sort((a, b) => a.z - b.z)
			.map((el) => {
				const id = map.get(el.id)!;
				if (el.type === 'connector') {
					const remap = (end: ConnectorEnd): ConnectorEnd =>
						end.elementId && map.has(end.elementId)
							? {
									...end,
									elementId: map.get(end.elementId)!,
									x: end.x + offset.x,
									y: end.y + offset.y
								}
							: end.elementId
								? end
								: { ...end, x: Math.round(end.x + offset.x), y: Math.round(end.y + offset.y) };
					return {
						...el,
						id,
						version: 0,
						z: el.type === 'connector' ? ++z : z,
						data: { ...el.data, from: remap(el.data.from), to: remap(el.data.to), locked: false }
					};
				}
				return {
					...el,
					id,
					version: 0,
					z: el.type === 'frame' ? el.z : ++z,
					data: {
						...el.data,
						x: Math.round(el.data.x + offset.x),
						y: Math.round(el.data.y + offset.y),
						locked: false
					}
				} as WbElement;
			});
		this.store.apply(copies);
		this.store.selection.clear();
		for (const c of copies) this.store.selection.add(c.id);
	}

	duplicate(): void {
		this.paste(this.copy());
	}
}
