/**
 * Verbinder (rein): Enden auflösen (an Elemente gebunden oder frei), Pfad je Verlauf (gerade, gewinkelt,
 * gebogen), Pfeilspitzen und Position der Beschriftung. Gebundene Enden folgen dem Element automatisch –
 * beim Verschieben einer Form muss der Verbinder deshalb nicht neu gespeichert werden.
 */
import type {
	ArrowHead,
	ConnectorData,
	ConnectorEnd,
	ConnectorRoute,
	WbElement
} from '../../schemas';
import {
	anchorDirection,
	anchorPoint,
	boxOf,
	center,
	isBoxElement,
	type Box,
	type Point
} from './geometry';

export interface ResolvedConnector {
	a: Point;
	b: Point;
	path: string;
	/** Mitte des Pfads (Beschriftung, Knick-Griff) */
	mid: Point;
	/** Winkel (Grad) der Pfadrichtung am Start (zeigt vom Pfad weg) und am Ende */
	startAngle: number;
	endAngle: number;
}

type Lookup = (id: string) => WbElement | undefined;

function targetBox(end: ConnectorEnd, lookup: Lookup): { box: Box; ellipse: boolean } | null {
	if (!end.elementId) return null;
	const el = lookup(end.elementId);
	if (!el || !isBoxElement(el)) return null;
	return { box: boxOf(el), ellipse: el.type === 'shape' && el.data.kind === 'ellipse' };
}

