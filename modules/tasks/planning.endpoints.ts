/** REST für Phasen, Verschieben aller Daten und Vorlagen (`/api/v1/modules/tasks/…`). */
import { sql } from 'drizzle-orm';
import {
	type AnyApiEndpoint,
	core,
	defineEndpoint,
	errors,
	rowsOf,
	type RequestContext
} from '$lib/sdk/server';
import { todayBerlin } from '$lib/sdk/dates';
import { canEditAll, requireBoardAccess } from './access';
import {
	buildDetail,
	loadDetailRows,
	lockBoard,
	mdb,
	PHASE_SELECT,
	strOrNull,
	userRefs,
	actionInfos
} from './boards.service';
import {
	idParams,
	MAX_PHASES,
	MAX_TEMPLATES_PER_USER,
	orderInput,
	PERM,
	phaseInput,
	phaseParams,
	phaseUpdateInput,
	shiftInput,
	templateParams,
	templateSaveInput,
	type BoardDetail,
	type TemplateSummary
} from './schemas';
import { BUILTIN_TEMPLATES, earliestDate, templateFromBoard, type TemplateData } from './templates';
import { boardTemplateSource, listStoredTemplates } from './templates.service';

const tags = ['Aufgaben'];

async function detail(ctx: RequestContext, boardId: string): Promise<BoardDetail> {
	const rows = await mdb().transaction((tx) => loadDetailRows(tx, ctx, boardId));
	return buildDetail(ctx, rows);
}

function summarize(
	t: { id: string; name: string; description: string | null; data: TemplateData },
	extra: Pick<TemplateSummary, 'builtin' | 'owner' | 'canDelete'>
): TemplateSummary {
	return {
		id: t.id,
		name: t.name,
		description: t.description,
		phases: t.data.phases.map((p) => ({ name: p.name, color: p.color })),
		taskCount: t.data.tasks.length,
		...extra
	};
}

