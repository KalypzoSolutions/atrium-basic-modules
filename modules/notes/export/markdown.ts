/**
 * Markdown-Export und -Import der Notizen (`@tiptap/markdown` mit dem Notiz-Schema).
 *
 * Export:
 *   - `.md`: alle Seiten hintereinander, je Seite `# Titel`, getrennt durch `---`. Bilder lassen sich in eine
 *     einzelne Textdatei nicht einbetten → **Hinweis-Link** `[Bild: <Alt-Text>](<App-Adresse des Bildes>)` (öffnet das
 *     Bild nach Anmeldung in der App); Bilder ohne Zugriff/aus fremden Notizen nur als Text `[Bild: …]`.
 *   - `.zip`: je Seite eine `.md`, Unterseiten im gleichnamigen Ordner (`Lager.md` + `Lager/Planung.md`), Bilder unter
 *     `bilder/<n>-<name>.webp`, im Text relativ verlinkt (`../bilder/…`). Der Import liest genau diese Struktur zurück.
 *   - Einbettungen (Whiteboard …) werden zu einer Zeile „[Whiteboard: <Titel>](<absolute Adresse>)“.
 */
import { MarkdownManager } from '@tiptap/markdown';
import { safeFileName } from '$lib/sdk/file-names';
import { assetUrl, isUuid, noteExtensions } from '../doc/extensions';
import { walk, type PmNode } from '../doc/text';
import { embedKey, embedLabel, type ResolvedEmbed } from './embeds';

let manager: MarkdownManager | null = null;

/** Gemeinsamer Markdown-Wandler (Schema der Notizen) */
export function markdownManager(): MarkdownManager {
	manager ??= new MarkdownManager({ extensions: noteExtensions() });
	return manager;
}

export interface MarkdownPage {
	id: string;
	parentId: string | null;
	depth: number;
	title: string;
	json: Record<string, unknown>;
}

export interface MarkdownImage {
	id: string;
	name: string;
	bytes: Uint8Array;
}

export interface MarkdownContext {
	/** Verfügbare Bilder (Asset-ID → Bild) */
	images: ReadonlyMap<string, MarkdownImage>;
	embeds: ReadonlyMap<string, ResolvedEmbed>;
	/** Basis-URL der App ohne `/` am Ende (für Hinweis-Links) */
	origin: string;
}

const clone = <T>(v: T): T => structuredClone(v);

/**
 * Inhalt für Markdown vorbereiten: Einbettungen → Absatz mit Link, Bilder ohne verfügbare Datei → nur Alt-Text
 * (`assetId` entfernt).
 */
function prepare(json: Record<string, unknown>, ctx: MarkdownContext): Record<string, unknown> {
	const copy = clone(json) as PmNode;
	for (const node of walk(copy)) {
		const content = Array.isArray(node.content) ? node.content : null;
		if (!content) continue;
		for (let i = 0; i < content.length; i++) {
			const c = content[i]!;
			if (c.type === 'embed') {
				const a = c.attrs ?? {};
				const info =
					typeof a.module === 'string' && typeof a.kind === 'string' && isUuid(a.refId)
						? ctx.embeds.get(embedKey({ module: a.module, kind: a.kind, refId: String(a.refId) }))
						: undefined;
				const label = embedLabel(info);
				const text: PmNode = info?.href
					? { type: 'text', text: label, marks: [{ type: 'link', attrs: { href: info.href } }] }
					: { type: 'text', text: `${label} (nur in der App sichtbar)` };
				content[i] = { type: 'paragraph', content: [text] };
			} else if (c.type === 'image') {
				const id = c.attrs?.assetId;
				if (!isUuid(id) || !ctx.images.has(id)) c.attrs = { ...c.attrs, assetId: null };
			}
		}
	}
	return copy as Record<string, unknown>;
}

const ASSET_REF_RE =
	/!\[([^\]]*)\]\(asset:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\s+"[^"]*")?\)/gi;

