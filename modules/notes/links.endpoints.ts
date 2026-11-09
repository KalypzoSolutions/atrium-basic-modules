/**
 * Öffentliche Links auf Notizen: Verwaltung (intern, `linkEndpoints` – läuft in `withNoteContext`) und Zugriff ohne
 * Login (`publicLinkEndpoints`, `public: true`, ohne Notiz-Kontext). Öffentliche Pfade liegen unter `/public/links/…`.
 * Gäste bearbeiten live wie angemeldete Personen (SSE + Updates), Updates aber als JSON (base64), weil der Router bei
 * öffentlichen Endpunkten nur JSON annimmt. Der Router ergänzt je öffentlichem Endpunkt einen IP-unabhängigen Gesamt-Bucket.
 */
import { sql } from 'drizzle-orm';
import {
	type AnyApiEndpoint,
	defineEndpoint,
	errors,
	IMAGE_RATE_LIMIT,
	rowsOf
} from '$lib/sdk/server';
import { mdb } from './db';
import { applyClientUpdate, stateFor } from './doc.service';
import { stateResponse } from './state-response';
import { hub, peersOf } from './live';
import { assetPaths } from './assets.service';
import { fileResponse } from './storage';
import {
	createLink,
	guestLevel,
	guestSubject,
	listLinks,
	publicInfo,
	resolveGuest,
	revokeLink,
	unlockLink,
	type GuestAccess
} from './links.service';
import {
	idParams,
	linkCreateInput,
	linkParams,
	linkUnlockInput,
	MAX_GUEST_STREAMS_PER_IP,
	MAX_PUBLIC_UPDATE_BYTES,
	PERM,
	presenceColor,
	publicAssetParams,
	publicAwarenessInput,
	publicLiveQuery,
	publicNoteParams,
	publicQuery,
	publicStateQuery,
	publicTokenParams,
	publicUpdateInput,
	type LiveEvent,
	type Peer,
	type UpdateResult
} from './schemas';

const tags = ['Notizen – Links'];
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');

export const linkEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/notes/:id/links',
		summary: 'Öffentliche Links einer Notiz auflisten (mit Adresse)',
		description: 'Nur Eigentümer*in bzw. `notes.note.edit-all`.',
		tags,
		permission: PERM.view,
		params: idParams,
		handler: async ({ ctx, params }) => listLinks(ctx, params.id)
	}),
	defineEndpoint({
		method: 'POST',
		path: '/notes/:id/links',
		summary:
			'Öffentlichen Link anlegen (Ansehen oder Bearbeiten, optional Ablaufdatum und Passwort)',
		description:
			'Gilt für die Seite und alle Unterseiten. Eigentümer*in bzw. `edit-all` und `notes.link.create` nötig; höchstens 20 aktive Links je Notiz.',
		tags,
		permission: PERM.view,
		params: idParams,
		body: linkCreateInput,
		handler: async ({ ctx, params, body }) => createLink(ctx, params.id, body)
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/links/:linkId',
		summary: 'Öffentlichen Link widerrufen',
		description: 'Offene Gast-Verbindungen werden sofort geschlossen.',
		tags,
		permission: PERM.view,
		params: linkParams,
		handler: async ({ ctx, params }) => {
			const link = await revokeLink(ctx, params.linkId);
			clearGuestCache();
			return link;
		}
	})
];

/** Kurzzeit-Cache für Gast-Updates (der Editor schickt etwa alle 100 ms) */
const HOT_TTL_MS = 5_000;
const hot = new Map<string, { at: number; access: GuestAccess }>();

async function guestForUpdate(token: string, noteId: string, t: string | undefined) {
	const key = `${token}|${noteId}|${t ?? ''}`;
	const now = Date.now();
	const cached = hot.get(key);
	if (cached && now - cached.at < HOT_TTL_MS) return cached.access;
	const access = await resolveGuest(token, noteId, t, 'edit');
	if (hot.size > 1000) {
		for (const [k, v] of hot) if (now - v.at >= HOT_TTL_MS) hot.delete(k);
	}
	hot.set(key, { at: now, access });
	return access;
}

/** Nach einem Widerruf o. Ä. nicht mehr aus dem Cache bedienen */
export function clearGuestCache(): void {
	hot.clear();
}

function decodeStateVector(sv: string | undefined): Uint8Array | null {
	if (!sv) return null;
	return new Uint8Array(Buffer.from(sv, 'base64'));
}

