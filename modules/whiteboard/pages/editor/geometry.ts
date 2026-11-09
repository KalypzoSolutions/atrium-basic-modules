/**
 * Geometrie des Whiteboards (rein, ohne DOM): Rechtecke, Drehung, Formen-Pfade, Treffer, Anker der Verbinder,
 * Rahmen-Inhalt. Alle Koordinaten in Board-Einheiten (1 = 1 px bei 100 % Zoom).
 */
import type { Anchor, BoxElement, ShapeKind, WbElement } from '../../schemas';

export interface Point {
	x: number;
	y: number;
}

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface Box extends Rect {
	rotation: number;
}

export const EMPTY_RECT: Rect = { x: 0, y: 0, w: 0, h: 0 };

/** Rechteck aus zwei Punkten (beliebige Richtung) */
export function rectFromPoints(a: Point, b: Point): Rect {
	return {
		x: Math.min(a.x, b.x),
		y: Math.min(a.y, b.y),
		w: Math.abs(b.x - a.x),
		h: Math.abs(b.y - a.y)
	};
}

export function center(r: Rect): Point {
	return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

export function rotatePoint(p: Point, c: Point, deg: number): Point {
	if (!deg) return p;
	const rad = (deg * Math.PI) / 180;
	const cos = Math.cos(rad);
	const sin = Math.sin(rad);
	const dx = p.x - c.x;
	const dy = p.y - c.y;
	return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}

/** Eckpunkte eines (gedrehten) Rahmens */
export function corners(b: Box): Point[] {
	const c = center(b);
	return [
		{ x: b.x, y: b.y },
		{ x: b.x + b.w, y: b.y },
		{ x: b.x + b.w, y: b.y + b.h },
		{ x: b.x, y: b.y + b.h }
	].map((p) => rotatePoint(p, c, b.rotation));
}

/** Achsenparalleles Hüllrechteck mehrerer Punkte */
export function boundsOfPoints(points: readonly Point[]): Rect {
	if (!points.length) return EMPTY_RECT;
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const p of points) {
		minX = Math.min(minX, p.x);
		minY = Math.min(minY, p.y);
		maxX = Math.max(maxX, p.x);
		maxY = Math.max(maxY, p.y);
	}
	return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function unionRects(rects: readonly Rect[]): Rect {
	if (!rects.length) return EMPTY_RECT;
	return boundsOfPoints(
		rects.flatMap((r) => [
			{ x: r.x, y: r.y },
			{ x: r.x + r.w, y: r.y + r.h }
		])
	);
}

export function intersects(a: Rect, b: Rect): boolean {
	return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

export function containsRect(outer: Rect, inner: Rect): boolean {
	return (
		inner.x >= outer.x &&
		inner.y >= outer.y &&
		inner.x + inner.w <= outer.x + outer.w &&
		inner.y + inner.h <= outer.y + outer.h
	);
}

export function inflate(r: Rect, by: number): Rect {
	return { x: r.x - by, y: r.y - by, w: r.w + by * 2, h: r.h + by * 2 };
}

export function boxOf(el: BoxElement): Box {
	const d = el.data;
	return { x: d.x, y: d.y, w: d.w, h: d.h, rotation: d.rotation ?? 0 };
}

/** Punkt in Element-Koordinaten (ohne Drehung) */
export function toLocal(p: Point, b: Box): Point {
	return rotatePoint(p, center(b), -b.rotation);
}

// --- Formen ------------------------------------------------------------------

const round = (n: number) => Math.round(n * 100) / 100;

function polygon(points: Point[]): string {
	return `M${points.map((p) => `${round(p.x)},${round(p.y)}`).join(' L')} Z`;
}

/** SVG-Pfad einer Form im Rahmen `w`×`h` (Ursprung oben links) */
export function shapePath(kind: ShapeKind, w: number, h: number): string {
	switch (kind) {
		case 'ellipse':
			return `M${round(w / 2)},0 A${round(w / 2)},${round(h / 2)} 0 1 1 ${round(w / 2)},${round(h)} A${round(w / 2)},${round(h / 2)} 0 1 1 ${round(w / 2)},0 Z`;
		case 'diamond':
			return polygon([
				{ x: w / 2, y: 0 },
				{ x: w, y: h / 2 },
				{ x: w / 2, y: h },
				{ x: 0, y: h / 2 }
			]);
		case 'triangle':
			return polygon([
				{ x: w / 2, y: 0 },
				{ x: w, y: h },
				{ x: 0, y: h }
			]);
		case 'hexagon': {
			const i = Math.min(w * 0.25, h * 0.5);
			return polygon([
				{ x: i, y: 0 },
				{ x: w - i, y: 0 },
				{ x: w, y: h / 2 },
				{ x: w - i, y: h },
				{ x: i, y: h },
				{ x: 0, y: h / 2 }
			]);
		}
		case 'star': {
			const pts: Point[] = [];
			for (let k = 0; k < 10; k++) {
				const r = k % 2 === 0 ? 0.5 : 0.21;
				const a = -Math.PI / 2 + (k * Math.PI) / 5;
				pts.push({ x: w / 2 + Math.cos(a) * r * w, y: h * 0.55 + Math.sin(a) * r * h * 1.05 });
			}
			return polygon(pts);
		}
		case 'speech': {
			const bh = h * 0.8;
			const r = Math.min(16, w / 6, bh / 4);
			return `M${r},0 H${round(w - r)} Q${round(w)},0 ${round(w)},${r} V${round(bh - r)} Q${round(w)},${round(bh)} ${round(w - r)},${round(bh)} H${round(w * 0.42)} L${round(w * 0.22)},${round(h)} L${round(w * 0.26)},${round(bh)} H${r} Q0,${round(bh)} 0,${round(bh - r)} V${r} Q0,0 ${r},0 Z`;
		}
		case 'cloud': {
			// fünf Bögen über einer flachen Basis
			const p = (x: number, y: number) => `${round(x * w)},${round(y * h)}`;
			return `M${p(0.2, 0.85)} C${p(0.02, 0.85)} ${p(0.0, 0.55)} ${p(0.16, 0.48)} C${p(0.12, 0.22)} ${p(0.38, 0.12)} ${p(0.46, 0.28)} C${p(0.52, 0.02)} ${p(0.86, 0.06)} ${p(0.82, 0.36)} C${p(1.0, 0.38)} ${p(1.02, 0.85)} ${p(0.8, 0.85)} Z`;
		}
		case 'rounded': {
			const r = Math.min(24, w / 4, h / 4);
			return `M${r},0 H${round(w - r)} Q${round(w)},0 ${round(w)},${r} V${round(h - r)} Q${round(w)},${round(h)} ${round(w - r)},${round(h)} H${r} Q0,${round(h)} 0,${round(h - r)} V${r} Q0,0 ${r},0 Z`;
		}
		case 'note':
		case 'rect':
		case 'text':
		default:
			return `M0,0 H${round(w)} V${round(h)} H0 Z`;
	}
}

/** Innerer Textbereich einer Form (relativ zum Rahmen), damit Text in Raute/Dreieck … passt */
export function textArea(kind: ShapeKind, w: number, h: number): Rect {
	const pad = kind === 'text' ? 4 : 12;
	switch (kind) {
		case 'ellipse':
			return { x: w * 0.15, y: h * 0.15, w: w * 0.7, h: h * 0.7 };
		case 'diamond':
			return { x: w * 0.25, y: h * 0.25, w: w * 0.5, h: h * 0.5 };
		case 'triangle':
			return { x: w * 0.25, y: h * 0.45, w: w * 0.5, h: h * 0.5 };
		case 'star':
			return { x: w * 0.3, y: h * 0.38, w: w * 0.4, h: h * 0.38 };
		case 'hexagon':
			return { x: w * 0.2, y: pad, w: w * 0.6, h: h - pad * 2 };
		case 'speech':
			return { x: pad, y: pad, w: w - pad * 2, h: h * 0.8 - pad * 2 };
		case 'cloud':
			return { x: w * 0.18, y: h * 0.3, w: w * 0.64, h: h * 0.5 };
		default:
			return { x: pad, y: pad, w: Math.max(1, w - pad * 2), h: Math.max(1, h - pad * 2) };
	}
}

// --- Treffer -------------------------------------------------------------------

/** Abstand eines Punkts zu einer Strecke */
export function distanceToSegment(p: Point, a: Point, b: Point): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const len = dx * dx + dy * dy;
	const t = len ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
	return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Punkt im (gedrehten) Rahmen, mit Toleranz `tol` */
export function hitBox(p: Point, b: Box, tol = 0): boolean {
	const l = toLocal(p, b);
	return l.x >= b.x - tol && l.x <= b.x + b.w + tol && l.y >= b.y - tol && l.y <= b.y + b.h + tol;
}

// --- Anker für Verbinder ------------------------------------------------------

/** Schnittpunkt der Strecke Mitte → `toward` mit dem Rand des (gedrehten) Rahmens bzw. der Ellipse */
export function borderPoint(b: Box, toward: Point, ellipse = false): Point {
	const c = center(b);
	const t = toLocal(toward, b);
	let dx = t.x - c.x;
	let dy = t.y - c.y;
	if (!dx && !dy) dy = -1;
	const hw = b.w / 2;
	const hh = b.h / 2;
	let s: number;
	if (ellipse) {
		s = 1 / Math.sqrt((dx * dx) / (hw * hw) + (dy * dy) / (hh * hh));
	} else {
		s = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
	}
	dx *= s;
	dy *= s;
	return rotatePoint({ x: c.x + dx, y: c.y + dy }, c, b.rotation);
}

export function anchorPoint(b: Box, anchor: Anchor, toward: Point, ellipse = false): Point {
	const c = center(b);
	const local: Point | null =
		anchor === 'top'
			? { x: c.x, y: b.y }
			: anchor === 'bottom'
				? { x: c.x, y: b.y + b.h }
				: anchor === 'left'
					? { x: b.x, y: c.y }
					: anchor === 'right'
						? { x: b.x + b.w, y: c.y }
						: anchor === 'center'
							? c
							: null;
	if (local) return rotatePoint(local, c, b.rotation);
	return borderPoint(b, toward, ellipse);
}

/** Nächster fester Anker (für das Andocken beim Ziehen) */
export function nearestAnchor(b: Box, p: Point): Exclude<Anchor, 'auto' | 'center'> {
	const options = ['top', 'right', 'bottom', 'left'] as const;
	let best: (typeof options)[number] = 'top';
	let dist = Infinity;
	for (const a of options) {
		const q = anchorPoint(b, a, p);
		const d = Math.hypot(q.x - p.x, q.y - p.y);
		if (d < dist) {
			dist = d;
			best = a;
		}
	}
	return best;
}

/** Richtung, in die ein Anker zeigt (für gewinkelte/gebogene Verbinder) */
export function anchorDirection(b: Box, at: Point): Point {
	const l = toLocal(at, b);
	const c = center(b);
	const nx = (l.x - c.x) / (b.w / 2 || 1);
	const ny = (l.y - c.y) / (b.h / 2 || 1);
	const dir =
		Math.abs(nx) >= Math.abs(ny)
			? { x: Math.sign(nx) || 1, y: 0 }
			: { x: 0, y: Math.sign(ny) || 1 };
	return rotatePoint(dir, { x: 0, y: 0 }, b.rotation);
}

// --- Elemente ------------------------------------------------------------------

export function isBoxElement(el: WbElement): el is BoxElement {
	return el.type !== 'connector';
}

/** Elemente, die beim Verschieben eines Rahmens mitwandern (vollständig enthalten, nicht der Rahmen selbst) */
export function frameChildren(frame: BoxElement, all: Iterable<WbElement>): string[] {
	const fr: Rect = { x: frame.data.x, y: frame.data.y, w: frame.data.w, h: frame.data.h };
	const out: string[] = [];
	for (const el of all) {
		if (el.id === frame.id || !isBoxElement(el)) continue;
		if (el.type === 'frame') continue;
		if (containsRect(fr, boundsOfPoints(corners(boxOf(el))))) out.push(el.id);
	}
	return out;
}

/** Am Raster ausrichten */
export function snap(v: number, grid: number): number {
	return grid > 0 ? Math.round(v / grid) * grid : v;
}
