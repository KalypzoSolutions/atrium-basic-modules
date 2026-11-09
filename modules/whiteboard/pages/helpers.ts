/** Kleine UI-Hilfen der Whiteboard-Seiten (ohne Server-Importe). */
import { ApiClientError } from '$lib/sdk/client';

export const BASE = '/modules/whiteboard';

export function errMsg(e: unknown, fallback: string): string {
	return e instanceof ApiClientError && e.message ? e.message : fallback;
}

/** Feldfehler aus `ApiClientError.details` */
export function fieldErrors(e: unknown): Record<string, string> {
	if (!(e instanceof ApiClientError) || !Array.isArray(e.details)) return {};
	return Object.fromEntries(
		(e.details as { path?: (string | number)[]; message: string }[]).map((d) => [
			String(d.path?.[0] ?? ''),
			d.message
		])
	);
}

/** Datei im Browser speichern */
export function downloadBlob(blob: Blob, name: string): void {
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = name;
	document.body.appendChild(a);
	a.click();
	a.remove();
	setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Dateiname aus `content-disposition` */
export function fileNameFrom(res: Response, fallback: string): string {
	const m = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '');
	return m?.[1] ?? fallback;
}

/** „vor 5 Min.“, „gestern“, sonst Datum */
export function relativeTime(iso: string): string {
	const then = new Date(iso).getTime();
	const diff = Date.now() - then;
	const min = Math.round(diff / 60_000);
	if (min < 1) return 'gerade eben';
	if (min < 60) return `vor ${min} Min.`;
	const h = Math.round(min / 60);
	if (h < 24) return `vor ${h} Std.`;
	const d = Math.round(h / 24);
	if (d === 1) return 'gestern';
	if (d < 7) return `vor ${d} Tagen`;
	return new Date(iso).toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' });
}
