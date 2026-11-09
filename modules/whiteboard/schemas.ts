/**
 * API-Vertrag des Moduls "whiteboard": Zod-Schemas für Server und UI (Boards, Elemente, Live-Ereignisse),
 * DTOs und Konstanten. Elemente werden je Element zusammengeführt (zuletzt geschrieben gewinnt, siehe `ops.service.ts`).
 */
import { z } from 'zod';
import { PRINCIPAL_TYPES, type PrincipalType } from '$lib/sdk/types/sharing';

export const MODULE_ID = 'whiteboard';
export const BASE_PATH = '/modules/whiteboard';
export const API_BASE = '/api/v1/modules/whiteboard';

/** Benachrichtigungen (core.notifications) */
export const NOTIFY_BOARD_SHARED = 'board-shared';

export const PERM = {
	view: 'whiteboard.board.view',
	create: 'whiteboard.board.create',
	viewAll: 'whiteboard.board.view-all',
	editAll: 'whiteboard.board.edit-all'
} as const;

export const SETTING_BOARD_MB = 'whiteboard.storage.boardMb';
export const DEFAULT_BOARD_MB = 200;

// --- Grenzen ----------------------------------------------------------------

export const MAX_BOARD_NAME = 100;
export const MAX_BOARD_DESCRIPTION = 2000;
export const MAX_ELEMENTS = 5000;
/** JSON-Größe der Daten eines Elements */
export const MAX_ELEMENT_BYTES = 64 * 1024;
export const MAX_TEXT = 5000;
export const MAX_POINTS = 3000;
export const MAX_OPS = 500;
export const MAX_SHARES = 200;
export const MAX_SNAPSHOTS_AUTO = 50;
export const MAX_SNAPSHOTS_MANUAL = 100;
export const MAX_ASSET_BYTES = 25 * 1024 * 1024;
export const MAX_IMPORT_BYTES = 100 * 1024 * 1024;
export const MAX_PDF_PAGES = 20;
export const MAX_PDF_PAGE_BYTES = 8 * 1024 * 1024;
/** Summe aller Seiten (Grenze der Core-PDF-Anlagen: 60 MB) */
export const MAX_PDF_TOTAL_BYTES = 55 * 1024 * 1024;
/** Koordinaten-/Größenbereich */
export const MAX_COORD = 1_000_000;
export const MAX_SIZE = 100_000;
/** Zoom 10–400 % */
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 4;

export const BOARD_COLORS = [
	'#2563eb',
	'#16a34a',
	'#d97706',
	'#dc2626',
	'#7c3aed',
	'#0891b2',
	'#db2777',
	'#475569'
] as const;

/** Füllfarben für Kacheln/Notizen (hell, damit dunkle Schrift lesbar bleibt) */
export const FILL_COLORS = [
	'#fff59d',
	'#ffcc80',
	'#f8bbd0',
	'#e1bee7',
	'#bbdefb',
	'#b2ebf2',
	'#c8e6c9',
	'#ffffff',
	'#eceff1',
	'#212121'
] as const;

/** Linien-/Stiftfarben */
export const STROKE_COLORS = [
	'#1f2937',
	'#dc2626',
	'#ea580c',
	'#ca8a04',
	'#16a34a',
	'#0891b2',
	'#2563eb',
	'#7c3aed',
	'#db2777',
	'#ffffff'
] as const;

export const BACKGROUNDS = ['dots', 'grid', 'none'] as const;
export type Background = (typeof BACKGROUNDS)[number];
export const BACKGROUND_LABELS: Record<Background, string> = {
	dots: 'Punkte',
	grid: 'Raster',
	none: 'Leer'
};

export const SHARE_LEVELS = ['read', 'edit'] as const;
export type ShareLevel = (typeof SHARE_LEVELS)[number];

// --- Bausteine --------------------------------------------------------------

const uuid = z.uuid('Ungültige ID');

const optionalText = (max: number) =>
	z
		.string()
		.trim()
		.max(max, `Höchstens ${max} Zeichen`)
		.nullish()
		.transform((v) => (v ? v : null));

const requiredText = (max: number) =>
	z.string().trim().min(1, 'Pflichtfeld').max(max, `Höchstens ${max} Zeichen`);

