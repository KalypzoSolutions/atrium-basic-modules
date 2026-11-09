/**
 * Große Notizen: Markdown-Tokenizer ohne quadratische Laufzeit, Ableiten/Verdichten nach Größe, gzip für `/state`,
 * JSON → Yjs ohne `prosemirrorJSONToYXmlFragment`.
 */
import { describe, expect, it } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { embedStart, tableStart } from '$modules/notes/doc/extensions';
import {
	compactThreshold,
	deriveDelayMs,
	jsonFromState,
	stateFromJson
} from '$modules/notes/doc.service';
import { parseMarkdown } from '$modules/notes/export/markdown';
import { acceptsGzip, stateResponse, STATE_GZIP_MIN_BYTES } from '$modules/notes/state-response';
import { COMPACT_AFTER_UPDATES, DERIVE_DELAY_MS } from '$modules/notes/schemas';

function bigMarkdown(sections: number): string {
	const parts: string[] = [];
	for (let i = 1; i <= sections; i++) {
		parts.push(`## Abschnitt ${i}`, '');
		for (let p = 0; p < 4; p++) parts.push(`Absatz ${p} in ${i}: Lorem ipsum **dolor** sit.`, '');
		if (i % 6 === 0) parts.push('| A | B |', '| --- | --- |', '| 1 | 2 |', '');
		if (i % 10 === 0) parts.push('- [ ] offen', '- [x] erledigt', '');
	}
	return parts.join('\n');
}

describe('notes-large: Markdown', () => {
	it('Tabellen-/Einbettungs-Start prüfen nur den Anfang bzw. den Block', () => {
		expect(tableStart('| a | b |\n| --- | --- |\n| 1 | 2 |')).toBe(0);
		expect(tableStart('Text\n| --- |')).toBe(-1);
		expect(tableStart('| a |\n---')).toBe(-1);
		expect(tableStart('nur eine Zeile')).toBe(-1);
		const embed = ':::embed {module="whiteboard" kind="board" refId="x"} :::';
		expect(embedStart(`Absatz\n${embed}\n\nRest`)).toBe(7);
		expect(embedStart(`Absatz\n\n${embed}`)).toBe(-1);
	});

	it('Tabellen und Aufgabenlisten bleiben erhalten', () => {
		const json = parseMarkdown(bigMarkdown(60)) as { content: { type: string }[] };
		const count = (t: string) => json.content.filter((c) => c.type === t).length;
		expect(count('table')).toBe(10);
		expect(count('taskList')).toBe(6);
		expect(count('heading')).toBe(60);
	});

	it('Laufzeit wächst etwa linear (früher quadratisch: 2400 Abschnitte ≈ 9 s)', () => {
		const time = (n: number) => {
			const md = bigMarkdown(n);
			const s = performance.now();
			parseMarkdown(md);
			return performance.now() - s;
		};
		time(200); // aufwärmen
		const small = time(600);
		const big = time(2400);
		expect(big).toBeLessThan(3000);
		// viermal so viel Text: deutlich weniger als die 16-fache Zeit einer quadratischen Laufzeit
		expect(big / Math.max(small, 5)).toBeLessThan(10);
	});
});

describe('notes-large: Ableiten und Verdichten', () => {
	it('Wartezeit wächst mit der Größe, höchstens 60 s', () => {
		expect(deriveDelayMs(0)).toBe(DERIVE_DELAY_MS);
		expect(deriveDelayMs(100 * 1024)).toBe(DERIVE_DELAY_MS);
		expect(deriveDelayMs(512 * 1024)).toBe(DERIVE_DELAY_MS + 10_000);
		expect(deriveDelayMs(50 * 1024 * 1024)).toBe(60_000);
		expect(deriveDelayMs(-5)).toBe(DERIVE_DELAY_MS);
	});

	it('Schwelle fürs Verdichten: kleine Notizen wie bisher, große später, höchstens 2000', () => {
		expect(compactThreshold(10_000)).toBe(COMPACT_AFTER_UPDATES);
		expect(compactThreshold(2 * 1024 * 1024)).toBe(512);
		expect(compactThreshold(20 * 1024 * 1024)).toBe(2000);
	});
});

describe('notes-large: JSON → Yjs', () => {
	it('Inhalt inkl. Nummerierungsart übersteht den Weg über Yjs', () => {
		const json = parseMarkdown(bigMarkdown(12));
		const doc = json as { content: Record<string, unknown>[] };
		doc.content.push({
			type: 'orderedList',
			attrs: { start: 1, type: null, listStyle: 'outline' },
			content: [
				{
					type: 'listItem',
					content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x' }] }]
				}
			]
		});
		const back = jsonFromState(stateFromJson(json)) as { content: Record<string, unknown>[] };
		expect(back.content.length).toBe(doc.content.length);
		expect((back.content.at(-1)!.attrs as Record<string, unknown>).listStyle).toBe('outline');
	});
});

describe('notes-large: /state mit gzip', () => {
	const req = (enc: string | null) =>
		new Request('http://x/state', { headers: enc ? { 'accept-encoding': enc } : {} });

	it('Accept-Encoding auswerten', () => {
		expect(acceptsGzip(req('gzip, deflate, br'))).toBe(true);
		expect(acceptsGzip(req('br'))).toBe(false);
		expect(acceptsGzip(req('gzip;q=0'))).toBe(false);
		expect(acceptsGzip(req(null))).toBe(false);
	});

	it('große Zustände komprimiert, kleine unverändert', async () => {
		const big = new Uint8Array(STATE_GZIP_MIN_BYTES * 2).fill(65);
		const res = await stateResponse(req('gzip'), big, { 'x-note-level': 'edit' });
		expect(res.headers.get('content-encoding')).toBe('gzip');
		expect(res.headers.get('x-note-level')).toBe('edit');
		expect(res.headers.get('cache-control')).toBe('no-store');
		const body = new Uint8Array(await res.arrayBuffer());
		expect(Number(res.headers.get('content-length'))).toBe(body.byteLength);
		expect(gunzipSync(body).equals(Buffer.from(big))).toBe(true);

		const small = new Uint8Array(100).fill(1);
		const plain = await stateResponse(req('gzip'), small, {});
		expect(plain.headers.get('content-encoding')).toBeNull();
		expect(new Uint8Array(await plain.arrayBuffer())).toEqual(small);

		const noGzip = await stateResponse(req(null), big, {});
		expect(noGzip.headers.get('content-encoding')).toBeNull();
	});
});
