/**
 * ZIP lesen und schreiben für Markdown-Export/-Import (fflate, rein). Grenzen beim Lesen: ≤ 500 Einträge, keine
 * absoluten Pfade, kein `..`, keine Steuerzeichen, keine ZIP64-Archive, je Datei ≤ `maxFileBytes`, entpackt
 * ≤ 200 MB (vorab aus den Kopfdaten und nachträglich aus den echten Längen). Verstöße → `ZipError` (Endpunkt: 422).
 */
import { unzipSync, zipSync, type Zippable } from 'fflate';

export const MAX_ZIP_ENTRIES = 500;
export const MAX_UNPACKED_BYTES = 200 * 1024 * 1024;

export class ZipError extends Error {}

/** Dateien (Pfad → Bytes) als ZIP */
export function writeZip(files: Record<string, Uint8Array>): Uint8Array {
	const zip: Zippable = {};
	for (const [path, bytes] of Object.entries(files)) {
		// Bilder sind schon komprimiert (WebP)
		zip[path] = [bytes, { level: path.endsWith('.webp') ? 0 : 6 }];
	}
	return zipSync(zip);
}

/** Erlaubter Eintragsname (relativ, ohne `..`, ohne Laufwerk/Steuerzeichen) */
export function isSafeEntryName(name: string): boolean {
	if (!name || name.length > 500) return false;
	if (name.startsWith('/') || name.startsWith('\\') || /^[a-z]:/i.test(name)) return false;
	if (name.includes('\\')) return false;
	// eslint-disable-next-line no-control-regex
	if (/[\u0000-\u001f\u007f]/.test(name)) return false;
	return !name.split('/').some((seg) => seg === '..' || seg === '.');
}

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;

/** ZIP64 abweisen, bevor fflate liest (präparierte Kopfdaten) */
function assertPlainZip(data: Uint8Array): void {
	const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	const min = Math.max(0, data.byteLength - 22 - 0xffff);
	let eocd = -1;
	for (let i = data.byteLength - 22; i >= min; i--) {
		if (view.getUint32(i, true) === EOCD) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw new ZipError('Die Datei ist kein gültiges ZIP-Archiv');
	if (eocd >= 20 && view.getUint32(eocd - 20, true) === ZIP64_LOCATOR) {
		throw new ZipError('ZIP64-Archive werden nicht unterstützt');
	}
	const entries = view.getUint16(eocd + 10, true);
	if (entries === 0xffff || view.getUint32(eocd + 12, true) === 0xffffffff) {
		throw new ZipError('ZIP64-Archive werden nicht unterstützt');
	}
	if (entries > MAX_ZIP_ENTRIES) {
		throw new ZipError(`Das Archiv enthält zu viele Einträge (höchstens ${MAX_ZIP_ENTRIES})`);
	}
}

/**
 * ZIP entpacken (nur Dateien, Ordner-Einträge und `__MACOSX/` werden übersprungen). `keep(name)` entscheidet, welche
 * Dateien überhaupt entpackt werden (z. B. nur `.md` und Bilder).
 */
export function readZip(
	data: Uint8Array,
	opts: { maxFileBytes: number; keep?: (name: string) => boolean }
): Map<string, Uint8Array> {
	if (data.byteLength < 22 || data[0] !== 0x50 || data[1] !== 0x4b) {
		throw new ZipError('Die Datei ist kein gültiges ZIP-Archiv');
	}
	assertPlainZip(data);
	let count = 0;
	let total = 0;
	const seen = new Set<string>();
	let out: Record<string, Uint8Array>;
	try {
		out = unzipSync(data, {
			filter(file) {
				count += 1;
				if (count > MAX_ZIP_ENTRIES) {
					throw new ZipError(`Das Archiv enthält zu viele Einträge (höchstens ${MAX_ZIP_ENTRIES})`);
				}
				if (!isSafeEntryName(file.name)) {
					throw new ZipError('Das Archiv enthält ungültige Pfade');
				}
				if (file.name.endsWith('/') || file.name.startsWith('__MACOSX/')) return false;
				if (opts.keep && !opts.keep(file.name)) return false;
				if (seen.has(file.name)) throw new ZipError('Das Archiv enthält doppelte Einträge');
				seen.add(file.name);
				if (file.originalSize > opts.maxFileBytes) {
					throw new ZipError('Das Archiv enthält eine zu große Datei');
				}
				total += file.originalSize;
				if (total > MAX_UNPACKED_BYTES) throw new ZipError('Das Archiv ist entpackt zu groß');
				return true;
			}
		});
	} catch (e) {
		if (e instanceof ZipError) throw e;
		throw new ZipError('Das Archiv ist beschädigt und kann nicht gelesen werden');
	}
	let actual = 0;
	const files = new Map<string, Uint8Array>();
	for (const [name, bytes] of Object.entries(out)) {
		actual += bytes.byteLength;
		if (actual > MAX_UNPACKED_BYTES) throw new ZipError('Das Archiv ist entpackt zu groß');
		if (bytes.byteLength > opts.maxFileBytes) {
			throw new ZipError('Das Archiv enthält eine zu große Datei');
		}
		files.set(name, bytes);
	}
	return files;
}
