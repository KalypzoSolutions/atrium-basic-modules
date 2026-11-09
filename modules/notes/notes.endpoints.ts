/** REST für Notizen: Seitenbaum, Anlegen/Ändern/Verschieben, Papierkorb, Suche, Freigaben (`/api/v1/modules/notes/…`). */
import { sql } from 'drizzle-orm';
import {
	addedPrincipals,
	type AnyApiEndpoint,
	core,
	defineEndpoint,
	describePrincipals,
	errors,
	inList,
	loadObjectShares,
	PRINCIPAL_SEARCH_RATE_LIMIT,
	principalMatchSql,
	type RequestContext,
	replaceObjectShares,
	requireShareCapability,
	rowsOf,
	searchPrincipals,
	type StoredShare,
	toIso,
	type Tx,
	validatePrincipals
} from '$lib/sdk/server';
import { addDays } from '$lib/sdk/dates';
import { loadIconSet } from '$lib/sdk/icons';
import {
	accessForMany,
	canEditAll,
	NOTE_SHARES,
	noteContextOf,
	notInTrashSql,
	requireNoteAccess,
	sameInheritedShares,
	subtreeHeight,
	subtreeIds,
	visibleNotesSql
} from './access';
import { mdb, refOf, userRefs } from './db';
import { jsonFromState, stateFromJson } from './doc.service';
import { parseMarkdown } from './export/markdown';
import { plainTextOf } from './doc/text';
import { closeNotes, hub, recheckNotes } from './live';
import { notifyNoteShared } from './notify';
import { afterPurge, purgeInTx } from './trash.service';
import {
	assertActionEditable,
	buildNodes,
	canCreate,
	childCount,
	type Container,
	likePattern,
	liveSubtree,
	loadNodes,
	lockContainer,
	nextPosition,
	noteDetail,
	pathText,
	renumber,
	visibleAncestors
} from './tree.service';
import {
	actionParams,
	idParams,
	MAX_CHILDREN,
	MAX_DEPTH,
	MAX_DOC_BYTES,
	MODULE_ID,
	moveInput,
	noteCreateInput,
	noteUpdateInput,
	PERM,
	principalQuery,
	recentQuery,
	searchQuery,
	sharesInput,
	TRASH_DAYS,
	trashIdsInput,
	type ActionNotes,
	type LiveEvent,
	type NoteDetail,
	type NoteNode,
	type NoteRoots,
	type NoteSearchHit,
	type NoteShareEntry,
	type NoteShares,
	type TrashItem
} from './schemas';

const tags = ['Notizen'];
const STAMM_NAME_SETTING = 'events.stamm.name';
const SEARCH_LIMIT = 50;

export async function everyoneLabel(): Promise<string> {
	try {
		const value = await core.settings.get<unknown>(STAMM_NAME_SETTING);
		if (typeof value === 'string' && value.trim()) return value.trim();
	} catch {
		// Einstellung nicht registriert (events nicht aktiv) → Standard
	}
	return 'Stamm';
}

/** Textausschnitt um den ersten Treffer (sonst Textanfang) */
export function snippetOf(text: string, q: string, radius = 70): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	if (!flat) return '';
	const words = q
		.toLowerCase()
		.split(/\s+/)
		.filter((w) => w.length >= 2);
	const lower = flat.toLowerCase();
	let at = -1;
	for (const w of [q.toLowerCase(), ...words]) {
		at = lower.indexOf(w);
		if (at >= 0) break;
	}
	if (at < 0) return flat.length > radius * 2 ? `${flat.slice(0, radius * 2 - 1)}…` : flat;
	const start = Math.max(0, at - radius);
	const end = Math.min(flat.length, at + radius);
	return `${start > 0 ? '…' : ''}${flat.slice(start, end).trim()}${end < flat.length ? '…' : ''}`;
}

/** Markdown → Yjs-Startzustand + abgeleitete Felder (422 bei unbrauchbarem Inhalt, 413 zu groß) */
function contentFromMarkdown(markdown: string) {
	let state: Uint8Array;
	try {
		const json = parseMarkdown(markdown);
		state = stateFromJson(json);
	} catch (e) {
		console.warn('[notes] Markdown konnte nicht gelesen werden', e);
		throw errors.validation([
			{ path: ['markdown'], message: 'Inhalt konnte nicht gelesen werden' }
		]);
	}
	if (state.byteLength > MAX_DOC_BYTES) throw errors.tooLarge('Der Inhalt ist zu groß');
	const json = jsonFromState(state);
	return { state, json, text: plainTextOf(json) };
}

