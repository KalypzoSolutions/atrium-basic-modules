import {
	expect,
	test,
	type APIRequestContext,
	type Browser,
	type BrowserContext,
	type Locator,
	type Page
} from '@playwright/test';
import { crc32, deflateSync } from 'node:zlib';
import { startS3Mock, type S3Mock } from '$testing/e2e';

// Dateien (Cloud-Ablage) mit S3-Ersatz – eine Ansicht „Dateien“: Ordner anlegen und navigieren, Upload
// per Drag & Drop und Dateiauswahl, Bild- und PDF-Vorschau, Kontextmenü per Rechtsklick (Umbenennen,
// „Neuer Ordner“ auf leerer Fläche), Verschieben per Drag & Drop, Papierkorb mit Rückgängig und
// Wiederherstellen, Freigabe „Mit dem ganzen Stamm teilen“ (zweite Person sieht den Ordner), öffentliche
// Links (URL jederzeit wieder sichtbar, mit Passwort) und Upload-Link ohne Login mit Namensangabe.
// Die E2E-Instanz hat kein S3 – die Spec stellt den Speicher vorübergehend auf einen lokalen Ersatz
// (`tests/helpers/s3-mock.ts`) um und setzt die Einstellungen danach zurück (andere Specs erwarten 503).

const ADMIN = { email: 'admin@example.test', password: 'e2e-admin-password-1' };
const ORIGIN = 'http://localhost:4173';
const API = '/api/v1/modules/files';
const DRAG_MIME = 'application/x-ep-files-nodes';
const run = Date.now().toString(36);

const ROOT = `E2E Ablage ${run}`;
const SUB = 'Unterordner';
const CTX_FOLDER = 'Per Rechtsklick';
const IMG1 = 'Bild-1.png';
const IMG2 = 'Bild-2.png';
const PDF_NAME = 'Elternbrief.pdf';
const TXT_NAME = 'Notizen.txt';
const TXT_RENAMED = 'Packliste.txt';
const LINK_PASSWORD = 'Zeltlager-2026';
const UPLOAD_1 = 'Gruppenfoto.png';
const UPLOAD_2 = 'Zeltplatz.png';
const UPLOADER = 'Oma Erna';

const MEMBER = {
	name: `Lena Stamm ${run}`,
	email: `lena-${run}@example.test`,
	password: 'e2e-lena-password-1'
};

const STORAGE_KEYS = {
	endpoint: 'core.storage.endpoint',
	region: 'core.storage.region',
	bucket: 'core.storage.bucket',
	accessKeyId: 'core.storage.accessKeyId',
	secretAccessKey: 'core.storage.secretAccessKey',
	forcePathStyle: 'core.storage.forcePathStyle'
} as const;
const SECRET_KEYS: string[] = [STORAGE_KEYS.accessKeyId, STORAGE_KEYS.secretAccessKey];

interface PublicSetting {
	key: string;
	secret: boolean;
	value: unknown;
	isSet: boolean;
}
interface FileNode {
	id: string;
	name: string;
	kind: 'folder' | 'file';
	contentType: string | null;
	own: boolean;
	owner: { id: string; name: string };
	uploadedByName: string | null;
	viaLink: boolean;
}
interface FolderListing {
	items: FileNode[];
}
interface NodeShares {
	shares: { type: string; id: string; level: string }[];
}

const PDF = Buffer.from(
	[
		'%PDF-1.4',
		'1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
		'2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
		'3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj',
		'4 0 obj<</Length 44>>stream',
		'BT /F1 24 Tf 72 760 Td (Elternbrief) Tj ET',
		'endstream endobj',
		'5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj',
		'trailer<</Root 1 0 R>>',
		'%%EOF'
	].join('\n')
);

/**
 * Einfarbiges PNG ohne `sharp` (Playwrights Modul-Lader verträgt sharp nicht): 320 × 240, RGB.
 * `color` als `#rrggbb`.
 */
function picture(color: string): Buffer {
	const [r, g, b] = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
	const width = 320;
	const height = 240;
	const row = Buffer.alloc(1 + width * 3);
	for (let x = 0; x < width; x++) row.set([r!, g!, b!], 1 + x * 3);
	const raw = Buffer.concat(Array.from({ length: height }, () => row));
	const chunk = (type: string, data: Buffer) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
		const crc = Buffer.alloc(4);
		crc.writeUInt32BE(crc32(body));
		return Buffer.concat([len, body, crc]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header.set([8, 2, 0, 0, 0], 8);
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', header),
		chunk('IDAT', deflateSync(raw)),
		chunk('IEND', Buffer.alloc(0))
	]);
}

