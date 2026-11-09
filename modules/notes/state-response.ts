/**
 * Antwort für `GET …/state` (intern und über öffentliche Links): Yjs-Zustand als Binärdaten, ab 32 KB gzip-komprimiert,
 * wenn der Browser es annimmt. Yjs-Zustände bestehen größtenteils aus Text und schrumpfen etwa auf ein Viertel –
 * große Notizen laden dadurch spürbar schneller (die App selbst komprimiert nicht; ein Proxy davor ggf. schon).
 */
import { promisify } from 'node:util';
import { gzip as gzipCb } from 'node:zlib';

const gzip = promisify(gzipCb);

/** Ab dieser Größe lohnt das Komprimieren */
export const STATE_GZIP_MIN_BYTES = 32 * 1024;

export function acceptsGzip(request: Request | undefined): boolean {
	const header = request?.headers.get('accept-encoding') ?? '';
	return /\bgzip\b/i.test(header) && !/\bgzip\s*;\s*q=0(?:\.0*)?\b/i.test(header);
}

export async function stateResponse(
	request: Request | undefined,
	update: Uint8Array,
	headers: Record<string, string>
): Promise<Response> {
	const base: Record<string, string> = {
		'content-type': 'application/octet-stream',
		'cache-control': 'no-store',
		vary: 'accept-encoding',
		...headers
	};
	if (update.byteLength >= STATE_GZIP_MIN_BYTES && acceptsGzip(request)) {
		const body = new Uint8Array(await gzip(update, { level: 6 }));
		return new Response(body, {
			status: 200,
			headers: { ...base, 'content-encoding': 'gzip', 'content-length': String(body.byteLength) }
		});
	}
	return new Response(new Uint8Array(update), {
		status: 200,
		headers: { ...base, 'content-length': String(update.byteLength) }
	});
}
