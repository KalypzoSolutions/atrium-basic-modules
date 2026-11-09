/**
 * Logik der Upload-Warteschlange im Modul `files` (ohne Svelte) – testbar.
 * Vorprüfung (Größe, Typ, Kontingent), Fortschritt, Fehlerauswertung, Pakete für den öffentlichen Upload,
 * XHR-Upload mit Fortschritt, Ordner aus Drag & Drop lesen.
 * Genutzt von `UploadDropzone.svelte` (intern) und `PublicLinkPage.svelte` (Upload-Links).
 */
import type { Quota } from '../schemas';

export type UploadStatus = 'waiting' | 'uploading' | 'done' | 'error';

/** Minimale Form einer Datei (Browser-`File` oder Test-Attrappe) */
export interface FileLike {
	name: string;
	size: number;
	type: string;
}

/** Datei mit optionalem Pfad relativ zur abgelegten Wurzel (z. B. „Fotos/2026/a.jpg“) */
export interface QueueInput<F extends FileLike = File> {
	file: F;
	relativePath: string | null;
}

export interface UploadItem<F extends FileLike = File> {
	key: string;
	file: F;
	/** Anzeigename: relativer Pfad oder Dateiname */
	name: string;
	relativePath: string | null;
	size: number;
	/** Zielordner zum Zeitpunkt des Einreihens (`null` = eigene Wurzel; Navigation ändert ihn nicht) */
	parentId: string | null;
	status: UploadStatus;
	/** 0..1 */
	progress: number;
	message: string;
	/** Abgelehnt (Vorprüfung, 413/422): erneuter Versuch sinnlos */
	rejected: boolean;
}

export const STATUS_LABELS: Record<UploadStatus, string> = {
	waiting: 'Wartet',
	uploading: 'Lädt hoch …',
	done: 'Fertig',
	error: 'Fehler'
};

/** „512 B“, „1,2 KB“, „3,4 MB“ (de-DE, Basis 1024) – bewusst ohne Import aus `helpers.ts` (Icons) */
export function sizeText(bytes: number): string {
	const n = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
	if (n < 1024) return `${Math.round(n)} B`;
	const units = ['KB', 'MB', 'GB', 'TB'];
	let v = n / 1024;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v.toLocaleString('de-DE', { maximumFractionDigits: v < 10 ? 1 : 0 })} ${units[i]}`;
}

/** Ist der (Browser-)Typ in der Liste erlaubt? Leere Liste = alles erlaubt; `image/*` als Platzhalter. */
export function typeAllowed(contentType: string, allowed: readonly string[]): boolean {
	if (!allowed.length) return true;
	const ct = contentType.split(';')[0]!.trim().toLowerCase();
	return allowed.some((raw) => {
		const a = raw.trim().toLowerCase();
		if (a === '*' || a === '*/*') return true;
		return a.endsWith('/*') ? ct.startsWith(a.slice(0, -1)) : a === ct;
	});
}

export interface PrecheckResult<F extends FileLike = File> extends QueueInput<F> {
	/** `null` = in Ordnung, sonst Grund der Ablehnung */
	problem: string | null;
}

/** Grenzen für die Vorprüfung – `FilesMeta` (intern) passt strukturell, öffentlich `PublicLinkInfo.upload` */
export interface UploadLimits {
	maxFileBytes: number;
	allowedContentTypes: readonly string[];
	/** Kontingent (nur mit `checkQuota`) */
	quota?: Quota | null;
	/** Öffentlicher Upload: Datei samt multipart-Aufschlag muss in einen Request passen */
	maxRequestBytes?: number;
}

export interface PrecheckOptions {
	/** Kontingent prüfen – nur, wenn das Ziel sicher die eigene Ablage ist (sonst prüft der Server) */
	checkQuota?: boolean;
	/** Bytes, die schon in der Warteschlange stehen (wartend/laufend) */
	pendingBytes?: number;
}

