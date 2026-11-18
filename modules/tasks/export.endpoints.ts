/**
 * Export von Aufgaben als PDF, PNG, HTML, CSV oder Markdown:
 * - POST `/boards/:id/export` – ganzes Board (gruppiert nach Spalten/Phasen, optional nur gefilterte Aufgaben),
 * - POST `/tasks/:id/export` – eine Aufgabe mit Beschreibung und Unteraufgaben,
 * - POST `/my/tasks/export` – mir zugewiesene Aufgaben über alle Boards (wie `GET /my/tasks`).
 * Sichtbar ist genau, was die jeweiligen Lese-Endpunkte zeigen. PNG = PDF-Seiten über `core.pdf.renderPage`
 * (mehrere Seiten → ZIP). POST statt GET, weil die gefilterten Aufgaben-IDs mitkommen können.
 */
import { sql } from 'drizzle-orm';
import { zipSync } from 'fflate';
import {
	type AnyApiEndpoint,
	contentDisposition,
	core,
	defineEndpoint,
	errors,
	inList,
	type RequestContext,
	type Row,
	rowsOf,
	secureFileResponse,
	type Tx
} from '$lib/sdk/server';
import { formatDateDe, todayBerlin } from '$lib/sdk/dates';
import {
	buildDetail,
	buildTask,
	bool,
	loadDetailRows,
	loadTaskRows,
	mdb,
	refOf,
	strOrNull,
	userRefs
} from './boards.service';
import {
	boardExportInput,
	csvExport,
	docFragment,
	EXPORT_EXTENSIONS,
	exportFileName,
	groupTasks,
	htmlDocument,
	markdownDocument,
	MAX_MY_EXPORT,
	MAX_PNG_PAGES,
	myExportInput,
	PNG_MAX_EDGE,
	taskCount,
	taskExportInput,
	type ExportDoc,
	type ExportFormat,
	type ExportItem,
	type ExportTask
} from './export';
import { idParams, PERM, taskParams, type Priority, type TaskCard } from './schemas';

const tags = ['Aufgaben'];
const rateLimit = { limit: 20, windowSec: 60 };

// --- Antwort ------------------------------------------------------------------

/** Text-Download mit genauem Typ, immer als Anhang, ohne aktive Inhalte im App-Kontext */
function textAttachment(body: string, contentType: string, name: string): Response {
	const bytes = new TextEncoder().encode(body);
	return new Response(Buffer.from(bytes), {
		headers: {
			'content-type': contentType,
			'content-disposition': contentDisposition('attachment', name),
			'content-length': String(bytes.byteLength),
			'x-content-type-options': 'nosniff',
			'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
			'cache-control': 'no-store'
		}
	});
}

function binaryAttachment(bytes: Uint8Array, contentType: string, name: string): Response {
	return secureFileResponse(bytes, {
		contentType,
		size: bytes.byteLength,
		name,
		download: true,
		cache: 'no-store'
	});
}

async function pdfOf(ctx: RequestContext, doc: ExportDoc, letterhead: boolean) {
	const available = core.pdf.listTemplates().map((t) => t.id);
	const result = await core.pdf.generate(ctx, {
		template: letterhead && available.includes('briefkopf') ? 'briefkopf' : 'default',
		title: doc.title.slice(0, 200),
		content: [{ type: 'richText', html: docFragment(doc) }]
	});
	return result.buffer;
}

/** PDF-Seiten als PNG: eine Seite → PNG, mehrere → ZIP (`…-seite-01.png`) */
async function pngOf(
	ctx: RequestContext,
	doc: ExportDoc,
	letterhead: boolean,
	base: string
): Promise<Response> {
	const pdf = await pdfOf(ctx, doc, letterhead);
	const first = await core.pdf.renderPage(pdf, {
		page: 1,
		maxEdge: PNG_MAX_EDGE,
		timeoutMs: 30_000
	});
	if (first.pageCount === 1) {
		return binaryAttachment(first.png, 'image/png', exportFileName(base, 'png'));
	}
	if (first.pageCount > MAX_PNG_PAGES) {
		throw errors.validation(
			[
				{
					path: ['format'],
					message: `Das wären ${first.pageCount} Seiten – als Bild gehen höchstens ${MAX_PNG_PAGES}. Bitte PDF wählen oder weniger Aufgaben exportieren.`
				}
			],
			'Zu viele Seiten für ein Bild'
		);
	}
	const stem = exportFileName(base, '').slice(0, -1);
	const files: Record<string, [Uint8Array, { level: 0 }]> = {};
	const digits = String(first.pageCount).length < 2 ? 2 : String(first.pageCount).length;
	for (let page = 1; page <= first.pageCount; page++) {
		const png =
			page === 1
				? first.png
				: (await core.pdf.renderPage(pdf, { page, maxEdge: PNG_MAX_EDGE, timeoutMs: 30_000 })).png;
		files[`${stem}-seite-${String(page).padStart(digits, '0')}.png`] = [png, { level: 0 }];
	}
	return binaryAttachment(zipSync(files), 'application/zip', exportFileName(base, 'zip'));
}

