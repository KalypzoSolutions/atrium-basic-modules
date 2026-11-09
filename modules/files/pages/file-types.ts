/**
 * Dateityp für die Anzeige (Symbol, Farbe, Kürzel) – rein, ohne Server-Imports.
 *
 * Erkennung über den Content-Type, als Rückfall über die Endung (z. B. `.docx`, das der Browser als
 * `application/octet-stream` geschickt hat). Farben kommen aus den Tokens `--file-<art>` in `app.css`
 * (`text-file-<art>`, `bg-file-<art>-muted`); „other“ und „text“ bleiben neutral grau.
 */
import File from '@lucide/svelte/icons/file';
import FileArchive from '@lucide/svelte/icons/file-archive';
import FileCode from '@lucide/svelte/icons/file-code';
import FileImage from '@lucide/svelte/icons/file-image';
import FileMusic from '@lucide/svelte/icons/file-music';
import FileSpreadsheet from '@lucide/svelte/icons/file-spreadsheet';
import FileText from '@lucide/svelte/icons/file-text';
import FileType from '@lucide/svelte/icons/file-type';
import FileVideoCamera from '@lucide/svelte/icons/file-video-camera';
import Presentation from '@lucide/svelte/icons/presentation';
import { splitExtension } from '../names';

export const FILE_KINDS = [
	'pdf',
	'word',
	'sheet',
	'slides',
	'image',
	'text',
	'code',
	'archive',
	'audio',
	'video',
	'other'
] as const;
export type FileKind = (typeof FILE_KINDS)[number];

export const FILE_KIND_LABELS: Record<FileKind, string> = {
	pdf: 'PDF-Dokument',
	word: 'Textdokument',
	sheet: 'Tabelle',
	slides: 'Präsentation',
	image: 'Bild',
	text: 'Textdatei',
	code: 'Code',
	archive: 'Archiv',
	audio: 'Audiodatei',
	video: 'Video',
	other: 'Datei'
};

/** Symbol je Art */
export const FILE_KIND_ICONS = {
	pdf: FileType,
	word: FileText,
	sheet: FileSpreadsheet,
	slides: Presentation,
	image: FileImage,
	text: FileText,
	code: FileCode,
	archive: FileArchive,
	audio: FileMusic,
	video: FileVideoCamera,
	other: File
} satisfies Record<FileKind, unknown>;

/**
 * Farbklassen je Art (statisch ausgeschrieben, damit Tailwind sie findet). Text und Sonstiges bleiben neutral,
 * Audio und Video teilen sich `media`.
 */
export const FILE_KIND_CLASSES: Record<FileKind, { text: string; tint: string }> = {
	pdf: { text: 'text-file-pdf', tint: 'bg-file-pdf-muted' },
	word: { text: 'text-file-word', tint: 'bg-file-word-muted' },
	sheet: { text: 'text-file-sheet', tint: 'bg-file-sheet-muted' },
	slides: { text: 'text-file-slides', tint: 'bg-file-slides-muted' },
	image: { text: 'text-file-image', tint: 'bg-file-image-muted' },
	text: { text: 'text-muted-foreground', tint: 'bg-muted/50' },
	code: { text: 'text-file-code', tint: 'bg-file-code-muted' },
	archive: { text: 'text-file-archive', tint: 'bg-file-archive-muted' },
	audio: { text: 'text-file-media', tint: 'bg-file-media-muted' },
	video: { text: 'text-file-media', tint: 'bg-file-media-muted' },
	other: { text: 'text-muted-foreground', tint: 'bg-muted/50' }
};

