/**
 * API-Vertrag des Moduls `files` (Dateien / Cloud-Ablage): Zod-Eingaben, DTO-Typen, Konstanten.
 * Wird von Server UND UI genutzt – keine Server-Imports.
 */
import { z } from 'zod';
import { styleColor as folderColor, styleIcon as folderIcon } from '$lib/sdk/style-presets';
import { isRealDate } from '$lib/sdk/dates';
import { PRINCIPAL_TYPES, type PrincipalInfo } from '$lib/sdk/types/sharing';

export const MODULE_ID = 'files';
/** Benachrichtigungen (core.notifications): mit mir geteilt, neue Dateien über einen Upload-Link */
export const NOTIFY_FILE_SHARED = 'file-shared';
export const NOTIFY_LINK_UPLOAD = 'link-upload';
export const BASE_PATH = '/modules/files';

export const PERMISSIONS = {
	/** Grundrecht: eigene Dateien und für mich Freigegebenes (auch an den ganzen Stamm) */
	view: 'files.file.view',
	/** Öffentliche Links anlegen (nur für Knoten mit Bearbeiten-Zugriff) */
	linkCreate: 'files.link.create',
	/** Alles sehen und verwalten (auch fremde Dateien) */
	manageAll: 'files.file.manage-all',
	/** Speicherkontingent einzelner Personen festlegen (Benutzer-Dialog der Verwaltung) */
	quotaManage: 'files.quota.manage'
} as const;

export const SETTING_KEYS = {
	/** Kontingent je Person in MB (gilt für „Meine Dateien“), 0 = unbegrenzt */
	quotaMb: 'files.quota.mb',
	/** Tage im Papierkorb bis zum endgültigen Löschen */
	trashDays: 'files.trash.days',
	/** Obergrenze je Upload-Link in MB (Summe aller darüber hochgeladenen Dateien), 0 = unbegrenzt */
	linkUploadMb: 'files.link.upload-mb'
} as const;

/**
 * Seit 0003 gibt es nur noch eine Ansicht: alle Knoten haben `space = 'personal'` (Spalte bleibt aus der
 * ersten Version, nur intern). Der frühere Stammesordner ist eine Freigabe an `everyone:*` („Stamm“).
 */
export const SPACES = ['personal'] as const;
export type Space = (typeof SPACES)[number];
/** Name der Wurzel in Breadcrumbs/Pfaden */
export const ROOT_LABEL = 'Dateien';

/** Art eines öffentlichen Links */
export const LINK_MODES = ['view', 'upload', 'view-upload'] as const;
export type LinkMode = (typeof LINK_MODES)[number];
export const LINK_MODE_LABELS: Record<LinkMode, string> = {
	view: 'Ansehen',
	upload: 'Hochladen',
	'view-upload': 'Ansehen und hochladen'
};
export const LINK_MODE_DESCRIPTIONS: Record<LinkMode, string> = {
	view: 'Ansehen und herunterladen, nichts hochladen',
	upload: 'Nur hochladen – der Inhalt des Ordners bleibt verborgen',
	'view-upload': 'Ansehen, herunterladen und neue Dateien hochladen'
};
export const linkCanView = (m: LinkMode) => m === 'view' || m === 'view-upload';
export const linkCanUpload = (m: LinkMode) => m === 'upload' || m === 'view-upload';

export const NODE_KINDS = ['folder', 'file'] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const SHARE_LEVELS = ['read', 'edit'] as const;
export type ShareLevel = (typeof SHARE_LEVELS)[number];
export const SHARE_LEVEL_LABELS: Record<ShareLevel, string> = { read: 'Sehen', edit: 'Bearbeiten' };

/** Zugriffsstufe des Aufrufers auf einen Knoten */
export type AccessLevel = 'read' | 'edit';

