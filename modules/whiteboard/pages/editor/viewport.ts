/**
 * Ansicht (rein): Verschiebung und Zoom. Bildschirm = Board × zoom + pan. Zoom 10–400 %.
 */
import { MAX_ZOOM, MIN_ZOOM } from '../../schemas';
import type { Point, Rect } from './geometry';

export interface View {
	panX: number;
	panY: number;
	zoom: number;
}

export const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

export function toWorld(view: View, p: Point): Point {
	return { x: (p.x - view.panX) / view.zoom, y: (p.y - view.panY) / view.zoom };
}

export function toScreen(view: View, p: Point): Point {
	return { x: p.x * view.zoom + view.panX, y: p.y * view.zoom + view.panY };
}

/** Zoom ändern, sodass der Bildschirmpunkt `at` an derselben Board-Stelle bleibt */
export function zoomAt(view: View, at: Point, zoom: number): View {
	const z = clampZoom(zoom);
	const w = toWorld(view, at);
	return { zoom: z, panX: at.x - w.x * z, panY: at.y - w.y * z };
}

/** Sichtbarer Board-Bereich */
export function visibleRect(view: View, size: { w: number; h: number }): Rect {
	const a = toWorld(view, { x: 0, y: 0 });
	return { x: a.x, y: a.y, w: size.w / view.zoom, h: size.h / view.zoom };
}

/** Ansicht, die `rect` mit Rand einpasst (höchstens 100 %, außer `maxZoom`) */
export function fitRect(
	rect: Rect,
	size: { w: number; h: number },
	opts: { padding?: number; maxZoom?: number } = {}
): View {
	const pad = opts.padding ?? 48;
	if (rect.w <= 0 || rect.h <= 0 || size.w <= 0 || size.h <= 0) {
		return { zoom: 1, panX: size.w / 2 - rect.x, panY: size.h / 2 - rect.y };
	}
	const zoom = clampZoom(
		Math.min((size.w - pad * 2) / rect.w, (size.h - pad * 2) / rect.h, opts.maxZoom ?? 1)
	);
	return {
		zoom,
		panX: size.w / 2 - (rect.x + rect.w / 2) * zoom,
		panY: size.h / 2 - (rect.y + rect.h / 2) * zoom
	};
}

/** Nächste Zoomstufe für +/- */
const STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 2, 3, 4];
export function stepZoom(current: number, dir: 1 | -1): number {
	if (dir > 0) return STEPS.find((s) => s > current + 0.001) ?? MAX_ZOOM;
	return [...STEPS].reverse().find((s) => s < current - 0.001) ?? MIN_ZOOM;
}
