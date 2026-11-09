/**
 * Export im Browser: Ausschnitt als eigenständiges SVG (gleiche Komponenten wie die Ansicht, Bilder als
 * Data-URL eingebettet), daraus PNG/JPEG über ein Canvas; PDF = gerenderte Seiten an den Server (`export.pdf`).
 */
import { flushSync, mount, unmount } from 'svelte';
import type { RefCard, WbElement } from '../../schemas';
import { boundsOfElements } from './bounds';
import ExportSvg from './ExportSvg.svelte';
import { frameChildren, inflate, intersects, type Rect } from './geometry';
import { LIGHT } from './render';
import { refKey, type RenderContext } from './types';

/** Größte Kantenlänge/Pixelzahl eines Canvas (Browsergrenzen, v. a. iOS) */
const MAX_EDGE = 8192;
const MAX_PIXELS = 16_000_000;

async function toDataUrl(url: string): Promise<string | null> {
	try {
		const res = await fetch(url, { credentials: 'same-origin' });
		if (!res.ok) return null;
		const blob = await res.blob();
		return await new Promise<string | null>((resolve) => {
			const reader = new FileReader();
			reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
			reader.onerror = () => resolve(null);
			reader.readAsDataURL(blob);
		});
	} catch {
		return null;
	}
}

/** Render-Kontext für den Export: alle Bilder als Data-URL, keine Bedienhilfen, volle Auflösung */
export async function exportContext(
	base: RenderContext,
	elements: readonly WbElement[]
): Promise<RenderContext> {
	const assetUrls = new Map<string, string>();
	const refs = new Map<string, RefCard>(base.refs);
	const jobs: Promise<void>[] = [];
	for (const el of elements) {
		if (el.type === 'image' || el.type === 'file') {
			const variant = el.type === 'image' ? 'web' : 'thumb';
			const key = `${el.data.assetId}:${variant}`;
			const href = base.assetHref(el.data.assetId, variant);
			if (href && !assetUrls.has(key)) {
				assetUrls.set(key, '');
				jobs.push(
					toDataUrl(href).then((d) => {
						if (d) assetUrls.set(key, d);
					})
				);
			}
		}
		if (el.type === 'ref') {
			const k = refKey(el.data.refType, el.data.refId);
			const card = refs.get(k);
			if (card?.imageUrl) {
				jobs.push(
					toDataUrl(card.imageUrl).then((d) => {
						refs.set(k, { ...card, imageUrl: d });
					})
				);
			}
		}
	}
	await Promise.all(jobs);
	return {
		...base,
		refs,
		zoom: 4,
		// Export immer hell (druckbar, unabhängig von Gerät und Theme)
		palette: LIGHT,
		editingId: null,
		exporting: true,
		assetHref: (assetId, variant) => assetUrls.get(`${assetId}:${variant}`) || null
	};
}

/** Bereich eines Exports (mit Rand) */
export function exportRect(
	elements: readonly WbElement[],
	lookup: (id: string) => WbElement | undefined,
	pad = 32
): Rect | null {
	const r = boundsOfElements(elements, lookup);
	return r ? inflate(r, pad) : null;
}

/** Elemente, die in einem Bereich liegen (für „Rahmen als Seite“), in Zeichenreihenfolge */
export function elementsIn(
	all: readonly WbElement[],
	rect: Rect,
	lookup: (id: string) => WbElement | undefined
): WbElement[] {
	return all.filter((el) => {
		const r = boundsOfElements([el], lookup);
		return !!r && intersects(rect, r);
	});
}

/** Rahmen samt Inhalt */
export function frameWithChildren(frame: WbElement, all: readonly WbElement[]): WbElement[] {
	if (frame.type !== 'frame') return [frame];
	const ids = new Set([frame.id, ...frameChildren(frame, all)]);
	// Verbinder zwischen enthaltenen Elementen gehören dazu
	for (const el of all) {
		if (el.type !== 'connector') continue;
		const a = el.data.from.elementId;
		const b = el.data.to.elementId;
		if ((a && ids.has(a)) || (b && ids.has(b))) ids.add(el.id);
	}
	return all.filter((el) => ids.has(el.id));
}

/** SVG-Text eines Ausschnitts */
export function renderSvg(
	elements: readonly WbElement[],
	rc: RenderContext,
	rect: Rect,
	transparent = false
): string {
	const host = document.createElement('div');
	host.style.cssText = 'position:fixed;left:-100000px;top:0;width:1px;height:1px;overflow:hidden';
	document.body.appendChild(host);
	const app = mount(ExportSvg, {
		target: host,
		props: { elements: [...elements], rc, rect, transparent }
	});
	flushSync();
	const svg = host.querySelector('svg');
	const text = svg ? new XMLSerializer().serializeToString(svg) : '';
	void unmount(app);
	host.remove();
	return text;
}

/** Skalierung für das Rastern (Standard 2×, begrenzt auf Browsergrenzen) */
export function rasterScale(rect: Rect, wanted = 2): number {
	const byEdge = Math.min(MAX_EDGE / rect.w, MAX_EDGE / rect.h);
	const byPixels = Math.sqrt(MAX_PIXELS / (rect.w * rect.h));
	return Math.max(0.05, Math.min(wanted, byEdge, byPixels));
}

/** SVG → PNG/JPEG */
export async function rasterize(
	svg: string,
	rect: Rect,
	opts: { scale?: number; type?: 'image/png' | 'image/jpeg'; quality?: number } = {}
): Promise<Blob> {
	const scale = rasterScale(rect, opts.scale ?? 2);
	const width = Math.max(1, Math.round(rect.w * scale));
	const height = Math.max(1, Math.round(rect.h * scale));
	const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
	try {
		const img = new Image();
		img.decoding = 'async';
		await new Promise<void>((resolve, reject) => {
			img.onload = () => resolve();
			img.onerror = () => reject(new Error('Bild konnte nicht erzeugt werden'));
			img.src = url;
		});
		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext('2d');
		if (!ctx) throw new Error('Canvas nicht verfügbar');
		if (opts.type === 'image/jpeg') {
			ctx.fillStyle = '#ffffff';
			ctx.fillRect(0, 0, width, height);
		}
		ctx.drawImage(img, 0, 0, width, height);
		return await new Promise<Blob>((resolve, reject) =>
			canvas.toBlob(
				(b) => (b ? resolve(b) : reject(new Error('Bild konnte nicht erzeugt werden'))),
				opts.type ?? 'image/png',
				opts.quality ?? 0.92
			)
		);
	} finally {
		URL.revokeObjectURL(url);
	}
}
