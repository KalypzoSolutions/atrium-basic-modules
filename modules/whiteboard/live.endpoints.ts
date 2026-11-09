/** Live-Bearbeitung: Ereignis-Stream (SSE), Änderungen und Anwesenheit (`/api/v1/modules/whiteboard/…`). */
import { type AnyApiEndpoint, defineEndpoint, errors } from '$lib/sdk/server';
import { requireBoardAccess } from './access';
import { mdb, userRefs } from './boards.service';
import { MAX_STREAMS_PER_USER, openStream, openStreamCount, updatePresence } from './live';
import { applyOps } from './ops.service';
import {
	idParams,
	liveQuery,
	opsInput,
	PERM,
	presenceColor,
	presenceInput,
	type OpsResult
} from './schemas';

const tags = ['Whiteboard'];

export const liveEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/boards/:id/live',
		summary: 'Live-Ereignisse eines Whiteboards (Server-Sent Events)',
		description:
			'`text/event-stream` mit JSON-Ereignissen (`hello`, `ops`, `presence`, `join`, `leave`, `board`, `access`, `reset`, `revoked`, `deleted`) und Heartbeat alle 20 s. `since` = zuletzt bekannte Änderungsnummer → fehlende Änderungen kommen sofort nach `hello`; ist sie zu alt, meldet `hello.reset`, dass das Board neu geladen werden muss.',
		tags,
		permission: PERM.view,
		params: idParams,
		query: liveQuery,
		handler: async ({ ctx, params, query, request }) => {
			if (!ctx.userId) throw errors.unauthenticated();
			if (openStreamCount(ctx.userId) >= MAX_STREAMS_PER_USER) {
				throw errors.rateLimited();
			}
			const access = await mdb().transaction((tx) => requireBoardAccess(tx, ctx, params.id));
			const me = (await userRefs(ctx, [ctx.userId])).get(ctx.userId);
			return openStream({
				ctx,
				request,
				boardId: params.id,
				client: query.client,
				level: access.level,
				since: query.since,
				peer: {
					client: query.client,
					userId: ctx.userId,
					name: me?.name ?? 'Unbekannt',
					image: me?.image ?? null,
					color: presenceColor(ctx.userId)
				}
			});
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/boards/:id/ops',
		summary: 'Elemente anlegen, ändern oder löschen',
		description:
			'Bis zu 500 Änderungen je Anfrage (`{ id, type, data, z }` ersetzt das ganze Element, `{ id, deleted: true }` löscht). Zuletzt geschrieben gewinnt; jede Änderung zählt die Version des Elements hoch. Antwort: neue Änderungsnummer und Versionen. Bearbeiten-Zugriff nötig.',
		tags,
		permission: PERM.view,
		// eigenes Kontingent: der Editor schickt gebündelt etwa alle 80 ms
		rateLimit: { limit: 1200, windowSec: 60 },
		params: idParams,
		body: opsInput,
		handler: ({ ctx, params, body }): Promise<OpsResult> => applyOps(ctx, params.id, body)
	}),
	defineEndpoint({
		method: 'POST',
		path: '/boards/:id/presence',
		summary: 'Anwesenheit melden (Mauszeiger, Auswahl, bearbeitetes Element)',
		description:
			'Wird nur an die anderen offenen Verbindungen verteilt, nicht gespeichert. Ohne offene Verbindung mit dieser `client`-Kennung → `{ ok: false }`.',
		tags,
		permission: PERM.view,
		rateLimit: { limit: 1500, windowSec: 60 },
		params: idParams,
		body: presenceInput,
		handler: async ({ ctx, params, body }) => {
			if (!ctx.userId) throw errors.unauthenticated();
			const ok = updatePresence(params.id, body.client, ctx.userId, {
				cursor: body.cursor,
				selection: body.selection,
				editing: body.editing
			});
			return { ok };
		}
	})
];
