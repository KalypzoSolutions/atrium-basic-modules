import { expect, test, type Page } from '@playwright/test';

// Aufgaben 2.0: Board anlegen, Aufgabe über ＋ im Spaltenkopf anlegen, im Seitenblatt Unteraufgabe abhaken und
// über „Stand“ erledigen; Ziehen zwischen Spalten; Phasen anlegen, Liste und Zeitleiste; Handy-Ansicht.
// Board aus einer Aktion: ep-intern-modules/_integration/e2e/tasks-actions.spec.ts

const ADMIN = { email: 'admin@example.test', password: 'e2e-admin-password-1' };
const ORIGIN = 'http://localhost:4173';
const run = Date.now().toString(36);

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

async function quickAdd(page: Page, column: string, title: string) {
	await page.getByRole('button', { name: `Aufgabe in „${column}“ anlegen` }).click();
	const input = page.getByLabel(`Neue Aufgabe in ${column}`);
	await input.fill(title);
	await input.press('Enter');
	await expect(
		page
			.getByRole('list', { name: `Aufgaben in ${column}` })
			.getByRole('button', { name: new RegExp(title) })
	).toBeVisible();
	await input.press('Escape');
}

test.describe.configure({ mode: 'serial' });

const boardName = `Lagerplanung ${run}`;
const taskTitle = `Zelte prüfen ${run}`;

test('Board anlegen, Aufgabe im Seitenblatt bearbeiten und erledigen', async ({ page }) => {
	await login(page);
	await ensureModules(page, ['tasks']);
	await page.goto('/modules/tasks');
	await page.getByRole('button', { name: 'Board anlegen' }).first().click();
	const dialog = page.getByRole('dialog');
	await dialog.getByLabel('Name').fill(boardName);
	await dialog.getByRole('button', { name: 'Anlegen' }).click();
	await page.waitForURL(/\/modules\/tasks\/[0-9a-f-]{36}/);
	await expect(page.getByRole('heading', { name: boardName })).toBeVisible();
	for (const col of ['Offen', 'In Arbeit', 'Erledigt']) {
		await expect(page.getByRole('heading', { name: col, exact: true })).toBeVisible();
	}

	await quickAdd(page, 'Offen', taskTitle);
	await page.getByRole('button', { name: new RegExp(taskTitle) }).click();

	// Seitenblatt: Unteraufgabe anlegen und abhaken (speichert sofort)
	const sheet = page.getByRole('dialog');
	await expect(sheet.getByLabel('Titel')).toHaveValue(taskTitle);
	await sheet.getByLabel('Neue Unteraufgabe').fill('Heringe zählen');
	await sheet.getByRole('button', { name: 'Hinzufügen' }).click();
	await expect(sheet.getByText('0 von 1 erledigt')).toBeVisible();
	await sheet.getByRole('checkbox', { name: '„Heringe zählen“ erledigt' }).click();
	await expect(sheet.getByText('1 von 1 erledigt')).toBeVisible();

	// Erledigen über „Stand“
	await sheet.getByRole('button', { name: 'Stand', exact: true }).click();
	await page.getByRole('option', { name: 'Erledigt' }).click();
	await expect(sheet.getByText('Gespeichert')).toBeVisible();
	await sheet.getByRole('button', { name: 'Schließen' }).click();
	await expect(
		page
			.getByRole('list', { name: 'Aufgaben in Erledigt' })
			.getByRole('button', { name: new RegExp(taskTitle) })
	).toBeVisible();
});

test('Aufgabe per Ziehen in eine andere Spalte verschieben', async ({ page }) => {
	await login(page);
	await page.goto('/modules/tasks');
	await page.getByRole('link', { name: new RegExp(boardName) }).click();
	await page.waitForURL(/\/modules\/tasks\/[0-9a-f-]{36}/);
	const title = `Ziehen ${run}`;
	await quickAdd(page, 'Offen', title);
	const card = page
		.getByRole('list', { name: 'Aufgaben in Offen' })
		.getByRole('button', { name: new RegExp(title) });
	await card.dragTo(page.getByRole('list', { name: 'Aufgaben in In Arbeit' }));
	const target = page
		.getByRole('list', { name: 'Aufgaben in In Arbeit' })
		.getByRole('button', { name: new RegExp(title) });
	await expect(target).toBeVisible();
	await page.reload();
	await expect(target).toBeVisible();
});

test('Phasen anlegen, Liste nach Phase, Zeitleiste', async ({ page }) => {
	await login(page);
	await page.goto('/modules/tasks');
	await page.getByRole('link', { name: new RegExp(boardName) }).click();
	await page.waitForURL(/\/modules\/tasks\/[0-9a-f-]{36}/);

	await page.getByRole('button', { name: /Phasen anlegen/ }).click();
	const dialog = page.getByRole('dialog');
	await dialog.getByLabel('Name').fill('Planung');
	await dialog.getByLabel('Beginn', { exact: true }).fill('2027-01-04');
	await dialog.getByLabel('Ende', { exact: true }).fill('2027-02-28');
	await dialog.getByRole('button', { name: 'Phase anlegen' }).click();
	await expect(dialog.getByLabel('Name der Phase')).toHaveValue('Planung');
	await dialog.getByRole('button', { name: 'Fertig' }).click();
	await expect(page.getByRole('button', { name: /^Phase Planung/ })).toBeVisible();

	// Aufgabe der Phase zuordnen (im Seitenblatt)
	await page.getByRole('button', { name: new RegExp(taskTitle) }).click();
	const sheet = page.getByRole('dialog');
	await sheet.getByRole('button', { name: 'Phase', exact: true }).click();
	await page.getByRole('option', { name: 'Planung' }).click();
	await expect(sheet.getByText('Gespeichert')).toBeVisible();
	await sheet.getByLabel('Fällig am').fill('2027-01-20');
	await sheet.getByLabel('Fällig am').blur();
	await expect(sheet.getByText('Gespeichert')).toBeVisible();
	await sheet.getByRole('button', { name: 'Schließen' }).click();

	await page.getByRole('tab', { name: 'Liste' }).click();
	await expect(page).toHaveURL(/view=list/);
	await expect(page.getByRole('heading', { name: /Planung/ })).toBeVisible();
	await expect(page.getByRole('button', { name: new RegExp(taskTitle) })).toBeVisible();

	await page.getByRole('tab', { name: 'Zeitleiste' }).click();
	// letzter Treffer = Balken der Zeitleiste (der erste ist die Phasenleiste)
	await expect(
		page.getByRole('button', { name: /^Phase Planung, 04\.01\.2027–28\.02\.2027/ }).last()
	).toBeVisible();
	await expect(
		page.getByRole('button', { name: new RegExp(`^${taskTitle}, 20\\.01\\.2027`) })
	).toBeVisible();
});

test('Handy: Liste mit Spalten-Pillen, Tippen öffnet die Aufgabe', async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await login(page);
	await page.goto('/modules/tasks');
	await page.getByRole('link', { name: new RegExp(boardName) }).click();
	await page.waitForURL(/\/modules\/tasks\/[0-9a-f-]{36}/);
	const pills = page.getByRole('group', { name: 'Spalte' });
	await expect(pills.getByRole('button', { name: /^Alle/ })).toHaveAttribute(
		'aria-pressed',
		'true'
	);
	await pills.getByRole('button', { name: /^Erledigt/ }).click();
	await page
		.getByRole('button', { name: new RegExp(taskTitle) })
		.first()
		.click();
	await expect(page.getByRole('dialog').getByLabel('Titel')).toHaveValue(taskTitle);
});