// --- Hilfen ------------------------------------------------------------------------------

/**
 * Anmeldung über die Login-Seite (Form-Action, `auth.api.signInEmail`). Die Login-Sperre zählt nur
 * Fehlversuche – erfolgreiche Anmeldungen der Specs lösen sie nicht aus. Statt blind 15 s zu warten
 * (#75) wird eine Sperre gezielt erkannt und mit klarer Meldung gemeldet.
 */
async function login(page: Page, creds: { email: string; password: string } = ADMIN) {
	await page.goto('/login');
	await page.getByLabel('E-Mail').fill(creds.email);
	await page.getByLabel('Passwort').fill(creds.password);
	await page.getByRole('button', { name: 'Anmelden' }).click();
	const blocked = page.getByText(/Zu viele Versuche/);
	await expect
		.poll(
			async () =>
				!new URL(page.url()).pathname.startsWith('/login') ||
				((await blocked.isVisible()) ? 'gesperrt' : false),
			{ timeout: 10_000 }
		)
		.toBe(true);
}

async function call<T>(
	req: APIRequestContext,
	method: string,
	path: string,
	body?: unknown
): Promise<T> {
	const res = await req.fetch(`/api/v1${path}`, {
		method,
		headers: {
			origin: ORIGIN,
			...(body === undefined ? {} : { 'content-type': 'application/json' })
		},
		data: body === undefined ? undefined : JSON.stringify(body)
	});
	if (!res.ok()) throw new Error(`${method} ${path}: ${res.status()} ${await res.text()}`);
	const text = await res.text();
	return (text ? (JSON.parse(text) as { data: T }).data : null) as T;
}

const api = <T>(page: Page, method: string, path: string, body?: unknown) =>
	call<T>(page.request, method, path, body);

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Eintrag der Dateiliste (Raster/Liste): `aria-label` = „<Name>, <Art>“ */
function item(page: Page, name: string): Locator {
	return page.getByRole('option', { name: new RegExp(`^${escapeRe(name)},`) });
}

function toast(page: Page, text: string | RegExp): Locator {
	return page.locator('[data-sonner-toast]').filter({ hasText: text });
}

async function listing(page: Page, parent?: string): Promise<FileNode[]> {
	const qs = parent ? `?${new URLSearchParams({ parent }).toString()}` : '';
	return (await api<FolderListing>(page, 'GET', `/modules/files/nodes${qs}`)).items;
}

async function nodeByName(page: Page, name: string, parent?: string): Promise<FileNode> {
	const node = (await listing(page, parent)).find((n) => n.name === name);
	if (!node) throw new Error(`Knoten „${name}“ nicht gefunden`);
	return node;
}

async function openFolder(page: Page, id: string) {
	await page.goto(`/modules/files?folder=${id}`);
	await expect(page.getByRole('listbox', { name: 'Dateien und Ordner' })).toBeVisible();
}

/** Synthetisches `DataTransfer` mit Dateien (für Drop-Ereignisse) */
async function filesTransfer(page: Page, files: { name: string; type: string; bytes: Buffer }[]) {
	const list = files.map((f) => ({ name: f.name, type: f.type, b64: f.bytes.toString('base64') }));
	return page.evaluateHandle((entries) => {
		const d = new DataTransfer();
		for (const f of entries) {
			const bytes = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0));
			d.items.add(new File([bytes], f.name, { type: f.type }));
		}
		return d;
	}, list);
}

/**
 * Rechtsklick an einer festen Stelle von `target`; prüft, dass das Kontextmenü an der Mausposition
 * erscheint: waagerecht beginnt (oder endet, wenn es nach links klappt) es am Klickpunkt, senkrecht
 * überdeckt es die Höhe des Klickpunkts (am unteren Rand verschiebt es sich nach oben).
 */
async function rightClick(page: Page, target: Locator, position: { x: number; y: number }) {
	await target.click({ button: 'right', position });
	const menu = page.getByRole('menu');
	await expect(menu).toBeVisible();
	// Erst nach dem Klick messen: Playwright scrollt das Ziel dafür ggf. in den sichtbaren Bereich
	const box = await target.boundingBox();
	const m = await menu.boundingBox();
	if (!box || !m) throw new Error('Ziel oder Kontextmenü nicht sichtbar');
	const px = box.x + position.x;
	const py = box.y + position.y;
	const near = (a: number, b: number) => Math.abs(a - b) <= 40;
	expect(near(m.x, px) || near(m.x + m.width, px), 'Menü waagerecht am Mauszeiger').toBe(true);
	expect(m.y <= py + 40 && m.y + m.height >= py - 40, 'Menü senkrecht am Mauszeiger').toBe(true);
	return menu;
}

