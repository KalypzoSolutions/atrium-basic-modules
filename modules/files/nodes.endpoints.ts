/**
 * Ordner/Dateien: Auflisten (eine Ansicht: eigene + freigegebene Einträge), Suche, Ordner anlegen, Einzelabruf, Umbenennen, Verschieben.
 * Dünne Endpunkte – Zugriffsprüfung und Logik in `nodes.service.ts` / `access.ts`.
 * Pfade: `/nodes/move` (POST) vor `/nodes/:id` (GET/PATCH) – Methoden unterscheiden sich ohnehin.
 */
import { defineEndpoint, type ApiEndpoint } from '$lib/sdk/server';
import { requireNode } from './access';
import { mdb } from './db';
import {
	createFolder,
	listFolder,
	loadFileNode,
	moveNodes,
	renameNode,
	searchNodes,
	setNodeStyle
} from './nodes.service';
import { keysFor } from './shares.service';
import {
	PERMISSIONS,
	folderCreateInput,
	idParams,
	listQuery,
	moveInput,
	renameInput,
	searchQuery,
	styleInput,
	type BulkResult,
	type FileNode,
	type FolderListing,
	type SearchResult
} from './schemas';

const tags = ['Modul: files'];

export const nodesEndpoints = [
	defineEndpoint({
		method: 'GET',
		path: '/nodes',
		summary: 'Inhalt eines Ordners (ohne `parent` = Wurzel: eigene und mir freigegebene Einträge)',
		tags,
		permission: PERMISSIONS.view,
		query: listQuery,
		handler: async ({ ctx, query }): Promise<FolderListing> =>
			listFolder(ctx, { parentId: query.parent ?? null, ownerId: query.owner })
	}),
	defineEndpoint({
		method: 'GET',
		path: '/search',
		summary: 'Ordner und Dateien nach Namen suchen',
		tags,
		permission: PERMISSIONS.view,
		query: searchQuery,
		handler: async ({ ctx, query }): Promise<SearchResult> => searchNodes(ctx, { q: query.q })
	}),
	defineEndpoint({
		method: 'POST',
		path: '/folders',
		summary: 'Ordner anlegen',
		tags,
		permission: PERMISSIONS.view,
		body: folderCreateInput,
		handler: async ({ ctx, body }): Promise<FileNode> => createFolder(ctx, body)
	}),
	defineEndpoint({
		method: 'POST',
		path: '/nodes/move',
		summary: 'Ordner/Dateien verschieben',
		tags,
		permission: PERMISSIONS.view,
		body: moveInput,
		handler: async ({ ctx, body }): Promise<BulkResult> => moveNodes(ctx, body)
	}),
	defineEndpoint({
		method: 'POST',
		path: '/nodes/style',
		summary: 'Icon und Farbe von Ordnern setzen oder zurücksetzen',
		tags,
		permission: PERMISSIONS.view,
		body: styleInput,
		handler: async ({ ctx, body }): Promise<BulkResult> => setNodeStyle(ctx, body)
	}),
	defineEndpoint({
		method: 'GET',
		path: '/nodes/:id',
		summary: 'Ordner oder Datei abrufen',
		tags,
		permission: PERMISSIONS.view,
		params: idParams,
		handler: async ({ ctx, params }): Promise<FileNode> => {
			// Zugriff zuerst prüfen (404 ohne Zugriff, kein Existenz-Leak), dann DTO laden
			const keys = await keysFor(ctx);
			await mdb().transaction((tx) => requireNode(tx, ctx, params.id, keys, 'read'));
			return loadFileNode(ctx, params.id);
		}
	}),
	defineEndpoint({
		method: 'PATCH',
		path: '/nodes/:id',
		summary: 'Ordner oder Datei umbenennen',
		tags,
		permission: PERMISSIONS.view,
		params: idParams,
		body: renameInput,
		handler: async ({ ctx, params, body }): Promise<FileNode> =>
			renameNode(ctx, params.id, body.name)
	})
] as ApiEndpoint[];
