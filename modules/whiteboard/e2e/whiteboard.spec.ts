import { expect, test, type Browser, type Page } from '@playwright/test';

// Whiteboards: anlegen, Notiz per Taste + Klick und Tippen, zweiter Browser sieht es live, Verbinder per
// Werkzeug zwischen zwei Notizen, Neuladen behält alles, Zwei-Finger-Zoom (Touch), PNG-/PDF-Export.
// Whiteboard aus der Aktions-Übersicht: ep-intern-modules/_integration/e2e/whiteboard-actions.spec.ts. Bild-/Datei-Upload prüft der Integrationstest (Fake-Speicher).

const ADMIN = { email: 'admin@example.test', password: 'e2e-admin-password-1' };
const ORIGIN = 'http://localhost:4173';
const run = Date.now().toString(36);
const boardName = `Programmideen ${run}`;

async function login(page: Page) {
	await page.goto('/login');
	await page.getByLabel('E-Mail').fill(ADMIN.email);
	await page.getByLabel('Passwort').fill(ADMIN.password);
	await page.getByRole('button', { name: 'Anmelden' }).click();
	await page.waitForURL(/\/dashboard/);
}

async function api<T>(page: Page, method: string, path: string, body?: unknown): Promise<T> {
	const res = await page.request.fetch(`/api/v1${path}`, {
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

async function ensureModules(page: Page, ids: string[]) {
	const list = await api<{ manifest: { id: string }; enabled: boolean }[]>(page, 'GET', '/modules');
	for (const id of ids) {
		if (!list.find((m) => m.manifest.id === id)?.enabled) {
			await api(page, 'POST', `/modules/${id}/enable`);
		}
	}
}

/** Weitere angemeldete Seite (eigener Browser-Kontext = eigene Live-Verbindung) */
async function secondPage(
	browser: Browser,
	url: string,
	opts: Parameters<Browser['newContext']>[0] = {}
) {
	const ctx = await browser.newContext({ baseURL: ORIGIN, ...opts });
	const page = await ctx.newPage();
	await login(page);
	await page.goto(url);
	await expect(page.locator('svg[role="application"]')).toBeVisible();
	return page;
}

const canvas = (page: Page) => page.locator('svg[role="application"]');
const elementWith = (page: Page, text: string) =>
	canvas(page).locator('g[data-el]', { hasText: text });

test.describe.configure({ mode: 'serial' });

let boardUrl = '';

test('Whiteboard anlegen, Notizen live, verbinden, neu laden', async ({ page, browser }) => {
	await login(page);
	await ensureModules(page, ['tasks', 'whiteboard']);
	await page.goto('/modules/whiteboard');
	await page.getByRole('button', { name: 'Neues Whiteboard' }).first().click();
	const dialog = page.getByRole('dialog');
	await dialog.getByLabel('Name').fill(boardName);
	await dialog.getByRole('button', { name: 'Anlegen' }).click();
	await page.waitForURL(/\/modules\/whiteboard\/[0-9a-f-]{36}/);
	boardUrl = new URL(page.url()).pathname;
	await expect(page.getByRole('heading', { name: boardName })).toBeVisible();
	await expect(page.getByRole('status').filter({ hasText: 'Live' })).toBeAttached();

	const other = await secondPage(browser, boardUrl);
	const box = (await canvas(page).boundingBox())!;

	// Notiz 1: Taste N, Klick, tippen
	await canvas(page).focus();
	await page.keyboard.press('n');
	await page.mouse.click(box.x + 300, box.y + 300);
	await expect(page.getByLabel('Text bearbeiten')).toBeFocused();
	await page.keyboard.type('Lagerfeuer');
	await page.keyboard.press('Escape');
	await expect(elementWith(other, 'Lagerfeuer')).toBeVisible();

	// Notiz 2 über die Werkzeugleiste
	await page.getByRole('button', { name: 'Notizzettel (N)' }).click();
	await page.mouse.click(box.x + 700, box.y + 300);
	await page.keyboard.type('Stockbrot');
	await page.keyboard.press('Escape');
	await expect(elementWith(other, 'Stockbrot')).toBeVisible();

	// Verbinder von Notiz 1 zu Notiz 2
	await page.keyboard.press('l');
	const a = (await elementWith(page, 'Lagerfeuer').boundingBox())!;
	const b = (await elementWith(page, 'Stockbrot').boundingBox())!;
	await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
	await page.mouse.down();
	await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 10 });
	await page.mouse.up();
	await expect(canvas(other).locator('g[data-el]')).toHaveCount(3);

	// Rückgängig entfernt den Verbinder – auch beim anderen; Wiederholen holt ihn zurück
	await page.keyboard.press('Control+z');
	await expect(canvas(other).locator('g[data-el]')).toHaveCount(2);
	await page.keyboard.press('Control+y');
	await expect(canvas(other).locator('g[data-el]')).toHaveCount(3);

	// Neu laden: alles gespeichert
	await expect(page.getByRole('status').filter({ hasText: 'Speichert' })).toHaveCount(0);
	await page.reload();
	await expect(elementWith(page, 'Lagerfeuer')).toBeVisible();
	await expect(canvas(page).locator('g[data-el]')).toHaveCount(3);
	await other.context().close();
});

test('Notizen schnell: Farbe vorab, Tab, „+“, Antippen, Text-Menü, wachsendes Textfeld', async ({
	page
}) => {
	await login(page);
	await page.goto(boardUrl);
	await expect(canvas(page).locator('g[data-el]').first()).toBeVisible();
	const box = (await canvas(page).boundingBox())!;
	const before = await canvas(page).locator('g[data-el]').count();

	await page.getByRole('button', { name: 'Notizzettel (N)' }).click();
	await page.getByRole('button', { name: 'Notizfarbe #bbdefb' }).click();
	await page.mouse.click(box.x + 250, box.y + box.height - 220);
	await page.keyboard.type('Wanderung');
	// Tab: nächste Notiz rechts daneben, gleich weiterschreiben
	await page.keyboard.press('Tab');
	await page.keyboard.type('Picknick');
	await page.keyboard.press('Escape');
	await expect(elementWith(page, 'Picknick').locator('path').nth(1)).toHaveAttribute(
		'fill',
		'#bbdefb'
	);

	// „+“ unten: neue Notiz mit Pfeil
	await canvas(page).locator('[data-handle="link-bottom"]').click();
	await page.keyboard.type('Baden');
	await page.keyboard.press('Escape');
	await expect(canvas(page).locator('g[data-el]')).toHaveCount(before + 4);

	// Antippen der ausgewählten Notiz öffnet die Eingabe
	const baden = (await elementWith(page, 'Baden').boundingBox())!;
	await page.mouse.click(baden.x + 15, baden.y + 15);
	await expect(page.getByLabel('Text bearbeiten')).toBeFocused();
	await page.keyboard.press('Escape');

	// Text-Menü: Handschrift
	await page.getByRole('button', { name: 'Text einstellen' }).click();
	await page.getByRole('button', { name: 'Handschrift' }).click();
	await page.keyboard.press('Escape');
	await expect(elementWith(page, 'Baden').locator('text')).toHaveAttribute(
		'font-family',
		/cursive/
	);

	// Textfeld wächst beim Tippen
	await page.keyboard.press('Escape');
	await canvas(page).focus();
	await page.keyboard.press('t');
	await page.mouse.click(box.x + 650, box.y + box.height - 120);
	const field = page.getByLabel('Text bearbeiten');
	const h1 = (await field.boundingBox())!.height;
	await page.keyboard.type('eins\nzwei\ndrei');
	await expect.poll(async () => (await field.boundingBox())!.height).toBeGreaterThan(h1 * 2);
	await page.keyboard.press('Escape');
});

test('Zwei-Finger-Zoom auf dem Touchscreen', async ({ browser }) => {
	const touch = await secondPage(browser, boardUrl, {
		hasTouch: true,
		isMobile: true,
		viewport: { width: 390, height: 844 }
	});
	const zoom = touch.getByTitle('Auf 100 % setzen (0)');
	const before = parseInt(await zoom.innerText(), 10);
	await touch.evaluate(() => {
		const svg = document.querySelector('svg[role="application"]')!;
		const r = svg.getBoundingClientRect();
		const ev = (type: string, id: number, x: number, y: number) =>
			svg.dispatchEvent(
				new PointerEvent(type, {
					pointerId: id,
					pointerType: 'touch',
					clientX: r.left + x,
					clientY: r.top + y,
					bubbles: true,
					isPrimary: id === 1
				})
			);
		ev('pointerdown', 1, 150, 300);
		ev('pointerdown', 2, 230, 300);
		for (let i = 1; i <= 10; i++) {
			ev('pointermove', 1, 150 - i * 6, 300);
			ev('pointermove', 2, 230 + i * 6, 300);
		}
		ev('pointerup', 1, 90, 300);
		ev('pointerup', 2, 290, 300);
	});
	await expect.poll(async () => parseInt(await zoom.innerText(), 10)).toBeGreaterThan(before);
	await touch.context().close();
});

test('Export als PNG und PDF', async ({ page }) => {
	await login(page);
	await page.goto(boardUrl);
	await expect(elementWith(page, 'Lagerfeuer')).toBeVisible();
	const openExport = async () => {
		await page.getByRole('button', { name: 'Whiteboard-Menü' }).click();
		await page.getByRole('menuitem', { name: 'Exportieren …' }).click();
	};
	await openExport();
	let download = page.waitForEvent('download');
	await page.getByRole('dialog').getByRole('button', { name: 'Exportieren' }).click();
	expect((await download).suggestedFilename()).toMatch(/^whiteboard-programmideen-.*\.png$/);

	await openExport();
	await page.getByRole('dialog').getByRole('radio', { name: 'PDF' }).click();
	download = page.waitForEvent('download', { timeout: 60_000 });
	await page.getByRole('dialog').getByRole('button', { name: 'Exportieren' }).click();
	expect((await download).suggestedFilename()).toMatch(/\.pdf$/);
});
