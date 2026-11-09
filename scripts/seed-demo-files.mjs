// Demo-Daten für das Modul `files` (Dateien / Cloud-Ablage; idempotent, über die echte API).
// Voraussetzung: demo-server läuft (http://localhost:4300), `node scripts/seed-demo.mjs` wurde ausgeführt,
// Storage ist konfiguriert (MinIO per `docker compose -f docker-compose.demo.yml up -d` +
// `node scripts/setup-demo-storage.mjs`).
// Aktiviert `members` und `files` und legt in der Ansicht „Dateien“ (eigene Wurzel des Admins) an:
// „Fotos Sommerlager“ (erzeugte Bilder, Packliste), „Elternbriefe“ (PDF) und „Satzung und Protokolle“
// (PDF, Textdatei) – die beiden letzten mit Freigabe an den ganzen Stamm (`everyone:*`, Lesen), denn einen
// eigenen Stammesordner gibt es nicht mehr. Dazu je ein öffentlicher Link auf die Fotos zum Ansehen und
// zum Hochladen; die URLs werden ausgegeben (sie lassen sich über `GET /nodes/:id/links` jederzeit abrufen).
// Vorhandene Ordner, Dateien, Freigaben und aktive Links werden wiederverwendet, nicht doppelt angelegt.
// Neue Links erzwingen: NEW_LINK=1 node scripts/seed-demo-files.mjs
import sharp from 'sharp';

const BASE = 'http://127.0.0.1:4300';
const ORIGIN = 'http://localhost:4300';
const F = '/modules/files';

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
	if (res.status >= 400 && res.status !== 409 && res.status !== 503) {
		console.warn(`${method} ${path} -> ${res.status}`, JSON.stringify(json?.error ?? json));
	}
	return { status: res.status, json };
}

// Zugangsdaten überschreibbar, falls die Admin-Adresse in der Demo-DB geändert wurde:
//   DEMO_EMAIL=… DEMO_PASSWORD=… node scripts/seed-demo-files.mjs
const EMAIL = process.env.DEMO_EMAIL ?? 'admin@demo.test';
const PASSWORD = process.env.DEMO_PASSWORD ?? 'Demo-Admin-2026!';

async function login() {
	// Better Auth begrenzt Anmeldungen (gemeinsamer Bucket ohne Client-IP): bei 401/429 kurz warten
	for (let attempt = 0; attempt < 6; attempt++) {
		cookie = '';
		const r = await call(
			'POST',
			'/sign-in/email',
			{ email: EMAIL, password: PASSWORD },
			'/api/auth'
		);
		if (cookie && r.status < 400) return;
		await new Promise((resolve) => setTimeout(resolve, 10_000));
	}
	throw new Error(`Login als ${EMAIL} fehlgeschlagen – läuft der Demo-Server?`);
}

function storageMissing() {
	console.error(
		'\nDer Dateispeicher (S3) ist nicht konfiguriert oder nicht erreichbar (503).\n' +
			'Bitte zuerst MinIO starten und hinterlegen:\n' +
			'  docker compose -f docker-compose.demo.yml up -d\n' +
			'  node scripts/setup-demo-storage.mjs\n'
	);
	process.exit(1);
}

await login();
for (const id of ['members', 'files']) {
	const r = await call('POST', `/modules/${id}/enable`);
	console.log(`Modul ${id} aktivieren:`, r.status);
	if (r.status >= 400 && r.status !== 409)
		throw new Error(`Modul ${id} konnte nicht aktiviert werden`);
}
// Neue Modulrechte sind erst nach erneutem Login in der Sitzung wirksam
await login();

// Speicher vorab prüfen (genaue Prüfung beim ersten Upload)
const storage = await call('GET', '/settings?group=storage');
const bucket = storage.json?.data?.find?.((s) => s.key === 'core.storage.bucket');
if (bucket && !bucket.value) storageMissing();

// --- Ordner ---------------------------------------------------------------------------

/** Ordnerinhalt; ohne `parentId` die Wurzel „Dateien“ (eigene Einträge + mir Freigegebenes) */
async function list(parentId) {
	const q = parentId ? `?${new URLSearchParams({ parent: parentId })}` : '';
	const r = await call('GET', `${F}/nodes${q}`);
	if (r.status >= 400) throw new Error(`Ordnerinhalt nicht lesbar (${r.status})`);
	return r.json.data.items;
}