export const MAX_NAME = 200;
/** Maximale Ordnertiefe (Wurzel = 0) */
export const MAX_DEPTH = 20;
export const MAX_BULK = 500;
export const MAX_SHARES = 200;
export const MAX_LINKS_PER_NODE = 20;
export const MAX_SEARCH_RESULTS = 100;
export const MAX_PASSWORD = 200;
export const MIN_PASSWORD = 8;
/** Fehlversuche je Link und Stunde, danach gesperrt (429) */
export const MAX_UNLOCK_FAILURES = 10;
/** Gleichzeitige Uploads im Browser */
export const UPLOAD_CONCURRENCY = 3;
/** Öffentlicher Upload: Dateien je Request (Core-Grenze für öffentliches Multipart: 10 Dateien, 30 MB je Request) */
export const MAX_PUBLIC_UPLOAD_FILES = 10;
export const MAX_PUBLIC_UPLOAD_BYTES = 30 * 1024 * 1024;
export const MAX_UPLOADER_NAME = 100;
export const DEFAULT_QUOTA_MB = 1024;
/** Obergrenze für ein eigenes Kontingent je Person (MB, ≈ 10 TB) */
export const MAX_USER_QUOTA_MB = 10_000_000;
export const DEFAULT_TRASH_DAYS = 30;
export const DEFAULT_LINK_UPLOAD_MB = 500;
/** Zugriffstoken nach Passwort-Eingabe (öffentlicher Link) */
export const LINK_ACCESS_TTL_SEC = 15 * 60;
/** Textvorschau nur bis zu dieser Größe */
export const MAX_TEXT_PREVIEW_BYTES = 1024 * 1024;

/** Bildtypen mit Thumbnail und Vorschau (Inhalt prüft der Server per `core.images`) */
export const PREVIEW_IMAGE_TYPES = [
	'image/jpeg',
	'image/png',
	'image/webp',
	'image/gif',
	'image/avif'
] as const;
export const PREVIEW_PDF = 'application/pdf';
export const PREVIEW_TEXT_TYPES = [
	'text/plain',
	'text/csv',
	'text/markdown',
	'application/json'
] as const;

/** Aktive Inhalte: nie inline ausliefern (immer `attachment`) */
export const NEVER_INLINE_TYPES = ['text/html', 'image/svg+xml', 'application/xhtml+xml'] as const;

// ---------------------------------------------------------------------------
// Bausteine
// ---------------------------------------------------------------------------

/**
 * Unsichtbare/Steuer-Zeichen (Zero-Width, Bidi wie U+202E, C1, Füllzeichen, weiche Trennung) sind in Namen
 * nicht erlaubt. Absichtlich einzelne (auch kombinierende) Zeichen, kein Graphem-Abgleich.
 */
export const INVISIBLE_CHARS =
	// eslint-disable-next-line no-misleading-character-class
	/[\u00AD\u0080-\u009F\u034F\u061C\u115F\u1160\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\u3164\uFEFF\uFFF9-\uFFFB]/u;

/** Ordner-/Dateiname: keine Pfadtrenner, keine Steuerzeichen, nicht „.“/„..“ */
export const nodeName = z
	.string()
	.trim()
	.min(1, 'Bitte einen Namen angeben')
	// Zeichen (Codepoints) wie `normalizeName`, nicht UTF-16-Einheiten (Emoji zählen einfach)
	.refine((v) => Array.from(v).length <= MAX_NAME, `Höchstens ${MAX_NAME} Zeichen`)
	.refine(
		// eslint-disable-next-line no-control-regex
		(v) => !/[/\\\u0000-\u001f\u007f]/.test(v),
		'Name darf keine / \\ oder Steuerzeichen enthalten'
	)
	.refine((v) => !INVISIBLE_CHARS.test(v), 'Name darf keine unsichtbaren Steuerzeichen enthalten')
	.refine((v) => v !== '.' && v !== '..', 'Ungültiger Name');

export const nodeId = z.uuid('Ungültige ID');

const refId = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[A-Za-z0-9*_-]+$/, 'Ungültige ID');

/** Zielordner: Knoten-ID oder `null` = Wurzel des Bereichs */
const parentRef = nodeId.nullable();

// ---------------------------------------------------------------------------
// Eingaben
// ---------------------------------------------------------------------------

export const idParams = z.object({ id: nodeId });
export const parentParams = z.object({ parent: z.union([nodeId, z.literal('root')]) });
export const linkIdParams = z.object({ id: z.uuid() });
export const tokenParams = z.object({
	token: z
		.string()
		.min(20)
		.max(100)
		.regex(/^[A-Za-z0-9_-]+$/)
});
export const tokenNodeParams = tokenParams.extend({ nodeId });

