/**
 * Freihand-Striche (rein): Umriss über `perfect-freehand`, Ausdünnen der Punkte vor dem Speichern und
 * natürliche Größe des Strichs. Gespeichert werden Punkte relativ zu einem beliebigen Ursprung; dargestellt wird
 * der Strich in den Rahmen `x/y/w/h` eingepasst – Vergrößern braucht deshalb keine neuen Punkte.
 */
import { getStroke } from 'perfect-freehand';
import { MAX_POINTS } from '../../schemas';
import type { Rect } from './geometry';

export type StrokePoint = [number, number, number];

/** Umriss als SVG-Pfad (gefüllte Fläche) */
export function strokePath(
	points: readonly StrokePoint[],
	opts: { size: number; marker?: boolean; simulatePressure?: boolean; last?: boolean }
): string {
	if (!points.length) return '';
	const outline = getStroke(
		points.map((p) => [p[0], p[1], p[2]]),
		{
			size: opts.marker ? opts.size * 2.5 : opts.size,
			thinning: opts.marker ? 0 : 0.55,
			smoothing: 0.5,
			streamline: 0.45,
			simulatePressure: opts.marker ? false : (opts.simulatePressure ?? true),
			last: opts.last ?? true,
			start: { cap: true },
			end: { cap: true }
		}
	);
	if (outline.length < 2) {
		// einzelner Punkt → kleiner Kreis
		const [x, y] = points[0]!;
		const r = Math.max(0.5, (opts.marker ? opts.size * 2.5 : opts.size) / 2);
		return `M${x - r},${y} a${r},${r} 0 1,0 ${r * 2},0 a${r},${r} 0 1,0 ${-r * 2},0`;
	}
	const r = (n: number) => Math.round(n * 100) / 100;
	const [sx, sy] = outline[0] as [number, number];
	let d = `M${r(sx)},${r(sy)} Q`;
	for (let i = 0; i < outline.length; i++) {
		const [x0, y0] = outline[i] as [number, number];
		const [x1, y1] = outline[(i + 1) % outline.length] as [number, number];
		d += `${r(x0)},${r(y0)} ${r((x0 + x1) / 2)},${r((y0 + y1) / 2)} `;
	}
	return `${d}Z`;
}

/** Hüllrechteck der Punkte (mindestens 1×1) */
export function pointsBounds(points: readonly StrokePoint[]): Rect {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const [x, y] of points) {
		minX = Math.min(minX, x);
		minY = Math.min(minY, y);
		maxX = Math.max(maxX, x);
		maxY = Math.max(maxY, y);
	}
	if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 1, h: 1 };
	return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
}

function perpendicular(p: StrokePoint, a: StrokePoint, b: StrokePoint): number {
	const dx = b[0] - a[0];
	const dy = b[1] - a[1];
	const len = Math.hypot(dx, dy);
	if (!len) return Math.hypot(p[0] - a[0], p[1] - a[1]);
	return Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / len;
}

/** Ramer-Douglas-Peucker (iterativ) */
function simplify(points: StrokePoint[], tolerance: number): StrokePoint[] {
	if (points.length < 3) return points;
	const keep = new Uint8Array(points.length);
	keep[0] = 1;
	keep[points.length - 1] = 1;
	const stack: [number, number][] = [[0, points.length - 1]];
	while (stack.length) {
		const [s, e] = stack.pop()!;
		let max = 0;
		let idx = -1;
		for (let i = s + 1; i < e; i++) {
			const d = perpendicular(points[i]!, points[s]!, points[e]!);
			if (d > max) {
				max = d;
				idx = i;
			}
		}
		if (idx >= 0 && max > tolerance) {
			keep[idx] = 1;
			stack.push([s, idx], [idx, e]);
		}
	}
	return points.filter((_, i) => keep[i]);
}

/**
 * Punkte für das Speichern: relativ zum Hüllrechteck, auf 0,1 gerundet, ausgedünnt (höchstens `MAX_POINTS`).
 * Liefert zusätzlich das Rechteck in Board-Koordinaten.
 */
export function finalizeStroke(
	points: readonly StrokePoint[],
	size: number
): { box: Rect; points: StrokePoint[]; vw: number; vh: number } {
	const b = pointsBounds(points);
	let rel: StrokePoint[] = points.map(([x, y, p]) => [
		Math.round((x - b.x) * 10) / 10,
		Math.round((y - b.y) * 10) / 10,
		Math.round(Math.min(1, Math.max(0, p)) * 100) / 100
	]);
	let tol = 0.4;
	rel = simplify(rel, tol);
	while (rel.length > MAX_POINTS) {
		tol *= 2;
		rel = simplify(rel, tol);
	}
	// Rand für die Strichstärke, damit der Strich nicht über den Rahmen hinausragt
	const pad = size;
	const w = Math.max(1, b.w + pad * 2);
	const h = Math.max(1, b.h + pad * 2);
	return {
		box: { x: b.x - pad, y: b.y - pad, w, h },
		points: rel.map(([x, y, p]) => [x + pad, y + pad, p]),
		vw: w,
		vh: h
	};
}