/** Eigener Ordner (in der Wurzel zählen nur eigene Einträge, nicht Freigegebenes anderer) */
async function ensureFolder(parentId, name) {
	const found = (await list(parentId)).find(
		(n) => n.kind === 'folder' && n.name === name && (parentId !== null || n.own)
	);
	if (found) {
		console.log(`Ordner „${name}“ vorhanden`);
		return found;
	}
	const r = await call('POST', `${F}/folders`, { parentId, name });
	if (r.status >= 400)
		throw new Error(`Ordner „${name}“ konnte nicht angelegt werden (${r.status})`);
	console.log(`Ordner „${name}“ angelegt`);
	return r.json.data;
}

// --- Upload ---------------------------------------------------------------------------

async function upload(parentId, name, bytes, type) {
	const existing = (await list(parentId)).find((n) => n.kind === 'file' && n.name === name);
	if (existing) {
		console.log(`  ${name} vorhanden`);
		return existing;
	}
	const fd = new FormData();
	fd.set('file', new Blob([bytes], { type }), name);
	// Der Endpoint verlangt Content-Length → Formular vorher in einen Puffer umwandeln
	const req = new Response(fd);
	const body = Buffer.from(await req.arrayBuffer());
	const res = await fetch(`${BASE}/api/v1${F}/nodes/${parentId ?? 'root'}/upload`, {
		method: 'POST',
		headers: { origin: ORIGIN, cookie, 'content-type': req.headers.get('content-type') },
		body
	});
	if (res.status === 503) storageMissing();
	const json = await res.json().catch(() => null);
	if (!res.ok) {
		throw new Error(
			`Upload ${name} fehlgeschlagen (${res.status}): ${JSON.stringify(json?.error)}`
		);
	}
	console.log(`  ${name} hochgeladen`);
	return json.data;
}

// --- Freigabe an den ganzen Stamm ---------------------------------------------------------

async function shareWithStamm(folder) {
	const current = await call('GET', `${F}/nodes/${folder.id}/shares`);
	if (current.status >= 400) {
		throw new Error(`Freigaben „${folder.name}“ nicht lesbar (${current.status})`);
	}
	const own = current.json?.data?.shares ?? [];
	if (own.some((s) => s.type === 'everyone' && s.id === '*')) {
		console.log(`Freigabe „${folder.name}“ an Stamm vorhanden`);
		return;
	}
	const r = await call('PUT', `${F}/nodes/${folder.id}/shares`, {
		shares: [
			...own.map((s) => ({ type: s.type, id: s.id, level: s.level })),
			{ type: 'everyone', id: '*', level: 'read' }
		]
	});
	console.log(`Freigabe „${folder.name}“ an Stamm (Lesen):`, r.status);
}

// --- Öffentliche Links (URL jederzeit abrufbar) ---------------------------------------------

const MODE_LABELS = {
	view: 'Ansehen',
	upload: 'Hochladen',
	'view-upload': 'Ansehen und hochladen'
};

/** Aktiven Link der Art (ohne Passwort, mit abrufbarer URL) wiederverwenden, sonst anlegen */
async function ensureLink(folder, mode) {
	const label = `„${MODE_LABELS[mode]}“ auf „${folder.name}“`;
	const current = await call('GET', `${F}/nodes/${folder.id}/links`);
	if (current.status >= 400) throw new Error(`Links ${label} nicht lesbar (${current.status})`);
	const found = (current.json?.data ?? []).find(
		(l) => l.active && !l.hasPassword && (l.mode ?? 'view') === mode && l.url
	);
	if (found && !process.env.NEW_LINK) {
		console.log(`Link ${label} vorhanden`);
		return found.url;
	}
	const r = await call('POST', `${F}/nodes/${folder.id}/links`, {
		expiresOn: null,
		password: null,
		mode
	});
	if (r.status >= 400) throw new Error(`Link ${label} konnte nicht angelegt werden (${r.status})`);
	console.log(`Link ${label} angelegt`);
	return r.json.data.url;
}

// --- Beispielinhalte ------------------------------------------------------------------

const palette = [
	['#2563eb', '#93c5fd'],
	['#16a34a', '#bbf7d0'],
	['#ea580c', '#fed7aa'],
	['#9333ea', '#e9d5ff'],
	['#0891b2', '#a5f3fc'],
	['#be123c', '#fecdd3']
];
const captions = [
	'Lagerplatz am See',
	'Jurtenaufbau',
	'Singerunde am Feuer',
	'Geländespiel',
	'Kanutour',
	'Abschlusskreis'
];

