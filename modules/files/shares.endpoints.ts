/**
 * Freigaben an Principals je Knoten und Suche nach Freigabe-Zielen.
 * Zugriff (read/edit), Validierung der Principals und Audit erledigt `shares.service.ts`.
 */
import { defineEndpoint, PRINCIPAL_SEARCH_RATE_LIMIT, type AnyApiEndpoint } from '$lib/sdk/server';
import { getShares, putShares, searchShareTargets } from './shares.service';
import { PERMISSIONS, idParams, principalSearchQuery, sharesInput } from './schemas';

const tags = ['Modul: files'];

export const sharesEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/nodes/:id/shares',
		summary: 'Freigaben eines Ordners bzw. einer Datei (eigene und geerbte)',
		description:
			'Braucht Lesezugriff auf den Knoten, sonst 404. `inherited` enthält die Freigaben übergeordneter Ordner (nur Anzeige).',
		tags,
		permission: PERMISSIONS.view,
		params: idParams,
		handler: ({ ctx, params }) => getShares(ctx, params.id)
	}),
	defineEndpoint({
		method: 'PUT',
		path: '/nodes/:id/shares',
		summary: 'Freigaben eines Ordners bzw. einer Datei ersetzen',
		description:
			'Ersetzt die komplette Liste (Stamm, Gruppe, Rolle, Mitglied, Benutzer*in; Stufe `read`/`edit`). Nur Eigentümer*in oder `files.file.manage-all` (ohne Zugriff 404, Bearbeiten über eine Freigabe reicht nicht → 403). Unbekannte oder doppelte Ziele → 422.',
		tags,
		permission: PERMISSIONS.view,
		params: idParams,
		body: sharesInput,
		handler: ({ ctx, params, body }) => putShares(ctx, params.id, body.shares)
	}),
	defineEndpoint({
		method: 'GET',
		path: '/principals',
		summary: 'Freigabe-Ziele suchen (Stamm, Gruppen, Rollen, Mitglieder, Benutzer*innen)',
		description:
			'Suche ab 2 Zeichen. Nur für Personen, die Freigaben verwalten können (`files.file.manage-all` oder Eigentümer*in mindestens eines Knotens), sonst 403. Mitglieder nur mit `members.member.view`, E-Mail-Adressen nur mit `core.users.view`.',
		tags,
		permission: PERMISSIONS.view,
		rateLimit: PRINCIPAL_SEARCH_RATE_LIMIT,
		query: principalSearchQuery,
		handler: ({ ctx, query }) => searchShareTargets(ctx, query.q)
	})
];
