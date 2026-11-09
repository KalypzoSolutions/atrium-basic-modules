/** Zod-Eingaben des Moduls `files` (`schemas.ts`). */
import { describe, expect, it } from 'vitest';
import {
	bulkInput,
	folderCreateInput,
	LINK_MODE_LABELS,
	LINK_MODES,
	linkCanUpload,
	linkCanView,
	linkCreateInput,
	listQuery,
	MAX_UPLOADER_NAME,
	publicUploadFields,
	MAX_BULK,
	MAX_NAME,
	MAX_PASSWORD,
	MAX_SHARES,
	MIN_PASSWORD,
	moveInput,
	nodeName,
	sharesInput
} from '$modules/files/schemas';

const ok = (s: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) =>
	expect(s.safeParse(v).success).toBe(true);
const bad = (s: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) =>
	expect(s.safeParse(v).success).toBe(false);
const ids = (n: number) => Array.from({ length: n }, () => crypto.randomUUID());

describe('nodeName', () => {
	it('erlaubt normale Namen, Umlaute, ß und Emoji', () => {
		ok(nodeName, 'Bericht.pdf');
		ok(nodeName, 'Übung für Größe ß.txt');
		ok(nodeName, 'Zeltlager ' + String.fromCodePoint(0x1f3d5) + '.jpg');
		ok(nodeName, '.gitignore');
		ok(nodeName, '...');
	});

	it('trimmt', () => {
		expect(nodeName.parse('  a.txt  ')).toBe('a.txt');
	});

	it('leer, „.“ und „..“ abgelehnt', () => {
		bad(nodeName, '');
		bad(nodeName, '   ');
		bad(nodeName, '.');
		bad(nodeName, ' .. ');
	});

	it('Länge', () => {
		ok(nodeName, 'a'.repeat(MAX_NAME));
		bad(nodeName, 'a'.repeat(MAX_NAME + 1));
	});

	it('Pfadtrenner abgelehnt', () => {
		bad(nodeName, 'a/b');
		bad(nodeName, 'a\\b');
	});

	it('Steuerzeichen abgelehnt', () => {
		for (const cp of [0x00, 0x09, 0x0a, 0x1f, 0x7f]) {
			bad(nodeName, 'a' + String.fromCodePoint(cp) + 'b');
		}
	});

	it('unsichtbare/Bidi-Zeichen abgelehnt', () => {
		for (const cp of [0x200b, 0x200e, 0x200f, 0x202a, 0x202e, 0x2066, 0x2069, 0xfeff]) {
			bad(nodeName, 'rechnung' + String.fromCodePoint(cp) + 'fdp.exe');
		}
	});
});

describe('linkCreateInput', () => {
	it('null/null erlaubt', () => {
		ok(linkCreateInput, { expiresOn: null, password: null });
	});

	it('Passwortlänge', () => {
		bad(linkCreateInput, { expiresOn: null, password: 'x'.repeat(MIN_PASSWORD - 1) });
		ok(linkCreateInput, { expiresOn: null, password: 'x'.repeat(MIN_PASSWORD) });
		ok(linkCreateInput, { expiresOn: null, password: 'x'.repeat(MAX_PASSWORD) });
		bad(linkCreateInput, { expiresOn: null, password: 'x'.repeat(MAX_PASSWORD + 1) });
	});

	it('Datumsformat', () => {
		ok(linkCreateInput, { expiresOn: '2026-12-31', password: null });
		bad(linkCreateInput, { expiresOn: '31.12.2026', password: null });
		bad(linkCreateInput, { expiresOn: '2026-1-5', password: null });
		bad(linkCreateInput, { expiresOn: '2026-12-31T00:00', password: null });
		bad(linkCreateInput, { expiresOn: '', password: null });
		// echtes Kalenderdatum (#72, 06-13)
		bad(linkCreateInput, { expiresOn: '2026-02-31', password: null });
		bad(linkCreateInput, { expiresOn: '2026-13-01', password: null });
		ok(linkCreateInput, { expiresOn: '2028-02-29', password: null });
	});

	it('Felder sind Pflicht, keine Zusatzfelder', () => {
		bad(linkCreateInput, {});
		bad(linkCreateInput, { expiresOn: null, password: null, extra: 1 });
	});
});

