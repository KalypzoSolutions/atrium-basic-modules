/**
 * Karten für Datensätze anderer Module (Aktion, Aufgabe, Aufgaben-Board, Termin, Galerie, Datei, Notiz) und andere
 * Whiteboards. Aufgelöst wird IMMER je Betrachter*in über die Verträge der Module (die prüfen die Rechte selbst);
 * im Element steht nur Typ + ID. Unsichtbares/Gelöschtes → `available: false` ohne Titel.
 * Alle Aufrufe außerhalb offener Transaktionen (die Dienste öffnen eigene).
 */
import { sql } from 'drizzle-orm';
import { core, inList, type RequestContext, rowsOf } from '$lib/sdk/server';
import { formatDateDe } from '$lib/sdk/dates';
import type { EventRefsService } from '$modules/events/contract';
import type { FileRefsService } from '$modules/files/contract';
import type { GalleryRefsService } from './peer-contracts';
import type { NoteRefsService } from '$modules/notes/contract';
import type { TaskRefsService } from '$modules/tasks/contract';
import { actionsService, visibleBoardsFilter } from './access';
import { mdb } from './boards.service';
import { boardLink } from './notify';
import { MODULE_ID, REF_LABELS, type RefCard, type RefType } from './schemas';

const DEFAULT_LIMIT = 20;
const like = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

function dateRange(start: string, end: string | null): string {
	return end && end !== start
		? `${formatDateDe(start)} – ${formatDateDe(end)}`
		: formatDateDe(start);
}

const PRIORITY_DE: Record<string, string> = {
	low: 'niedrig',
	medium: 'mittel',
	high: 'hoch',
	urgent: 'dringend'
};

function formatSize(bytes: number | null): string | null {
	if (bytes == null) return null;
	if (bytes < 1024) return `${bytes} B`;
	const kb = bytes / 1024;
	if (kb < 1024) return `${Math.round(kb)} KB`;
	return `${(kb / 1024).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB`;
}

export function unavailableCard(type: RefType, id: string): RefCard {
	return {
		type,
		id,
		available: false,
		title: `${REF_LABELS[type]} nicht verfügbar`,
		subtitle: null,
		href: null,
		color: null,
		imageUrl: null,
		badge: null
	};
}

const card = (type: RefType, id: string, rest: Partial<RefCard> & { title: string }): RefCard => ({
	type,
	id,
	available: true,
	subtitle: null,
	href: null,
	color: null,
	imageUrl: null,
	badge: null,
	...rest
});

