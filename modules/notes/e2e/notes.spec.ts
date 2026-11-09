import { expect, test, type Browser, type Page } from '@playwright/test';

// Notizen: anlegen, tippen, zweiter Browser sieht den Text live, Fett per Leiste, Tabelle einfügen,
// Unterseite anlegen (Baum), Quelltext-Ansicht zeigt Markdown, Export-Download startet.
// Bild-Upload und Export-Inhalte prüfen die Integrationstests (Fake-Speicher).

const ADMIN = { email: 'admin@example.test', password: 'e2e-admin-password-1' };
const ORIGIN = 'http://localhost:4173';
const run = Date.now().toString(36);
const noteName = `Lagerplanung ${run}`;

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

const content = (page: Page) => page.getByRole('textbox', { name: 'Inhalt der Notiz' });
const saved = (page: Page) => page.getByRole('status').filter({ hasText: 'Gespeichert' });

async function secondPage(browser: Browser, url: string) {
	const ctx = await browser.newContext({ baseURL: ORIGIN });
	const page = await ctx.newPage();
	await login(page);
	await page.goto(url);
	await expect(content(page)).toBeVisible();
	return page;
}

test.describe.configure({ mode: 'serial' });

let noteUrl = '';

test('Notiz anlegen, live tippen, fett, Tabelle', async ({ page, browser }) => {
	await login(page);
	await ensureModules(page, ['notes']);
	await page.goto('/modules/notes');
	await page.getByRole('button', { name: 'Neue Notiz' }).first().click();
	await page.waitForURL(/\/modules\/notes\/[0-9a-f-]{36}/);
	noteUrl = new URL(page.url()).pathname;

	// Titel
	const title = page.getByLabel('Titel der Notiz');
	await title.fill(noteName);
	await title.press('Enter');
	await expect(content(page)).toBeFocused();

	const other = await secondPage(browser, noteUrl);
	await expect(other.getByLabel('Titel der Notiz')).toHaveValue(noteName, { timeout: 10_000 });

	// Tippen → live beim zweiten Browser
	await page.keyboard.type('Wir brauchen Zelte und Holz.');
	await expect(content(other)).toContainText('Wir brauchen Zelte und Holz.', { timeout: 10_000 });

	// Fett per Leiste
	await page.keyboard.press('Enter');
	await page.getByRole('button', { name: 'Fett' }).click();
	await page.keyboard.type('Wichtig');
	await expect(content(page).locator('strong')).toHaveText('Wichtig');
	await expect(content(other).locator('strong')).toHaveText('Wichtig', { timeout: 10_000 });

	// Tabelle über das Menü
	await page.keyboard.press('Enter');
	await page.getByRole('button', { name: 'Tabelle', exact: true }).click();
	await page.getByRole('menuitem', { name: /Tabelle einfügen/ }).click();
	await expect(content(page).locator('table')).toBeVisible();
	await expect(content(page).locator('th')).toHaveCount(3);
	await expect(content(other).locator('table')).toBeVisible({ timeout: 10_000 });

	await expect(saved(page)).toBeAttached({ timeout: 10_000 });
	await other.context().close();

	// Neu laden behält den Inhalt
	await page.reload();
	await expect(content(page)).toContainText('Wir brauchen Zelte und Holz.');
	await expect(content(page).locator('table')).toBeVisible();
});

test('Unterseite im Seitenbaum anlegen', async ({ page }) => {
	await login(page);
	await page.goto(noteUrl);
	await expect(content(page)).toBeVisible();
	const tree = page.getByRole('navigation', { name: 'Seiten' });
	await expect(tree.getByRole('link', { name: noteName })).toBeVisible();
	await page.getByRole('button', { name: 'Notiz-Menü' }).click();
	await page.getByRole('menuitem', { name: 'Unterseite anlegen' }).click();
	await expect(content(page).getByRole('link', { name: /Neue Seite/ })).toBeVisible();
	await expect(tree.getByRole('link', { name: 'Neue Seite' })).toBeVisible();
	await tree.getByRole('link', { name: 'Neue Seite' }).click();
	await page.waitForURL((u) => u.pathname !== noteUrl);
	await expect(page.getByRole('navigation', { name: 'Brotkrumen' })).toContainText(noteName);
});

test('Quelltext-Ansicht zeigt Markdown', async ({ page }) => {
	await login(page);
	await page.goto(noteUrl);
	await expect(content(page)).toContainText('Wichtig');
	await page.getByRole('button', { name: 'Notiz-Menü' }).click();
	await page.getByRole('menuitem', { name: /Quelltext/ }).click();
	const source = page.getByLabel('Markdown-Quelltext');
	await expect(source).toBeVisible();
	await expect(source).toHaveValue(/\*\*Wichtig\*\*/);

	// Änderung im Quelltext landet im Editor
	await source.click();
	await source.press('ControlOrMeta+End');
	await source.pressSequentially('\n\n## Aus dem Quelltext');
	await expect(content(page).locator('h2', { hasText: 'Aus dem Quelltext' })).toBeAttached({
		timeout: 5_000
	});
});

test('Export startet einen Download', async ({ page }) => {
	await login(page);
	await page.goto(noteUrl);
	await expect(content(page)).toBeVisible();
	await page.getByRole('button', { name: 'Notiz-Menü' }).click();
	await page.getByRole('menuitem', { name: /Exportieren/ }).click();
	const dialog = page.getByRole('dialog');
	await expect(dialog.getByRole('heading', { name: 'Exportieren' })).toBeVisible();
	const download = page.waitForEvent('download');
	await dialog.getByRole('link', { name: 'Herunterladen' }).click();
	const file = await download;
	expect(file.suggestedFilename()).toMatch(/\.md$/);
});
