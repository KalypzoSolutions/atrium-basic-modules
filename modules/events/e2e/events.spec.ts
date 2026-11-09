import { expect, test, type Page } from '@playwright/test';

// Termine: Monat ist Standard; anlegen über den Dialog, Ansicht/Bearbeiten im selben Dialog,
// Liste über den Tab „Liste“ (`?view=list`); Serien (wöchentlich, 4 Vorkommen) und Absage eines Vorkommens.

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

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function localToday(): string {
	return iso(new Date());
}

/** Nächster Montag (lokal), immer nach heute */
function nextMonday(): Date {
	const d = new Date();
	d.setHours(12, 0, 0, 0);
	d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7));
	return d;
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test.describe.configure({ mode: 'serial' });

test('Monat ist die Standardansicht', async ({ page }) => {
	await login(page);
	await ensureModules(page, ['events']);
	await page.goto('/modules/events');
	await expect(page.getByRole('heading', { name: 'Termine', exact: true })).toBeVisible();
	await expect(page.getByRole('tab', { name: 'Monat' })).toHaveAttribute('aria-selected', 'true');
	await expect(page.getByRole('tab', { name: 'Liste' })).toHaveAttribute('aria-selected', 'false');
	await expect(page.getByRole('table', { name: /^Kalender / })).toBeVisible();

	// Tab „Liste“ setzt view=list, „Monat“ entfernt den Parameter wieder
	await page.getByRole('tab', { name: 'Liste' }).click();
	await expect(page).toHaveURL(/view=list/);
	await page.getByRole('tab', { name: 'Monat' }).click();
	await expect(page).not.toHaveURL(/view=/);
});

test('Termin anlegen, ansehen, bearbeiten', async ({ page }) => {
	await login(page);
	await ensureModules(page, ['events']);
	const title = `Heimabend ${run}`;
	const renamed = `Heimabend neu ${run}`;

	await page.goto('/modules/events');
	await page.getByRole('button', { name: 'Neuer Termin' }).first().click();

	const dialog = page.getByRole('dialog', { name: 'Termin anlegen' });
	await expect(dialog).toBeVisible();
	await dialog.getByLabel('Titel *').fill(title);
	await dialog.getByLabel('Ort').fill('Pfadfinderheim');
	await dialog.getByLabel('Startdatum *').fill(localToday());
	await dialog.getByLabel('Startuhrzeit').fill('18:00');
	await dialog.getByRole('combobox', { name: 'Tags' }).fill('Heimabend');
	await dialog.getByRole('combobox', { name: 'Tags' }).press('Enter');
	await dialog.getByLabel('Auf der Stammeswebsite anzeigen').check();
	await dialog.getByRole('button', { name: 'Speichern' }).click();
	await expect(dialog).toBeHidden();

	// Monat (Standard): Balken mit dem Titel
	await expect(
		page.getByRole('button', { name: new RegExp(`^${escapeRe(title)},`) }).first()
	).toBeVisible();

	// Liste: neuer Termin mit Website-Badge und Tag
	await page.getByRole('tab', { name: 'Liste' }).click();
	await expect(page).toHaveURL(/view=list/);
	const row = page.getByRole('row', { name: `Termin ${title} anzeigen` });
	await expect(row).toBeVisible();
	await expect(row).toContainText('Website');
	await expect(row).toContainText('Heimabend');

	// Ansicht im Dialog: Felder gesperrt
	await row.getByText(title).click();
	const view = page.getByRole('dialog', { name: new RegExp(escapeRe(title)) });
	await expect(view).toBeVisible();
	// Ansicht: Titel als Überschrift, Felder gesperrt
	await expect(view.getByRole('heading', { name: new RegExp(escapeRe(title)) })).toBeVisible();
	await expect(view.getByLabel('Ort')).toBeDisabled();
	await expect(view.getByLabel('Ort')).toHaveValue('Pfadfinderheim');
	await expect(view.getByRole('button', { name: 'Schließen' }).last()).toBeVisible();
	await expect(view.getByRole('button', { name: 'Löschen' })).toBeVisible();

	// Bearbeiten → Titel ändern → Speichern → Ansicht mit neuem Titel
	await view.getByRole('button', { name: 'Bearbeiten' }).click();
	const edit = page.getByRole('dialog', { name: 'Termin bearbeiten' });
	await expect(edit).toBeVisible();
	await expect(edit.getByLabel('Titel *')).toBeEnabled();
	await edit.getByLabel('Titel *').fill(renamed);
	await edit.getByRole('button', { name: 'Speichern' }).click();

	const after = page.getByRole('dialog', { name: new RegExp(escapeRe(renamed)) });
	await expect(after).toBeVisible();
	await expect(after.getByRole('heading', { name: new RegExp(escapeRe(renamed)) })).toBeVisible();
	await expect(after.getByLabel('Ort')).toBeDisabled();
	await after.getByRole('button', { name: 'Schließen' }).last().click();
	await expect(after).toBeHidden();
	await expect(page.getByRole('row', { name: `Termin ${renamed} anzeigen` })).toBeVisible();
});

test('Serie anzeigen und ein Vorkommen absagen', async ({ page }) => {
	await login(page);
	await ensureModules(page, ['events']);
	const title = `Gruppenstunde ${run}`;
	const start = nextMonday();
	const second = new Date(start);
	second.setDate(second.getDate() + 7);

	await api(page, 'POST', '/modules/events/events', {
		title,
		startsOn: iso(start),
		startsTime: '17:00',
		endsTime: null,
		recurrence: { freq: 'weekly', interval: 1, end: { type: 'count', count: 4 } }
	});

	// Monat des zweiten Vorkommens: dort sind immer mindestens zwei Vorkommen sichtbar
	// (entweder das erste oder das dritte liegt im selben 6-Wochen-Raster)
	await page.goto(`/modules/events?month=${iso(second).slice(0, 7)}`);
	const bars = page.getByRole('button', { name: new RegExp(`^${escapeRe(title)} \\(Serie\\),`) });
	await expect(bars.first()).toBeVisible();
	await expect.poll(() => bars.count()).toBeGreaterThanOrEqual(2);

	// Liste: vier Vorkommen mit Serien-Hinweis
	const search = encodeURIComponent(title);
	await page.goto(`/modules/events?view=list&search=${search}`);
	const rows = page.getByRole('row', { name: `Termin ${title} anzeigen` });
	await expect(rows).toHaveCount(4);
	await expect(rows.first()).toContainText('Serie');

	// Ein Vorkommen über die UI absagen: Ansicht → „Löschen“ → „Nur diesen Termin absagen“
	await rows.nth(1).getByText(title).click();
	const view = page.getByRole('dialog', { name: new RegExp(escapeRe(title)) });
	await expect(view).toBeVisible();
	await view.getByRole('button', { name: 'Löschen' }).click();

	const only = page
		.getByRole('radio', { name: /Nur diesen Termin/ })
		.or(page.getByRole('button', { name: /Nur diesen Termin/ }));
	await expect(only.first()).toBeVisible();
	const isRadio = (await page.getByRole('radio', { name: /Nur diesen Termin/ }).count()) > 0;
	await only.first().click();
	if (isRadio) {
		// Auswahl per Radio → Bestätigen im (Alert-)Dialog
		const confirm = page
			.getByRole('alertdialog')
			.or(page.getByRole('dialog').last())
			.getByRole('button', { name: /absagen|Löschen|Bestätigen/ })
			.last();
		await confirm.click();
	}

	await expect(rows).toHaveCount(3);
});
