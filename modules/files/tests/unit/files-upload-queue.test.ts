import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FilesMeta } from '$modules/files/schemas';
import {
	MULTIPART_BASE_RESERVE,
	collectEntries,
	fromFileList,
	makeItems,
	partReserve,
	pendingBytes,
	planBatches,
	precheck,
	publicUploadError,
	queueProgress,
	summaryToast,
	typeAllowed,
	uploadError,
	xhrUpload,
	type EntryLike,
	type FileLike
} from '$modules/files/pages/upload-queue';

const MB = 1024 * 1024;

function meta(over: Partial<FilesMeta> = {}, quota?: FilesMeta['quota']): FilesMeta {
	return {
		quota: quota ?? { usedBytes: 0, limitBytes: null },
		maxFileBytes: 10 * MB,
		allowedContentTypes: [],
		trashDays: 30,
		can: { linkCreate: true, manageAll: false },
		...over
	};
}

const f = (name: string, size: number, type = ''): FileLike => ({ name, size, type });
const inp = (file: FileLike, relativePath: string | null = null) => ({ file, relativePath });

describe('typeAllowed', () => {
	it('leere Liste erlaubt alles', () => {
		expect(typeAllowed('application/x-foo', [])).toBe(true);
	});
	it('exakt und mit Platzhalter, ohne Groß/Klein und Parameter', () => {
		const allowed = ['image/*', 'application/pdf'];
		expect(typeAllowed('image/png', allowed)).toBe(true);
		expect(typeAllowed('IMAGE/JPEG', allowed)).toBe(true);
		expect(typeAllowed('application/pdf', allowed)).toBe(true);
		expect(typeAllowed('text/plain; charset=utf-8', ['text/plain'])).toBe(true);
		expect(typeAllowed('video/mp4', allowed)).toBe(false);
		expect(typeAllowed('imagex/png', allowed)).toBe(false);
	});
});

describe('precheck', () => {
	it('ohne meta wird nichts abgelehnt', () => {
		const r = precheck([inp(f('a', 999 * MB))], null);
		expect(r[0]!.problem).toBeNull();
	});

	it('Größe: genau Maximum erlaubt, ein Byte mehr abgelehnt', () => {
		const r = precheck([inp(f('ok', 10 * MB)), inp(f('gross', 10 * MB + 1))], meta());
		expect(r[0]!.problem).toBeNull();
		expect(r[1]!.problem).toMatch(/^Zu groß \(10 MB, max\. 10 MB\)$/);
	});

	it('Typ nur prüfen, wenn der Browser ihn kennt', () => {
		const m = meta({ allowedContentTypes: ['image/*'] });
		const r = precheck(
			[
				inp(f('a.png', 1, 'image/png')),
				inp(f('a.exe', 1, 'application/x-msdownload')),
				inp(f('x', 1))
			],
			m
		);
		expect(r.map((x) => x.problem === null)).toEqual([true, false, true]);
		expect(r[1]!.problem).toContain('Dateityp nicht erlaubt');
	});

	it('Kontingent: ab der ersten Datei, die nicht passt, wird abgelehnt (nur mit checkQuota)', () => {
		const m = meta({}, { usedBytes: 6 * MB, limitBytes: 10 * MB });
		const files = [inp(f('a', 3 * MB)), inp(f('b', 2 * MB)), inp(f('c', 1))];
		const r = precheck(files, m, { checkQuota: true });
		expect(r[0]!.problem).toBeNull();
		expect(r[1]!.problem).toContain('Kontingent');
		// auch die kleine Datei danach (ab dem Eintrag, der nicht mehr passt)
		expect(r[2]!.problem).toContain('Kontingent');
		// Ziel ist ein (evtl. fremder) Ordner: Kontingent prüft der Server
		expect(precheck(files, m).every((x) => x.problem === null)).toBe(true);
		expect(precheck(files, m, { checkQuota: false }).every((x) => x.problem === null)).toBe(true);
	});

	it('Kontingent: genau passend erlaubt, wartende Bytes zählen mit', () => {
		const m = meta({}, { usedBytes: 6 * MB, limitBytes: 10 * MB });
		expect(precheck([inp(f('a', 4 * MB))], m, { checkQuota: true })[0]!.problem).toBeNull();
		expect(
			precheck([inp(f('a', 4 * MB))], m, { checkQuota: true, pendingBytes: 1 })[0]!.problem
		).toContain('Kontingent');
	});

	it('unbegrenztes Kontingent', () => {
		const m = meta({}, { usedBytes: 99 * MB, limitBytes: null });
		expect(precheck([inp(f('a', 5 * MB))], m, { checkQuota: true })[0]!.problem).toBeNull();
	});

	it('öffentliche Grenzen ohne Kontingent; Datei muss samt Aufschlag in einen Request passen', () => {
		const limits = {
			maxFileBytes: 30 * MB,
			allowedContentTypes: ['image/*'],
			maxRequestBytes: 30 * MB
		};
		const r = precheck(
			[inp(f('a.jpg', 5 * MB, 'image/jpeg')), inp(f('b.jpg', 30 * MB, 'image/jpeg'))],
			limits,
			{ checkQuota: true }
		);
		expect(r[0]!.problem).toBeNull();
		expect(r[1]!.problem).toMatch(/^Zu groß/);
		const max = 30 * MB - MULTIPART_BASE_RESERVE - partReserve('c.jpg');
		expect(precheck([inp(f('c.jpg', max, 'image/jpeg'))], limits)[0]!.problem).toBeNull();
		expect(precheck([inp(f('c.jpg', max + 1, 'image/jpeg'))], limits)[0]!.problem).toMatch(
			/^Zu groß/
		);
	});
});