/** GET `/nodes` – Inhalt eines Ordners; ohne `parent` = Wurzel (eigene + mir freigegebene Einträge) */
export const listQuery = z.object({
	parent: nodeId.optional(),
	/** nur mit `manage-all`: Wurzel einer anderen Person */
	owner: z.string().min(1).max(64).optional()
});

export const searchQuery = z.object({
	q: z.string().trim().min(2, 'Mindestens 2 Zeichen').max(100)
});

export const contentQuery = z.object({
	download: z.enum(['0', '1']).optional()
});

export const folderCreateInput = z
	.object({
		/** `null` = eigene Wurzel */
		parentId: parentRef,
		name: nodeName
	})
	.strict();
export type FolderCreateInput = z.input<typeof folderCreateInput>;

export const renameInput = z.object({ name: nodeName }).strict();

/** Vorschlagsfarben für Ordner, Farbe und Icon: gemeinsam mit anderen Modulen (`$lib/sdk/style-presets`) */
export {
	STYLE_COLORS as FOLDER_COLORS,
	styleColor as folderColor,
	styleIcon as folderIcon
} from '$lib/sdk/style-presets';

/**
 * POST `/nodes/style` – Aussehen eines oder mehrerer Ordner. Fehlendes Feld = unverändert, `null` = zurücksetzen.
 */
export const styleInput = z
	.object({
		ids: z.array(nodeId).min(1).max(MAX_BULK),
		icon: folderIcon.nullable().optional(),
		color: folderColor.nullable().optional()
	})
	.strict()
	.refine((v) => v.icon !== undefined || v.color !== undefined, {
		message: 'Icon oder Farbe angeben',
		path: ['icon']
	});
export type StyleInput = z.input<typeof styleInput>;

/** Kontingent einer Person: Standard (Einstellung), eigenes Limit in MB oder unbegrenzt */
export const QUOTA_MODES = ['default', 'custom', 'unlimited'] as const;
export type QuotaMode = (typeof QUOTA_MODES)[number];

export const userIdParams = z.object({
	userId: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[A-Za-z0-9_-]+$/, 'Ungültige ID')
});

export const userQuotaInput = z
	.object({
		mode: z.enum(QUOTA_MODES),
		/** nur bei `custom` (Pflicht), ganze MB */
		mb: z
			.number()
			.int('Bitte eine ganze Zahl angeben')
			.min(1, 'Mindestens 1 MB')
			.max(MAX_USER_QUOTA_MB, 'Zu groß')
			.nullable()
			.optional()
	})
	.strict()
	.superRefine((v, c) => {
		if (v.mode === 'custom' && (v.mb === null || v.mb === undefined)) {
			c.addIssue({ code: 'custom', message: 'Bitte ein Limit angeben', path: ['mb'] });
		}
	});
export type UserQuotaInput = z.input<typeof userQuotaInput>;

export const moveInput = z
	.object({
		ids: z.array(nodeId).min(1).max(MAX_BULK),
		/** Ziel: Ordner-ID oder `null` = eigene Wurzel */
		targetId: parentRef
	})
	.strict();
export type MoveInput = z.input<typeof moveInput>;

export const bulkInput = z.object({ ids: z.array(nodeId).min(1).max(MAX_BULK) }).strict();

/** Upload (multipart): Textfelder neben `file` */
export const uploadFields = z.object({
	/** Relativer Pfad bei Ordner-Upload, z. B. „Fotos/2026/bild.jpg“ – Ordner werden angelegt */
	relativePath: z.string().max(1000).optional(),
	/** `rename` (Standard) = „Name (2)“, `replace` = vorhandene Datei ersetzen */
	conflict: z.enum(['rename', 'replace']).default('rename')
});

export const shareInput = z
	.object({
		type: z.enum(PRINCIPAL_TYPES),
		id: refId,
		level: z.enum(SHARE_LEVELS)
	})
	.strict();
export type ShareInput = z.infer<typeof shareInput>;
export const sharesInput = z
	.object({ shares: z.array(shareInput).max(MAX_SHARES) })
	.strict()
	.superRefine((v, c) => {
		const seen = new Set<string>();
		v.shares.forEach((s, i) => {
			const k = `${s.type}:${s.id}`;
			if (seen.has(k))
				c.addIssue({ code: 'custom', message: 'Doppelt', path: ['shares', i, 'id'] });
			seen.add(k);
		});
	});