/** „…“-Menü eines Eintrags öffnen und einen Punkt wählen */
async function menuAction(page: Page, name: string, action: string) {
	await page.getByRole('button', { name: `Aktionen für ${name}` }).click();
	await page.getByRole('menuitem', { name: action }).click();
}

/** Link-Dialog eines Eintrags öffnen (wartet, bis die Liste geladen ist) */
async function openLinkDialog(page: Page, name: string): Promise<Locator> {
	await menuAction(page, name, 'Öffentlicher Link');
	const dialog = page.getByRole('dialog', { name: new RegExp(escapeRe(`„${name}“`)) });
	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole('heading', { name: /^Aktive Links \(\d+\)/ })).toBeVisible();
	return dialog;
}

async function linkUrls(dialog: Locator): Promise<string[]> {
	return dialog
		.locator('input[id^="files-link-url-"]')
		.evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value));
}

async function closeDialog(dialog: Locator) {
	await dialog.getByRole('button', { name: 'Schließen' }).last().click();
	await expect(dialog).toBeHidden();
}

/** Link anlegen und die neue URL aus der Liste zurückgeben */
async function createLink(
	page: Page,
	name: string,
	opts: { password?: string; mode?: RegExp } = {}
): Promise<string> {
	const dialog = await openLinkDialog(page, name);
	const before = await linkUrls(dialog);
	if (opts.mode) {
		const radio = dialog
			.getByRole('radiogroup', { name: 'Art des Links' })
			.getByRole('radio', { name: opts.mode });
		await radio.click();
		await expect(radio).toHaveAttribute('aria-checked', 'true');
	}
	if (opts.password) {
		await dialog.locator('#files-link-use-password').click();
		await dialog.locator('#files-link-password').fill(opts.password);
	}
	await dialog.getByRole('button', { name: 'Link erstellen' }).click();
	await expect(toast(page, 'Link erstellt')).toBeVisible();
	await expect(dialog.locator('input[id^="files-link-url-"]')).toHaveCount(before.length + 1);
	const url = (await linkUrls(dialog)).find((u) => !before.includes(u));
	expect(url).toMatch(/\/p\/files\/link\/[A-Za-z0-9_-]{20,}$/);
	await closeDialog(dialog);
	return url!;
}

async function guestPage(browser: Browser): Promise<{ guest: BrowserContext; pub: Page }> {
	const guest = await browser.newContext({ baseURL: ORIGIN });
	return { guest, pub: await guest.newPage() };
}

// --- Speicher umstellen und zurücksetzen --------------------------------------------------

let s3: S3Mock | undefined;
let context: BrowserContext | undefined;
/** Eine angemeldete Seite für alle Tests (Better Auth begrenzt Anmeldungen auf 10/min) */
let page: Page;
let original: PublicSetting[] = [];
let rootId = '';
let subId = '';

