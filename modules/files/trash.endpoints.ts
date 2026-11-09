/**
 * Papierkorb: in den Papierkorb verschieben, Liste, Wiederherstellen, endgültig Löschen.
 * Zugriffsprüfung, Transaktion und Audit liegen in `trash.service.ts`.
 */
import { defineEndpoint, type ApiEndpoint } from '$lib/sdk/server';
import { listTrash, purgeNodes, restoreNodes, trashNodes } from './trash.service';
import { bulkInput, PERMISSIONS } from './schemas';

const TAGS = ['Modul: files'];

export const trashEndpoints = [
	defineEndpoint({
		method: 'POST',
		path: '/nodes/trash',
		summary: 'Dateien/Ordner in den Papierkorb verschieben (Bearbeiten-Zugriff nötig)',
		tags: TAGS,
		permission: PERMISSIONS.view,
		body: bulkInput,
		handler: async ({ ctx, body }) => trashNodes(ctx, body.ids)
	}),
	defineEndpoint({
		method: 'GET',
		path: '/trash',
		summary: 'Papierkorb-Einträge, die der Aufrufer sieht (mit Datum des endgültigen Löschens)',
		tags: TAGS,
		permission: PERMISSIONS.view,
		handler: async ({ ctx }) => listTrash(ctx)
	}),
	defineEndpoint({
		method: 'POST',
		path: '/trash/restore',
		summary: 'Einträge aus dem Papierkorb wiederherstellen (ursprünglicher Ort oder Wurzel)',
		tags: TAGS,
		permission: PERMISSIONS.view,
		body: bulkInput,
		handler: async ({ ctx, body }) => restoreNodes(ctx, body.ids)
	}),
	defineEndpoint({
		method: 'POST',
		path: '/trash/purge',
		summary: 'Einträge im Papierkorb endgültig löschen (inkl. Dateien im Speicher)',
		tags: TAGS,
		permission: PERMISSIONS.view,
		body: bulkInput,
		handler: async ({ ctx, body }) => purgeNodes(ctx, body.ids)
	})
] as ApiEndpoint[];