/**
 * Vorprüfung im Browser (der Server prüft zusätzlich):
 * - größer als `maxFileBytes` (bzw. passt nicht in `maxRequestBytes`) → „Zu groß (x, max. y)“
 * - `allowedContentTypes` gesetzt, Browser-Typ bekannt und nicht erlaubt → „Dateityp nicht erlaubt“
 * - nur mit `checkQuota` und Grenze: ab der ersten Datei, die nicht mehr ins Kontingent passt, wird abgelehnt.
 * Ohne `limits` wird nichts abgelehnt.
 */
export function precheck<F extends FileLike>(
	files: readonly QueueInput<F>[],
	limits: UploadLimits | null,
	opts: PrecheckOptions = {}
): PrecheckResult<F>[] {
	if (!limits) return files.map((f) => ({ ...f, problem: null }));
	const quota = opts.checkQuota ? (limits.quota ?? null) : null;
	const limit = quota ? quota.limitBytes : null;
	let free =
		limit === null || !quota
			? Infinity
			: Math.max(0, limit - quota.usedBytes - Math.max(0, opts.pendingBytes ?? 0));
	let quotaExceeded = false;
	return files.map((f) => {
		const { size, type } = f.file;
		const maxFor =
			limits.maxRequestBytes === undefined
				? limits.maxFileBytes
				: Math.max(
						0,
						Math.min(
							limits.maxFileBytes,
							limits.maxRequestBytes - MULTIPART_BASE_RESERVE - partReserve(f.file.name)
						)
					);
		let problem: string | null = null;
		if (size > maxFor) {
			problem = `Zu groß (${sizeText(size)}, max. ${sizeText(maxFor)})`;
		} else if (type && !typeAllowed(type, limits.allowedContentTypes)) {
			problem = `Dateityp nicht erlaubt (${type})`;
		} else if (quotaExceeded || size > free) {
			quotaExceeded = true;
			problem = `Kein Platz mehr im Kontingent (noch ${sizeText(free === Infinity ? 0 : free)} frei)`;
		} else {
			free -= size;
		}
		return { ...f, problem };
	});
}

/** Neue Einträge aus der Vorprüfung (abgelehnte direkt als Fehler) */
export function makeItems<F extends FileLike>(
	checked: readonly PrecheckResult<F>[],
	target: { parentId: string | null },
	makeKey: () => string = () => crypto.randomUUID()
): UploadItem<F>[] {
	return checked.map((c) => ({
		key: makeKey(),
		file: c.file,
		name: c.relativePath || c.file.name || 'Unbenannt',
		relativePath: c.relativePath,
		size: c.file.size,
		parentId: target.parentId,
		status: c.problem ? 'error' : 'waiting',
		progress: 0,
		message: c.problem ?? '',
		rejected: !!c.problem
	}));
}

/** Bytes, die noch hochgeladen werden (wartend/laufend) – für die Kontingent-Prüfung weiterer Dateien */
export function pendingBytes(
	items: readonly Pick<UploadItem<FileLike>, 'status' | 'size'>[]
): number {
	return items
		.filter((i) => i.status === 'waiting' || i.status === 'uploading')
		.reduce((s, i) => s + i.size, 0);
}

export interface QueueProgress {
	/** hochgeladene Bytes (fertig + laufend anteilig) */
	loadedBytes: number;
	/** Bytes aller nicht abgelehnten Einträge */
	totalBytes: number;
	/** 0..1; fertige und fehlgeschlagene Einträge zählen als abgearbeitet */
	fraction: number;
	done: number;
	failed: number;
	rejected: number;
	waiting: number;
	uploading: number;
	/** noch etwas wartend/laufend */
	busy: boolean;
}