/** Markdown einer Seite (ohne Titelzeile); `imageRef` bestimmt das Ziel der Bilder */
export function pageMarkdown(
	json: Record<string, unknown>,
	ctx: MarkdownContext,
	imageRef: (assetId: string, alt: string) => string
): string {
	const md = markdownManager().serialize(prepare(json, ctx));
	return md.replace(ASSET_REF_RE, (_m, alt: string, id: string) => imageRef(id.toLowerCase(), alt));
}

/** Titelzeile (`# …`, Zeilenumbrüche entfernt, Markdown-Sonderzeichen am Anfang entschärft) */
export function titleLine(title: string): string {
	const t = (title || 'Ohne Titel').replace(/\s+/g, ' ').trim();
	return `# ${t.replace(/^([#>*+\-=`])/, '\\$1')}`;
}

/** Eine `.md` mit allen Seiten hintereinander */
export function exportMarkdown(pages: readonly MarkdownPage[], ctx: MarkdownContext): string {
	const parts = pages.map((p) => {
		const body = pageMarkdown(p.json, ctx, (id, alt) => {
			const label = alt ? `Bild: ${alt}` : 'Bild';
			return `[${label}](${ctx.origin}${assetUrl(id, 'web')})`;
		});
		return `${titleLine(p.title)}\n\n${body}`.trimEnd();
	});
	return `${parts.join('\n\n---\n\n')}\n`;
}

/** Datei-/Ordnername aus einem Titel (Pfadzeichen und Steuerzeichen entfernt, ≤ 80 Zeichen) */
export function pathSegment(title: string): string {
	const s = String(title ?? '')
		.normalize('NFC')
		.replace(/[\p{Cc}\\/:*?"<>|]+/gu, ' ')
		.replace(/\s+/g, ' ')
		.replace(/^[.\s]+|[.\s]+$/g, '')
		.slice(0, 80)
		.trim();
	return s || 'Ohne Titel';
}

function unique(name: string, used: Set<string>): string {
	let candidate = name;
	for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${name} (${n})`;
	used.add(candidate.toLowerCase());
	return candidate;
}

/** Dateien für das ZIP (Pfad → Inhalt): Seiten als `.md` in Ordnern, Bilder unter `bilder/` */
export function exportMarkdownFiles(
	pages: readonly MarkdownPage[],
	ctx: MarkdownContext
): Record<string, Uint8Array> {
	const files: Record<string, Uint8Array> = {};
	const enc = new TextEncoder();
	// Bilder: fortlaufend nummeriert, sichere Namen
	const imagePaths = new Map<string, string>();
	let n = 0;
	const imageFile = (id: string): string | null => {
		const img = ctx.images.get(id);
		if (!img) return null;
		let path = imagePaths.get(id);
		if (!path) {
			n++;
			const base = safeFileName(img.name.replace(/\.[A-Za-z0-9]{1,10}$/, ''), {
				german: true,
				maxLength: 60,
				fallback: 'bild'
			});
			path = `bilder/${n}-${base}.webp`;
			imagePaths.set(id, path);
			files[path] = img.bytes;
		}
		return path;
	};
	// Ordner je Seite: Elternordner + eindeutiger Name unter den Geschwistern
	const folderOf = new Map<string, string>();
	const usedIn = new Map<string, Set<string>>();
	for (const p of pages) {
		const parentFolder = p.parentId ? (folderOf.get(p.parentId) ?? '') : '';
		const used = usedIn.get(parentFolder) ?? new Set<string>(['bilder']);
		usedIn.set(parentFolder, used);
		const name = unique(pathSegment(p.title), used);
		const folder = parentFolder ? `${parentFolder}/${name}` : name;
		folderOf.set(p.id, folder);
		const up = '../'.repeat(p.depth);
		const body = pageMarkdown(p.json, ctx, (id, alt) => {
			const path = imageFile(id);
			return path ? `![${alt}](${up}${path})` : alt ? `[Bild: ${alt}]` : '';
		});
		files[`${folder}.md`] = enc.encode(`${titleLine(p.title)}\n\n${body}`.trimEnd() + '\n');
	}
	return files;
}