export const principalSearchQuery = z.object({ q: z.string().trim().min(2).max(100) });

/** Echtes Kalenderdatum `YYYY-MM-DD` (z. B. kein 31.02.) */
// Zentral in `$lib/sdk/dates` (#32); hier für bestehende Importe weitergereicht
export { isRealDate };

export const linkCreateInput = z
	.object({
		/** Ablaufdatum `YYYY-MM-DD` (gültig bis Tagesende) oder `null` = unbegrenzt */
		expiresOn: z
			.string()
			.regex(/^\d{4}-\d{2}-\d{2}$/, 'Datum im Format JJJJ-MM-TT')
			.refine(isRealDate, 'Ungültiges Datum')
			.nullable(),
		password: z
			.string()
			.min(MIN_PASSWORD, `Mindestens ${MIN_PASSWORD} Zeichen`)
			.max(MAX_PASSWORD)
			.nullable(),
		/** Upload-Arten nur für Ordner (sonst 422) */
		mode: z.enum(LINK_MODES).default('view')
	})
	.strict();
export type LinkCreateInput = z.input<typeof linkCreateInput>;

export const linkUnlockInput = z.object({ password: z.string().min(1).max(MAX_PASSWORD) }).strict();

/** Öffentliche Abfragen: `t` = Zugriffstoken nach Passwort-Eingabe */
export const publicInfoQuery = z.object({ t: z.string().max(500).optional() });
export const publicNodesQuery = z.object({
	parent: nodeId.optional(),
	t: z.string().max(500).optional()
});
/** Öffentlicher Upload (multipart): Textfelder neben `file` (mehrere Dateien möglich) */
export const publicUploadFields = z
	.object({
		/** Optionaler Name der hochladenden Person */
		name: z
			.string()
			.trim()
			.max(MAX_UPLOADER_NAME, `Höchstens ${MAX_UPLOADER_NAME} Zeichen`)
			.optional(),
		/** Zugriffstoken nach Passwort-Eingabe */
		t: z.string().max(500).optional()
	})
	.strict();
export type PublicUploadFields = z.infer<typeof publicUploadFields>;

export const publicContentQuery = z.object({
	t: z.string().max(500).optional(),
	download: z.enum(['0', '1']).optional(),
	thumb: z.enum(['0', '1']).optional()
});

// ---------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------

export interface UserRef {
	id: string;
	name: string;
}