describe('planBatches', () => {
	it('leer → keine Pakete', () => {
		expect(planBatches([], 10, 30 * MB)).toEqual([]);
	});
	it('höchstens maxFiles je Paket, Reihenfolge bleibt', () => {
		const files = Array.from({ length: 23 }, (_, i) => f(`d${i}`, 1));
		const b = planBatches(files, 10, 30 * MB);
		expect(b.map((x) => x.length)).toEqual([10, 10, 3]);
		expect(b.flat()).toEqual(files.map((_, i) => i));
	});
	it('Bytes je Paket inkl. Aufschlag ≤ maxRequestBytes', () => {
		const files = [f('a', 12 * MB), f('b', 12 * MB), f('c', 12 * MB), f('d', 1)];
		const b = planBatches(files, 10, 30 * MB);
		expect(b).toEqual([
			[0, 1],
			[2, 3]
		]);
		for (const batch of b) {
			const sum = batch.reduce(
				(s, i) => s + files[i]!.size + partReserve(files[i]!.name),
				MULTIPART_BASE_RESERVE
			);
			expect(sum).toBeLessThanOrEqual(30 * MB);
		}
	});
	it('zu große Einzeldatei bekommt ein eigenes Paket', () => {
		expect(planBatches([f('a', 1), f('riesig', 40 * MB), f('b', 1)], 10, 30 * MB)).toEqual([
			[0],
			[1],
			[2]
		]);
	});
});

describe('publicUploadError', () => {
	it('Statuscodes', () => {
		expect(publicUploadError(413, { error: { message: 'x' } }, false)).toEqual({
			kind: 'rejected',
			message: 'Zu groß bzw. kein Speicherplatz mehr frei'
		});
		expect(publicUploadError(422, { error: { message: 'Dateityp nicht erlaubt' } }, false)).toEqual(
			{ kind: 'rejected', message: 'Dateityp nicht erlaubt' }
		);
		expect(publicUploadError(429, null, false)).toEqual({
			kind: 'retry',
			message: 'Gerade zu viele Uploads – bitte kurz warten'
		});
		expect(publicUploadError(404, null, false).kind).toBe('unavailable');
		expect(publicUploadError(403, null, true).kind).toBe('relock');
		expect(publicUploadError(403, null, false).kind).toBe('rejected');
		expect(publicUploadError(0, null, false).kind).toBe('retry');
		expect(publicUploadError(500, null, false).kind).toBe('retry');
	});
});