/** Gesamtfortschritt (Bytes-basiert, leere Dateien zählen mit 1 Byte, damit sie den Balken bewegen) */
export function queueProgress(
	items: readonly Pick<UploadItem<FileLike>, 'status' | 'size' | 'progress' | 'rejected'>[]
): QueueProgress {
	let loaded = 0;
	let processed = 0;
	let total = 0;
	let totalWeight = 0;
	const p: QueueProgress = {
		loadedBytes: 0,
		totalBytes: 0,
		fraction: 0,
		done: 0,
		failed: 0,
		rejected: 0,
		waiting: 0,
		uploading: 0,
		busy: false
	};
	for (const i of items) {
		if (i.rejected) {
			p.rejected++;
			continue;
		}
		const size = Math.max(0, i.size);
		const weight = Math.max(1, size);
		const prog = Math.min(1, Math.max(0, Number.isFinite(i.progress) ? i.progress : 0));
		total += size;
		totalWeight += weight;
		if (i.status === 'done') {
			p.done++;
			loaded += size;
			processed += weight;
		} else if (i.status === 'error') {
			p.failed++;
			processed += weight;
		} else if (i.status === 'uploading') {
			p.uploading++;
			loaded += size * prog;
			processed += weight * prog;
		} else {
			p.waiting++;
		}
	}
	p.loadedBytes = Math.round(loaded);
	p.totalBytes = total;
	p.fraction = totalWeight > 0 ? Math.min(1, processed / totalWeight) : items.length ? 1 : 0;
	p.busy = p.waiting + p.uploading > 0;
	return p;
}

/** Text für den Abschluss-Toast; `kind` bestimmt success/warning/error */
export function summaryToast(counts: {
	ok: number;
	failed: number;
	rejected: number;
}): { kind: 'success' | 'warning' | 'error'; message: string } | null {
	const { ok, failed, rejected } = counts;
	const files = (n: number) => (n === 1 ? '1 Datei' : `${n} Dateien`);
	const parts = [
		failed > 0 && `${failed} fehlgeschlagen`,
		rejected > 0 && `${rejected} abgelehnt`
	].filter(Boolean) as string[];
	if (ok > 0 && !parts.length) return { kind: 'success', message: `${files(ok)} hochgeladen` };
	if (ok > 0) return { kind: 'warning', message: `${files(ok)} hochgeladen, ${parts.join(', ')}` };
	if (parts.length) return { kind: 'error', message: `Nichts hochgeladen: ${parts.join(', ')}` };
	return null;
}

/** Fehler einer Upload-Antwort: Text aus `error.message`, 413/422 = abgelehnt (kein Wiederholen) */
export function uploadError(status: number, body: unknown): { message: string; rejected: boolean } {
	const msg =
		body && typeof body === 'object' && 'error' in body
			? (body as { error?: { message?: unknown } }).error?.message
			: undefined;
	const fromServer = typeof msg === 'string' && msg.trim() ? msg.trim() : null;
	const fallback =
		status === 0
			? 'Netzwerkfehler – Hochladen fehlgeschlagen'
			: status === 413
				? 'Die Datei ist zu groß.'
				: status === 422
					? 'Datei oder Name ungültig'
					: status === 403
						? 'Keine Berechtigung für diesen Ordner'
						: status === 404
							? 'Zielordner nicht gefunden'
							: status === 429
								? 'Gerade zu viele Uploads – bitte kurz warten'
								: status === 503
									? 'Dateispeicher nicht eingerichtet'
									: 'Hochladen fehlgeschlagen';
	return { message: fromServer ?? fallback, rejected: status === 413 || status === 422 };
}

/** Wie wird ein Fehler beim öffentlichen Upload behandelt? */
export type PublicUploadErrorKind =
	/** Meldung anzeigen, Dateien bleiben zum erneuten Versuch */
	| 'retry'
	/** Meldung anzeigen, erneuter Versuch sinnlos (413/422) */
	| 'rejected'
	/** Passwort erneut abfragen (403 bei Passwort-Link) */
	| 'relock'
	/** Link nicht (mehr) verfügbar (404) – neutrale Seite */
	| 'unavailable';

/**
 * Fehler einer Antwort von `POST /public/links/:token/upload`:
 * 413 → feste Meldung, 422 → Server-Meldung, 429 → „bitte kurz warten“, 403 → bei Passwort-Links neu
 * freischalten, sonst „kann nicht hochgeladen werden“, 404 → neutral.
 */