/** JPEG mit Farbverlauf, Kreis und Beschriftung (keine echten Fotos, keine Personen) */
async function picture(i) {
	const [a, b] = palette[i % palette.length];
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1067">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>
<rect width="1600" height="1067" fill="url(#g)"/>
<circle cx="${380 + i * 170}" cy="460" r="${180 + (i % 3) * 30}" fill="#ffffff" fill-opacity="0.3"/>
<rect x="0" y="900" width="1600" height="167" fill="#000000" fill-opacity="0.25"/>
<text x="64" y="1010" font-size="84" font-family="Arial, sans-serif" fill="#ffffff">${captions[i % captions.length]}</text>
</svg>`;
	return sharp(Buffer.from(svg)).jpeg({ quality: 82 }).toBuffer();
}

/** Kleines gültiges PDF (eine Seite, Helvetica) mit korrekter xref-Tabelle */
function pdf(lines) {
	const esc = (s) =>
		s
			.replace(/[\\()]/g, (c) => `\\${c}`)
			.replace(
				/[^\x20-\x7e]/g,
				(c) =>
					({ ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss', Ä: 'Ae', Ö: 'Oe', Ü: 'Ue', '–': '-' })[c] ?? '?'
			);
	const [title, ...rest] = lines;
	let content = `BT /F1 22 Tf 72 770 Td (${esc(title)}) Tj /F1 12 Tf`;
	for (const l of rest) content += ` 0 -22 Td (${esc(l)}) Tj`;
	content += ' ET';
	const objects = [
		'<</Type/Catalog/Pages 2 0 R>>',
		'<</Type/Pages/Kids[3 0 R]/Count 1>>',
		'<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
		`<</Length ${Buffer.byteLength(content, 'latin1')}>>\nstream\n${content}\nendstream`,
		'<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'
	];
	let out = '%PDF-1.4\n';
	const offsets = [];
	objects.forEach((o, i) => {
		offsets.push(Buffer.byteLength(out, 'latin1'));
		out += `${i + 1} 0 obj\n${o}\nendobj\n`;
	});
	const xref = Buffer.byteLength(out, 'latin1');
	out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
	out += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(out, 'latin1');
}

// --- Fotos Sommerlager ------------------------------------------------------------------

const fotos = await ensureFolder(null, 'Fotos Sommerlager');
for (let i = 0; i < captions.length; i++) {
	await upload(
		fotos.id,
		`Sommerlager-${String(i + 1).padStart(2, '0')}.jpg`,
		await picture(i),
		'image/jpeg'
	);
}
await upload(
	fotos.id,
	'Packliste.txt',
	Buffer.from(
		'Packliste Sommerlager 2026\n\n- Schlafsack und Isomatte\n- Kluft und Halstuch\n- Taschenlampe\n- Trinkflasche\n- Regenjacke\n- Liederbuch\n'
	),
	'text/plain'
);

// --- Elternbriefe (an den ganzen Stamm freigegeben) ----------------------------------------

const eltern = await ensureFolder(null, 'Elternbriefe');
await upload(
	eltern.id,
	'Elternbrief Sommerlager 2026.pdf',
	pdf([
		'Elternbrief Sommerlager 2026',
		'Liebe Eltern,',
		'vom 20. bis 30. Juli fahren wir ins Sommerlager an den See.',
		'Die Packliste liegt bei, der Teilnahmebeitrag betraegt 180 Euro.',
		'Gut Pfad!'
	]),
	'application/pdf'
);
await shareWithStamm(eltern);

// --- Satzung und Protokolle (an den ganzen Stamm freigegeben) -----------------------------

const satzung = await ensureFolder(null, 'Satzung und Protokolle');
await upload(
	satzung.id,
	'Satzung.pdf',
	pdf([
		'Satzung des Stammes',
		'Paragraf 1 - Name und Sitz',
		'Paragraf 2 - Zweck',
		'Paragraf 3 - Mitgliedschaft'
	]),
	'application/pdf'
);
await upload(
	satzung.id,
	'Protokoll Stammesrat 2026-09.txt',
	Buffer.from(
		'Protokoll Stammesrat vom 14.09.2026\n\nTOP 1: Rückblick Sommerlager\nTOP 2: Planung Herbstfahrt\nTOP 3: Material und Kasse\n'
	),
	'text/plain'
);
await shareWithStamm(satzung);

// --- Öffentliche Links auf die Fotos: Ansehen und Hochladen --------------------------------

const viewUrl = await ensureLink(fotos, 'view');
const uploadUrl = await ensureLink(fotos, 'upload');
const shown = (url) => url ?? '(URL nicht abrufbar – NEW_LINK=1 legt einen neuen Link an)';
console.log(`\nÖffentlicher Link „Ansehen“ auf „Fotos Sommerlager“:\n  ${shown(viewUrl)}`);
console.log(`Öffentlicher Link „Hochladen“ auf „Fotos Sommerlager“:\n  ${shown(uploadUrl)}`);
console.log('\nFertig. Ansehen: http://localhost:4300/modules/files');
