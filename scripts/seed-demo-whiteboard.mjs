// Demo-Daten für das Modul `whiteboard` (über die echte API, idempotent über den Namen).
// Voraussetzung: demo-server läuft, `node scripts/seed-demo.mjs` (+ optional `seed-demo-modules.mjs` für Aktionen).
// Aktiviert das Modul und legt das Whiteboard „Sommerlager – Programmideen“ mit Rahmen, Notizzetteln, Formen,
// Verbindern, Freihand-Strich, Link und (falls vorhanden) einer Karte der Aktion „Kopenhagen 2026“ an.

const BASE = 'http://127.0.0.1:4300';
const ORIGIN = 'http://localhost:4300';
const W = '/modules/whiteboard';
const NAME = 'Sommerlager – Programmideen';

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
const enabled = await call('POST', '/modules/whiteboard/enable');
console.log('Modul whiteboard aktivieren:', enabled.status);
await login();

const list = await call('GET', `${W}/boards?search=${encodeURIComponent('Programmideen')}`);
const existing = list.json?.data?.items?.find((b) => b.name === NAME);
if (existing) {
	console.log('Whiteboard existiert bereits:', existing.id);
	process.exit(0);
}

const actions = await call('GET', `${W}/refs?type=action&search=Kopenhagen`);
const action = actions.json?.data?.[0] ?? null;

const board = await call('POST', `${W}/boards`, {
	name: NAME,
	description: 'Ideen für Programm, Workshops und Abende – gemeinsam sammeln und sortieren.',
	color: '#16a34a',
	background: 'dots',
	actionId: action?.id ?? null
});
const id = board.json?.data?.id;
if (!id) throw new Error('Whiteboard konnte nicht angelegt werden');

const uid = () => crypto.randomUUID();
const base = { rotation: 0, locked: false };
const note = (x, y, text, fill = '#fff59d') => ({
	id: uid(),
	type: 'shape',
	data: { ...base, kind: 'note', x, y, w: 200, h: 170, text, fill, fontSize: 20 }
});
const shape = (kind, x, y, w, h, text, fill = '#ffffff') => ({
	id: uid(),
	type: 'shape',
	data: { ...base, kind, x, y, w, h, text, fill, stroke: '#1f2937', strokeWidth: 2, fontSize: 18 }
});
const frame = (x, y, w, h, title, color) => ({
	id: uid(),
	type: 'frame',
	data: { ...base, x, y, w, h, title, color, fill: 'transparent' }
});
const connect = (a, b, route = 'curve', label = '') => ({
	id: uid(),
	type: 'connector',
	data: {
		from: { elementId: a.id, anchor: 'auto', x: a.data.x, y: a.data.y },
		to: { elementId: b.id, anchor: 'auto', x: b.data.x, y: b.data.y },
		route,
		label,
		endHead: 'arrow'
	}
});

const f1 = frame(0, 0, 900, 520, 'Tag 1 – Ankommen', '#2563eb');
const f2 = frame(980, 0, 900, 520, 'Tag 2 – Gelände', '#16a34a');
const n1 = note(40, 60, 'Zelte aufbauen & Lagerplatz erkunden');
const n2 = note(300, 60, 'Kennenlernspiele am Nachmittag', '#ffcc80');
const n3 = note(560, 60, 'Lagerfeuer mit Stockbrot 🔥', '#f8bbd0');
const s1 = shape('diamond', 330, 300, 220, 150, 'Regen?', '#bbdefb');
const s2 = shape('rounded', 620, 320, 220, 110, 'Spieleabend im Zelt', '#c8e6c9');
const n4 = note(1020, 60, 'Geländespiel „Schatzsuche“', '#c8e6c9');
const n5 = note(1280, 60, 'Kartenkunde & Kompass', '#b2ebf2');
const s3 = shape('cloud', 1540, 60, 280, 180, 'Abends: Singerunde', '#e1bee7');
const s4 = shape('star', 1100, 300, 200, 180, 'Highlight!', '#fff59d');
const text = {
	id: uid(),
	type: 'shape',
	data: {
		...base,
		kind: 'text',
		x: 0,
		y: -120,
		w: 900,
		h: 60,
		text: 'Sommerlager 2026 – Programmideen',
		fill: 'transparent',
		stroke: 'transparent',
		fontSize: 40,
		bold: true,
		align: 'left',
		valign: 'top'
	}
};
const link = {
	id: uid(),
	type: 'link',
	data: {
		...base,
		x: 1360,
		y: 400,
		w: 260,
		h: 96,
		url: 'https://de.wikipedia.org/wiki/Pfadfinder',
		title: 'Pfadfinden – Wikipedia',
		note: 'Hintergrund für die Gruppenstunde'
	}
};
const stroke = {
	id: uid(),
	type: 'freehand',
	data: {
		...base,
		x: 60,
		y: 330,
		w: 220,
		h: 120,
		vw: 220,
		vh: 120,
		color: '#dc2626',
		size: 5,
		points: Array.from({ length: 40 }, (_, i) => [10 + i * 5, 60 + Math.sin(i / 4) * 40, 0.5])
	}
};
const elements = [f1, f2, text, n1, n2, n3, s1, s2, n4, n5, s3, s4, link, stroke];
elements.push(
	connect(n1, n2),
	connect(n2, n3),
	connect(n3, s1, 'elbow', 'wenn trocken'),
	connect(s1, s2, 'straight', 'ja')
);
elements.push(connect(n4, n5), connect(n5, s3, 'curve'));
if (action) {
	elements.push({
		id: uid(),
		type: 'ref',
		data: { ...base, x: 1640, y: 280, w: 220, h: 110, refType: 'action', refId: action.id }
	});
}
let z = 0;
const ops = elements.map((el) => ({ ...el, z: el.type === 'frame' ? -1 : ++z }));
const res = await call('POST', `${W}/boards/${id}/ops`, { client: 'seed-demo-whiteboard', ops });
console.log('Elemente angelegt:', res.status, res.json?.data?.applied?.length ?? 0);
await call('POST', `${W}/boards/${id}/snapshots`, { label: 'Erster Entwurf' });
console.log(`Fertig: ${ORIGIN}${W}/${id}`);