export function publicUploadError(
	status: number,
	body: unknown,
	needsPassword: boolean
): { kind: PublicUploadErrorKind; message: string } {
	const msg =
		body && typeof body === 'object' && 'error' in body
			? (body as { error?: { message?: unknown } }).error?.message
			: undefined;
	const fromServer = typeof msg === 'string' && msg.trim() ? msg.trim() : null;
	if (status === 413)
		return { kind: 'rejected', message: 'Zu groß bzw. kein Speicherplatz mehr frei' };
	if (status === 422) {
		return { kind: 'rejected', message: fromServer ?? 'Datei oder Angaben ungültig' };
	}
	if (status === 429) {
		return { kind: 'retry', message: 'Gerade zu viele Uploads – bitte kurz warten' };
	}
	if (status === 404)
		return { kind: 'unavailable', message: 'Dieser Link ist nicht (mehr) verfügbar.' };
	if (status === 403) {
		return needsPassword
			? { kind: 'relock', message: 'Bitte gib das Passwort erneut ein.' }
			: { kind: 'rejected', message: 'Über diesen Link kann nicht hochgeladen werden.' };
	}
	if (status === 0) {
		return { kind: 'retry', message: 'Netzwerkfehler – Hochladen fehlgeschlagen' };
	}
	return { kind: 'retry', message: 'Hochladen fehlgeschlagen – bitte erneut versuchen' };
}

// ---------------------------------------------------------------------------
// Pakete für den öffentlichen Upload (mehrere Dateien je Request)
// ---------------------------------------------------------------------------

/** Aufschlag je Request für Boundary-Ende und Textfelder (`name` ≤ 100 Zeichen, `t` ≤ 500) */
export const MULTIPART_BASE_RESERVE = 4 * 1024;

/** Aufschlag je Datei-Teil im multipart-Body (Kopfzeilen + Dateiname, UTF-8, ggf. maskiert) */
export function partReserve(name: string): number {
	return 512 + new TextEncoder().encode(name).length * 3;
}

/**
 * Dateien in Requests aufteilen (Reihenfolge bleibt): je Paket ≤ `maxFiles` Dateien und Summe aus Größen +
 * Aufschlägen ≤ `maxRequestBytes`. Eine Datei, die allein nicht passt, kommt in ein eigenes Paket (der Server
 * lehnt sie dann mit 413 ab – die Vorprüfung sollte sie vorher aussortieren). Ergebnis: Indizes je Paket.
 */
export function planBatches(
	files: readonly Pick<FileLike, 'name' | 'size'>[],
	maxFiles: number,
	maxRequestBytes: number
): number[][] {
	const per = Math.max(1, Math.floor(maxFiles));
	const batches: number[][] = [];
	let current: number[] = [];
	let bytes = MULTIPART_BASE_RESERVE;
	files.forEach((f, i) => {
		const need = Math.max(0, f.size) + partReserve(f.name);
		if (current.length && (current.length >= per || bytes + need > maxRequestBytes)) {
			batches.push(current);
			current = [];
			bytes = MULTIPART_BASE_RESERVE;
		}
		current.push(i);
		bytes += need;
	});
	if (current.length) batches.push(current);
	return batches;
}

// ---------------------------------------------------------------------------
// XHR-Upload mit Fortschritt (fetch kennt keinen Upload-Fortschritt)
// ---------------------------------------------------------------------------

export interface XhrResult {
	/** HTTP-Status, `0` = Netzwerkfehler oder abgebrochen */
	status: number;
	/** JSON-Antwort (oder `null`) */
	body: unknown;
	aborted: boolean;
}

/**
 * `POST url` mit `form` als multipart (Browser setzt Content-Type mit Boundary und Content-Length).
 * `onProgress(loaded, total)` beim Hochladen; `signal` bricht ab. Wirft nie – Fehler stehen im Ergebnis.
 */
