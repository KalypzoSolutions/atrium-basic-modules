// Demo-Daten für das Modul `notes` (über die echte API, idempotent über den Titel).
// Voraussetzung: demo-server läuft, `node scripts/seed-demo.mjs`.
// Aktiviert das Modul und legt die Notiz „Sommerlager 2027“ mit Unterseiten (Packliste mit Aufgaben, Programm mit
// Tabelle, Protokoll) an; mit `--big` zusätzlich eine sehr große Notiz (~300 Seiten Text, 50 Tabellen) zum Lasttest.

const BASE = 'http://127.0.0.1:4300';
const ORIGIN = 'http://localhost:4300';
const N = '/modules/notes';
const TITLE = 'Sommerlager 2027';
const BIG = process.argv.includes('--big');

let cookie = '';
async function call(method, path, body, base = '/api/v1') {
	const res = await fetch(BASE + base + path, {
		method,
		headers: {
			'content-type': 'application/json',
			origin: ORIGIN,
			...(cookie ? { cookie } : {})
		},
		body: body ? JSON.stringify(body) : undefined
	});
	const set = res.headers.getSetCookie?.() ?? [];
	if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
	const json = await res.json().catch(() => null);
	if (res.status >= 400 && res.status !== 409) {
		console.warn(`${method} ${path} -> ${res.status}`, JSON.stringify(json?.error ?? json));
	}
	return { status: res.status, json };
}

const EMAIL = process.env.DEMO_EMAIL ?? 'admin@demo.test';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'Demo-Admin-2026!';

async function login() {
	for (let attempt = 0; attempt < 6; attempt++) {
		cookie = '';
		const r = await call(
			'POST',
			'/sign-in/email',
			{ email: EMAIL, password: PASSWORD },
			'/api/auth'
		);
		if (cookie && r.status < 400) return true;
		if (r.status === 401) return false;
		await new Promise((resolve) => setTimeout(resolve, 10_000));
	}
	return false;
}

if (!(await login())) throw new Error(`Login als ${EMAIL} fehlgeschlagen - läuft der Demo-Server?`);
console.log('Modul notes aktivieren:', (await call('POST', '/modules/notes/enable')).status);
await login();

async function create(title, markdown, parentId = null, icon = null) {
	const r = await call('POST', `${N}/notes`, { title, markdown, parentId, icon });
	if (r.status >= 400) throw new Error(`Notiz „${title}“ konnte nicht angelegt werden`);
	return r.json.data.id;
}

const roots = await call('GET', `${N}/notes/roots`);
const existing = roots.json?.data?.own?.find((n) => n.title === TITLE);
if (existing) {
	console.log('Notiz existiert bereits:', existing.id);
} else {
	const root = await create(
		TITLE,
		[
			'# Sommerlager 2027',
			'',
			'Zwei Wochen am **Edersee** – alle Infos für das Leitungsteam. Unterseiten: Packliste, Programm, Protokolle.',
			'',
			'> Anmeldeschluss ist der 15. März.',
			'',
			'## Eckdaten',
			'',
			'- Zeitraum: 18.07.–01.08.2027',
			'- Ort: Zeltplatz am See',
			'- Leitung: Tessa, Tom',
			''
		].join('\n'),
		null,
		'tent'
	);
	await create(
		'Packliste',
		[
			'## Gruppe',
			'',
			'- [x] Kohten (6 Bahnen je Zelt)',
			'- [x] Jurte für die Küche',
			'- [ ] Erste-Hilfe-Kiste prüfen',
			'- [ ] Gaskocher + 2 Flaschen',
			'',
			'## Persönlich',
			'',
			'- [ ] Schlafsack, Isomatte',
			'- [ ] Kluft und Halstuch',
			''
		].join('\n'),
		root,
		'backpack'
	);
	await create(
		'Programm',
		[
			'| Tag | Vormittag | Nachmittag |',
			'| --- | --- | --- |',
			'| Montag | Aufbau | Geländespiel |',
			'| Dienstag | Wanderung | Baden |',
			'| Mittwoch | Workshops | Lagerfeuer |',
			''
		].join('\n'),
		root,
		'calendar'
	);
	const protocols = await create(
		'Protokolle',
		'Protokolle der Vorbereitungstreffen.',
		root,
		'notebook-pen'
	);
	await create(
		'Treffen 12.01.',
		'**Anwesend:** Tessa, Tom, Lea\n\n1. Ort festgelegt\n2. Budget besprochen\n3. Nächstes Treffen: 09.02.',
		protocols
	);
	console.log('Notiz angelegt:', root);
}

if (BIG) {
	const bigTitle = 'Lasttest – große Notiz';
	if (roots.json?.data?.own?.some((n) => n.title === bigTitle)) {
		console.log('Große Notiz existiert bereits');
	} else {
		const parts = [];
		for (let i = 1; i <= 300; i++) {
			parts.push(`## Abschnitt ${i}`, '');
			for (let p = 0; p < 4; p++) {
				parts.push(
					`Absatz ${p + 1} in Abschnitt ${i}: Lorem ipsum dolor sit amet, **consectetur** adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.`,
					''
				);
			}
			if (i % 6 === 0) {
				parts.push('| Spalte A | Spalte B | Spalte C |', '| --- | --- | --- |');
				for (let r = 0; r < 8; r++) parts.push(`| Wert ${r} | ${i * r} | Zeile ${r} |`);
				parts.push('');
			}
		}
		const id = await create(bigTitle, parts.join('\n'));
		console.log(
			'Große Notiz angelegt:',
			id,
			`(${Math.round(parts.join('\n').length / 1024)} KB Markdown)`
		);
	}
}