// --- Freigaben --------------------------------------------------------------

async function loadShareState(tx: Tx, ctx: RequestContext, id: string, need: 'read' | 'share') {
	const access = await requireNoteAccess(tx, ctx, id, need);
	const ancestors = access.chain.slice(0, -1);
	const ancestorAccess = await accessForMany(
		tx,
		ctx,
		ancestors.map((a) => a.id)
	);
	const visible = ancestors.filter((a) => ancestorAccess.has(a.id));
	const inherited = await loadObjectShares(
		tx,
		NOTE_SHARES,
		visible.map((a) => a.id)
	);
	const titles = new Map(ancestors.map((a) => [a.id, a.title]));
	return {
		access,
		ownerId: access.chain[0]?.ownerId ?? null,
		title: access.chain[access.chain.length - 1]?.title ?? '',
		shares: (await loadObjectShares(tx, NOTE_SHARES, [id])).map(
			({ type, id: pid, level }): StoredShare => ({ type, id: pid, level })
		),
		inherited: inherited.map((s) => ({ ...s, fromTitle: titles.get(s.objectId) ?? '' }))
	};
}

async function describeShares(
	ctx: RequestContext,
	list: readonly StoredShare[],
	label: string
): Promise<NoteShareEntry[]> {
	const described = await describePrincipals(ctx, MODULE_ID, list, { everyoneLabel: label });
	return described.map((p, i) => ({
		type: p.type,
		userId: p.id,
		name: p.name,
		detail: p.detail ?? null,
		color: p.color ?? null,
		image: p.image ?? null,
		level: list[i]!.level
	}));
}

async function buildShares(
	ctx: RequestContext,
	state: {
		ownerId: string | null;
		shares: StoredShare[];
		inherited: (StoredShare & { objectId: string; fromTitle: string })[];
		canManage: boolean;
	}
): Promise<NoteShares> {
	const label = await everyoneLabel();
	const [owners, shares, inherited] = await Promise.all([
		userRefs(ctx, [state.ownerId]),
		describeShares(ctx, state.shares, label),
		describeShares(ctx, state.inherited, label)
	]);
	shares.sort((a, b) => a.name.localeCompare(b.name, 'de'));
	return {
		owner: refOf(owners, state.ownerId),
		shares,
		inherited: inherited.map((e, i) => ({
			...e,
			fromId: state.inherited[i]!.objectId,
			fromTitle: state.inherited[i]!.fromTitle
		})),
		canManage: state.canManage,
		everyoneLabel: label
	};
}

// --- Papierkorb -------------------------------------------------------------

async function trashList(ctx: RequestContext): Promise<TrashItem[]> {
	const data = await mdb().transaction(async (tx) => {
		const rows = await rowsOf(
			tx,
			sql`SELECT n.id, n.title, n.icon, n.deleted_at, n.deleted_by, p.title AS parent_title,
					(WITH RECURSIVE down AS (
						SELECT c.id, 1 AS depth FROM notes c WHERE c.parent_id = n.id
						UNION ALL
						SELECT c.id, down.depth + 1 FROM notes c JOIN down ON c.parent_id = down.id
						WHERE down.depth < 64
					) SELECT count(*)::int FROM down) AS descendants
				FROM notes n LEFT JOIN notes p ON p.id = n.parent_id
				WHERE n.trash_root ORDER BY n.deleted_at DESC, n.id`
		);
		const access = await accessForMany(
			tx,
			ctx,
			rows.map((r) => String(r.id))
		);
		return rows.filter((r) => access.get(String(r.id))?.canShare);
	});
	const users = await userRefs(
		ctx,
		data.map((r) => (r.deleted_by == null ? null : String(r.deleted_by)))
	);
	return data.map((r) => {
		const deletedAt = toIso(r.deleted_at);
		return {
			id: String(r.id),
			title: String(r.title ?? ''),
			icon: r.icon == null ? null : String(r.icon),
			descendants: Number(r.descendants ?? 0),
			parentTitle: r.parent_title == null ? null : String(r.parent_title),
			deletedAt,
			deletedBy: refOf(users, r.deleted_by == null ? null : String(r.deleted_by)),
			purgeOn: addDays(deletedAt.slice(0, 10), TRASH_DAYS)
		};
	});
}