describe('sharesInput', () => {
	const share = (id: string, type = 'user', level = 'read') => ({ type, id, level });

	it('gültige Liste', () => {
		ok(sharesInput, { shares: [] });
		ok(sharesInput, { shares: [share('u1'), share('*', 'everyone'), share('u1', 'role', 'edit')] });
	});

	it('Duplikate → Fehler am Pfad shares.1.id', () => {
		const r = sharesInput.safeParse({ shares: [share('u1'), share('u1', 'user', 'edit')] });
		expect(r.success).toBe(false);
		expect(r.error!.issues.map((i) => i.path.join('.'))).toEqual(['shares.1.id']);
	});

	it('ungültige Stufe, Typ oder ID', () => {
		bad(sharesInput, { shares: [share('u1', 'user', 'admin')] });
		bad(sharesInput, { shares: [share('u1', 'unbekannt')] });
		bad(sharesInput, { shares: [share('a b')] });
		bad(sharesInput, { shares: [share('')] });
	});

	it('Obergrenze MAX_SHARES', () => {
		const list = (n: number) => Array.from({ length: n }, (_, i) => share(`u${i}`));
		ok(sharesInput, { shares: list(MAX_SHARES) });
		bad(sharesInput, { shares: list(MAX_SHARES + 1) });
	});
});

describe('folderCreateInput / listQuery', () => {
	it('ohne `space`; `parentId` Pflicht (null = eigene Wurzel)', () => {
		ok(folderCreateInput, { parentId: null, name: 'Fotos' });
		ok(folderCreateInput, { parentId: crypto.randomUUID(), name: 'Fotos' });
		bad(folderCreateInput, { name: 'Fotos' });
		bad(folderCreateInput, { parentId: null, name: 'Fotos', space: 'shared' });
	});

	it('listQuery ignoriert `space`', () => {
		const r = listQuery.safeParse({ space: 'shared' });
		expect(r.success).toBe(true);
		expect(r.data).toEqual({});
	});
});

describe('Link-Arten', () => {
	it('LINK_MODES, Labels, Standard `view`', () => {
		expect([...LINK_MODES]).toEqual(['view', 'upload', 'view-upload']);
		for (const m of LINK_MODES) expect(LINK_MODE_LABELS[m]).toBeTruthy();
		expect(linkCreateInput.parse({ expiresOn: null, password: null }).mode).toBe('view');
		ok(linkCreateInput, { expiresOn: null, password: null, mode: 'upload' });
		ok(linkCreateInput, { expiresOn: null, password: null, mode: 'view-upload' });
		bad(linkCreateInput, { expiresOn: null, password: null, mode: 'edit' });
	});

	it('linkCanView / linkCanUpload', () => {
		expect(LINK_MODES.map(linkCanView)).toEqual([true, false, true]);
		expect(LINK_MODES.map(linkCanUpload)).toEqual([false, true, true]);
	});

	it('publicUploadFields: Name optional, ≤ MAX_UPLOADER_NAME, strikt', () => {
		ok(publicUploadFields, {});
		ok(publicUploadFields, { name: 'x'.repeat(MAX_UPLOADER_NAME) });
		ok(publicUploadFields, { name: `  ${'x'.repeat(MAX_UPLOADER_NAME)}  ` });
		bad(publicUploadFields, { name: 'x'.repeat(MAX_UPLOADER_NAME + 1) });
		ok(publicUploadFields, { t: 'abc' });
		bad(publicUploadFields, { t: 'x'.repeat(501) });
		bad(publicUploadFields, { relativePath: 'a/b' });
	});
});

describe('moveInput / bulkInput', () => {
	it('moveInput Grenzen', () => {
		bad(moveInput, { ids: [], targetId: null });
		ok(moveInput, { ids: ids(1), targetId: null });
		ok(moveInput, { ids: ids(MAX_BULK), targetId: crypto.randomUUID() });
		bad(moveInput, { ids: ids(MAX_BULK + 1), targetId: null });
	});

	it('moveInput Felder (ohne `space` seit 0003)', () => {
		bad(moveInput, { ids: ['keine-uuid'], targetId: null });
		bad(moveInput, { ids: ids(1), targetId: 'root' });
		bad(moveInput, { ids: ids(1) });
		bad(moveInput, { ids: ids(1), targetId: null, x: 1 });
		// `space` ist kein Feld mehr (strikt)
		bad(moveInput, { ids: ids(1), targetId: null, space: 'personal' });
	});

	it('bulkInput Grenzen', () => {
		bad(bulkInput, { ids: [] });
		ok(bulkInput, { ids: ids(MAX_BULK) });
		bad(bulkInput, { ids: ids(MAX_BULK + 1) });
		bad(bulkInput, { ids: ids(1), extra: true });
	});
});