async function respond(
	ctx: RequestContext,
	doc: ExportDoc,
	opts: { format: ExportFormat; letterhead: boolean; base: string; scope: string }
): Promise<Response> {
	const name = exportFileName(opts.base, EXPORT_EXTENSIONS[opts.format]);
	let response: Response;
	switch (opts.format) {
		case 'html':
			response = textAttachment(htmlDocument(doc), 'text/html; charset=utf-8', name);
			break;
		case 'md':
			response = textAttachment(markdownDocument(doc), 'text/markdown; charset=utf-8', name);
			break;
		case 'csv':
			response = textAttachment(csvExport(doc), 'text/csv; charset=utf-8', name);
			break;
		case 'pdf':
			response = binaryAttachment(await pdfOf(ctx, doc, opts.letterhead), 'application/pdf', name);
			break;
		case 'png':
			response = await pngOf(ctx, doc, opts.letterhead, opts.base);
			break;
	}
	await core.audit.logFromContext(ctx, 'tasks.export.created', {
		metadata: {
			scope: opts.scope,
			format: opts.format,
			count: taskCount(doc),
			detailed: doc.detailed,
			letterhead: opts.letterhead
		}
	});
	return response;
}

// --- Daten --------------------------------------------------------------------

const ITEM_SELECT = sql`task_id, title, done, assignee_id, to_char(due_on, 'YYYY-MM-DD') AS due_on`;

async function loadItems(tx: Tx, ids: string[]): Promise<Row[]> {
	if (!ids.length) return [];
	return rowsOf(
		tx,
		sql`SELECT ${ITEM_SELECT} FROM task_checklist WHERE task_id IN (${inList(ids)})
			ORDER BY position, created_at, id`
	);
}

/** Unteraufgaben je Aufgabe mit Namen der Zuständigen (nach der Transaktion) */
async function itemsByTask(ctx: RequestContext, rows: Row[]): Promise<Map<string, ExportItem[]>> {
	const ids = rows.map((r) => strOrNull(r.assignee_id)).filter((v): v is string => !!v);
	const users = await userRefs(ctx, ids);
	const out = new Map<string, ExportItem[]>();
	for (const r of rows) {
		const key = String(r.task_id);
		const assignee = strOrNull(r.assignee_id);
		const list = out.get(key) ?? [];
		list.push({
			title: String(r.title),
			done: bool(r.done),
			assignee: assignee ? refOf(users, assignee).name : null,
			dueOn: strOrNull(r.due_on)
		});
		out.set(key, list);
	}
	return out;
}

const standLine = (count: number) =>
	`Stand: ${formatDateDe(todayBerlin())} · ${count === 1 ? '1 Aufgabe' : `${count} Aufgaben`}`;

// --- Endpunkte ----------------------------------------------------------------

