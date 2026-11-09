/**
 * Öffentliche Links auf Ordner/Dateien: Verwaltung (intern) und öffentlicher Zugriff ohne Login.
 * Öffentliche Pfade liegen unter `/public/links/…` und überschneiden sich nicht mit internen Pfaden.
 * Rate-Limits gelten je IP (angemeldet: je Benutzer*in) und Endpunkt-Muster; der Router ergänzt für
 * öffentliche Endpunkte einen IP-unabhängigen Gesamt-Bucket (20 × Limit, mindestens 200).
 */
import type { ApiEndpoint } from '$lib/sdk/server';
import {
	createLink,
	listLinks,
	publicContent,
	publicInfo,
	publicList,
	publicUpload,
	revokeLink,
	unlockLink
} from './links.service';
import {
	MAX_PUBLIC_UPLOAD_BYTES,
	MAX_PUBLIC_UPLOAD_FILES,
	PERMISSIONS,
	idParams,
	linkCreateInput,
	publicInfoQuery,
	linkIdParams,
	linkUnlockInput,
	publicContentQuery,
	publicNodesQuery,
	publicUploadFields,
	tokenNodeParams,
	tokenParams,
	type LinkCreateInput,
	type PublicUploadFields
} from './schemas';

const TAGS = ['Dateien – Links'];

type TokenP = { token: string };

export const linksEndpoints: ApiEndpoint[] = [
	// --- Intern -------------------------------------------------------------
	{
		method: 'GET',
		path: '/nodes/:id/links',
		summary: 'Öffentliche Links eines Ordners/einer Datei auflisten',
		tags: TAGS,
		permission: PERMISSIONS.view,
		params: idParams,
		handler: async ({ ctx, params }) => listLinks(ctx, (params as { id: string }).id)
	},
	{
		method: 'POST',
		path: '/nodes/:id/links',
		summary:
			'Öffentlichen Link anlegen (Art Ansehen/Hochladen/beides, optional mit Ablaufdatum und Passwort)',
		tags: TAGS,
		permission: PERMISSIONS.view,
		params: idParams,
		body: linkCreateInput,
		handler: async ({ ctx, params, body }) =>
			createLink(ctx, (params as { id: string }).id, body as LinkCreateInput)
	},
	{
		method: 'DELETE',
		path: '/links/:id',
		summary: 'Öffentlichen Link widerrufen',
		tags: TAGS,
		permission: PERMISSIONS.view,
		params: linkIdParams,
		handler: async ({ ctx, params }) => revokeLink(ctx, (params as { id: string }).id)
	},

	// --- Öffentlich ---------------------------------------------------------
	{
		method: 'GET',
		path: '/public/links/:token',
		summary: 'Öffentlichen Link lesen (Name, Art, Passwortpflicht, Upload-Grenzen)',
		tags: TAGS,
		permission: null,
		public: true,
		rateLimit: { limit: 60, windowSec: 60 },
		params: tokenParams,
		query: publicInfoQuery,
		handler: async ({ ctx, params, query }) =>
			publicInfo(ctx, (params as TokenP).token, (query as { t?: string }).t)
	},
	{
		method: 'POST',
		path: '/public/links/:token/unlock',
		summary: 'Passwortgeschützten Link freischalten (liefert ein Zugriffstoken)',
		tags: TAGS,
		permission: null,
		public: true,
		// Brute-Force-Schutz
		rateLimit: { limit: 10, windowSec: 600 },
		params: tokenParams,
		body: linkUnlockInput,
		handler: async ({ ctx, params, body }) =>
			unlockLink(ctx, (params as TokenP).token, (body as { password: string }).password)
	},
	{
		method: 'GET',
		path: '/public/links/:token/nodes',
		summary: 'Inhalt eines Ordners über einen öffentlichen Link',
		tags: TAGS,
		permission: null,
		public: true,
		rateLimit: { limit: 120, windowSec: 60 },
		params: tokenParams,
		query: publicNodesQuery,
		handler: async ({ ctx, params, query }) => {
			const q = query as { parent?: string; t?: string };
			return publicList(ctx, (params as TokenP).token, {
				parentId: q.parent ?? null,
				...(q.t !== undefined ? { accessToken: q.t } : {})
			});
		}
	},
	{
		method: 'GET',
		path: '/public/links/:token/content/:nodeId',
		summary: 'Datei über einen öffentlichen Link abrufen (Vorschau, Download oder Thumbnail)',
		tags: TAGS,
		permission: null,
		public: true,
		// Galerie-Ansicht lädt viele Thumbnails
		rateLimit: { limit: 300, windowSec: 60 },
		params: tokenNodeParams,
		query: publicContentQuery,
		handler: async ({ ctx, params, query }) => {
			const p = params as TokenP & { nodeId: string };
			const q = query as { t?: string; download?: '0' | '1'; thumb?: '0' | '1' };
			return publicContent(ctx, p.token, p.nodeId, {
				...(q.t !== undefined ? { accessToken: q.t } : {}),
				download: q.download === '1',
				thumb: q.thumb === '1'
			});
		}
	},
	{
		method: 'POST',
		path: '/public/links/:token/upload',
		summary:
			'Dateien über einen Upload-Link hochladen (multipart, Dateien im Feld "file", optional "name" und "t")',
		tags: TAGS,
		permission: null,
		public: true,
		// Missbrauchsschutz: je IP höchstens 20 Requests (à bis zu 10 Dateien) in 10 Minuten
		rateLimit: { limit: 20, windowSec: 600 },
		multipart: { maxBytes: MAX_PUBLIC_UPLOAD_BYTES, maxFiles: MAX_PUBLIC_UPLOAD_FILES },
		params: tokenParams,
		body: publicUploadFields,
		handler: async ({ ctx, params, body, files }) =>
			publicUpload(ctx, (params as TokenP).token, body as PublicUploadFields, files ?? [])
	}
] as ApiEndpoint[];