export const planningEndpoints: AnyApiEndpoint[] = [
	// --- Phasen ---
	defineEndpoint({
		method: 'POST',
		path: '/boards/:id/phases',
		summary: 'Phase anlegen (am Ende)',
		tags,
		permission: PERM.view,
		params: idParams,
		body: phaseInput,
		handler: async ({ ctx, params, body }) => {
			const phaseId = crypto.randomUUID();
			await mdb().transaction(async (tx) => {
				await requireBoardAccess(tx, ctx, params.id, 'edit');
				await lockBoard(tx, params.id);
				const [n] = await rowsOf(
					tx,
					sql`SELECT count(*)::int AS n, COALESCE(max(position), -1)::int AS max
						FROM board_phases WHERE board_id = ${params.id}`
				);
				if (Number(n?.n ?? 0) >= MAX_PHASES) {
					throw errors.conflict(`Höchstens ${MAX_PHASES} Phasen je Board`);
				}
				await tx.execute(
					sql`INSERT INTO board_phases (id, board_id, name, color, starts_on, ends_on, position)
						VALUES (${phaseId}, ${params.id}, ${body.name}, ${body.color}, ${body.startsOn},
							${body.endsOn}, ${Number(n?.max ?? -1) + 1})`
				);
				await tx.execute(sql`UPDATE boards SET updated_at = now() WHERE id = ${params.id}`);
			});
			await core.audit.logFromContext(ctx, 'tasks.phase.created', {
				target: phaseId,
				metadata: { board: params.id }
			});
			return detail(ctx, params.id);
		}
	}),
	defineEndpoint({
		method: 'PUT',
		path: '/boards/:id/phases/order',
		summary: 'Phasen umsortieren (alle IDs genau einmal)',
		tags,
		permission: PERM.view,
		params: idParams,
		body: orderInput,
		handler: async ({ ctx, params, body }) => {
			await mdb().transaction(async (tx) => {
				await requireBoardAccess(tx, ctx, params.id, 'edit');
				await lockBoard(tx, params.id);
				const rows = await rowsOf(
					tx,
					sql`SELECT id FROM board_phases WHERE board_id = ${params.id}`
				);
				const known = new Set(rows.map((r) => String(r.id)));
				if (
					body.ids.length !== known.size ||
					new Set(body.ids).size !== body.ids.length ||
					body.ids.some((id) => !known.has(id))
				) {
					throw errors.validation([
						{ path: ['ids'], message: 'Alle Phasen des Boards genau einmal angeben' }
					]);
				}
				for (const [i, id] of body.ids.entries()) {
					await tx.execute(sql`UPDATE board_phases SET position = ${i} WHERE id = ${id}`);
				}
				await tx.execute(sql`UPDATE boards SET updated_at = now() WHERE id = ${params.id}`);
			});
			await core.audit.logFromContext(ctx, 'tasks.phase.reordered', { target: params.id });
			return detail(ctx, params.id);
		}
	}),
	defineEndpoint({
		method: 'PATCH',
		path: '/boards/:id/phases/:phaseId',
		summary: 'Phase ändern (nur übergebene Felder)',
		tags,
		permission: PERM.view,
		params: phaseParams,
		body: phaseUpdateInput,
		handler: async ({ ctx, params, body }) => {
			await mdb().transaction(async (tx) => {
				await requireBoardAccess(tx, ctx, params.id, 'edit');
				await lockBoard(tx, params.id);
				const [cur] = await rowsOf(
					tx,
					sql`SELECT ${PHASE_SELECT} FROM board_phases WHERE id = ${params.phaseId}
						AND board_id = ${params.id}`
				);
				if (!cur) throw errors.notFound('Phase nicht gefunden');
				const startsOn = body.startsOn !== undefined ? body.startsOn : strOrNull(cur.starts_on);
				const endsOn = body.endsOn !== undefined ? body.endsOn : strOrNull(cur.ends_on);
				if (startsOn && endsOn && endsOn < startsOn) {
					throw errors.validation([{ path: ['endsOn'], message: 'Das Ende liegt vor dem Beginn' }]);
				}
				const sets = [
					body.name !== undefined ? sql`name = ${body.name}` : null,
					body.color !== undefined ? sql`color = ${body.color ?? null}` : null,
					body.startsOn !== undefined ? sql`starts_on = ${body.startsOn ?? null}` : null,
					body.endsOn !== undefined ? sql`ends_on = ${body.endsOn ?? null}` : null
				].filter((v) => v !== null);
				if (sets.length) {
					await tx.execute(
						sql`UPDATE board_phases SET ${sql.join(sets, sql`, `)} WHERE id = ${params.phaseId}`
					);
				}
				await tx.execute(sql`UPDATE boards SET updated_at = now() WHERE id = ${params.id}`);
			});
			await core.audit.logFromContext(ctx, 'tasks.phase.updated', {
				target: params.phaseId,
				metadata: { board: params.id, fields: Object.keys(body) }
			});
			return detail(ctx, params.id);
		}
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/boards/:id/phases/:phaseId',
		summary: 'Phase löschen (Aufgaben bleiben, dann ohne Phase)',
		tags,
		permission: PERM.view,
		params: phaseParams,
		handler: async ({ ctx, params }) => {
			const released = await mdb().transaction(async (tx) => {
				await requireBoardAccess(tx, ctx, params.id, 'edit');
				await lockBoard(tx, params.id);
				const [n] = await rowsOf(
					tx,
					sql`SELECT count(*)::int AS n FROM tasks WHERE phase_id = ${params.phaseId}`
				);
				const res = await rowsOf(
					tx,
					sql`DELETE FROM board_phases WHERE id = ${params.phaseId} AND board_id = ${params.id}
						RETURNING id`
				);
				if (!res.length) throw errors.notFound('Phase nicht gefunden');
				const rest = await rowsOf(
					tx,
					sql`SELECT id FROM board_phases WHERE board_id = ${params.id} ORDER BY position, created_at, id`
				);
				for (const [i, r] of rest.entries()) {
					await tx.execute(sql`UPDATE board_phases SET position = ${i} WHERE id = ${String(r.id)}`);
				}
				await tx.execute(sql`UPDATE boards SET updated_at = now() WHERE id = ${params.id}`);
				return Number(n?.n ?? 0);
			});
			await core.audit.logFromContext(ctx, 'tasks.phase.deleted', {
				target: params.phaseId,
				metadata: { board: params.id, tasks: released }
			});
			return detail(ctx, params.id);
		}
	}),

	// --- Verschieben ---
	defineEndpoint({
		method: 'POST',
		path: '/boards/:id/shift',
		summary: 'Alle Daten des Boards verschieben',
		description:
			'Verschiebt Phasen, Beginn/Fälligkeit aller Aufgaben und Unteraufgaben sowie das Bezugsdatum um `days` Tage. ' +
			'Mit `apply: false` wird nur das Bezugsdatum übernommen (Hinweis „Aktion verschoben“ ausblenden).',
		tags,
		permission: PERM.view,
		params: idParams,
		body: shiftInput,
		handler: async ({ ctx, params, body }) => {
			const days = body.days;
			await mdb().transaction(async (tx) => {
				await requireBoardAccess(tx, ctx, params.id, 'edit');
				await lockBoard(tx, params.id);
				if (body.apply && days !== 0) {
					await tx.execute(
						sql`UPDATE board_phases SET starts_on = starts_on + ${days}::int, ends_on = ends_on + ${days}::int
							WHERE board_id = ${params.id}`
					);
					await tx.execute(
						sql`UPDATE tasks SET starts_on = starts_on + ${days}::int, due_on = due_on + ${days}::int,
								reminded_on = NULL, updated_at = now()
							WHERE board_id = ${params.id}`
					);
					await tx.execute(
						sql`UPDATE task_checklist x SET due_on = x.due_on + ${days}::int
							FROM tasks t WHERE t.id = x.task_id AND t.board_id = ${params.id} AND x.due_on IS NOT NULL`
					);
				}
				await tx.execute(
					sql`UPDATE boards SET anchor_on = anchor_on + ${days}::int, updated_at = now()
						WHERE id = ${params.id}`
				);
			});
			await core.audit.logFromContext(ctx, 'tasks.board.shifted', {
				target: params.id,
				metadata: { days, apply: body.apply }
			});
			return detail(ctx, params.id);
		}
	}),

	// --- Vorlagen ---
	defineEndpoint({
		method: 'GET',
		path: '/templates',
		summary: 'Vorlagen (mitgelieferte und eigene; mit `edit-all` alle)',
		tags,
		permission: PERM.create,
		handler: async ({ ctx }): Promise<TemplateSummary[]> => {
			const stored = await mdb().transaction((tx) => listStoredTemplates(tx, ctx));
			const owners = await userRefs(
				ctx,
				stored.map((t) => t.ownerId)
			);
			return [
				...BUILTIN_TEMPLATES.map((t) =>
					summarize(t, { builtin: true, owner: null, canDelete: false })
				),
				...stored.map((t) =>
					summarize(t, {
						builtin: false,
						owner: owners.get(t.ownerId) ?? { id: t.ownerId, name: 'Unbekannt', image: null },
						canDelete: true
					})
				)
			];
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/boards/:id/template',
		summary: 'Board als eigene Vorlage speichern',
		description:
			'Speichert Spalten, Phasen und Aufgaben (ohne Zuständige und Erledigt-Stand). Daten werden relativ zum ' +
			'Beginn der Aktion bzw. zum Bezugsdatum gespeichert, Daten nach dem Ende der Aktion relativ zum Ende.',
		tags,
		permission: PERM.create,
		params: idParams,
		body: templateSaveInput,
		handler: async ({ ctx, params, body }): Promise<TemplateSummary> => {
			if (!ctx.userId) throw errors.badRequest('Vorlagen können nur Benutzer*innen speichern');
			const userId = ctx.userId;
			const { source, anchorOn, actionId } = await mdb().transaction(async (tx) => {
				await requireBoardAccess(tx, ctx, params.id, 'read');
				const [b] = await rowsOf(
					tx,
					sql`SELECT action_id, to_char(anchor_on, 'YYYY-MM-DD') AS anchor_on FROM boards WHERE id = ${params.id}`
				);
				return {
					source: await boardTemplateSource(tx, params.id),
					anchorOn: strOrNull(b?.anchor_on),
					actionId: strOrNull(b?.action_id)
				};
			});
			const action = actionId ? (await actionInfos(ctx, [actionId])).get(actionId) : undefined;
			const startsOn = action?.startsOn ?? anchorOn ?? earliestDate(source) ?? todayBerlin();
			const data = templateFromBoard(source, {
				startsOn,
				endsOn: action?.startsOn === startsOn ? action.endsOn : null
			});
			const id = crypto.randomUUID();
			await mdb().transaction(async (tx) => {
				await tx.execute(
					sql`SELECT pg_advisory_xact_lock(hashtext(${`tasks:templates:${userId}`}))`
				);
				const [n] = await rowsOf(
					tx,
					sql`SELECT count(*)::int AS n FROM board_templates WHERE owner_id = ${userId}`
				);
				if (Number(n?.n ?? 0) >= MAX_TEMPLATES_PER_USER) {
					throw errors.conflict(`Höchstens ${MAX_TEMPLATES_PER_USER} eigene Vorlagen`);
				}
				await tx.execute(
					sql`INSERT INTO board_templates (id, name, description, owner_id, data)
						VALUES (${id}, ${body.name}, ${body.description}, ${userId}, ${JSON.stringify(data)}::jsonb)`
				);
			});
			await core.audit.logFromContext(ctx, 'tasks.template.created', {
				target: id,
				metadata: { board: params.id, phases: data.phases.length, tasks: data.tasks.length }
			});
			const owners = await userRefs(ctx, [userId]);
			return summarize(
				{ id, name: body.name, description: body.description, data },
				{
					builtin: false,
					owner: owners.get(userId) ?? { id: userId, name: 'Unbekannt', image: null },
					canDelete: true
				}
			);
		}
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/templates/:id',
		summary: 'Eigene Vorlage löschen (mit `edit-all` jede)',
		tags,
		permission: PERM.create,
		params: templateParams,
		handler: async ({ ctx, params }) => {
			const all = canEditAll(ctx);
			const deleted = await mdb().transaction((tx) =>
				rowsOf(
					tx,
					sql`DELETE FROM board_templates WHERE id = ${params.id}
						${all ? sql`` : sql`AND owner_id = ${ctx.userId ?? ''}`} RETURNING id`
				)
			);
			if (!deleted.length) throw errors.notFound('Vorlage nicht gefunden');
			await core.audit.logFromContext(ctx, 'tasks.template.deleted', { target: params.id });
			return { id: params.id, deleted: true };
		}
	})
];
