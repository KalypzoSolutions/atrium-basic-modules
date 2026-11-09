/** Base64 im Browser ohne Node-Buffer (Yjs-Updates, State-Vectors, Awareness) */

export function toBase64(bytes: Uint8Array): string {
	let bin = '';
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
	}
	return btoa(bin);
}

export function fromBase64(text: string): Uint8Array {
	// auch base64url akzeptieren
	const normal = text.replace(/-/g, '+').replace(/_/g, '/');
	const bin = atob(normal);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}