// --- Import -------------------------------------------------------------------------------------------

/** Markdown → ProseMirror-JSON der Notizen (fremde Bildadressen fallen über das Schema weg) */
export function parseMarkdown(markdown: string): Record<string, unknown> {
	const json = markdownManager().parse(markdown) as Record<string, unknown>;
	const content = Array.isArray(json.content) ? json.content : [];
	return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}

/** Text einer Überschrift */
function headingText(node: PmNode): string {
	const parts: string[] = [];
	for (const n of walk(node))
		if (n.type === 'text' && typeof n.text === 'string') parts.push(n.text);
	return parts.join('').replace(/\s+/g, ' ').trim();
}

/**
 * Titel aus dem Inhalt: Ist der erste Block eine H1, wird sie zum Titel und aus dem Inhalt entfernt (sonst stünde der
 * Titel doppelt da); sonst die erste H1 irgendwo im Text (bleibt stehen), sonst der Ersatztitel.
 */
export function takeTitle(
	json: Record<string, unknown>,
	fallback: string,
	max = 200
): { title: string; json: Record<string, unknown> } {
	const content = (Array.isArray(json.content) ? json.content : []) as PmNode[];
	const isH1 = (n: PmNode | undefined) => n?.type === 'heading' && Number(n.attrs?.level) === 1;
	const first = content[0];
	if (isH1(first)) {
		const title = headingText(first!);
		if (title) {
			const rest = content.slice(1);
			return {
				title: title.slice(0, max),
				json: { ...json, content: rest.length ? rest : [{ type: 'paragraph' }] }
			};
		}
	}
	const h1 = content.find((n) => isH1(n) && headingText(n));
	return { title: (h1 ? headingText(h1) : fallback).slice(0, max), json };
}

const IMAGE_MD_RE = /!\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^)\s]+)(\s+"[^"\n]*")?\s*\)/g;

/**
 * Bild-Verweise in Markdown umschreiben: `resolve(ziel)` liefert eine Asset-ID (→ `asset:<id>`) oder `null`
 * (→ Bild entfällt, Alt-Text bleibt als `[Bild: …]`). Externe Adressen werden nie übernommen.
 */
export function rewriteImageRefs(
	markdown: string,
	resolve: (target: string) => string | null
): string {
	return markdown.replace(IMAGE_MD_RE, (_m, alt: string, rawTarget: string) => {
		const target = rawTarget.startsWith('<') ? rawTarget.slice(1, -1) : rawTarget;
		const id = resolve(target.trim());
		const cleanAlt = alt.replace(/[[\]]/g, '');
		if (id) return `![${cleanAlt}](asset:${id})`;
		return cleanAlt ? `[Bild: ${cleanAlt}]` : '';
	});
}

/** Relativen Verweis gegen den Ordner der `.md` auflösen (`null` = extern, absolut oder außerhalb des Archivs) */
export function resolveRelative(baseDir: string, target: string): string | null {
	let t = target;
	if (/^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith('/') || t.startsWith('\\')) return null;
	t = t.split('#')[0]!.split('?')[0]!;
	try {
		t = decodeURIComponent(t);
	} catch {
		return null;
	}
	const parts = baseDir ? baseDir.split('/') : [];
	for (const seg of t.replace(/\\/g, '/').split('/')) {
		if (!seg || seg === '.') continue;
		if (seg === '..') {
			if (!parts.length) return null;
			parts.pop();
		} else parts.push(seg);
	}
	return parts.length ? parts.join('/') : null;
}

/** Alle Asset-Verweise eines Dokuments (für Tests/Prüfungen) */
export function imageAssetIds(json: unknown): string[] {
	const ids: string[] = [];
	for (const n of walk(json)) {
		if (n.type === 'image' && isUuid(n.attrs?.assetId)) ids.push(String(n.attrs!.assetId));
	}
	return ids;
}