test.describe.serial('Dateien', () => {
	test.beforeAll(async ({ browser }) => {
		s3 = await startS3Mock();
		context = await browser.newContext({ baseURL: ORIGIN });
		page = await context.newPage();
		await login(page);
		const admin = page.request;

		const all = await call<PublicSetting[]>(admin, 'GET', '/settings?group=storage');
		const keys = Object.values(STORAGE_KEYS) as string[];
		original = all.filter((s) => keys.includes(s.key));

		// Der Ersatz prüft keine Signaturen: vorhandene Zugangsdaten bleiben, sonst Platzhalter
		const values: Record<string, unknown> = {
			[STORAGE_KEYS.endpoint]: s3.endpoint,
			[STORAGE_KEYS.region]: 'us-east-1',
			[STORAGE_KEYS.bucket]: 'e2e-files',
			[STORAGE_KEYS.forcePathStyle]: true
		};
		for (const key of SECRET_KEYS) {
			if (!original.find((s) => s.key === key)?.isSet) values[key] = `e2e-${key.split('.').pop()}`;
		}
		await call(admin, 'PUT', '/settings', { values });

		const modules = await call<{ manifest: { id: string }; enabled: boolean }[]>(
			admin,
			'GET',
			'/modules'
		);
		for (const id of ['files']) {
			if (!modules.find((m) => m.manifest.id === id)?.enabled) {
				await call(admin, 'POST', `/modules/${id}/enable`);
			}
		}
	});

	test.afterAll(async () => {
		try {
			if (context && original.length) {
				const values: Record<string, unknown> = {};
				for (const s of original) {
					// Secrets kommen nie zurück: nur löschen, was die Spec selbst gesetzt hat
					if (s.secret) {
						if (!s.isSet) values[s.key] = null;
					} else values[s.key] = s.value;
				}
				await call(page.request, 'PUT', '/settings', { values });
			}
		} finally {
			await context?.close();
			await s3?.close();
		}
	});

	test('Ordner anlegen, hineinnavigieren, Breadcrumbs zurück', async () => {
		await page.goto('/modules/files');
		await expect(page.getByRole('heading', { name: 'Dateien', exact: true })).toBeVisible();
		// Eine Ansicht: keine Reiter mehr, Papierkorb als Knopf im Seitenkopf
		await expect(page.getByRole('tab')).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Papierkorb', exact: true })).toBeVisible();

		// Wurzelordner über „Neuer Ordner“
		await page.getByRole('button', { name: 'Neuer Ordner' }).click();
		let dialog = page.getByRole('dialog');
		await dialog.getByLabel('Name *').fill(ROOT);
		await dialog.getByRole('button', { name: 'Anlegen' }).click();
		await expect(dialog).toBeHidden();
		await expect(toast(page, 'Ordner angelegt')).toBeVisible();
		await expect(item(page, ROOT)).toBeVisible();

		// Hineinnavigieren (Doppelklick)
		await item(page, ROOT).dblclick();
		await page.waitForURL(/[?&]folder=[0-9a-f-]{36}/);
		rootId = new URL(page.url()).searchParams.get('folder')!;
		const crumbs = page.getByRole('navigation', { name: 'Ordnerpfad' });
		await expect(crumbs.locator('[aria-current="page"]')).toHaveText(ROOT);
		await expect(page.getByText('Dieser Ordner ist leer')).toBeVisible();

		// Unterordner anlegen und öffnen
		await page.getByRole('button', { name: 'Neuer Ordner' }).click();
		dialog = page.getByRole('dialog');
		await dialog.getByLabel('Name *').fill(SUB);
		await dialog.getByRole('button', { name: 'Anlegen' }).click();
		await expect(dialog).toBeHidden();
		await item(page, SUB).dblclick();
		await expect(crumbs.locator('[aria-current="page"]')).toHaveText(SUB);
		subId = new URL(page.url()).searchParams.get('folder')!;
		expect(subId).not.toBe(rootId);

		// Breadcrumbs zurück: erst zum Wurzelordner, dann zu „Dateien“
		await crumbs.getByRole('button', { name: ROOT }).click();
		await expect(crumbs.locator('[aria-current="page"]')).toHaveText(ROOT);
		await expect(item(page, SUB)).toBeVisible();
		expect(new URL(page.url()).searchParams.get('folder')).toBe(rootId);

		await crumbs.getByRole('button', { name: 'Dateien' }).click();
		await expect(crumbs.locator('[aria-current="page"]')).toHaveText('Dateien');
		await expect(item(page, ROOT)).toBeVisible();
		expect(new URL(page.url()).searchParams.get('folder')).toBeNull();
	});

	test('Upload per Drag & Drop', async () => {
		await openFolder(page, rootId);

		const dt = await filesTransfer(page, [
			{ name: IMG1, type: 'image/png', bytes: picture('#2563eb') },
			{ name: IMG2, type: 'image/png', bytes: picture('#16a34a') }
		]);

		// Externe Dateien landen über das Listenelement in der Upload-Zone des aktuellen Ordners
		const target = page.getByRole('listbox', { name: 'Dateien und Ordner' });
		await target.dispatchEvent('dragenter', { dataTransfer: dt });
		await target.dispatchEvent('dragover', { dataTransfer: dt });
		await expect(page.getByText('Zum Hochladen loslassen')).toBeVisible();
		await target.dispatchEvent('drop', { dataTransfer: dt });

		await expect(toast(page, '2 Dateien hochgeladen')).toBeVisible({ timeout: 20_000 });
		await expect(item(page, IMG1)).toBeVisible();
		await expect(item(page, IMG2)).toBeVisible();
		expect(s3!.size()).toBeGreaterThanOrEqual(2);
	});

	test('Upload per Dateiauswahl', async () => {
		await openFolder(page, rootId);

		await page.getByRole('button', { name: 'Hochladen', exact: true }).click();
		const [chooser] = await Promise.all([
			page.waitForEvent('filechooser'),
			page.getByRole('menuitem', { name: 'Dateien' }).click()
		]);
		expect(chooser.isMultiple()).toBe(true);
		await chooser.setFiles([
			{ name: PDF_NAME, mimeType: 'application/pdf', buffer: PDF },
			{
				name: TXT_NAME,
				mimeType: 'text/plain',
				buffer: Buffer.from('Schlafsack\nIsomatte\nTaschenlampe\n')
			}
		]);

		await expect(toast(page, '2 Dateien hochgeladen')).toBeVisible({ timeout: 20_000 });
		await expect(item(page, PDF_NAME)).toBeVisible();
		await expect(item(page, TXT_NAME)).toBeVisible();
	});

	test('Bildvorschau mit Blättern und PDF-Vorschau', async () => {
		await openFolder(page, rootId);

		// Bild: Doppelklick öffnet die Vorschau, Pfeil rechts blättert zum nächsten Bild
		await item(page, IMG1).dblclick();
		const preview = page.getByRole('dialog');
		await expect(preview).toBeVisible();
		const img1 = preview.locator(`img[alt="${IMG1}"]`);
		await expect(img1).toBeVisible();
		await expect
			.poll(() => img1.evaluate((el) => (el as HTMLImageElement).naturalWidth))
			.toBeGreaterThan(0);
		await page.keyboard.press('ArrowRight');
		await expect(preview.locator(`img[alt="${IMG2}"]`)).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(preview).toBeHidden();

		// PDF: Headless-Chromium hat keinen PDF-Viewer → iframe oder Ausweichkarte
		await item(page, PDF_NAME).dblclick();
		await expect(preview).toBeVisible();
		await expect(
			preview.locator('iframe').or(preview.getByRole('link', { name: 'In neuem Tab öffnen' }))
		).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(preview).toBeHidden();

		// Inhalt kommt als PDF aus dem Speicher
		const pdf = await nodeByName(page, PDF_NAME, rootId);
		const res = await page.request.get(`${API}/nodes/${pdf.id}/content`);
		expect(res.status()).toBe(200);
		expect(res.headers()['content-type']).toContain('application/pdf');
		expect((await res.body()).subarray(0, 5).toString()).toBe('%PDF-');
	});

	test('Rechtsklick: Umbenennen und „Neuer Ordner“ auf leerer Fläche', async () => {
		await openFolder(page, rootId);

		// Rechtsklick auf eine Datei → Kontextmenü an der Mausposition → Umbenennen
		let menu = await rightClick(page, item(page, TXT_NAME), { x: 60, y: 40 });
		await expect(menu.getByRole('menuitem', { name: 'Herunterladen' })).toBeVisible();
		await menu.getByRole('menuitem', { name: 'Umbenennen' }).click();
		await expect(menu).toBeHidden();
		let dialog = page.getByRole('dialog', { name: 'Datei umbenennen' });
		await expect(dialog).toBeVisible();
		await expect(dialog.getByLabel('Name *')).toHaveValue(TXT_NAME);
		await dialog.getByLabel('Name *').fill(TXT_RENAMED);
		await dialog.getByRole('button', { name: 'Umbenennen' }).click();
		await expect(dialog).toBeHidden();
		await expect(toast(page, 'Umbenannt')).toBeVisible();
		await expect(item(page, TXT_RENAMED)).toBeVisible();
		await expect(item(page, TXT_NAME)).toHaveCount(0);

		// Rechtsklick auf die leere Fläche unter der Liste → „Neuer Ordner“
		const area = page.getByRole('listbox', { name: 'Dateien und Ordner' }).locator('..');
		const box = await area.boundingBox();
		if (!box) throw new Error('Fläche der Dateiliste nicht sichtbar');
		menu = await rightClick(page, area, { x: 8, y: box.height - 8 });
		await expect(menu.getByRole('menuitem', { name: 'Dateien hochladen' })).toBeVisible();
		await expect(menu.getByRole('menuitem', { name: 'Umbenennen' })).toHaveCount(0);
		await menu.getByRole('menuitem', { name: 'Neuer Ordner' }).click();
		dialog = page.getByRole('dialog', { name: 'Neuer Ordner' });
		await expect(dialog).toBeVisible();
		await dialog.getByLabel('Name *').fill(CTX_FOLDER);
		await dialog.getByRole('button', { name: 'Anlegen' }).click();
		await expect(dialog).toBeHidden();
		await expect(toast(page, 'Ordner angelegt')).toBeVisible();
		await expect(item(page, CTX_FOLDER)).toBeVisible();
		expect((await listing(page, rootId)).map((n) => n.name)).toContain(CTX_FOLDER);
	});

	test('Verschieben per Drag & Drop', async () => {
		await openFolder(page, rootId);
		const img2 = await nodeByName(page, IMG2, rootId);

		const source = item(page, IMG2);
		const target = item(page, SUB);
		await expect(source).toBeVisible();
		// HTML5-DnD mit eigenem DataTransfer: dragstart setzt die IDs (DRAG_MIME), drop liest sie
		const dt = await page.evaluateHandle(
			({ mime, ids }) => {
				const d = new DataTransfer();
				d.setData(mime, JSON.stringify(ids));
				return d;
			},
			{ mime: DRAG_MIME, ids: [img2.id] }
		);
		await source.dispatchEvent('dragstart', { dataTransfer: dt });
		await target.dispatchEvent('dragenter', { dataTransfer: dt });
		await target.dispatchEvent('dragover', { dataTransfer: dt });
		await target.dispatchEvent('drop', { dataTransfer: dt });

		await expect(toast(page, `Nach „${SUB}“ verschoben`)).toBeVisible();
		await expect(item(page, IMG2)).toBeHidden();
		expect((await listing(page, subId)).map((n) => n.name)).toContain(IMG2);
		expect((await listing(page, rootId)).map((n) => n.name)).not.toContain(IMG2);
	});

	test('Papierkorb: Rückgängig und Wiederherstellen', async () => {
		await openFolder(page, rootId);

		const trash = async () => {
			await menuAction(page, TXT_RENAMED, 'In den Papierkorb');
			const confirm = page.getByRole('alertdialog');
			await expect(confirm).toContainText(`„${TXT_RENAMED}“ in den Papierkorb?`);
			await confirm.getByRole('button', { name: 'In den Papierkorb' }).click();
			await expect(confirm).toBeHidden();
			await expect(toast(page, `„${TXT_RENAMED}“ liegt im Papierkorb`)).toBeVisible();
			await expect(item(page, TXT_RENAMED)).toBeHidden();
		};

		// Löschen + Rückgängig im Toast
		await trash();
		await toast(page, `„${TXT_RENAMED}“ liegt im Papierkorb`)
			.getByRole('button', { name: 'Rückgängig' })
			.click();
		await expect(toast(page, 'Wiederhergestellt')).toBeVisible();
		await expect(item(page, TXT_RENAMED)).toBeVisible();

		// Erneut löschen, über den Knopf „Papierkorb“ wiederherstellen
		await trash();
		await page.getByRole('button', { name: 'Papierkorb', exact: true }).click();
		await expect(page).toHaveURL(/view=trash/);
		await expect(page.getByRole('heading', { name: 'Papierkorb', exact: true })).toBeVisible();
		const restore = page.getByRole('button', { name: `${TXT_RENAMED} wiederherstellen` });
		await expect(restore).toBeVisible();
		await expect(page.getByText(new RegExp(escapeRe(ROOT))).first()).toBeVisible();
		await restore.click();
		await expect(restore).toBeHidden();

		// Zurück zu „Dateien“ über den Knopf im Seitenkopf
		await page.getByRole('button', { name: 'Zurück zu Dateien' }).click();
		await expect(page).not.toHaveURL(/view=trash/);
		await expect(item(page, ROOT)).toBeVisible();

		await openFolder(page, rootId);
		await expect(item(page, TXT_RENAMED)).toBeVisible();
	});

	test('Mit dem ganzen Stamm teilen: zweite Person sieht den Ordner', async ({ browser }) => {
		// Eine zusätzliche Anmeldung; bei Login-Sperre (10/min) wartet `login` und versucht es erneut
		test.setTimeout(120_000);

		// Zweite Person mit Grundrecht der Ablage (über eine eigene Rolle)
		const role = await api<{ id: string }>(page, 'POST', '/roles', {
			name: `E2E Dateien ${run}`,
			permissions: ['files.file.view']
		});
		await api(page, 'POST', '/users', { ...MEMBER, roleIds: [role.id] });

		await page.goto('/modules/files');
		await expect(item(page, ROOT)).toBeVisible();
		await menuAction(page, ROOT, 'Freigeben');
		const dialog = page.getByRole('dialog', { name: new RegExp(escapeRe(`„${ROOT}“ freigeben`)) });
		await expect(dialog).toBeVisible();
		const stamm = dialog.getByRole('switch', { name: 'Mit dem ganzen Stamm teilen' });
		await expect(stamm).toBeEnabled();
		await expect(stamm).not.toBeChecked();
		await stamm.click();
		await expect(toast(page, 'Freigabe gespeichert')).toBeVisible();
		await expect(stamm).toBeChecked();
		await closeDialog(dialog);

		const shares = await api<NodeShares>(page, 'GET', `/modules/files/nodes/${rootId}/shares`);
		expect(shares.shares).toContainEqual(
			expect.objectContaining({ type: 'everyone', id: '*', level: 'read' })
		);
		await expect(item(page, ROOT)).toContainText('Mit dem ganzen Stamm geteilt');
		const ownerName = (await nodeByName(page, ROOT)).owner.name;

		// Zweite Person in eigenem Browser-Context: Ordner liegt direkt unter „Dateien“ mit „von …“
		const other = await browser.newContext({ baseURL: ORIGIN });
		try {
			const p2 = await other.newPage();
			await login(p2, MEMBER);
			await p2.goto('/modules/files');
			await expect(p2.getByRole('heading', { name: 'Dateien', exact: true })).toBeVisible();
			const shared = item(p2, ROOT);
			await expect(shared).toBeVisible();
			await expect(shared).toContainText(`von ${ownerName}`);

			const mine = await listing(p2);
			const entry = mine.find((n) => n.id === rootId);
			expect(entry?.own).toBe(false);
			expect(entry?.owner.name).toBe(ownerName);

			// Hinein: Inhalt sichtbar, aber nur lesend (kein „Neuer Ordner“)
			await shared.dblclick();
			await p2.waitForURL(new RegExp(`[?&]folder=${rootId}`));
			await expect(item(p2, SUB)).toBeVisible();
			await expect(item(p2, IMG1)).toBeVisible();
			await expect(p2.getByRole('button', { name: 'Neuer Ordner' })).toHaveCount(0);
		} finally {
			await other.close();
		}
	});

	test('Öffentlicher Link: URL jederzeit sichtbar, ohne Login, auch mit Passwort', async ({
		browser
	}) => {
		await page.goto('/modules/files');
		await expect(item(page, ROOT)).toBeVisible();

		const openUrl = await createLink(page, ROOT);

		// Dialog erneut öffnen: dieselbe URL steht weiterhin in der Liste
		const again = await openLinkDialog(page, ROOT);
		await expect.poll(() => linkUrls(again)).toContain(openUrl);
		await closeDialog(again);

		const lockedUrl = await createLink(page, ROOT, { password: LINK_PASSWORD });
		expect(lockedUrl).not.toBe(openUrl);

		// Neuer Context ohne Anmeldung
		const { guest, pub } = await guestPage(browser);
		try {
			await pub.goto(openUrl);
			await expect(pub).toHaveURL(/\/p\/files\/link\//);
			await expect(pub.getByRole('heading', { name: ROOT })).toBeVisible();
			await expect(pub.getByRole('button', { name: `Ordner ${SUB} öffnen` })).toBeVisible();
			await expect(pub.getByRole('button', { name: `${PDF_NAME} ansehen` })).toBeVisible();
			// „Ansehen“ bietet keinen Upload an
			await expect(pub.locator('#uploader-name')).toHaveCount(0);
			await pub.getByRole('button', { name: `${IMG1} ansehen` }).click();
			const preview = pub.getByRole('dialog');
			await expect(preview).toBeVisible();
			const img = preview.locator(`img[alt="${IMG1}"]`);
			await expect(img).toBeVisible();
			await expect
				.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth))
				.toBeGreaterThan(0);
			await pub.keyboard.press('Escape');

			// Unterordner im öffentlichen Link
			await pub.getByRole('button', { name: `Ordner ${SUB} öffnen` }).click();
			await expect(pub.getByRole('heading', { name: SUB })).toBeVisible();
			await expect(pub.getByRole('button', { name: `${IMG2} ansehen` })).toBeVisible();

			// Passwort-Link: erst Formular, falsches Passwort → Meldung, richtiges → Inhalt
			await pub.goto(lockedUrl);
			await expect(pub.getByText('ist mit einem Passwort geschützt')).toBeVisible();
			await expect(pub.getByRole('button', { name: `${IMG1} ansehen` })).toBeHidden();
			await pub.locator('#link-password').fill('falsches-passwort');
			await pub.getByRole('button', { name: 'Öffnen', exact: true }).click();
			await expect(pub.getByText('Das Passwort ist falsch.')).toBeVisible();
			await pub.locator('#link-password').fill(LINK_PASSWORD);
			await pub.getByRole('button', { name: 'Öffnen', exact: true }).click();
			await expect(pub.getByRole('heading', { name: ROOT })).toBeVisible();
			await expect(pub.getByRole('button', { name: `${IMG1} ansehen` })).toBeVisible();
		} finally {
			await guest.close();
		}
	});

	test('Upload-Link ohne Login: Inhalt verborgen, Datei mit Namen landet im Ordner', async ({
		browser
	}) => {
		await openFolder(page, rootId);
		const uploadUrl = await createLink(page, SUB, { mode: /^Hochladen/ });

		const { guest, pub } = await guestPage(browser);
		try {
			await pub.goto(uploadUrl);
			await expect(
				pub.getByRole('heading', { name: `Dateien hochladen in „${SUB}“` })
			).toBeVisible();
			// „Hochladen“ zeigt keinen Inhalt des Ordners
			await expect(pub.getByRole('button', { name: `${IMG2} ansehen` })).toHaveCount(0);
			await expect(pub.getByText(IMG2)).toHaveCount(0);

			// Name angeben, Datei über die Auswahl hochladen
			await pub.locator('#uploader-name').fill(UPLOADER);
			await pub.locator('input[type="file"]').setInputFiles({
				name: UPLOAD_1,
				mimeType: 'image/png',
				buffer: picture('#ea580c')
			});
			await expect(pub.getByText('Danke! 1 Datei hochgeladen')).toBeVisible({ timeout: 20_000 });
			await expect(pub.getByRole('status').filter({ hasText: 'Danke!' })).toContainText(UPLOAD_1);
			// Auch nach dem Upload kein Ordnerinhalt
			await expect(pub.getByText(IMG2)).toHaveCount(0);

			// Weitere Datei per Drag & Drop (der Name bleibt erhalten)
			await pub.getByRole('button', { name: 'Weitere Dateien hochladen' }).click();
			await expect(pub.locator('#uploader-name')).toHaveValue(UPLOADER);
			const zone = pub.getByRole('button', { name: /Dateien auswählen/ });
			const dt = await filesTransfer(pub, [
				{ name: UPLOAD_2, type: 'image/png', bytes: picture('#9333ea') }
			]);
			// Element festhalten: während des Ziehens ändert sich der zugängliche Name der Fläche (Overlay-Text)
			const zoneEl = await zone.elementHandle();
			await zoneEl!.dispatchEvent('dragenter', { dataTransfer: dt });
			await zoneEl!.dispatchEvent('dragover', { dataTransfer: dt });
			await zoneEl!.dispatchEvent('drop', { dataTransfer: dt });
			await expect(pub.getByText('Danke! 1 Datei hochgeladen')).toBeVisible({ timeout: 20_000 });
			await expect(pub.getByRole('status').filter({ hasText: 'Danke!' })).toContainText(UPLOAD_2);
		} finally {
			await guest.close();
		}

		// Zurück als Eigentümer*in: beide Dateien im Ordner, Details zeigen den Namen
		const files = await listing(page, subId);
		for (const name of [UPLOAD_1, UPLOAD_2]) {
			const f = files.find((n) => n.name === name);
			expect(f, name).toBeDefined();
			expect(f!.viaLink).toBe(true);
			expect(f!.uploadedByName).toBe(UPLOADER);
			expect(f!.own).toBe(true);
		}

		await openFolder(page, subId);
		await expect(item(page, UPLOAD_1)).toBeVisible();
		await expect(item(page, UPLOAD_2)).toBeVisible();
		const menu = await rightClick(page, item(page, UPLOAD_1), { x: 60, y: 40 });
		await menu.getByRole('menuitem', { name: 'Details' }).click();
		const details = page.getByRole('dialog', { name: 'Details' });
		await expect(details).toBeVisible();
		await expect(details).toContainText(UPLOAD_1);
		await expect(details).toContainText(`von „${UPLOADER}“`);
		await closeDialog(details);
	});
});