describe('xhrUpload', () => {
	class FakeXhr {
		static last: FakeXhr | null = null;
		upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
		onload: (() => void) | null = null;
		onerror: (() => void) | null = null;
		onabort: (() => void) | null = null;
		status = 0;
		responseText = '';
		method = '';
		url = '';
		headers: Record<string, string> = {};
		sent: unknown = null;
		constructor() {
			FakeXhr.last = this;
		}
		open(method: string, url: string) {
			this.method = method;
			this.url = url;
		}
		setRequestHeader(k: string, v: string) {
			this.headers[k] = v;
		}
		send(body: unknown) {
			this.sent = body;
		}
		abort() {
			this.onabort?.();
		}
	}
	const original = (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
	beforeEach(() => {
		(globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = FakeXhr;
	});
	afterEach(() => {
		(globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = original;
	});

	it('Fortschritt und JSON-Antwort', async () => {
		const seen: number[] = [];
		const form = new FormData();
		const p = xhrUpload('/x', form, (l, t) => seen.push(l / t));
		const x = FakeXhr.last!;
		expect(x).toMatchObject({ method: 'POST', url: '/x', sent: form });
		x.upload.onprogress?.({ lengthComputable: true, loaded: 5, total: 10 } as ProgressEvent);
		x.status = 201;
		x.responseText = '{"data":{"uploaded":[]}}';
		x.onload?.();
		expect(await p).toEqual({ status: 201, body: { data: { uploaded: [] } }, aborted: false });
		expect(seen).toEqual([0.5]);
	});
	it('kaputtes JSON → body null; Netzwerkfehler → 0', async () => {
		const p1 = xhrUpload('/x', new FormData());
		FakeXhr.last!.status = 500;
		FakeXhr.last!.responseText = '<html>';
		FakeXhr.last!.onload?.();
		expect(await p1).toEqual({ status: 500, body: null, aborted: false });
		const p2 = xhrUpload('/x', new FormData());
		FakeXhr.last!.onerror?.();
		expect(await p2).toEqual({ status: 0, body: null, aborted: false });
	});
	it('Abbrechen per Signal', async () => {
		const c = new AbortController();
		const p = xhrUpload('/x', new FormData(), undefined, c.signal);
		c.abort();
		expect(await p).toEqual({ status: 0, body: null, aborted: true });
		const pre = new AbortController();
		pre.abort();
		expect(await xhrUpload('/x', new FormData(), undefined, pre.signal)).toMatchObject({
			aborted: true
		});
	});
});

describe('makeItems / pendingBytes', () => {
	it('abgelehnte als Fehler, Name aus relativem Pfad', () => {
		let n = 0;
		const items = makeItems(
			[
				{ ...inp(f('a.jpg', 5), 'Fotos/a.jpg'), problem: null },
				{ ...inp(f('b', 7)), problem: 'Zu groß' }
			],
			{ parentId: null },
			() => `k${++n}`
		);
		expect(items[0]).toMatchObject({
			key: 'k1',
			name: 'Fotos/a.jpg',
			status: 'waiting',
			rejected: false
		});
		expect(items[1]).toMatchObject({
			key: 'k2',
			name: 'b',
			status: 'error',
			rejected: true,
			message: 'Zu groß'
		});
		expect(pendingBytes(items)).toBe(5);
	});
});

describe('queueProgress', () => {
	const it0 = { rejected: false, progress: 0 };
	it('leer → 0', () => {
		expect(queueProgress([]).fraction).toBe(0);
	});
	it('bytesbasiert, abgelehnte zählen nicht', () => {
		const p = queueProgress([
			{ ...it0, status: 'done', size: 100 },
			{ ...it0, status: 'uploading', size: 300, progress: 0.5 },
			{ ...it0, status: 'waiting', size: 600 },
			{ status: 'error', size: 1000, progress: 0, rejected: true }
		]);
		expect(p.totalBytes).toBe(1000);
		expect(p.loadedBytes).toBe(250);
		expect(p.fraction).toBeCloseTo(0.25);
		expect(p).toMatchObject({ done: 1, uploading: 1, waiting: 1, rejected: 1, busy: true });
	});
	it('Fehler zählen als abgearbeitet, Fortschritt geklemmt, leere Dateien bewegen den Balken', () => {
		const p = queueProgress([
			{ ...it0, status: 'error', size: 0 },
			{ ...it0, status: 'uploading', size: 0, progress: Number.NaN },
			{ ...it0, status: 'done', size: 0, progress: 5 }
		]);
		expect(p.fraction).toBeCloseTo(2 / 3);
		expect(p.busy).toBe(true);
	});
	it('nur abgelehnte → 1, nicht busy', () => {
		const p = queueProgress([{ status: 'error', size: 5, progress: 0, rejected: true }]);
		expect(p.fraction).toBe(1);
		expect(p.busy).toBe(false);
	});
});

describe('summaryToast', () => {
	it('Varianten', () => {
		expect(summaryToast({ ok: 1, failed: 0, rejected: 0 })).toEqual({
			kind: 'success',
			message: '1 Datei hochgeladen'
		});
		expect(summaryToast({ ok: 3, failed: 1, rejected: 2 })).toEqual({
			kind: 'warning',
			message: '3 Dateien hochgeladen, 1 fehlgeschlagen, 2 abgelehnt'
		});
		expect(summaryToast({ ok: 0, failed: 0, rejected: 1 })?.kind).toBe('error');
		expect(summaryToast({ ok: 0, failed: 0, rejected: 0 })).toBeNull();
	});
});

describe('uploadError', () => {
	it('Meldung vom Server, 413/422 abgelehnt', () => {
		expect(uploadError(413, { error: { code: 'too_large', message: 'Zu groß!' } })).toEqual({
			message: 'Zu groß!',
			rejected: true
		});
		expect(uploadError(422, null).rejected).toBe(true);
		expect(uploadError(500, { error: { message: '' } })).toEqual({
			message: 'Hochladen fehlgeschlagen',
			rejected: false
		});
		expect(uploadError(0, null).message).toContain('Netzwerkfehler');
		expect(uploadError(403, 'kaputt').rejected).toBe(false);
		expect(uploadError(429, null)).toEqual({
			message: 'Gerade zu viele Uploads – bitte kurz warten',
			rejected: false
		});
	});
});

// --- Ordner aus Drag & Drop ---

function fileEntry(file: FileLike): EntryLike {
	return {
		isFile: true,
		isDirectory: false,
		name: file.name,
		file: (ok: (f: FileLike) => void) => ok(file)
	} as EntryLike;
}
/** readEntries liefert seitenweise (hier je 2), dann leer */
function dirEntry(name: string, children: EntryLike[]): EntryLike {
	return {
		isFile: false,
		isDirectory: true,
		name,
		createReader() {
			let pos = 0;
			return {
				readEntries(ok: (e: EntryLike[]) => void) {
					const page = children.slice(pos, pos + 2);
					pos += page.length;
					setTimeout(() => ok(page), 0);
				}
			};
		}
	} as EntryLike;
}

describe('collectEntries', () => {
	it('rekursiv mit Pfad inkl. Wurzelordner, mehrere Seiten, leere Ordner ignoriert', async () => {
		const tree = dirEntry('Fotos', [
			fileEntry(f('a.jpg', 1)),
			dirEntry('2026', [
				fileEntry(f('b.jpg', 2)),
				fileEntry(f('c.jpg', 3)),
				fileEntry(f('d.jpg', 4))
			]),
			dirEntry('leer', []),
			fileEntry(f('e.jpg', 5))
		]);
		const out = await collectEntries<FileLike>([tree, fileEntry(f('lose.txt', 6))]);
		expect(out.map((o) => o.relativePath)).toEqual([
			'Fotos/a.jpg',
			'Fotos/2026/b.jpg',
			'Fotos/2026/c.jpg',
			'Fotos/2026/d.jpg',
			'Fotos/e.jpg',
			null
		]);
	});
	it('nicht lesbare Einträge werden übersprungen', async () => {
		const broken = {
			isFile: true,
			isDirectory: false,
			name: 'x',
			file: (_ok: unknown, err: (e: unknown) => void) => err(new Error('nope'))
		} as EntryLike;
		expect(await collectEntries([broken])).toEqual([]);
	});
});

describe('fromFileList', () => {
	it('webkitRelativePath als Pfad', () => {
		const r = fromFileList([
			{ ...f('a.jpg', 1), webkitRelativePath: 'Fotos/a.jpg' },
			{ ...f('b.jpg', 1), webkitRelativePath: '' }
		]);
		expect(r.map((x) => x.relativePath)).toEqual(['Fotos/a.jpg', null]);
	});
});