export const publicLinkEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/public/links/:token',
		summary: 'Öffentlichen Notiz-Link lesen (Titel, Stufe, Passwortpflicht, Seitenbaum)',
		tags,
		permission: null,
		public: true,
		rateLimit: { limit: 60, windowSec: 60 },
		params: publicTokenParams,
		query: publicQuery,
		handler: async ({ ctx, params, query }) => publicInfo(ctx, params.token, query.t)
	}),
	defineEndpoint({
		method: 'POST',
		path: '/public/links/:token/unlock',
		summary: 'Passwortgeschützten Notiz-Link freischalten (liefert ein Zugriffstoken)',
		tags,
		permission: null,
		public: true,
		rateLimit: { limit: 10, windowSec: 600 },
		params: publicTokenParams,
		body: linkUnlockInput,
		handler: async ({ params, body }) => unlockLink(params.token, body.password)
	}),
	defineEndpoint({
		method: 'GET',
		path: '/public/links/:token/notes/:noteId/state',
		summary: 'Yjs-Zustand einer Seite über einen öffentlichen Link (binär)',
		tags,
		permission: null,
		public: true,
		rateLimit: { limit: 120, windowSec: 60 },
		params: publicNoteParams,
		query: publicStateQuery,
		handler: async ({ params, query, request }) => {
			const access = await resolveGuest(params.token, params.noteId, query.t);
			const { update, stateVector } = await stateFor(params.noteId, decodeStateVector(query.sv));
			return stateResponse(request, update, {
				'x-yjs-state-vector': b64(stateVector),
				'x-note-level': access.level
			});
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/public/links/:token/notes/:noteId/live',
		summary: 'Live-Ereignisse einer Seite über einen öffentlichen Link (Server-Sent Events)',
		description:
			'Wie `/notes/:id/live`. `key` = Geheimnis des Tabs (Identität für Anwesenheit), `name` = angezeigter Name (leer = „Gast“).',
		tags,
		permission: null,
		public: true,
		rateLimit: { limit: 30, windowSec: 60 },
		params: publicNoteParams,
		query: publicLiveQuery,
		handler: async ({ ctx, params, query, request }) => {
			const guests = hub.countWhere((s) => s.userId.startsWith('guest:') && s.ctx.ip === ctx.ip);
			if (guests >= MAX_GUEST_STREAMS_PER_IP) throw errors.rateLimited();
			const access = await resolveGuest(params.token, params.noteId, query.t);
			const subject = guestSubject(query.key);
			const name = query.name ? `${query.name} (Gast)` : 'Gast';
			const peer: Peer = {
				client: query.client,
				userId: subject,
				name,
				image: null,
				color: presenceColor(subject),
				canEdit: access.level === 'edit',
				awarenessId: query.awarenessId ?? null
			};
			const { token, noteId } = params;
			const t = query.t;
			return hub.open({
				ctx,
				request,
				objectId: noteId,
				client: query.client,
				level: access.level,
				peer,
				subject,
				recheck: () => guestLevel(token, noteId, t),
				onOpen: async (push, sub) => {
					push({
						type: 'hello',
						client: query.client,
						level: sub.level,
						peers: peersOf(noteId).filter((p) => p.client !== query.client)
					} satisfies LiveEvent);
					hub.broadcast(noteId, { type: 'join', peer: sub.peer } satisfies LiveEvent, query.client);
				}
			});
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/public/links/:token/notes/:noteId/updates',
		summary: 'Yjs-Update über einen Bearbeiten-Link anwenden (base64 im JSON)',
		tags,
		permission: null,
		public: true,
		rateLimit: { limit: 1200, windowSec: 60 },
		params: publicNoteParams,
		body: publicUpdateInput,
		handler: async ({ params, body }): Promise<UpdateResult> => {
			await guestForUpdate(params.token, params.noteId, body.t);
			const bytes = new Uint8Array(Buffer.from(body.update, 'base64'));
			if (bytes.byteLength > MAX_PUBLIC_UPDATE_BYTES) {
				throw errors.tooLarge('Die Änderung ist zu groß');
			}
			const result = await applyClientUpdate(params.noteId, bytes, {
				userId: null,
				client: body.client
			});
			return { ok: true, sizeBytes: result.sizeBytes };
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/public/links/:token/notes/:noteId/awareness',
		summary: 'Anwesenheit eines Gasts melden (Cursor, Auswahl)',
		description:
			'Nur für die eigene offene Verbindung (gleiche `client`-Kennung und gleiches Geheimnis `key`), sonst `{ ok: false }`.',
		tags,
		permission: null,
		public: true,
		rateLimit: { limit: 1500, windowSec: 60 },
		params: publicNoteParams,
		body: publicAwarenessInput,
		handler: async ({ params, body }) => {
			const sub = hub.get(params.noteId, body.client);
			if (!sub || sub.userId !== guestSubject(body.key)) return { ok: false };
			hub.broadcast(
				params.noteId,
				{ type: 'awareness', client: body.client, update: body.update } satisfies LiveEvent,
				body.client
			);
			return { ok: true };
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/public/links/:token/assets/:assetId/:variant',
		summary: 'Bild einer Seite über einen öffentlichen Link',
		tags,
		permission: null,
		public: true,
		rateLimit: IMAGE_RATE_LIMIT,
		params: publicAssetParams,
		query: publicQuery,
		handler: async ({ params, query }) => {
			const row = await mdb().transaction(async (tx) => {
				const [r] = await rowsOf(
					tx,
					sql`SELECT note_id, name, paths FROM note_assets WHERE id = ${params.assetId}`
				);
				return r ?? null;
			});
			if (!row) throw errors.notFound('Bild nicht gefunden');
			await resolveGuest(params.token, String(row.note_id), query.t).catch((e: unknown) => {
				if ((e as { status?: number }).status === 404) throw errors.notFound('Bild nicht gefunden');
				throw e;
			});
			const paths = assetPaths(row.paths);
			const path = paths[params.variant] ?? (params.variant === 'file' ? paths.web : undefined);
			if (!path) throw errors.notFound('Bild nicht gefunden');
			return fileResponse(path, {
				name: String(row.name),
				download: false,
				cache: 'private, max-age=3600'
			});
		}
	})
];