export const exportEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'POST',
		path: '/my/tasks/export',
		summary: 'Meine Aufgaben exportieren (PDF, PNG, HTML, CSV, Markdown)',
		description: `Wie \`GET /my/tasks\` (direkt oder über eine offene Unteraufgabe zugewiesen), gruppiert nach Board, höchstens ${MAX_MY_EXPORT}.`,
		tags,
		permission: PERM.view,
		rateLimit,
		body: myExportInput,
		handler: async ({ ctx, body }) => {
			const me = ctx.userId;
			const data = me
				? await mdb().transaction(async (tx) => {
						const tasks = await rowsOf(
							tx,
							sql`SELECT t.id, t.title, t.description, t.priority, t.is_milestone,
									to_char(t.due_on, 'YYYY-MM-DD') AS due_on, to_char(t.starts_on, 'YYYY-MM-DD') AS starts_on,
									(t.completed_at IS NOT NULL) AS done, p.name AS phase_name,
									b.id AS board_id, b.name AS board_name, b.color AS board_color, c.name AS column_name
								FROM tasks t
								JOIN boards b ON b.id = t.board_id
								JOIN board_columns c ON c.id = t.column_id
								LEFT JOIN board_phases p ON p.id = t.phase_id
								WHERE (EXISTS (SELECT 1 FROM task_assignees a WHERE a.task_id = t.id AND a.user_id = ${me})
									OR EXISTS (SELECT 1 FROM task_checklist x WHERE x.task_id = t.id
										AND x.assignee_id = ${me} AND NOT x.done))
									AND ${body.includeDone ? sql`TRUE` : sql`t.completed_at IS NULL`}
								ORDER BY lower(b.name), b.id, (t.completed_at IS NOT NULL), t.due_on NULLS LAST,
									CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
									t.created_at
								LIMIT ${MAX_MY_EXPORT}`
						);
						const ids = tasks.map((t) => String(t.id));
						const assignees = ids.length
							? await rowsOf(
									tx,
									sql`SELECT task_id, user_id FROM task_assignees WHERE task_id IN (${inList(ids)})
										ORDER BY created_at, user_id`
								)
							: [];
						return { tasks, assignees, items: await loadItems(tx, ids) };
					})
				: { tasks: [], assignees: [], items: [] };
			const users = await userRefs(
				ctx,
				data.assignees.map((a) => String(a.user_id))
			);
			const assigneesOf = new Map<string, string[]>();
			for (const a of data.assignees) {
				const list = assigneesOf.get(String(a.task_id)) ?? [];
				list.push(refOf(users, String(a.user_id)).name);
				assigneesOf.set(String(a.task_id), list);
			}
			const items = await itemsByTask(ctx, data.items);
			const boards = new Map<string, { id: string; name: string; color: string | null }>();
			for (const t of data.tasks) {
				boards.set(String(t.board_id), {
					id: String(t.board_id),
					name: String(t.board_name),
					color: strOrNull(t.board_color)
				});
			}
			const toTask = (t: Row): ExportTask => ({
				title: String(t.title),
				board: String(t.board_name),
				column: String(t.column_name),
				phase: strOrNull(t.phase_name),
				priority: String(t.priority) as Priority,
				startsOn: strOrNull(t.starts_on),
				dueOn: strOrNull(t.due_on),
				isMilestone: bool(t.is_milestone),
				done: bool(t.done),
				assignees: assigneesOf.get(String(t.id)) ?? [],
				description: strOrNull(t.description),
				items: items.get(String(t.id)) ?? []
			});
			const sections = groupTasks(
				data.tasks,
				(t) => String(t.board_id),
				[...boards.values()],
				'Ohne Board',
				toTask
			);
			const count = data.tasks.length;
			const doc: ExportDoc = {
				title: 'Meine Aufgaben',
				subtitle: [
					body.includeDone ? 'Offene und erledigte Aufgaben' : 'Offene Aufgaben',
					standLine(count) + (count >= MAX_MY_EXPORT ? ` (nur die ersten ${MAX_MY_EXPORT})` : '')
				],
				sections,
				detailed: body.detailed,
				show: { board: false, column: true, phase: true }
			};
			return respond(ctx, doc, {
				format: body.format,
				letterhead: body.letterhead,
				base: `meine-aufgaben-${todayBerlin()}`,
				scope: 'my'
			});
		}
	}),

	defineEndpoint({
		method: 'POST',
		path: '/boards/:id/export',
		summary: 'Board exportieren (PDF, PNG, HTML, CSV, Markdown)',
		description:
			'Gruppiert nach Spalten, Phasen oder als eine Liste; `taskIds` = nur diese Aufgaben (Filter der Seite), `detailed` = mit Beschreibung und Unteraufgaben statt Tabelle.',
		tags,
		permission: PERM.view,
		rateLimit,
		params: idParams,
		body: boardExportInput,
		handler: async ({ ctx, params, body }) => {
			const { rows, items } = await mdb().transaction(async (tx) => {
				const rows = await loadDetailRows(tx, ctx, params.id);
				return {
					rows,
					items: await loadItems(
						tx,
						rows.tasks.map((t) => String(t.id))
					)
				};
			});
			const board = await buildDetail(ctx, rows);
			const itemMap = await itemsByTask(ctx, items);
			const descriptions = new Map(rows.tasks.map((t) => [String(t.id), strOrNull(t.description)]));
			const columnIndex = new Map(board.columns.map((c, i) => [c.id, i]));
			const columnOf = new Map(board.columns.map((c) => [c.id, c]));
			const phaseName = new Map(board.phases.map((p) => [p.id, p.name]));
			const wanted = body.taskIds ? new Set(body.taskIds) : null;
			const isDone = (t: TaskCard) => columnOf.get(t.columnId)?.isDone ?? !!t.completedAt;

			const cards = board.tasks
				.filter((t) => (!wanted || wanted.has(t.id)) && (body.includeDone || !isDone(t)))
				.sort(
					(a, b) =>
						(columnIndex.get(a.columnId) ?? 0) - (columnIndex.get(b.columnId) ?? 0) ||
						a.position - b.position
				);
			const toTask = (t: TaskCard): ExportTask => ({
				title: t.title,
				board: null,
				column: columnOf.get(t.columnId)?.name ?? '',
				phase: t.phaseId ? (phaseName.get(t.phaseId) ?? null) : null,
				priority: t.priority,
				startsOn: t.startsOn,
				dueOn: t.dueOn,
				isMilestone: t.isMilestone,
				done: isDone(t),
				assignees: t.assignees.map((a) => a.name),
				description: descriptions.get(t.id) ?? null,
				items: itemMap.get(t.id) ?? []
			});
			const group = body.groupBy === 'phase' && !board.phases.length ? 'none' : body.groupBy;
			const sections =
				group === 'column'
					? groupTasks(cards, (t) => t.columnId, board.columns, 'Ohne Spalte', toTask)
					: group === 'phase'
						? groupTasks(cards, (t) => t.phaseId, board.phases, 'Ohne Phase', toTask)
						: [{ title: null, color: null, tasks: cards.map(toTask) }];
			const subtitle: string[] = [];
			if (board.description?.trim()) subtitle.push(board.description.trim());
			if (board.action) subtitle.push(`Aktion: ${board.action.name}`);
			if (body.filterLabel) subtitle.push(body.filterLabel);
			if (!body.includeDone) subtitle.push('Ohne erledigte Aufgaben');
			subtitle.push(standLine(cards.length));
			const doc: ExportDoc = {
				title: board.name,
				subtitle,
				sections,
				detailed: body.detailed,
				show: {
					board: false,
					column: group !== 'column',
					phase: group !== 'phase' && board.phases.length > 0
				}
			};
			return respond(ctx, doc, {
				format: body.format,
				letterhead: body.letterhead,
				base: board.name || 'board',
				scope: 'board'
			});
		}
	}),

	defineEndpoint({
		method: 'POST',
		path: '/tasks/:id/export',
		summary: 'Aufgabe exportieren (PDF, PNG, HTML, CSV, Markdown)',
		tags,
		permission: PERM.view,
		rateLimit,
		params: taskParams,
		body: taskExportInput,
		handler: async ({ ctx, params, body }) => {
			const { rows, info } = await mdb().transaction(async (tx) => {
				const rows = await loadTaskRows(tx, ctx, params.id);
				const [info] = await rowsOf(
					tx,
					sql`SELECT b.name AS board_name, c.name AS column_name, c.is_done, p.name AS phase_name
						FROM tasks t
						JOIN boards b ON b.id = t.board_id
						JOIN board_columns c ON c.id = t.column_id
						LEFT JOIN board_phases p ON p.id = t.phase_id
						WHERE t.id = ${params.id}`
				);
				return { rows, info };
			});
			if (!info) throw errors.notFound('Aufgabe nicht gefunden');
			const task = await buildTask(ctx, rows);
			const exported: ExportTask = {
				title: task.title,
				board: String(info.board_name),
				column: String(info.column_name),
				phase: strOrNull(info.phase_name),
				priority: task.priority,
				startsOn: task.startsOn,
				dueOn: task.dueOn,
				isMilestone: task.isMilestone,
				done: bool(info.is_done) || !!task.completedAt,
				assignees: task.assignees.map((a) => a.name),
				description: task.description,
				items: task.items.map((i) => ({
					title: i.title,
					done: i.done,
					assignee: i.assignee?.name ?? null,
					dueOn: i.dueOn
				}))
			};
			const doc: ExportDoc = {
				title: task.title,
				subtitle: [
					`Board: ${exported.board}${exported.done ? ' · erledigt' : ''}`,
					`Stand: ${formatDateDe(todayBerlin())}`
				],
				sections: [{ title: null, color: null, tasks: [exported] }],
				detailed: true,
				single: true,
				show: { board: false, column: true, phase: true }
			};
			return respond(ctx, doc, {
				format: body.format,
				letterhead: body.letterhead,
				base: task.title || 'aufgabe',
				scope: 'task'
			});
		}
	})
];
