/**
 * Export von Aufgaben (rein, Server + Tests): ein gemeinsames Modell `ExportDoc` (Abschnitte mit Aufgaben) und
 * daraus HTML-Fragment (auch Inhalt des PDF über den Core-Block `richText`), eigenständige HTML-Datei, Markdown
 * und CSV. Das HTML-Fragment nutzt nur, was `sanitizeDocumentHtml` stehen lässt (Tabellen, `color`/`background-color`,
 * Checklisten als `ul.task-list`), damit das PDF genauso aussieht wie die HTML-Datei.
 */
import { z } from 'zod';
import { csvDocument } from '$lib/sdk/csv';
import { formatDateDe } from '$lib/sdk/dates';
import { safeFileName } from '$lib/sdk/file-names';
import { MAX_TASKS_PER_BOARD, PRIORITY_LABELS, type Priority } from './schemas';

export const EXPORT_FORMATS = ['pdf', 'png', 'html', 'csv', 'md'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const EXPORT_FORMAT_LABELS: Record<ExportFormat, string> = {
	pdf: 'PDF',
	png: 'Bild (PNG)',
	html: 'HTML',
	csv: 'CSV (Excel)',
	md: 'Markdown'
};

export const EXPORT_FORMAT_DESCRIPTIONS: Record<ExportFormat, string> = {
	pdf: 'Zum Drucken und Weitergeben.',
	png: 'Wie das PDF als Bild – bei mehreren Seiten ein ZIP mit einem Bild je Seite.',
	html: 'Eine Webseite zum Öffnen im Browser.',
	csv: 'Tabelle zum Weiterbearbeiten in Excel oder LibreOffice.',
	md: 'Text mit Checklisten, z. B. für Notizen oder Chats.'
};

/** Gruppierung beim Board-Export */
export const BOARD_GROUPS = ['column', 'phase', 'none'] as const;
export type BoardGroup = (typeof BOARD_GROUPS)[number];
export const BOARD_GROUP_LABELS: Record<BoardGroup, string> = {
	column: 'Nach Spalten',
	phase: 'Nach Phasen',
	none: 'Eine Liste'
};

/** PNG: höchstens so viele Seiten (sonst PDF wählen) */
export const MAX_PNG_PAGES = 30;
/** Lange Kante je Seite in Pixeln (A4 ≈ 190 dpi, unter `MAX_RASTER_PIXELS` des Core) */
export const PNG_MAX_EDGE = 2200;
/** „Meine Aufgaben“: höchstens so viele Aufgaben */
export const MAX_MY_EXPORT = 500;

export interface ExportItem {
	title: string;
	done: boolean;
	assignee: string | null;
	dueOn: string | null;
}

export interface ExportTask {
	title: string;
	/** Board-Name (nur bei „Meine Aufgaben“) */
	board: string | null;
	column: string;
	phase: string | null;
	priority: Priority;
	startsOn: string | null;
	dueOn: string | null;
	isMilestone: boolean;
	done: boolean;
	assignees: string[];
	description: string | null;
	items: ExportItem[];
}

export interface ExportSection {
	/** `null` = keine eigene Überschrift (eine Liste) */
	title: string | null;
	color: string | null;
	tasks: ExportTask[];
}

export interface ExportDoc {
	title: string;
	/** Zeilen unter dem Titel (Board-Beschreibung, Filter, Stand) */
	subtitle: string[];
	sections: ExportSection[];
	/** Beschreibung und Unteraufgaben je Aufgabe statt einer Tabelle */
	detailed: boolean;
	/** Zusatzspalten der Übersicht */
	show: { board: boolean; column: boolean; phase: boolean };
	/** Eine einzelne Aufgabe: Titel steht schon als Dokument-Titel, keine eigene Überschrift */
	single?: boolean;
}

// --- Gruppieren ---------------------------------------------------------------

interface Named {
	id: string;
	name: string;
	color?: string | null;
}

/**
 * Aufgaben in Abschnitte teilen. `order` gibt die Reihenfolge der Gruppen vor; Aufgaben ohne Gruppe landen in
 * `rest` (z. B. „Ohne Phase“) am Ende. Leere Gruppen entfallen.
 */
export function groupTasks<T>(
	tasks: readonly T[],
	keyOf: (t: T) => string | null,
	order: readonly Named[],
	rest: string,
	toTask: (t: T) => ExportTask
): ExportSection[] {
	const buckets = new Map<string | null, ExportTask[]>();
	for (const t of tasks) {
		const k = keyOf(t);
		const known = k !== null && order.some((o) => o.id === k) ? k : null;
		const list = buckets.get(known) ?? [];
		list.push(toTask(t));
		buckets.set(known, list);
	}
	const sections: ExportSection[] = [];
	for (const o of order) {
		const list = buckets.get(o.id);
		if (list?.length) sections.push({ title: o.name, color: o.color ?? null, tasks: list });
	}
	const none = buckets.get(null);
	if (none?.length) sections.push({ title: rest, color: null, tasks: none });
	return sections;
}

export const taskCount = (doc: ExportDoc) => doc.sections.reduce((n, s) => n + s.tasks.length, 0);

// --- Texte ----------------------------------------------------------------------

const date = (iso: string | null) => (iso ? formatDateDe(iso) : '');

/** „12.11.2026“, „ab 01.11. bis 12.11.2026“ bzw. „◆ 12.11.2026“ beim Meilenstein */
export function dateText(t: Pick<ExportTask, 'startsOn' | 'dueOn' | 'isMilestone'>): string {
	if (t.isMilestone && t.dueOn) return `◆ ${date(t.dueOn)}`;
	if (t.startsOn && t.dueOn) return `${date(t.startsOn)} – ${date(t.dueOn)}`;
	if (t.startsOn) return `ab ${date(t.startsOn)}`;
	return date(t.dueOn);
}

export function checklistText(items: readonly ExportItem[]): string {
	if (!items.length) return '';
	return `${items.filter((i) => i.done).length}/${items.length}`;
}

/** Kurze Metazeile einer Aufgabe (Detail-Ansicht, Markdown) */
export function metaParts(t: ExportTask, show: ExportDoc['show']): string[] {
	const parts: string[] = [];
	if (show.board && t.board) parts.push(`Board: ${t.board}`);
	if (show.column) parts.push(`Spalte: ${t.column}`);
	if (show.phase && t.phase) parts.push(`Phase: ${t.phase}`);
	parts.push(`Priorität: ${PRIORITY_LABELS[t.priority]}`);
	const d = dateText(t);
	if (d) parts.push(t.isMilestone ? `Meilenstein: ${d.slice(2)}` : `Termin: ${d}`);
	if (t.assignees.length) parts.push(`Zuständig: ${t.assignees.join(', ')}`);
	return parts;
}

function itemSuffix(i: ExportItem): string {
	const bits = [i.assignee, i.dueOn ? `bis ${date(i.dueOn)}` : null].filter(Boolean);
	return bits.length ? ` (${bits.join(', ')})` : '';
}

// --- HTML ---------------------------------------------------------------------

export function escapeHtml(value: unknown): string {
	return String(value ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

const HEX = /^#[0-9a-f]{6}$/i;
const MUTED = '#6b7280';

/** Absätze aus Klartext (Leerzeilen trennen, Zeilenumbrüche bleiben) */
function paragraphs(text: string): string {
	return text
		.trim()
		.split(/\n{2,}/)
		.map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
		.join('');
}

function sectionHeading(s: ExportSection): string {
	if (!s.title) return '';
	const color = s.color && HEX.test(s.color) ? ` style="color: ${s.color.toLowerCase()}"` : '';
	const count = s.tasks.length === 1 ? '1 Aufgabe' : `${s.tasks.length} Aufgaben`;
	return `<h2${color}>${escapeHtml(s.title)} <span style="color: ${MUTED}; font-size: 11pt">· ${count}</span></h2>`;
}

function tableHtml(s: ExportSection, show: ExportDoc['show']): string {
	const cols: { label: string; width: number; cell: (t: ExportTask) => string }[] = [
		{
			label: 'Aufgabe',
			width: 34,
			cell: (t) => (t.done ? `<s>${escapeHtml(t.title)}</s>` : escapeHtml(t.title))
		}
	];
	if (show.board) cols.push({ label: 'Board', width: 14, cell: (t) => escapeHtml(t.board ?? '') });
	if (show.column) cols.push({ label: 'Spalte', width: 12, cell: (t) => escapeHtml(t.column) });
	if (show.phase) cols.push({ label: 'Phase', width: 12, cell: (t) => escapeHtml(t.phase ?? '') });
	cols.push(
		{ label: 'Zuständig', width: 16, cell: (t) => escapeHtml(t.assignees.join(', ')) },
		{ label: 'Termin', width: 14, cell: (t) => escapeHtml(dateText(t)) },
		{ label: 'Priorität', width: 9, cell: (t) => escapeHtml(PRIORITY_LABELS[t.priority]) },
		{ label: 'Unteraufg.', width: 7, cell: (t) => escapeHtml(checklistText(t.items)) }
	);
	const total = cols.reduce((n, c) => n + c.width, 0);
	const head = cols
		.map((c) => `<th style="width: ${Math.round((c.width / total) * 100)}%">${c.label}</th>`)
		.join('');
	const rows = s.tasks
		.map((t) => `<tr>${cols.map((c) => `<td>${c.cell(t)}</td>`).join('')}</tr>`)
		.join('');
	return `<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}

function checklistHtml(items: readonly ExportItem[]): string {
	if (!items.length) return '';
	const lis = items
		.map(
			(i) =>
				`<li class="task-item${i.done ? ' checked' : ''}"><input type="checkbox" disabled${i.done ? ' checked' : ''}><div>${escapeHtml(i.title)}${escapeHtml(itemSuffix(i))}</div></li>`
		)
		.join('');
	return `<ul class="task-list">${lis}</ul>`;
}

function detailHtml(t: ExportTask, show: ExportDoc['show'], single: boolean): string {
	const title = `${t.done ? '✓ ' : ''}${t.title}`;
	const meta = `<p style="color: ${MUTED}; font-size: 10pt">${escapeHtml(metaParts(t, show).join(' · '))}</p>`;
	const desc = t.description?.trim() ? paragraphs(t.description) : '';
	const items = t.items.length
		? `<p><strong>Unteraufgaben (${checklistText(t.items)})</strong></p>${checklistHtml(t.items)}`
		: '';
	return `${single ? '' : `<h3>${escapeHtml(title)}</h3>`}${meta}${desc}${items}`;
}

/** Inhalt ohne Dokument-Titel (den druckt die PDF-Vorlage bzw. `htmlDocument`) */
export function docFragment(doc: ExportDoc): string {
	const out: string[] = [];
	for (const line of doc.subtitle) {
		out.push(`<p style="color: ${MUTED}">${escapeHtml(line)}</p>`);
	}
	if (!taskCount(doc)) {
		out.push('<p>Keine Aufgaben.</p>');
		return out.join('');
	}
	for (const s of doc.sections) {
		out.push(sectionHeading(s));
		if (doc.detailed) {
			if (s.title) out.push('<hr>');
			out.push(s.tasks.map((t) => detailHtml(t, doc.show, !!doc.single)).join('<hr>'));
		} else {
			out.push(tableHtml(s, doc.show));
		}
	}
	return out.join('');
}

const DOCUMENT_CSS = `
:root { color-scheme: light; }
body { font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #111827; background: #fff;
	max-width: 60rem; margin: 2rem auto; padding: 0 1rem; }
h1 { font-size: 1.75rem; margin: 0 0 .25rem; }
h2 { font-size: 1.25rem; margin: 2rem 0 .5rem; }
h3 { font-size: 1.05rem; margin: 1.25rem 0 .25rem; }
p { margin: .35rem 0; }
hr { border: 0; border-top: 1px solid #e5e7eb; margin: 1rem 0; }
table { width: 100%; border-collapse: collapse; font-size: .9rem; }
th, td { text-align: left; vertical-align: top; padding: .4rem .5rem; border-bottom: 1px solid #e5e7eb; }
th { background: #f3f4f6; font-weight: 600; }
s { color: #6b7280; }
ul.task-list { list-style: none; padding-left: .2rem; }
li.task-item { display: flex; gap: .5rem; align-items: flex-start; }
li.task-item input { margin: .3rem 0 0; }
li.task-item.checked > div { color: #6b7280; text-decoration: line-through; }
@media print { body { margin: 0; max-width: none; } }
`;

/** Eigenständige HTML-Datei (ohne Skripte, ohne externe Quellen) */
export function htmlDocument(doc: ExportDoc): string {
	return [
		'<!doctype html>',
		'<html lang="de">',
		'<head>',
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		`<title>${escapeHtml(doc.title)}</title>`,
		`<style>${DOCUMENT_CSS}</style>`,
		'</head>',
		'<body>',
		`<h1>${escapeHtml(doc.title)}</h1>`,
		docFragment(doc),
		'</body>',
		'</html>',
		''
	].join('\n');
}

// --- Markdown -----------------------------------------------------------------

/** Zeichen mit Bedeutung in Markdown entschärfen (Inline-Text) */
export function escapeMd(text: string): string {
	return text.replace(/[\\`*_[\]<>#|~]/g, (c) => `\\${c}`).replace(/\s*\n\s*/g, ' ');
}

export function markdownDocument(doc: ExportDoc): string {
	const out: string[] = [`# ${escapeMd(doc.title)}`, ''];
	for (const line of doc.subtitle) out.push(`_${escapeMd(line)}_`, '');
	if (!taskCount(doc)) {
		out.push('Keine Aufgaben.', '');
		return out.join('\n');
	}
	const single = doc.sections.length === 1 && !doc.sections[0]!.title;
	for (const s of doc.sections) {
		if (s.title) out.push(`## ${escapeMd(s.title)}`, '');
		for (const t of s.tasks) {
			const level = single ? '##' : '###';
			if (doc.detailed) {
				if (!doc.single) out.push(`${level} ${t.done ? '[x]' : '[ ]'} ${escapeMd(t.title)}`, '');
				out.push(metaParts(t, doc.show).map(escapeMd).join(' · '), '');
				if (t.description?.trim()) {
					out.push(
						t.description
							.trim()
							.split('\n')
							.map((l) => l.replace(/^(\s*)([#>|-]|\d+\.)/, '$1\\$2'))
							.join('\n'),
						''
					);
				}
				for (const i of t.items) {
					out.push(`- [${i.done ? 'x' : ' '}] ${escapeMd(i.title + itemSuffix(i))}`);
				}
				if (t.items.length) out.push('');
			} else {
				const meta = metaParts(t, doc.show).map(escapeMd).join(' · ');
				const items = t.items.length ? ` · Unteraufgaben ${checklistText(t.items)}` : '';
				out.push(`- [${t.done ? 'x' : ' '}] **${escapeMd(t.title)}** — ${meta}${items}`);
			}
		}
		if (!doc.detailed) out.push('');
	}
	return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

// --- CSV ----------------------------------------------------------------------

/** Eine Zeile je Aufgabe; Abschnitt, Unteraufgaben als Text mit ☑/☐ */
export function csvExport(doc: ExportDoc): string {
	const header = [
		...(doc.show.board ? ['Board'] : []),
		'Spalte',
		'Phase',
		'Aufgabe',
		'Erledigt',
		'Priorität',
		'Beginn',
		'Fällig',
		'Meilenstein',
		'Zuständig',
		'Unteraufgaben erledigt',
		'Unteraufgaben gesamt',
		'Unteraufgaben',
		'Beschreibung'
	];
	const rows = doc.sections.flatMap((s) =>
		s.tasks.map((t) => [
			...(doc.show.board ? [t.board ?? ''] : []),
			t.column,
			t.phase ?? '',
			t.title,
			t.done ? 'ja' : 'nein',
			PRIORITY_LABELS[t.priority],
			date(t.startsOn),
			date(t.dueOn),
			t.isMilestone ? 'ja' : 'nein',
			t.assignees.join(', '),
			t.items.filter((i) => i.done).length,
			t.items.length,
			t.items.map((i) => `${i.done ? '☑' : '☐'} ${i.title}${itemSuffix(i)}`).join('\n'),
			t.description ?? ''
		])
	);
	return csvDocument(header, rows);
}

// --- Dateiname ----------------------------------------------------------------

export const EXPORT_EXTENSIONS: Record<ExportFormat, string> = {
	pdf: 'pdf',
	png: 'png',
	html: 'html',
	csv: 'csv',
	md: 'md'
};

export function exportFileName(base: string, ext: string): string {
	return `${safeFileName(base, { german: true, fallback: 'aufgaben', maxLength: 90 })}.${ext}`;
}

// --- Eingaben -----------------------------------------------------------------

const formatField = z.enum(EXPORT_FORMATS, 'Unbekanntes Format');

/** POST `/boards/:id/export` */
export const boardExportInput = z
	.object({
		format: formatField,
		groupBy: z.enum(BOARD_GROUPS).default('column'),
		detailed: z.boolean().default(false),
		includeDone: z.boolean().default(true),
		letterhead: z.boolean().default(false),
		/** Nur diese Aufgaben (aktive Filter der Seite); fehlt = alle */
		taskIds: z.array(z.uuid('Ungültige ID')).max(MAX_TASKS_PER_BOARD).optional(),
		/** Beschreibung der Filter für die Kopfzeile, z. B. „Filter: Priorität hoch“ */
		filterLabel: z.string().trim().max(300).optional()
	})
	.strict();
export type BoardExportInput = z.input<typeof boardExportInput>;

/** POST `/tasks/:id/export` */
export const taskExportInput = z
	.object({ format: formatField, letterhead: z.boolean().default(false) })
	.strict();
export type TaskExportInput = z.input<typeof taskExportInput>;

/** POST `/my/tasks/export` */
export const myExportInput = z
	.object({
		format: formatField,
		detailed: z.boolean().default(false),
		includeDone: z.boolean().default(false),
		letterhead: z.boolean().default(false)
	})
	.strict();
export type MyExportInput = z.input<typeof myExportInput>;