const EXTENSION_KINDS: Record<string, FileKind> = {
	pdf: 'pdf',
	doc: 'word',
	docx: 'word',
	dot: 'word',
	dotx: 'word',
	docm: 'word',
	odt: 'word',
	ott: 'word',
	rtf: 'word',
	pages: 'word',
	xls: 'sheet',
	xlsx: 'sheet',
	xlt: 'sheet',
	xltx: 'sheet',
	xlsm: 'sheet',
	ods: 'sheet',
	ots: 'sheet',
	csv: 'sheet',
	numbers: 'sheet',
	ppt: 'slides',
	pptx: 'slides',
	pot: 'slides',
	potx: 'slides',
	pps: 'slides',
	ppsx: 'slides',
	odp: 'slides',
	otp: 'slides',
	key: 'slides',
	jpg: 'image',
	jpeg: 'image',
	png: 'image',
	gif: 'image',
	webp: 'image',
	avif: 'image',
	heic: 'image',
	heif: 'image',
	bmp: 'image',
	tif: 'image',
	tiff: 'image',
	svg: 'image',
	txt: 'text',
	md: 'text',
	log: 'text',
	json: 'code',
	xml: 'code',
	html: 'code',
	htm: 'code',
	css: 'code',
	js: 'code',
	ts: 'code',
	yml: 'code',
	yaml: 'code',
	zip: 'archive',
	rar: 'archive',
	'7z': 'archive',
	tar: 'archive',
	gz: 'archive',
	mp3: 'audio',
	wav: 'audio',
	m4a: 'audio',
	ogg: 'audio',
	flac: 'audio',
	mp4: 'video',
	mov: 'video',
	webm: 'video',
	avi: 'video',
	mkv: 'video'
};

function kindFromType(t: string): FileKind | null {
	if (!t || t === 'application/octet-stream') return null;
	if (t === 'application/pdf') return 'pdf';
	if (t.startsWith('image/')) return 'image';
	if (t.startsWith('audio/')) return 'audio';
	if (t.startsWith('video/')) return 'video';
	if (t === 'text/csv') return 'sheet';
	if (
		t.includes('wordprocessingml') ||
		t === 'application/msword' ||
		t === 'application/rtf' ||
		t === 'text/rtf' ||
		t.startsWith('application/vnd.oasis.opendocument.text')
	)
		return 'word';
	if (
		t.includes('spreadsheetml') ||
		t === 'application/vnd.ms-excel' ||
		t.startsWith('application/vnd.oasis.opendocument.spreadsheet')
	)
		return 'sheet';
	if (
		t.includes('presentationml') ||
		t === 'application/vnd.ms-powerpoint' ||
		t.startsWith('application/vnd.oasis.opendocument.presentation')
	)
		return 'slides';
	if (
		t === 'application/zip' ||
		t === 'application/x-zip-compressed' ||
		t === 'application/gzip' ||
		t === 'application/x-7z-compressed' ||
		t === 'application/vnd.rar' ||
		t === 'application/x-tar'
	)
		return 'archive';
	if (t === 'application/json' || t === 'application/xml' || t === 'text/html' || t === 'text/xml')
		return 'code';
	if (t.startsWith('text/')) return 'text';
	return null;
}

export interface FileTypeInfo {
	kind: FileKind;
	/** Kurzes Kürzel für das Abzeichen, z. B. „DOCX“, „PDF“ (leer, wenn nichts Sinnvolles bekannt ist) */
	badge: string;
	/** Beschreibung für Screenreader/Tooltip, z. B. „Tabelle“ */
	label: string;
}

/** Art, Kürzel und Beschreibung eines Dateityps */
export function fileTypeOf(
	contentType: string | null | undefined,
	name?: string | null
): FileTypeInfo {
	const t = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
	const ext = name ? splitExtension(name)[1].slice(1).toLowerCase() : '';
	const kind = kindFromType(t) ?? EXTENSION_KINDS[ext] ?? 'other';
	const badge = ext && ext.length <= 4 ? ext.toUpperCase() : kind === 'pdf' ? 'PDF' : '';
	return { kind, badge, label: FILE_KIND_LABELS[kind] };
}

/** Getönte Vorschaufläche (Klasse) für eine Datei ohne Vorschaubild */
export function fileTint(contentType: string | null | undefined, name?: string | null): string {
	return FILE_KIND_CLASSES[fileTypeOf(contentType, name).kind].tint;
}
