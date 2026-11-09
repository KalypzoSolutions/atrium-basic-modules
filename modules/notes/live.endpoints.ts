/** Live-Bearbeitung: Yjs-Zustand, Ereignis-Stream (SSE), Änderungen und Anwesenheit (`/api/v1/modules/notes/…`). */
import { type AnyApiEndpoint, defineEndpoint, errors } from '$lib/sdk/server';
import { requireNoteAccess } from './access';
import { mdb, userRefs } from './db';
import { applyClientUpdate, stateFor } from './doc.service';
import { hub, peersOf } from './live';
import { stateResponse } from './state-response';
import {
	awarenessInput,
	idParams,
	liveQuery,
	MAX_STREAMS_PER_USER,
	MAX_UPDATE_BYTES,
	PERM,
	presenceColor,
	stateQuery,
	updatesQuery,
	type LiveEvent,
	type Peer,
	type UpdateResult
} from './schemas';

const tags = ['Notizen'];
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');

function decodeStateVector(sv: string | undefined): Uint8Array | null {
	if (!sv) return null;
	// Node liest base64 und base64url gleichermaßen
	return new Uint8Array(Buffer.from(sv, 'base64'));
}

export const liveEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/notes/:id/state',
		summary: 'Yjs-Zustand einer Notiz (binär)',
		description:
			'`application/octet-stream` = Yjs-Update. Mit `sv` (eigener State-Vector, base64) nur die fehlenden Änderungen. Header `x-yjs-state-vector` = State-Vector des Servers (base64), `x-note-level` = `read`/`edit`.',
		tags,
		permission: PERM.view,
		params: idParams,
		query: stateQuery,
		handler: async ({ ctx, params, query, request }) => {
			const access = await mdb().transaction((tx) => requireNoteAccess(tx, ctx, params.id));
			const { update, stateVector } = await stateFor(params.id, decodeStateVector(query.sv));
			return stateResponse(request, update, {
				'x-yjs-state-vector': b64(stateVector),
				'x-note-level': access.level
			});
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/notes/:id/live',
		summary: 'Live-Ereignisse einer Notiz (Server-Sent Events)',
		description:
			'`text/event-stream` mit JSON-Ereignissen (`hello`, `update`, `awareness`, `join`, `leave`, `peer`, `meta`, `access`, `reset`, `revoked`, `deleted`) und Heartbeat alle 20 s. Yjs-Updates kommen base64-kodiert.',
		tags,
		permission: PERM.view,
		params: idParams,
		query: liveQuery,
		handler: async ({ ctx, params, query, request }) => {
			if (!ctx.userId) throw errors.unauthenticated();
			const userId = ctx.userId;
			if (hub.streamCount(userId) >= MAX_STREAMS_PER_USER) throw errors.rateLimited();
			const access = await mdb().transaction((tx) => requireNoteAccess(tx, ctx, params.id));
			const me = (await userRefs(ctx, [userId])).get(userId);
			const peer: Peer = {
				client: query.client,
				userId,
				name: me?.name ?? 'Unbekannt',
				image: me?.image ?? null,
				color: presenceColor(userId),
				canEdit: access.level === 'edit',
				awarenessId: query.awarenessId ?? null
			};
			return hub.open({
				ctx,
				request,
				objectId: params.id,
				client: query.client,
				level: access.level,
				peer,
				onOpen: async (push, sub) => {
					push({
						type: 'hello',
						client: query.client,
						level: sub.level,
						peers: peersOf(params.id).filter((p) => p.client !== query.client)
					} satisfies LiveEvent);
					hub.broadcast(
						params.id,
						{ type: 'join', peer: sub.peer } satisfies LiveEvent,
						query.client
					);
				}
			});
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/notes/:id/updates',
		summary: 'Yjs-Update anwenden (binär)',
		description:
			'Body = ein (zusammengeführtes) Yjs-Update als `application/octet-stream`, höchstens 5 MB. Wird gespeichert und an alle anderen Verbindungen verteilt. Bearbeiten-Zugriff nötig.',
		tags,
		permission: PERM.view,
		// eigenes Kontingent: der Editor schickt gebündelt etwa alle 100 ms
		rateLimit: { limit: 1200, windowSec: 60 },
		params: idParams,
		query: updatesQuery,
		handler: async ({ ctx, params, query, request }): Promise<UpdateResult> => {
			const type = (request.headers.get('content-type') ?? '').toLowerCase();
			if (!/^application\/octet-stream\s*(;|$)/.test(type)) {
				throw errors.badRequest('Content-Type application/octet-stream erforderlich');
			}
			const length = Number(request.headers.get('content-length') ?? 0);
			if (length > MAX_UPDATE_BYTES) throw errors.tooLarge('Die Änderung ist zu groß');
			await mdb().transaction((tx) => requireNoteAccess(tx, ctx, params.id, 'edit'));
			const bytes = new Uint8Array(await request.arrayBuffer());
			if (bytes.byteLength > MAX_UPDATE_BYTES) throw errors.tooLarge('Die Änderung ist zu groß');
			const result = await applyClientUpdate(params.id, bytes, {
				userId: ctx.userId,
				client: query.client
			});
			return { ok: true, sizeBytes: result.sizeBytes };
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/notes/:id/awareness',
		summary: 'Anwesenheit melden (Cursor, Auswahl)',
		description:
			'Awareness-Update (base64) wird nur an die anderen offenen Verbindungen verteilt, nicht gespeichert. Ohne eigene offene Verbindung mit dieser `client`-Kennung → `{ ok: false }`.',
		tags,
		permission: PERM.view,
		rateLimit: { limit: 1500, windowSec: 60 },
		params: idParams,
		body: awarenessInput,
		handler: async ({ ctx, params, body }) => {
			if (!ctx.userId) throw errors.unauthenticated();
			const sub = hub.get(params.id, body.client);
			if (!sub || sub.userId !== ctx.userId) return { ok: false };
			hub.broadcast(
				params.id,
				{ type: 'awareness', client: body.client, update: body.update } satisfies LiveEvent,
				body.client
			);
			return { ok: true };
		}
	})
];
