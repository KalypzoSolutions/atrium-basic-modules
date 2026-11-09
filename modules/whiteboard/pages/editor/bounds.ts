/** Hüllrechtecke von Elementen (rein): Rahmen-Elemente über ihre Ecken, Verbinder über den Pfad */
import type { WbElement } from '../../schemas';
import { resolveConnector, samplePath } from './connectors';
import { boundsOfPoints, boxOf, corners, inflate, unionRects, type Rect } from './geometry';

export function elementBounds(el: WbElement, lookup: (id: string) => WbElement | undefined): Rect {
	if (el.type === 'connector') {
		const geo = resolveConnector(el.data, lookup);
		const r = boundsOfPoints(samplePath(geo, el.data.route));
		// Pfeilspitzen und Beschriftung
		return inflate(r, Math.max(12, el.data.strokeWidth * 4) + (el.data.label ? 10 : 0));
	}
	const r = boundsOfPoints(corners(boxOf(el)));
	// Rahmentitel steht über dem Rahmen
	return el.type === 'frame' ? { x: r.x, y: r.y - 28, w: r.w, h: r.h + 28 } : r;
}

export function boundsOfElements(
	list: readonly WbElement[],
	lookup: (id: string) => WbElement | undefined
): Rect | null {
	if (!list.length) return null;
	return unionRects(list.map((el) => elementBounds(el, lookup)));
}