/** Papierkorb-Eintrag prüfen (teilen/löschen mit `includeDeleted`, muss oberster Eintrag sein) */
async function requireTrashRoot(tx: Tx, ctx: RequestContext, id: string) {
	const access = await requireNoteAccess(tx, ctx, id, 'share', { includeDeleted: true });
	const [row] = await rowsOf(tx, sql`SELECT trash_root FROM notes WHERE id = ${id}`);
	if (!(row?.trash_root === true || row?.trash_root === 't')) {
		throw errors.notFound('Eintrag nicht im Papierkorb');
	}
	return access;
}

export const noteEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/notes/roots',
		summary: 'Oberste Seiten: eigene, mit mir geteilte und Notizen sichtbarer Aktionen',
		tags,
		permission: PERM.view,
		handler: async ({ ctx }): Promise<NoteRoots> => {
			const nc = noteContextOf(ctx);
			const uid = ctx.userId ?? '';
			const actionIds = [...nc.actions.keys()];
			const data = await mdb().transaction(async (tx) => {
				const own = uid
					? await loadNodes(
							tx,
							ctx,
							sql`n.parent_id IS NULL AND n.owner_id = ${uid} AND n.deleted_at IS NULL`
						)
					: { rows: [], access: new Map() };
				let shared: Awaited<ReturnType<typeof loadNodes>> = { rows: [], access: new Map() };
				if (nc.keys.length) {
					const candidates = await loadNodes(
						tx,
						ctx,
						sql`(n.owner_id IS NULL OR n.owner_id <> ${uid}) AND ${notInTrashSql('n')}
							AND EXISTS (SELECT 1 FROM note_shares s WHERE s.note_id = n.id
								AND ${principalMatchSql('s', nc.keys)})`,
						{ order: sql`n.title, n.id` }
					);
					// nur oberste zugängliche: liegt eine zugängliche Oberseite darüber, erscheint die Seite dort
					const above = await visibleAncestors(
						tx,
						ctx,
						candidates.rows.map((r) => String(r.id))
					);
					shared = {
						rows: candidates.rows.filter((r) => !above.get(String(r.id))?.length),
						access: candidates.access
					};
				}
				const actions = actionIds.length
					? await loadNodes(
							tx,
							ctx,
							sql`n.parent_id IS NULL AND n.action_id IN (${inList(actionIds)})
								AND n.deleted_at IS NULL AND (n.owner_id IS NULL OR n.owner_id <> ${uid})`,
							{ order: sql`n.title, n.id` }
						)
					: { rows: [], access: new Map() };
				return { own, shared, actions };
			});
			const [own, shared, actions] = await Promise.all([
				buildNodes(ctx, data.own),
				buildNodes(ctx, data.shared),
				buildNodes(ctx, data.actions)
			]);
			return {
				own,
				shared,
				actions: actions.map((n) => ({
					...n,
					actionName: nc.actionNames.get(n.actionId ?? '') ?? 'Aktion'
				})),
				canCreate: canCreate(ctx)
			};
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/notes/recent',
		summary: 'Zuletzt geänderte Notizen (mit Textanfang)',
		tags,
		permission: PERM.view,
		query: recentQuery,
		handler: async ({ ctx, query }): Promise<NoteNode[]> => {
			const data = await mdb().transaction((tx) =>
				loadNodes(tx, ctx, sql`${visibleNotesSql(ctx, 'n')} AND ${notInTrashSql('n')}`, {
					order: sql`n.updated_at DESC, n.id`,
					limit: query.limit
				})
			);
			return buildNodes(ctx, data, { excerpt: true });
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/notes/search',
		summary: 'Notizen durchsuchen (Titel und Volltext)',
		tags,
		permission: PERM.view,
		query: searchQuery,
		handler: async ({ ctx, query }): Promise<NoteSearchHit[]> => {
			const q = query.q;
			const data = await mdb().transaction(async (tx) => {
				const found = await loadNodes(
					tx,
					ctx,
					sql`${visibleNotesSql(ctx, 'n')} AND ${notInTrashSql('n')}
						AND (n.title ILIKE ${likePattern(q)}
							OR to_tsvector('german', n.title || ' ' || n.content_text) @@ plainto_tsquery('german', ${q}))`,
					{
						order: sql`(n.title ILIKE ${likePattern(q)}) DESC, n.updated_at DESC, n.id`,
						limit: SEARCH_LIMIT
					}
				);
				const paths = await visibleAncestors(
					tx,
					ctx,
					found.rows.map((r) => String(r.id))
				);
				return { found, paths };
			});
			return data.found.rows.map((r) => ({
				id: String(r.id),
				title: String(r.title ?? ''),
				icon: r.icon == null ? null : String(r.icon),
				snippet: snippetOf(String(r.content_text ?? ''), q),
				path: pathText(data.paths.get(String(r.id)) ?? [])
			}));
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/notes/trash',
		summary: 'Papierkorb (Notizen, die ich löschen darf)',
		description: `Gelöschte Notizen samt Unterseiten; nach ${TRASH_DAYS} Tagen endgültig gelöscht.`,
		tags,
		permission: PERM.view,
		handler: ({ ctx }) => trashList(ctx)
	}),
	defineEndpoint({
		method: 'POST',
		path: '/notes/trash/restore',
		summary: 'Notizen aus dem Papierkorb wiederherstellen',
		description:
			'Zurück unter die Oberseite, falls sie noch besteht und nicht gelöscht ist – sonst als oberste Seite der Eigentümer*in. Position ans Ende.',
		tags,
		permission: PERM.view,
		body: trashIdsInput,
		handler: async ({ ctx, body }) => {
			const restored = await mdb().transaction(async (tx) => {
				const out: string[] = [];
				for (const id of body.ids) {
					const access = await requireTrashRoot(tx, ctx, id);
					const parent = access.chain[access.chain.length - 2] ?? null;
					const parentOk = parent ? !access.chain.slice(0, -1).some((n) => n.deletedAt) : false;
					const ownerId = access.chain[0]?.ownerId ?? null;
					const newOwner = parent && !parentOk ? (ownerId ?? ctx.userId ?? null) : ownerId;
					const container: Container =
						parentOk && parent ? { parentId: parent.id } : { ownerId: newOwner };
					await lockContainer(tx, container);
					const position = await nextPosition(tx, container);
					const ids = await liveSubtree(tx, id, 'trash-root');
					await tx.execute(
						sql`UPDATE notes SET deleted_at = NULL, deleted_by = NULL, trash_root = false
							WHERE id IN (${inList(ids)})`
					);
					if (!parentOk && parent) {
						// Oberseite gelöscht: als eigene Wurzel (Eigentum des ganzen Teilbaums angleichen)
						await tx.execute(
							sql`UPDATE notes SET parent_id = NULL, position = ${position} WHERE id = ${id}`
						);
						if (newOwner !== ownerId) {
							const all = await subtreeIds(tx, id);
							await tx.execute(
								sql`UPDATE notes SET owner_id = ${newOwner} WHERE id IN (${inList(all)})`
							);
						}
					} else {
						await tx.execute(sql`UPDATE notes SET position = ${position} WHERE id = ${id}`);
					}
					out.push(id);
				}
				return out;
			});
			await core.audit.logFromContext(ctx, 'notes.note.restored', {
				metadata: { ids: restored, count: restored.length }
			});
			return { restored };
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/notes/trash/purge',
		summary: 'Notizen im Papierkorb endgültig löschen (mit Unterseiten, Versionen und Bildern)',
		tags,
		permission: PERM.view,
		body: trashIdsInput,
		handler: async ({ ctx, body }) => {
			const result = await mdb().transaction(async (tx) => {
				for (const id of body.ids) await requireTrashRoot(tx, ctx, id);
				return purgeInTx(tx, body.ids);
			});
			await afterPurge(result);
			await core.audit.logFromContext(ctx, 'notes.note.purged', {
				metadata: { ids: body.ids, notes: result.noteIds.length, files: result.paths.length }
			});
			return { purged: result.noteIds.length };
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/notes/by-action/:actionId',
		summary: 'Notizen einer Aktion (Karte in der Aktion)',
		tags,
		permission: PERM.view,
		params: actionParams,
		handler: async ({ ctx, params }): Promise<ActionNotes> => {
			const level = noteContextOf(ctx).actions.get(params.actionId) ?? null;
			if (!level && !canEditAll(ctx)) throw errors.notFound('Aktion nicht gefunden');
			const data = await mdb().transaction((tx) =>
				loadNodes(
					tx,
					ctx,
					sql`n.parent_id IS NULL AND n.action_id = ${params.actionId} AND n.deleted_at IS NULL`
				)
			);
			return {
				notes: await buildNodes(ctx, data),
				canCreate: (level === 'edit' || canEditAll(ctx)) && canCreate(ctx)
			};
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/principals',
		summary: 'Freigabe-Ziele suchen (Stamm, Gruppen, Rollen, Mitglieder, Benutzer*innen)',
		description:
			'Nur für Personen, die Notizen teilen können (`notes.note.create`, `edit-all` oder Eigentümer*in einer Notiz), sonst 403.',
		tags,
		permission: PERM.view,
		rateLimit: PRINCIPAL_SEARCH_RATE_LIMIT,
		query: principalQuery,
		handler: async ({ ctx, query }) => {
			await requireShareCapability(ctx, MODULE_ID, {
				anyPermission: [PERM.create, PERM.editAll],
				canShareSql: (userId) => sql`SELECT 1 FROM notes WHERE owner_id = ${userId}`
			});
			return searchPrincipals(ctx, MODULE_ID, query.search, {
				everyoneLabel: await everyoneLabel()
			});
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/notes',
		summary: 'Notiz oder Unterseite anlegen',
		description:
			'Ohne `parentId` eine neue oberste Seite (Recht `notes.note.create`, optional an einer Aktion mit Bearbeiten-Zugriff); mit `parentId` eine Unterseite (Bearbeiten-Zugriff auf die Oberseite, gehört der Eigentümer*in der obersten Seite). `markdown` = Startinhalt.',
		tags,
		permission: PERM.view,
		body: noteCreateInput,
		handler: async ({ ctx, body }): Promise<NoteDetail> => {
			if (!ctx.userId) throw errors.badRequest('Notizen können nur Benutzer*innen anlegen');
			const userId = ctx.userId;
			if (body.parentId) {
				if (body.actionId) {
					throw errors.validation([
						{ path: ['actionId'], message: 'Nur oberste Seiten können an einer Aktion hängen' }
					]);
				}
			} else {
				if (!canCreate(ctx)) throw errors.forbidden('Keine Berechtigung zum Anlegen von Notizen');
				assertActionEditable(ctx, body.actionId);
			}
			if (body.icon) {
				const icons = await loadIconSet();
				if (!icons.has(body.icon)) {
					throw errors.validation([{ path: ['icon'], message: 'Unbekanntes Icon' }]);
				}
			}
			const content = body.markdown ? contentFromMarkdown(body.markdown) : null;
			const id = crypto.randomUUID();
			await mdb().transaction(async (tx) => {
				let ownerId: string | null = userId;
				let container: Container = { ownerId: userId };
				if (body.parentId) {
					const parent = await requireNoteAccess(tx, ctx, body.parentId, 'edit');
					if (parent.chain.length + 1 > MAX_DEPTH) {
						throw errors.validation([
							{ path: ['parentId'], message: `Höchstens ${MAX_DEPTH} Ebenen` }
						]);
					}
					if ((await childCount(tx, body.parentId)) >= MAX_CHILDREN) {
						throw errors.validation([
							{ path: ['parentId'], message: `Höchstens ${MAX_CHILDREN} Unterseiten je Seite` }
						]);
					}
					ownerId = parent.chain[0]?.ownerId ?? null;
					container = { parentId: body.parentId };
				}
				await lockContainer(tx, container);
				const position = await nextPosition(tx, container);
				await tx.execute(
					sql`INSERT INTO notes (id, parent_id, position, title, icon, color, owner_id, action_id,
							ydoc, content_json, content_text, size_bytes, created_by, updated_by)
						VALUES (${id}, ${body.parentId}, ${position}, ${body.title}, ${body.icon}, ${body.color},
							${ownerId}, ${body.parentId ? null : body.actionId},
							${content ? Buffer.from(content.state) : null},
							${content ? JSON.stringify(content.json) : null}::jsonb,
							${content?.text ?? ''}, ${content?.state.byteLength ?? 0}, ${userId}, ${userId})`
				);
			});
			await core.audit.logFromContext(ctx, 'notes.note.created', {
				target: id,
				metadata: {
					parentId: body.parentId,
					withAction: !!body.actionId,
					fromMarkdown: !!content
				}
			});
			return noteDetail(ctx, id);
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/notes/:id',
		summary: 'Notiz (Eigenschaften, Pfad, Zugriff – Inhalt über `/state`)',
		tags,
		permission: PERM.view,
		params: idParams,
		handler: ({ ctx, params }) => noteDetail(ctx, params.id)
	}),
	defineEndpoint({
		method: 'GET',
		path: '/notes/:id/children',
		summary: 'Unterseiten einer Notiz',
		tags,
		permission: PERM.view,
		params: idParams,
		handler: async ({ ctx, params }): Promise<NoteNode[]> => {
			const data = await mdb().transaction(async (tx) => {
				await requireNoteAccess(tx, ctx, params.id);
				return loadNodes(tx, ctx, sql`n.parent_id = ${params.id} AND n.deleted_at IS NULL`);
			});
			return buildNodes(ctx, data);
		}
	}),
	defineEndpoint({
		method: 'PATCH',
		path: '/notes/:id',
		summary: 'Titel, Icon, Farbe oder Aktion ändern',
		description: 'Aktion nur bei obersten Seiten und nur durch Eigentümer*in bzw. `edit-all`.',
		tags,
		permission: PERM.view,
		params: idParams,
		body: noteUpdateInput,
		handler: async ({ ctx, params, body }): Promise<NoteDetail> => {
			if (body.actionId !== undefined) assertActionEditable(ctx, body.actionId);
			if (body.icon) {
				const icons = await loadIconSet();
				if (!icons.has(body.icon)) {
					throw errors.validation([{ path: ['icon'], message: 'Unbekanntes Icon' }]);
				}
			}
			const subtree = await mdb().transaction(async (tx) => {
				const access = await requireNoteAccess(
					tx,
					ctx,
					params.id,
					body.actionId !== undefined ? 'share' : 'edit'
				);
				if (access.level !== 'edit') {
					throw errors.forbidden('Keine Berechtigung zum Bearbeiten dieser Notiz');
				}
				if (body.actionId !== undefined && access.chain.length > 1) {
					throw errors.validation([
						{ path: ['actionId'], message: 'Nur oberste Seiten können an einer Aktion hängen' }
					]);
				}
				const sets = [
					body.title !== undefined ? sql`title = ${body.title}` : null,
					body.icon !== undefined ? sql`icon = ${body.icon ?? null}` : null,
					body.color !== undefined ? sql`color = ${body.color ?? null}` : null,
					body.actionId !== undefined ? sql`action_id = ${body.actionId}` : null
				].filter((v) => v !== null);
				if (sets.length) {
					await tx.execute(
						sql`UPDATE notes SET ${sql.join(
							[...sets, sql`updated_at = now()`, sql`updated_by = ${ctx.userId}`],
							sql`, `
						)} WHERE id = ${params.id}`
					);
				}
				return body.actionId !== undefined ? subtreeIds(tx, params.id) : [];
			});
			await core.audit.logFromContext(ctx, 'notes.note.updated', {
				target: params.id,
				metadata: { fields: Object.keys(body) }
			});
			const detail = await noteDetail(ctx, params.id);
			hub.broadcast(params.id, {
				type: 'meta',
				note: { id: detail.id, title: detail.title, icon: detail.icon, color: detail.color }
			} satisfies LiveEvent);
			if (subtree.length) await recheckNotes(subtree);
			return detail;
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/notes/:id/move',
		summary: 'Notiz verschieben (andere Oberseite, oberste Ebene oder Reihenfolge)',
		description:
			'Bearbeiten-Zugriff auf Notiz und Ziel. In den Teilbaum einer anderen Eigentümer*in, auf die eigene oberste Ebene, unter eine anders geteilte Seite oder weg von der Aktion nur durch Eigentümer*in bzw. `edit-all` – beim Wechsel der Eigentümer*in wechselt das Eigentum des ganzen Teilbaums.',
		tags,
		permission: PERM.view,
		params: idParams,
		body: moveInput,
		handler: async ({ ctx, params, body }): Promise<NoteDetail> => {
			const moved = await mdb().transaction(async (tx) => {
				const src = await requireNoteAccess(tx, ctx, params.id, 'edit');
				const oldParent = src.chain[src.chain.length - 2]?.id ?? null;
				const oldOwner = src.chain[0]?.ownerId ?? null;
				const height = await subtreeHeight(tx, params.id);
				let target: Container;
				let newOwner: string | null;
				if (body.parentId) {
					const dest = await requireNoteAccess(tx, ctx, body.parentId, 'edit');
					if (dest.chain.some((n) => n.id === params.id)) {
						throw errors.validation([
							{ path: ['parentId'], message: 'Eine Seite kann nicht in sich selbst liegen' }
						]);
					}
					if (dest.chain.length + height > MAX_DEPTH) {
						throw errors.validation([
							{ path: ['parentId'], message: `Höchstens ${MAX_DEPTH} Ebenen` }
						]);
					}
					if (
						body.parentId !== oldParent &&
						(await childCount(tx, body.parentId)) >= MAX_CHILDREN
					) {
						throw errors.validation([
							{ path: ['parentId'], message: `Höchstens ${MAX_CHILDREN} Unterseiten je Seite` }
						]);
					}
					newOwner = dest.chain[0]?.ownerId ?? null;
					target = { parentId: body.parentId };
					if (newOwner !== oldOwner && !src.canShare) {
						throw errors.forbidden(
							'Nur die Eigentümer*in darf diese Notiz in eine fremde Notiz verschieben'
						);
					}
					// Bearbeiten-Freigabe: nur verschieben, wenn sich dadurch niemandes Zugriff ändert
					// (gleiche vererbte Freigaben, Wurzel bleibt Wurzel – sonst ginge die Aktion verloren)
					if (
						!src.canShare &&
						body.parentId !== oldParent &&
						(!oldParent ||
							src.chain[0]?.actionId !== dest.chain[0]?.actionId ||
							!(await sameInheritedShares(
								tx,
								src.chain.slice(0, -1).map((n) => n.id),
								dest.chain.map((n) => n.id)
							)))
					) {
						throw errors.forbidden(
							'Nur die Eigentümer*in darf diese Notiz unter eine anders geteilte Seite verschieben'
						);
					}
				} else if (!oldParent) {
					// schon oberste Seite: nur Reihenfolge unter den Wurzeln der Eigentümer*in
					newOwner = oldOwner;
					target = { ownerId: oldOwner };
				} else {
					if (!ctx.userId) throw errors.badRequest('Nur Benutzer*innen haben eigene Notizen');
					if (!src.canShare) {
						throw errors.forbidden(
							'Nur die Eigentümer*in darf diese Notiz auf die oberste Ebene verschieben'
						);
					}
					newOwner = ctx.userId;
					target = { ownerId: ctx.userId };
				}
				const source: Container = oldParent ? { parentId: oldParent } : { ownerId: oldOwner };
				const sameContainer = JSON.stringify(source) === JSON.stringify(target);
				const locks = sameContainer ? [target] : [source, target];
				locks.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
				for (const c of locks) await lockContainer(tx, c);
				const ids = await subtreeIds(tx, params.id);
				await tx.execute(
					sql`UPDATE notes SET parent_id = ${body.parentId},
							action_id = ${body.parentId ? null : sql`action_id`}
						WHERE id = ${params.id}`
				);
				if (newOwner !== oldOwner) {
					await tx.execute(
						sql`UPDATE notes SET owner_id = ${newOwner} WHERE id IN (${inList(ids)})`
					);
				}
				await renumber(tx, target, { id: params.id, at: body.position });
				if (!sameContainer) await renumber(tx, source);
				return ids;
			});
			await core.audit.logFromContext(ctx, 'notes.note.moved', {
				target: params.id,
				metadata: { parentId: body.parentId, position: body.position, notes: moved.length }
			});
			await recheckNotes(moved);
			return noteDetail(ctx, params.id);
		}
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/notes/:id',
		summary: 'Notiz mit Unterseiten in den Papierkorb legen',
		description: `Nur Eigentümer*in oder \`notes.note.edit-all\`. Nach ${TRASH_DAYS} Tagen endgültig gelöscht.`,
		tags,
		permission: PERM.view,
		params: idParams,
		handler: async ({ ctx, params }) => {
			const ids = await mdb().transaction(async (tx) => {
				await requireNoteAccess(tx, ctx, params.id, 'share');
				const list = await liveSubtree(tx, params.id, 'deleted');
				await tx.execute(
					sql`UPDATE notes SET deleted_at = now(), deleted_by = ${ctx.userId},
							trash_root = (id = ${params.id})
						WHERE id IN (${inList(list)})`
				);
				return list;
			});
			closeNotes(ids);
			await core.audit.logFromContext(ctx, 'notes.note.trashed', {
				target: params.id,
				metadata: { notes: ids.length }
			});
			return { id: params.id, trashed: ids.length };
		}
	}),

	// --- Freigaben ---
	defineEndpoint({
		method: 'GET',
		path: '/notes/:id/shares',
		summary: 'Freigaben einer Notiz (eigene und von Oberseiten geerbte)',
		tags,
		permission: PERM.view,
		params: idParams,
		handler: async ({ ctx, params }) => {
			const state = await mdb().transaction((tx) => loadShareState(tx, ctx, params.id, 'read'));
			return buildShares(ctx, { ...state, canManage: state.access.canShare });
		}
	}),
	defineEndpoint({
		method: 'PUT',
		path: '/notes/:id/shares',
		summary: 'Freigaben einer Notiz ersetzen (gelten auch für alle Unterseiten)',
		description:
			'Stamm, Gruppe, Rolle, Mitglied, Benutzer*in mit `read`/`edit`. Nur Eigentümer*in oder `edit-all`. Offene Live-Verbindungen werden sofort neu geprüft.',
		tags,
		permission: PERM.view,
		params: idParams,
		body: sharesInput,
		handler: async ({ ctx, params, body }) => {
			const current = await mdb().transaction((tx) => loadShareState(tx, ctx, params.id, 'share'));
			body.shares.forEach((s, i) => {
				if (s.type === 'user' && s.id === current.ownerId) {
					throw errors.validation([
						{ path: ['shares', i, 'id'], message: 'Die Eigentümer*in hat bereits Zugriff' }
					]);
				}
			});
			await validatePrincipals(ctx, MODULE_ID, body.shares, {
				keep: new Set(current.shares.map((s) => `${s.type}:${s.id}`))
			});
			const { before, ids, state } = await mdb().transaction(async (tx) => {
				const state = await loadShareState(tx, ctx, params.id, 'share');
				await replaceObjectShares(tx, ctx, NOTE_SHARES, params.id, body.shares);
				return { before: state.shares, ids: await subtreeIds(tx, params.id), state };
			});
			const old = new Map(before.map((s) => [`${s.type}:${s.id}`, s.level]));
			const changed = [
				...addedPrincipals(before, body.shares),
				...body.shares.filter((s) => s.level === 'edit' && old.get(`${s.type}:${s.id}`) === 'read')
			];
			if (changed.length) {
				await notifyNoteShared(ctx, {
					noteId: params.id,
					title: current.title,
					ownerId: current.ownerId,
					principals: changed
				});
			}
			await core.audit.logFromContext(ctx, 'notes.note.shared', {
				target: params.id,
				metadata: {
					shares: body.shares.length,
					added: addedPrincipals(before, body.shares).length,
					removed: addedPrincipals(body.shares, before).length
				}
			});
			await recheckNotes(ids);
			return buildShares(ctx, {
				ownerId: state.ownerId,
				shares: body.shares,
				inherited: state.inherited,
				canManage: true
			});
		}
	})
];