export interface FileNode {
	id: string;
	parentId: string | null;
	kind: NodeKind;
	name: string;
	ownerId: string;
	/** Eigentümer*in (für „von …“ bei fremden Einträgen) */
	owner: UserRef;
	/** Gehört dem Aufrufer */
	own: boolean;
	/** An den ganzen Stamm freigegeben (direkt oder geerbt) */
	stamm: boolean;
	/** nur Dateien */
	contentType: string | null;
	sizeBytes: number | null;
	hasThumb: boolean;
	/** Zugriff des Aufrufers */
	access: AccessLevel;
	/** Darf Freigaben und öffentliche Links verwalten (Eigentümer*in oder `manage-all`) – Bearbeiten über eine Freigabe reicht NICHT */
	canShare: boolean;
	/** Hat eigene Freigaben (Principals) */
	shared: boolean;
	/** Hat aktive öffentliche Links */
	linked: boolean;
	/** Ordner: Anzahl direkter Einträge */
	childCount: number | null;
	/** Ordner: Summe aller Dateien im Teilbaum (ohne Papierkorb) */
	folderBytes: number | null;
	/** Ordner: Icon-Name aus der Icon-Bibliothek (`null` = Standard) */
	icon: string | null;
	/** Ordner: Farbe `#rrggbb` (`null` = Standard) */
	color: string | null;
	createdBy: UserRef | null;
	/** Über einen Upload-Link hochgeladen: angegebener Name (oder leer = ohne Namen) */
	uploadedByName: string | null;
	/** Über einen öffentlichen Upload-Link hochgeladen */
	viaLink: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface Breadcrumb {
	/** `null` = Wurzel („Dateien“) */
	id: string | null;
	name: string;
}

export interface FolderListing {
	/** `null` = Wurzel */
	folder: FileNode | null;
	breadcrumbs: Breadcrumb[];
	/** Zugriff im aktuellen Ordner (bestimmt Upload/Neuer Ordner) */
	access: AccessLevel;
	/** Ordner zuerst, dann Dateien, je nach Name (de, ohne Groß/Klein) */
	items: FileNode[];
}

export interface SearchResult {
	items: (FileNode & { path: string })[];
	truncated: boolean;
}

export interface TrashItem {
	id: string;
	kind: NodeKind;
	name: string;
	/** Ursprünglicher Ort, z. B. „Dateien / Fotos“ */
	originalPath: string;
	sizeBytes: number;
	deletedAt: string;
	deletedBy: UserRef | null;
	/** Endgültiges Löschen am */
	purgeOn: string;
}

export interface NodeShare extends PrincipalInfo {
	level: ShareLevel;
}

export interface NodeShares {
	shares: NodeShare[];
	/** Von übergeordneten Ordnern geerbt (nur Anzeige) */
	inherited: (NodeShare & { fromId: string; fromName: string })[];
}

export interface ShareLink {
	id: string;
	nodeId: string;
	mode: LinkMode;
	/** Link-URL (jederzeit; `null` nur bei alten Links aus der Zeit vor 0003) */
	url: string | null;
	expiresOn: string | null;
	hasPassword: boolean;
	active: boolean;
	revokedAt: string | null;
	accessCount: number;
	lastAccessAt: string | null;
	createdBy: UserRef | null;
	createdAt: string;
}

export interface PublicNode {
	id: string;
	kind: NodeKind;
	name: string;
	/** Ordner: Icon und Farbe (sonst `null`) */
	icon: string | null;
	color: string | null;
	contentType: string | null;
	sizeBytes: number | null;
	hasThumb: boolean;
	updatedAt: string;
}

export interface PublicLinkInfo {
	name: string;
	kind: NodeKind;
	mode: LinkMode;
	needsPassword: boolean;
	expiresOn: string | null;
	/** Grenzen für Upload-Links (sonst `null`) */
	upload: {
		maxFileBytes: number;
		maxFiles: number;
		maxRequestBytes: number;
		allowedContentTypes: string[];
	} | null;
	/** nur bei Datei-Links bzw. nach Freischalten */
	node: PublicNode | null;
}

export interface PublicListing {
	breadcrumbs: Breadcrumb[];
	items: PublicNode[];
}

export interface Quota {
	usedBytes: number;
	/** `null` = unbegrenzt */
	limitBytes: number | null;
}

/** Kontingent einer Person für die Verwaltung (GET/PUT `/quotas/:userId`) */
export interface UserQuota {
	userId: string;
	mode: QuotaMode;
	/** eigenes Limit in MB (nur bei `custom`) */
	customMb: number | null;
	/** Standard aus den Einstellungen (`null` = unbegrenzt) */
	defaultBytes: number | null;
	/** wirksames Limit (`null` = unbegrenzt) */
	limitBytes: number | null;
	usedBytes: number;
}

export interface FilesMeta {
	quota: Quota;
	maxFileBytes: number;
	allowedContentTypes: string[];
	trashDays: number;
	can: {
		linkCreate: boolean;
		manageAll: boolean;
	};
}

export interface BulkResult {
	affected: number;
}

/** Antwort auf einen öffentlichen Upload */
export interface PublicUploadResult {
	uploaded: { name: string; sizeBytes: number }[];
}

// --- Zuletzt geändert (Dashboard, `GET /recent`) ----------------------------------

export const RECENT_DEFAULT_LIMIT = 8;
export const RECENT_MAX_LIMIT = 20;

export const recentQuery = z.object({
	limit: z.coerce.number().int().min(1).max(RECENT_MAX_LIMIT).default(RECENT_DEFAULT_LIMIT)
});

export type RecentQuery = z.infer<typeof recentQuery>;

/** Zuletzt geänderte Datei, die der Aufrufer besitzt oder per Freigabe sehen darf */
export interface RecentFile {
	id: string;
	name: string;
	/** Inhaltstyp (`application/pdf` …) */
	mime: string | null;
	size: number;
	/** ISO-Zeitstempel */
	updatedAt: string;
	/** Elternordner, wenn der Aufrufer ihn öffnen darf (sonst `null` = Wurzel „Dateien“) */
	parentId: string | null;
	own: boolean;
	hasThumb: boolean;
}