const angle = (from: Point, to: Point) =>
	(Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
const r2 = (n: number) => Math.round(n * 100) / 100;
const pt = (p: Point) => `${r2(p.x)},${r2(p.y)}`;

/** Enden auflösen; `lookup` liefert die aktuellen Elemente */
export function resolveEnds(
	data: Pick<ConnectorData, 'from' | 'to'>,
	lookup: Lookup
): { a: Point; b: Point; dirA: Point | null; dirB: Point | null } {
	const ta = targetBox(data.from, lookup);
	const tb = targetBox(data.to, lookup);
	const refA = ta ? center(ta.box) : { x: data.from.x, y: data.from.y };
	const refB = tb ? center(tb.box) : { x: data.to.x, y: data.to.y };
	const a = ta ? anchorPoint(ta.box, data.from.anchor, refB, ta.ellipse) : refA;
	const b = tb ? anchorPoint(tb.box, data.to.anchor, refA, tb.ellipse) : refB;
	return {
		a,
		b,
		dirA: ta && data.from.anchor !== 'center' ? anchorDirection(ta.box, a) : null,
		dirB: tb && data.to.anchor !== 'center' ? anchorDirection(tb.box, b) : null
	};
}

export function connectorGeometry(
	route: ConnectorRoute,
	ends: { a: Point; b: Point; dirA: Point | null; dirB: Point | null },
	bend = 0
): ResolvedConnector {
	const { a, b } = ends;
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const dist = Math.hypot(dx, dy) || 1;
	if (route === 'curve') {
		const d = Math.max(40, dist * 0.4);
		let c1: Point;
		let c2: Point;
		if (ends.dirA || ends.dirB) {
			const da = ends.dirA ?? { x: dx / dist, y: dy / dist };
			const db = ends.dirB ?? { x: -dx / dist, y: -dy / dist };
			c1 = { x: a.x + da.x * d, y: a.y + da.y * d };
			c2 = { x: b.x + db.x * d, y: b.y + db.y * d };
		} else {
			// frei: senkrecht zur Strecke ausbeulen (bend −1 … 1)
			const nx = -dy / dist;
			const ny = dx / dist;
			const off = (bend || 0.25) * dist * 0.5;
			c1 = { x: a.x + dx / 3 + nx * off, y: a.y + dy / 3 + ny * off };
			c2 = { x: a.x + (dx * 2) / 3 + nx * off, y: a.y + (dy * 2) / 3 + ny * off };
		}
		// Mitte der kubischen Bézierkurve bei t = 0,5
		const mid = {
			x: 0.125 * a.x + 0.375 * c1.x + 0.375 * c2.x + 0.125 * b.x,
			y: 0.125 * a.y + 0.375 * c1.y + 0.375 * c2.y + 0.125 * b.y
		};
		return {
			a,
			b,
			path: `M${pt(a)} C${pt(c1)} ${pt(c2)} ${pt(b)}`,
			mid,
			startAngle: angle(c1, a),
			endAngle: angle(c2, b)
		};
	}
	if (route === 'elbow') {
		const horizontal = ends.dirA ? ends.dirA.x !== 0 : Math.abs(dx) >= Math.abs(dy);
		if (horizontal) {
			const xm = a.x + dx / 2 + (bend * Math.abs(dx)) / 2;
			const p1 = { x: xm, y: a.y };
			const p2 = { x: xm, y: b.y };
			return {
				a,
				b,
				path: `M${pt(a)} L${pt(p1)} L${pt(p2)} L${pt(b)}`,
				mid: { x: xm, y: (a.y + b.y) / 2 },
				startAngle: angle(p1.x === a.x && p1.y === a.y ? p2 : p1, a),
				endAngle: angle(p2.x === b.x && p2.y === b.y ? p1 : p2, b)
			};
		}
		const ym = a.y + dy / 2 + (bend * Math.abs(dy)) / 2;
		const p1 = { x: a.x, y: ym };
		const p2 = { x: b.x, y: ym };
		return {
			a,
			b,
			path: `M${pt(a)} L${pt(p1)} L${pt(p2)} L${pt(b)}`,
			mid: { x: (a.x + b.x) / 2, y: ym },
			startAngle: angle(p1.x === a.x && p1.y === a.y ? p2 : p1, a),
			endAngle: angle(p2.x === b.x && p2.y === b.y ? p1 : p2, b)
		};
	}
	return {
		a,
		b,
		path: `M${pt(a)} L${pt(b)}`,
		mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
		startAngle: angle(b, a),
		endAngle: angle(a, b)
	};
}

export function resolveConnector(data: ConnectorData, lookup: Lookup): ResolvedConnector {
	return connectorGeometry(data.route, resolveEnds(data, lookup), data.bend);
}

/** Pfeilspitze als SVG-Pfad an `tip`, Richtung `deg` (zeigt in Richtung der Spitze) */
export function arrowHeadPath(
	kind: ArrowHead,
	tip: Point,
	deg: number,
	strokeWidth: number
): { d: string; filled: boolean } | null {
	if (kind === 'none') return null;
	const size = Math.max(9, strokeWidth * 3.5);
	const rad = (deg * Math.PI) / 180;
	const back = (len: number, spread: number) => ({
		x: tip.x - Math.cos(rad) * len + Math.cos(rad + Math.PI / 2) * spread,
		y: tip.y - Math.sin(rad) * len + Math.sin(rad + Math.PI / 2) * spread
	});
	switch (kind) {
		case 'arrow': {
			const l = back(size, size * 0.55);
			const r = back(size, -size * 0.55);
			return { d: `M${pt(l)} L${pt(tip)} L${pt(r)}`, filled: false };
		}
		case 'triangle': {
			const l = back(size, size * 0.5);
			const r = back(size, -size * 0.5);
			return { d: `M${pt(l)} L${pt(tip)} L${pt(r)} Z`, filled: true };
		}
		case 'dot': {
			const c = back(size * 0.35, 0);
			const rr = r2(size * 0.35);
			return {
				d: `M${r2(c.x - rr)},${r2(c.y)} a${rr},${rr} 0 1,0 ${r2(rr * 2)},0 a${rr},${rr} 0 1,0 ${r2(-rr * 2)},0`,
				filled: true
			};
		}
		case 'bar': {
			const l = back(0, size * 0.6);
			const r = back(0, -size * 0.6);
			return { d: `M${pt(l)} L${pt(r)}`, filled: false };
		}
	}
}

/** Abstand eines Punkts zum Verbinder (für Treffer); nähert Kurven mit 24 Stützpunkten an */
export function connectorDistance(c: ResolvedConnector, route: ConnectorRoute, p: Point): number {
	const pts = samplePath(c, route);
	let best = Infinity;
	for (let i = 1; i < pts.length; i++) {
		const a = pts[i - 1]!;
		const b = pts[i]!;
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		const len = dx * dx + dy * dy;
		const t = len ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
		best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
	}
	return best;
}

/** Stützpunkte des Pfads (für Treffer und Hüllrechteck) */
export function samplePath(c: ResolvedConnector, route: ConnectorRoute): Point[] {
	const nums = c.path.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
	const pts: Point[] = [];
	for (let i = 0; i + 1 < nums.length; i += 2) pts.push({ x: nums[i]!, y: nums[i + 1]! });
	if (route !== 'curve' || pts.length !== 4) return pts;
	const [p0, p1, p2, p3] = pts as [Point, Point, Point, Point];
	const out: Point[] = [];
	for (let i = 0; i <= 24; i++) {
		const t = i / 24;
		const u = 1 - t;
		out.push({
			x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
			y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y
		});
	}
	return out;
}