/** Karten eines Typs suchen (`search` leer → neueste/zuletzt geänderte) bzw. für `ids` auflösen */
async function resolve(
	ctx: RequestContext,
	type: RefType,
	q: { search?: string; ids?: string[]; limit?: number }
): Promise<RefCard[]> {
	const search = q.search?.trim() ?? '';
	const searchLimit = Math.min(Math.max(q.limit ?? DEFAULT_LIMIT, 1), 100);
	switch (type) {
		case 'action': {
			const service = await actionsService();
			if (!service) return [];
			let list = await service.accessibleActions(ctx, q.ids ? { ids: q.ids } : undefined);
			if (!q.ids) {
				const s = search.toLocaleLowerCase('de');
				list = list
					.filter((a) => !s || a.name.toLocaleLowerCase('de').includes(s))
					.sort((a, b) => b.startsOn.localeCompare(a.startsOn))
					.slice(0, searchLimit);
			}
			return list.map((a) =>
				card('action', a.id, {
					title: a.name,
					subtitle: dateRange(a.startsOn, a.endsOn),
					href: `/modules/actions/${encodeURIComponent(a.id)}`,
					badge: a.level === 'edit' ? null : 'nur lesen'
				})
			);
		}
		case 'task':
		case 'taskboard': {
			const service = await core.modules.useOptional<TaskRefsService>('tasks', MODULE_ID);
			if (!service) return [];
			if (type === 'taskboard') {
				const list = q.ids
					? await service.describeBoardRefs(ctx, q.ids)
					: await service.searchBoardRefs(ctx, { search, limit: searchLimit });
				return list.map((b) =>
					card('taskboard', b.id, {
						title: b.name,
						subtitle: `${b.open} offen · ${b.done} erledigt`,
						href: b.href,
						color: b.color
					})
				);
			}
			const list = q.ids
				? await service.describeTaskRefs(ctx, q.ids)
				: await service.searchTaskRefs(ctx, { search, limit: searchLimit });
			return list.map((t) =>
				card('task', t.id, {
					title: t.title,
					subtitle: [t.boardName, t.columnName].join(' · '),
					href: t.href,
					badge: t.done
						? 'erledigt'
						: t.dueOn
							? `fällig ${formatDateDe(t.dueOn)}`
							: `Priorität ${PRIORITY_DE[t.priority] ?? t.priority}`
				})
			);
		}
		case 'event': {
			const service = await core.modules.useOptional<EventRefsService>('events', MODULE_ID);
			if (!service) return [];
			const list = q.ids
				? await service.describeEventRefs(ctx, q.ids)
				: await service.searchEventRefs(ctx, { search, limit: searchLimit });
			return list.map((e) =>
				card('event', e.id, {
					title: e.title,
					subtitle: dateRange(e.startsOn, e.endsOn),
					href: `/modules/events?event=${encodeURIComponent(e.id)}`,
					color: e.color,
					badge: e.recurring ? 'Serie' : null
				})
			);
		}
		case 'gallery': {
			const service = await core.modules.useOptional<GalleryRefsService>('galleries', MODULE_ID);
			if (!service) return [];
			const list = q.ids
				? await service.describeGalleryCards(ctx, q.ids)
				: await service.searchGalleryCards(ctx, { search, limit: searchLimit });
			return list.map((g) =>
				card('gallery', g.id, {
					title: g.title,
					subtitle: `${g.imageCount} ${g.imageCount === 1 ? 'Bild' : 'Bilder'}`,
					href: g.href,
					imageUrl: g.coverUrl,
					badge: g.visibility === 'public' ? 'öffentlich' : null
				})
			);
		}
		case 'file': {
			const service = await core.modules.useOptional<FileRefsService>('files', MODULE_ID);
			if (!service) return [];
			const list = q.ids
				? await service.describeFileRefs(ctx, q.ids)
				: await service.searchFileRefs(ctx, { search, limit: searchLimit });
			return list.map((f) =>
				card('file', f.id, {
					title: f.name,
					subtitle: f.kind === 'folder' ? 'Ordner' : formatSize(f.sizeBytes),
					href: f.kind === 'folder' ? f.href : (f.contentUrl ?? f.href),
					color: f.color,
					imageUrl: f.hasThumb
						? `/api/v1/modules/files/nodes/${encodeURIComponent(f.id)}/thumb`
						: null,
					badge: f.kind === 'folder' ? null : (f.contentType ?? null)
				})
			);
		}
		case 'note': {
			const service = await core.modules.useOptional<NoteRefsService>('notes', MODULE_ID);
			if (!service) return [];
			const list = q.ids
				? await service.describeNoteRefs(ctx, q.ids)
				: await service.searchNoteRefs(ctx, { search, limit: Math.min(searchLimit, 50) });
			return list.map((n) =>
				card('note', n.id, {
					title: n.title || 'Ohne Titel',
					subtitle: n.excerpt || n.path || null,
					href: n.href,
					color: n.color
				})
			);
		}
		case 'whiteboard': {
			const rows = await mdb().transaction((tx) =>
				rowsOf(
					tx,
					sql`SELECT b.id, b.name, b.color, b.element_count FROM boards b
						WHERE ${visibleBoardsFilter(ctx)}
							${q.ids ? sql`AND b.id IN (${inList(q.ids)})` : search ? sql`AND b.name ILIKE ${like(search)}` : sql``}
						ORDER BY b.updated_at DESC, b.id LIMIT ${q.ids ? q.ids.length : searchLimit}`
				)
			);
			return rows.map((r) =>
				card('whiteboard', String(r.id), {
					title: String(r.name),
					subtitle: `${Number(r.element_count ?? 0)} Elemente`,
					href: boardLink(String(r.id)),
					color: r.color == null ? null : String(r.color)
				})
			);
		}
	}
}

/** GET `/refs`: Kandidaten für den Karten-Dialog */
export async function searchRefs(
	ctx: RequestContext,
	type: RefType,
	search: string,
	limit?: number
) {
	return resolve(ctx, type, { search, limit });
}

/** POST `/refs/describe`: Karten je Betrachter*in auflösen, Reihenfolge wie `items` */
export async function describeRefs(
	ctx: RequestContext,
	items: readonly { type: RefType; id: string }[]
): Promise<RefCard[]> {
	const byType = new Map<RefType, string[]>();
	for (const it of items) {
		const list = byType.get(it.type) ?? [];
		if (!list.includes(it.id)) list.push(it.id);
		byType.set(it.type, list);
	}
	const found = new Map<string, RefCard>();
	for (const [type, ids] of byType) {
		// Typen von Modulen ohne Recht/inaktiv liefern leer → nicht verfügbar
		const cards = await resolve(ctx, type, { ids: ids.slice(0, 200) }).catch((e) => {
			console.warn(`[whiteboard] Karten (${type}) nicht auflösbar`, e);
			return [] as RefCard[];
		});
		for (const c of cards) found.set(`${type}:${c.id}`, c);
	}
	return items.map((it) => found.get(`${it.type}:${it.id}`) ?? unavailableCard(it.type, it.id));
}