const boardColor = z
	.string()
	.regex(/^#[0-9a-fA-F]{6}$/, 'Farbe als #rrggbb')
	.transform((v) => v.toLowerCase())
	.nullish()
	.transform((v) => v ?? null);

/** Farbe in Elementen: `#rrggbb` oder `transparent` */
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Farbe als #rrggbb');
const paint = z.union([hex, z.literal('transparent')]);

const coord = z.number().finite().min(-MAX_COORD).max(MAX_COORD);
const size = z.number().finite().min(1).max(MAX_SIZE);
const rotation = z.number().finite().min(-360).max(360).default(0);
const text = (max = MAX_TEXT) => z.string().max(max, `Höchstens ${max} Zeichen`);

/** Gemeinsame Geometrie der Elemente mit Rahmen */
const box = {
	x: coord,
	y: coord,
	w: size,
	h: size,
	rotation,
	locked: z.boolean().default(false)
};

export const STROKE_STYLES = ['solid', 'dashed', 'dotted'] as const;
export type StrokeStyle = (typeof STROKE_STYLES)[number];

export const TEXT_ALIGNS = ['left', 'center', 'right'] as const;
export type TextAlign = (typeof TEXT_ALIGNS)[number];
export const V_ALIGNS = ['top', 'middle', 'bottom'] as const;
export type VAlign = (typeof V_ALIGNS)[number];

/** Schriftbild der Texte in Formen */
export const FONT_FAMILIES = ['sans', 'serif', 'mono', 'hand'] as const;
export type FontFamily = (typeof FONT_FAMILIES)[number];
export const FONT_FAMILY_LABELS: Record<FontFamily, string> = {
	sans: 'Normal',
	serif: 'Serif',
	mono: 'Mono',
	hand: 'Handschrift'
};

const textStyle = {
	text: text().default(''),
	textColor: hex.nullable().default(null),
	fontSize: z.number().int().min(8).max(160).default(18),
	fontFamily: z.enum(FONT_FAMILIES).default('sans'),
	align: z.enum(TEXT_ALIGNS).default('center'),
	valign: z.enum(V_ALIGNS).default('middle'),
	bold: z.boolean().default(false),
	italic: z.boolean().default(false),
	underline: z.boolean().default(false),
	strike: z.boolean().default(false),
	/** Schrift verkleinern, bis der Text in die Form passt (Notizzettel) */
	autoFit: z.boolean().default(false),
	/** Höhe wächst/schrumpft beim Tippen mit dem Text (Textfelder) */
	autoHeight: z.boolean().default(false)
};

export const SHAPE_KINDS = [
	'note',
	'rect',
	'rounded',
	'ellipse',
	'diamond',
	'triangle',
	'hexagon',
	'star',
	'speech',
	'cloud',
	'text'
] as const;
export type ShapeKind = (typeof SHAPE_KINDS)[number];
export const SHAPE_LABELS: Record<ShapeKind, string> = {
	note: 'Notizzettel',
	rect: 'Rechteck',
	rounded: 'Abgerundet',
	ellipse: 'Ellipse',
	diamond: 'Raute',
	triangle: 'Dreieck',
	hexagon: 'Sechseck',
	star: 'Stern',
	speech: 'Sprechblase',
	cloud: 'Wolke',
	text: 'Text'
};

export const shapeData = z
	.object({
		...box,
		kind: z.enum(SHAPE_KINDS),
		fill: paint.default('#fff59d'),
		stroke: paint.default('transparent'),
		strokeWidth: z.number().min(0).max(24).default(2),
		strokeStyle: z.enum(STROKE_STYLES).default('solid'),
		...textStyle
	})
	.strict();

export const ARROW_HEADS = ['none', 'arrow', 'triangle', 'dot', 'bar'] as const;
export type ArrowHead = (typeof ARROW_HEADS)[number];
export const ROUTES = ['straight', 'elbow', 'curve'] as const;
export type ConnectorRoute = (typeof ROUTES)[number];
export const ANCHORS = ['auto', 'top', 'right', 'bottom', 'left', 'center'] as const;
export type Anchor = (typeof ANCHORS)[number];

/** Ende eines Verbinders: frei (`x`/`y`) oder an ein Element gebunden (Koordinaten = letzter bekannter Punkt) */
const connectorEnd = z
	.object({
		elementId: uuid.nullable().default(null),
		anchor: z.enum(ANCHORS).default('auto'),
		x: coord,
		y: coord
	})
	.strict();

export const connectorData = z
	.object({
		from: connectorEnd,
		to: connectorEnd,
		route: z.enum(ROUTES).default('straight'),
		stroke: hex.default('#1f2937'),
		strokeWidth: z.number().min(1).max(24).default(2),
		strokeStyle: z.enum(STROKE_STYLES).default('solid'),
		startHead: z.enum(ARROW_HEADS).default('none'),
		endHead: z.enum(ARROW_HEADS).default('arrow'),
		label: text(200).default(''),
		/** Krümmung/Knick (−1 … 1, 0 = Mitte) */
		bend: z.number().min(-1).max(1).default(0),
		locked: z.boolean().default(false)
	})
	.strict();

/** Punkte relativ zu `x`/`y`: `[x, y, druck]` (Druck 0–1) */
const point = z.tuple([coord, coord, z.number().min(0).max(1)]);

export const freehandData = z
	.object({
		...box,
		points: z.array(point).min(1).max(MAX_POINTS, `Höchstens ${MAX_POINTS} Punkte`),
		/** Größe des Koordinatensystems der Punkte (wird in `w`×`h` eingepasst) */
		vw: size,
		vh: size,
		color: hex.default('#1f2937'),
		size: z.number().min(1).max(64).default(4),
		opacity: z.number().min(0.05).max(1).default(1),
		/** Marker: breite, halbtransparente Spitze ohne Druck */
		marker: z.boolean().default(false)
	})
	.strict();

export const imageData = z
	.object({
		...box,
		assetId: uuid,
		alt: text(300).default(''),
		stroke: paint.default('transparent'),
		strokeWidth: z.number().min(0).max(24).default(0)
	})
	.strict();

export const fileData = z
	.object({
		...box,
		assetId: uuid,
		color: hex.nullable().default(null)
	})
	.strict();

/** Erlaubte Link-Ziele: http(s), mailto oder interne relative Pfade (`/…`, nicht `//`) */
export function isAllowedLink(url: string): boolean {
	const v = url.trim();
	if (!v || v.length > 2000) return false;
	// keine Leer- und Steuerzeichen
	for (const ch of v) {
		const code = ch.charCodeAt(0);
		if (code <= 0x20 || code === 0x7f || /\s/.test(ch)) return false;
	}
	if (v.startsWith('/')) return !v.startsWith('//') && !v.startsWith('/\\');
	try {
		const u = new URL(v);
		return u.protocol === 'https:' || u.protocol === 'http:' || u.protocol === 'mailto:';
	} catch {
		return false;
	}
}

export const linkData = z
	.object({
		...box,
		url: z
			.string()
			.trim()
			.max(2000)
			.refine(isAllowedLink, 'Nur http(s)-, mailto- oder interne Links'),
		title: text(200).default(''),
		note: text(500).default(''),
		color: hex.nullable().default(null)
	})
	.strict();

export const frameData = z
	.object({
		...box,
		title: text(120).default('Rahmen'),
		color: hex.nullable().default(null),
		fill: paint.default('transparent')
	})
	.strict();

export const REF_TYPES = [
	'action',
	'task',
	'taskboard',
	'event',
	'gallery',
	'file',
	'whiteboard',
	'note'
] as const;
export type RefType = (typeof REF_TYPES)[number];
export const REF_LABELS: Record<RefType, string> = {
	action: 'Aktion',
	task: 'Aufgabe',
	taskboard: 'Aufgaben-Board',
	event: 'Termin',
	gallery: 'Galerie',
	file: 'Datei',
	whiteboard: 'Whiteboard',
	note: 'Notiz'
};
/** Modul, das den Verweis liefert (nur bei aktivem Modul sichtbar) */
export const REF_MODULES: Record<RefType, string> = {
	action: 'actions',
	task: 'tasks',
	taskboard: 'tasks',
	event: 'events',
	gallery: 'galleries',
	file: 'files',
	whiteboard: 'whiteboard',
	note: 'notes'
};

/** Karte für einen Datensatz aus einem anderen Modul. Titel o. Ä. wird NIE gespeichert (nur je Betrachter*in aufgelöst). */
export const refData = z
	.object({
		...box,
		refType: z.enum(REF_TYPES),
		refId: z.string().trim().min(1).max(64),
		color: hex.nullable().default(null)
	})
	.strict();

export const ELEMENT_TYPES = [
	'shape',
	'connector',
	'freehand',
	'image',
	'file',
	'link',
	'frame',
	'ref'
] as const;
export type ElementType = (typeof ELEMENT_TYPES)[number];

export const ELEMENT_SCHEMAS = {
	shape: shapeData,
	connector: connectorData,
	freehand: freehandData,
	image: imageData,
	file: fileData,
	link: linkData,
	frame: frameData,
	ref: refData
} as const;

export type ShapeData = z.infer<typeof shapeData>;
export type ConnectorData = z.infer<typeof connectorData>;
export type ConnectorEnd = ConnectorData['from'];
export type FreehandData = z.infer<typeof freehandData>;
export type ImageData = z.infer<typeof imageData>;
export type FileData = z.infer<typeof fileData>;
export type LinkData = z.infer<typeof linkData>;
export type FrameData = z.infer<typeof frameData>;
export type RefData = z.infer<typeof refData>;

interface ElementBase {
	id: string;
	z: number;
	/** Serverseitige Version (0 = noch nicht bestätigt) */
	version: number;
}
export type WbElement =
	| (ElementBase & { type: 'shape'; data: ShapeData })
	| (ElementBase & { type: 'connector'; data: ConnectorData })
	| (ElementBase & { type: 'freehand'; data: FreehandData })
	| (ElementBase & { type: 'image'; data: ImageData })
	| (ElementBase & { type: 'file'; data: FileData })
	| (ElementBase & { type: 'link'; data: LinkData })
	| (ElementBase & { type: 'frame'; data: FrameData })
	| (ElementBase & { type: 'ref'; data: RefData });

/** Elemente mit Rahmen (alles außer Verbindern) */
export type BoxElement = Exclude<WbElement, { type: 'connector' }>;

/** Daten eines Elements nach Typ prüfen (`null` = ungültig) */
export function parseElementData<T extends ElementType>(
	type: T,
	data: unknown
): z.infer<(typeof ELEMENT_SCHEMAS)[T]> | null {
	const res = ELEMENT_SCHEMAS[type].safeParse(data);
	return res.success ? (res.data as z.infer<(typeof ELEMENT_SCHEMAS)[T]>) : null;
}

// --- Änderungen (ops) --------------------------------------------------------

const zValue = z.number().finite().min(-1e12).max(1e12);

/** Element anlegen oder ersetzen (ganze Daten) */
const upsertOp = z
	.object({
		id: uuid,
		type: z.enum(ELEMENT_TYPES),
		data: z.unknown(),
		z: zValue
	})
	.strict();

/** Element löschen */
const deleteOp = z.object({ id: uuid, deleted: z.literal(true) }).strict();

export const elementOp = z.union([deleteOp, upsertOp]);
export type ElementOp = z.infer<typeof elementOp>;

/** Kennung einer Verbindung (je Browser-Tab), um eigene Änderungen nicht doppelt anzuwenden */
export const clientId = z
	.string()
	.trim()
	.min(8)
	.max(64)
	.regex(/^[A-Za-z0-9_-]+$/, 'Ungültige Kennung');

/** POST `/boards/:id/ops` */
export const opsInput = z
	.object({
		client: clientId,
		ops: z.array(elementOp).min(1).max(MAX_OPS, `Höchstens ${MAX_OPS} Änderungen je Anfrage`)
	})
	.strict();
export type OpsInput = z.input<typeof opsInput>;

/** POST `/boards/:id/presence` */
export const presenceInput = z
	.object({
		client: clientId,
		cursor: z.object({ x: coord, y: coord }).strict().nullable(),
		selection: z.array(uuid).max(200).default([]),
		editing: uuid.nullable().default(null)
	})
	.strict();
export type PresenceInput = z.input<typeof presenceInput>;

export const liveQuery = z.object({
	client: clientId,
	since: z.coerce.number().int().min(0).optional()
});

// --- Boards -----------------------------------------------------------------

export const idParams = z.object({ id: uuid });
export const actionParams = z.object({ actionId: uuid });
export const snapshotParams = z.object({ id: uuid, snapshotId: uuid });
export const assetParams = z.object({
	id: uuid,
	variant: z.enum(['thumb', 'web', 'file'])
});

export const boardInput = z
	.object({
		name: requiredText(MAX_BOARD_NAME),
		description: optionalText(MAX_BOARD_DESCRIPTION),
		color: boardColor,
		background: z.enum(BACKGROUNDS).default('dots'),
		/** Aktion aus `actions` (Zugriff auf die Aktion vererbt sich aufs Board) */
		actionId: uuid.nullish().transform((v) => v ?? null)
	})
	.strict();
export type BoardInput = z.input<typeof boardInput>;

export const boardUpdateInput = z
	.object({
		name: requiredText(MAX_BOARD_NAME).optional(),
		description: optionalText(MAX_BOARD_DESCRIPTION).optional(),
		color: boardColor.optional(),
		background: z.enum(BACKGROUNDS).optional(),
		actionId: uuid.nullable().optional()
	})
	.strict();
export type BoardUpdateInput = z.input<typeof boardUpdateInput>;

export const listQuery = z.object({
	search: z.string().trim().max(100).optional(),
	actionId: uuid.optional(),
	limit: z.coerce.number().int().min(1).max(200).default(100),
	offset: z.coerce.number().int().min(0).default(0)
});

export const recentQuery = z.object({
	limit: z.coerce.number().int().min(1).max(20).default(6)
});

export const searchQuery = z.object({
	search: z.string().trim().min(2, 'Mindestens 2 Zeichen').max(100)
});

const principalShare = z
	.object({
		type: z.enum(PRINCIPAL_TYPES),
		id: z.string().trim().min(1).max(64),
		level: z.enum(SHARE_LEVELS)
	})
	.strict();

export const sharesInput = z
	.object({ shares: z.array(principalShare).max(MAX_SHARES, `Höchstens ${MAX_SHARES} Freigaben`) })
	.strict()
	.superRefine((v, ctx) => {
		const seen = new Set<string>();
		v.shares.forEach((s, i) => {
			const key = `${s.type}:${s.id}`;
			if (seen.has(key)) {
				ctx.addIssue({ code: 'custom', path: ['shares', i, 'id'], message: 'Doppelte Freigabe' });
			}
			seen.add(key);
			if (s.type === 'everyone' && s.id !== '*') {
				ctx.addIssue({ code: 'custom', path: ['shares', i, 'id'], message: 'Ungültige ID' });
			}
		});
	});
export type SharesInput = z.infer<typeof sharesInput>;

export const snapshotInput = z
	.object({ label: z.string().trim().min(1, 'Pflichtfeld').max(100, 'Höchstens 100 Zeichen') })
	.strict();

/** GET `/refs?type&search` */
export const refSearchQuery = z.object({
	type: z.enum(REF_TYPES),
	search: z.string().trim().max(100).default(''),
	limit: z.coerce.number().int().min(1).max(100).default(20)
});

/** POST `/refs/describe` */
export const refDescribeInput = z
	.object({
		items: z
			.array(z.object({ type: z.enum(REF_TYPES), id: z.string().trim().min(1).max(64) }).strict())
			.max(500)
	})
	.strict();

export const pdfExportFields = z.object({
	title: z.string().trim().max(200).optional(),
	orientation: z.enum(['landscape', 'portrait']).default('landscape')
});

// --- Persönliche Einstellungen ------------------------------------------------

export const SURFACE_MODES = ['fixed', 'theme'] as const;
export type SurfaceMode = (typeof SURFACE_MODES)[number];
export const DEFAULT_SURFACE_COLOR = '#ffffff';
export const SURFACE_PRESETS = [
	{ value: '#ffffff', label: 'Weiß' },
	{ value: '#111827', label: 'Schwarz' }
] as const;

/** Fläche: fest (gleiche Farbe in Hell/Dunkel und mit jedem Theme) oder wie Modus/Theme */
export const surfacePrefs = z
	.object({
		mode: z.enum(SURFACE_MODES).default('fixed'),
		color: z
			.string()
			.regex(/^#[0-9a-fA-F]{6}$/, 'Farbe als #rrggbb')
			.transform((v) => v.toLowerCase())
			.default(DEFAULT_SURFACE_COLOR)
	})
	.strict();

/** PUT `/me/prefs` (gespeicherte Werte werden beim Lesen ebenso geprüft, Unbekanntes fällt weg) */
export const userPrefsInput = z
	.object({ surface: surfacePrefs.default({ mode: 'fixed', color: DEFAULT_SURFACE_COLOR }) })
	.strict();
export type UserPrefs = z.output<typeof userPrefsInput>;
export const DEFAULT_USER_PREFS: UserPrefs = {
	surface: { mode: 'fixed', color: DEFAULT_SURFACE_COLOR }
};

// --- Antworten (DTOs) -------------------------------------------------------

export interface UserRef {
	id: string;
	name: string;
	image: string | null;
}

export interface BoardAccess {
	level: ShareLevel;
	isOwner: boolean;
	/** Teilen, löschen, Aktion umhängen */
	canShare: boolean;
}

export interface Board {
	id: string;
	name: string;
	description: string | null;
	color: string | null;
	background: Background;
	owner: UserRef;
	actionId: string | null;
	actionName: string | null;
	elementCount: number;
	access: BoardAccess;
	updatedAt: string;
	updatedBy: UserRef | null;
	createdAt: string;
}

export interface BoardList {
	items: Board[];
	total: number;
}

export interface Asset {
	id: string;
	kind: 'image' | 'file';
	name: string;
	contentType: string;
	sizeBytes: number;
	width: number | null;
	height: number | null;
	/** Vorschaubild vorhanden (Bilder immer, PDFs meist) */
	hasThumb: boolean;
}

export interface BoardDetail extends Board {
	seq: number;
	elements: WbElement[];
	assets: Asset[];
	/** Belegter Speicher des Boards / Grenze (Byte, 0 = unbegrenzt) */
	storage: { usedBytes: number; limitBytes: number };
}

export interface ActionBoards {
	boards: Board[];
	canCreate: boolean;
}

export interface BoardShareEntry {
	type: PrincipalType;
	userId: string;
	name: string;
	detail: string | null;
	color: string | null;
	image: string | null;
	level: ShareLevel;
}

export interface BoardShares {
	owner: UserRef;
	shares: BoardShareEntry[];
	canManage: boolean;
	everyoneLabel: string;
}

export interface Snapshot {
	id: string;
	label: string | null;
	auto: boolean;
	elementCount: number;
	createdAt: string;
	createdBy: UserRef | null;
}

/** Aufgelöste Karte (je Betrachter*in) */
export interface RefCard {
	type: RefType;
	id: string;
	/** `false` = nicht (mehr) vorhanden oder kein Zugriff */
	available: boolean;
	title: string;
	subtitle: string | null;
	href: string | null;
	color: string | null;
	imageUrl: string | null;
	/** Kurzer Status, z. B. „erledigt“, „3 offen“ */
	badge: string | null;
}

export interface OpsResult {
	seq: number;
	applied: { id: string; version: number }[];
}

// --- Live (SSE) --------------------------------------------------------------

export interface PresenceUser {
	client: string;
	userId: string;
	name: string;
	image: string | null;
	color: string;
	canEdit: boolean;
	cursor: { x: number; y: number } | null;
	selection: string[];
	editing: string | null;
}

/** Element, wie es über die Leitung kommt (`deleted` = gelöscht) */
export interface LiveElement {
	id: string;
	type: ElementType;
	data: unknown;
	z: number;
	version: number;
	deleted: boolean;
}

export type LiveEvent =
	| {
			type: 'hello';
			seq: number;
			client: string;
			level: ShareLevel;
			peers: PresenceUser[];
			reset: boolean;
	  }
	| {
			type: 'ops';
			seq: number;
			client: string | null;
			userId: string | null;
			elements: LiveElement[];
	  }
	| { type: 'presence'; peer: PresenceUser }
	| { type: 'join'; peer: PresenceUser }
	| { type: 'leave'; client: string }
	| {
			type: 'board';
			board: Pick<Board, 'name' | 'description' | 'color' | 'background' | 'actionId'>;
	  }
	| { type: 'access'; level: ShareLevel }
	| { type: 'reset'; reason: 'restore' | 'purge' }
	| { type: 'revoked' }
	| { type: 'deleted' };

/** Farbe einer Person in der Anwesenheit (stabil je Konto) */
export const PRESENCE_COLORS = [
	'#e11d48',
	'#2563eb',
	'#16a34a',
	'#d97706',
	'#7c3aed',
	'#0891b2',
	'#c026d3',
	'#ea580c'
] as const;

export function presenceColor(userId: string): string {
	let h = 0;
	for (const ch of userId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
	return PRESENCE_COLORS[h % PRESENCE_COLORS.length]!;
}

// --- Export-Archiv -----------------------------------------------------------

export const ARCHIVE_FORMAT = 'ep-whiteboard';
export const ARCHIVE_VERSION = 1;
export const ARCHIVE_EXTENSION = '.epwhiteboard';