export function xhrUpload(
	url: string,
	form: FormData,
	onProgress?: (loaded: number, total: number) => void,
	signal?: AbortSignal
): Promise<XhrResult> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve({ status: 0, body: null, aborted: true });
			return;
		}
		const xhr = new XMLHttpRequest();
		let settled = false;
		const done = (r: XhrResult) => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener('abort', onAbort);
			resolve(r);
		};
		const onAbort = () => xhr.abort();
		signal?.addEventListener('abort', onAbort);
		xhr.upload.onprogress = (e) => {
			if (e.lengthComputable && e.total > 0) onProgress?.(e.loaded, e.total);
		};
		xhr.onload = () => {
			let body: unknown;
			try {
				body = xhr.responseText ? JSON.parse(xhr.responseText) : null;
			} catch {
				body = null;
			}
			done({ status: xhr.status, body, aborted: false });
		};
		xhr.onerror = () => done({ status: 0, body: null, aborted: false });
		xhr.onabort = () => done({ status: 0, body: null, aborted: true });
		try {
			xhr.open('POST', url);
			xhr.setRequestHeader('accept', 'application/json');
			xhr.send(form);
		} catch {
			done({ status: 0, body: null, aborted: false });
		}
	});
}

// ---------------------------------------------------------------------------
// Ordner aus Drag & Drop (`webkitGetAsEntry`) – strukturelle Typen, damit Tests Attrappen nutzen können
// ---------------------------------------------------------------------------

export interface EntryLike {
	isFile: boolean;
	isDirectory: boolean;
	name: string;
}
export interface FileEntryLike<F> extends EntryLike {
	file(success: (f: F) => void, error?: (e: unknown) => void): void;
}
export interface DirectoryEntryLike extends EntryLike {
	createReader(): {
		readEntries(success: (entries: EntryLike[]) => void, error?: (e: unknown) => void): void;
	};
}

/** Alle Einträge eines Ordners (`readEntries` liefert seitenweise, bis eine leere Seite kommt) */
async function readAll(dir: DirectoryEntryLike): Promise<EntryLike[]> {
	const reader = dir.createReader();
	const all: EntryLike[] = [];
	for (;;) {
		const page = await new Promise<EntryLike[]>((resolve, reject) =>
			reader.readEntries(resolve, reject)
		);
		if (!page.length) return all;
		all.push(...page);
	}
}

/**
 * Dateien eines abgelegten Eintrags rekursiv sammeln. Datei auf oberster Ebene → `relativePath = null`;
 * in Ordnern → Pfad inkl. Ordnername der Wurzel (z. B. „Fotos/2026/a.jpg“). Leere Ordner liefern nichts.
 * Nicht lesbare Einträge werden übersprungen.
 */
export async function collectEntry<F extends FileLike>(
	entry: EntryLike,
	prefix = ''
): Promise<QueueInput<F>[]> {
	if (entry.isFile) {
		try {
			const file = await new Promise<F>((resolve, reject) =>
				(entry as FileEntryLike<F>).file(resolve, reject)
			);
			return [{ file, relativePath: prefix ? `${prefix}${entry.name}` : null }];
		} catch {
			return [];
		}
	}
	if (entry.isDirectory) {
		let children: EntryLike[];
		try {
			children = await readAll(entry as DirectoryEntryLike);
		} catch {
			return [];
		}
		const out: QueueInput<F>[] = [];
		for (const child of children) {
			out.push(...(await collectEntry<F>(child, `${prefix}${entry.name}/`)));
		}
		return out;
	}
	return [];
}

/** Mehrere abgelegte Einträge nacheinander sammeln */
export async function collectEntries<F extends FileLike>(
	entries: readonly EntryLike[]
): Promise<QueueInput<F>[]> {
	const out: QueueInput<F>[] = [];
	for (const e of entries) out.push(...(await collectEntry<F>(e)));
	return out;
}

/** Auswahl über `<input webkitdirectory>`: `webkitRelativePath` als Pfad (leer → `null`) */
export function fromFileList<F extends FileLike & { webkitRelativePath?: string }>(
	files: Iterable<F>
): QueueInput<F>[] {
	return Array.from(files, (file) => ({
		file,
		relativePath: file.webkitRelativePath ? file.webkitRelativePath : null
	}));
}
