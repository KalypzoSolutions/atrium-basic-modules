/**
 * Hilfen für die Oberfläche des Moduls `files` (ohne Server-Imports).
 */
import Folder from '@lucide/svelte/icons/folder';
import { ApiClientError } from '$lib/sdk/client';
import { FILE_KIND_ICONS, fileTypeOf } from './file-types';
import { formatDateTimeDe } from '$lib/sdk/dates';
import {
	BASE_PATH,
	PREVIEW_IMAGE_TYPES,
	PREVIEW_PDF,
	PREVIEW_TEXT_TYPES,
	type FileNode,
	type NodeKind
} from '../schemas';

/** Basis für `apiFetch` (`/modules/files`) */
export const API = BASE_PATH;
/** Basis für rohe URLs (img/a/fetch) */
export const RAW_API = `/api/v1${BASE_PATH}`;

export type PreviewKind = 'image' | 'pdf' | 'text';

/** Welche Vorschau gibt es für den Typ? `null` = nur Dateiinfo + Download */
export function previewKind(contentType: string | null | undefined): PreviewKind | null {
	const t = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
	if ((PREVIEW_IMAGE_TYPES as readonly string[]).includes(t)) return 'image';
	if (t === PREVIEW_PDF) return 'pdf';
	if ((PREVIEW_TEXT_TYPES as readonly string[]).includes(t)) return 'text';
	return null;
}

/** „0 B“, „512 B“, „1,2 KB“, „3,4 MB“, „1,1 GB“ (de-DE, Basis 1024) */
export function formatBytes(bytes: number | null | undefined): string {
	const n = Number.isFinite(bytes) && (bytes ?? 0) > 0 ? (bytes as number) : 0;
	if (n < 1024) return `${Math.round(n)} B`;
	const units = ['KB', 'MB', 'GB', 'TB'];
	let v = n / 1024;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v.toLocaleString('de-DE', { maximumFractionDigits: v < 10 ? 1 : 0 })} ${units[i]}`;
}

/** Icon-Komponente für Ordner bzw. Dateityp (Typ über Content-Type, sonst Endung des Namens) */
export function iconFor(kind: NodeKind, contentType: string | null | undefined, name?: string) {
	if (kind === 'folder') return Folder;
	return FILE_KIND_ICONS[fileTypeOf(contentType, name).kind];
}

/** Inhalt (inline bzw. Download) eines Knotens */
export function contentUrl(id: string, download = false): string {
	return `${RAW_API}/nodes/${id}/content${download ? '?download=1' : ''}`;
}

export function thumbUrl(node: Pick<FileNode, 'id' | 'hasThumb' | 'updatedAt'>): string | null {
	return node.hasThumb
		? `${RAW_API}/nodes/${node.id}/thumb?v=${encodeURIComponent(node.updatedAt)}`
		: null;
}

/** ISO-Zeitstempel → „19.10.2026, 14:05“ */
export const formatDateTime = (iso: string | null | undefined): string =>
	formatDateTimeDe(iso, iso ?? '');

/** Verständlicher Fehlertext aus einem API-Fehler */
export function errorText(e: unknown, fallback: string): string {
	if (e instanceof ApiClientError) return e.message || fallback;
	return fallback;
}

/** Ordner zuerst, dann Name (de, ohne Groß/Klein, Zahlen natürlich) */
export function compareNodes(
	a: Pick<FileNode, 'kind' | 'name'>,
	b: Pick<FileNode, 'kind' | 'name'>
): number {
	if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
	return a.name.localeCompare(b.name, 'de', { sensitivity: 'base', numeric: true });
}

/** MIME-Typ für den Drag-&-Drop-Transfer beim Verschieben (Liste von Knoten-IDs als JSON) */
export const DRAG_MIME = 'application/x-ep-files-nodes';

/** Aktionen auf Einträgen (Menü, Tastatur, Mehrfachauswahl) */
export type NodeAction =
	'open' | 'download' | 'rename' | 'style' | 'move' | 'share' | 'link' | 'info' | 'trash';

/**
 * Name in Stücke für weiche Umbrüche (`<wbr>` dazwischen): nach `_`, `-`, `.`, `/` und vor Ziffernfolgen nach
 * Buchstaben – so bricht „Einladung_Stammesthing_2026.pdf“ an den Unterstrichen statt mitten im Wort.
 */
export function breakableName(name: string): string[] {
	return name.split(/(?<=[_\-./])|(?<=[A-Za-zÄÖÜäöüß])(?=\d)/u).filter((p) => p.length > 0);
}

/** „Leer“, „1 Eintrag“, „12 Einträge · 4,1 MB“ */
export function folderMeta(node: Pick<FileNode, 'childCount' | 'folderBytes'>): string {
	const n = node.childCount ?? 0;
	if (n === 0) return 'Leer';
	const count = n === 1 ? '1 Eintrag' : `${n.toLocaleString('de-DE')} Einträge`;
	return node.folderBytes ? `${count} · ${formatBytes(node.folderBytes)}` : count;
}

/** Minimale Form für die Vorschau (intern `FileNode`, öffentlich `PublicNode`) */
export interface PreviewNode {
	id: string;
	name: string;
	contentType: string | null;
	sizeBytes: number | null;
	hasThumb: boolean;
	updatedAt: string;
}

/** URL eines Inhalts für die Vorschau (intern vs. öffentlicher Link) */
export type ContentUrlFn = (
	node: PreviewNode,
	opts: { download?: boolean; thumb?: boolean }
) => string;

/** Standard: interne Endpunkte */
export const internalUrl: ContentUrlFn = (node, opts) =>
	opts.thumb ? `${RAW_API}/nodes/${node.id}/thumb` : contentUrl(node.id, !!opts.download);

/** Ansichten der Seite (`?view=`): Dateien (Standard) oder Papierkorb */
export const VIEWS = ['files', 'trash'] as const;
export type View = (typeof VIEWS)[number];
export const VIEW_LABELS: Record<View, string> = {
	files: 'Dateien',
	trash: 'Papierkorb'
};
