/** Versionsverlauf einer Notiz (`/api/v1/modules/notes/notes/:id/versions…`). */
import { type AnyApiEndpoint, core, defineEndpoint } from '$lib/sdk/server';
import {
	deleteVersion,
	getVersion,
	listVersions,
	restoreVersion,
	saveVersion
} from './versions.service';
import { idParams, PERM, versionInput, versionParams } from './schemas';

const tags = ['Notizen'];

export const versionEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/notes/:id/versions',
		summary: 'Versionen einer Notiz (neueste zuerst)',
		tags,
		permission: PERM.view,
		params: idParams,
		handler: ({ ctx, params }) => listVersions(ctx, params.id)
	}),
	defineEndpoint({
		method: 'POST',
		path: '/notes/:id/versions',
		summary: 'Benannte Version speichern',
		description: 'Bearbeiten-Zugriff nötig; höchstens 100 benannte Versionen je Notiz (sonst 409).',
		tags,
		permission: PERM.view,
		params: idParams,
		body: versionInput,
		handler: async ({ ctx, params, body }) => {
			const version = await saveVersion(ctx, params.id, body.label);
			await core.audit.logFromContext(ctx, 'notes.version.created', {
				target: params.id,
				metadata: { versionId: version.id }
			});
			return version;
		}
	}),
	defineEndpoint({
		method: 'GET',
		path: '/notes/:id/versions/:versionId',
		summary: 'Version mit Inhalt (Vorschau)',
		tags,
		permission: PERM.view,
		params: versionParams,
		handler: ({ ctx, params }) => getVersion(ctx, params.id, params.versionId)
	}),
	defineEndpoint({
		method: 'POST',
		path: '/notes/:id/versions/:versionId/restore',
		summary: 'Version wiederherstellen',
		description:
			'Sichert vorher den aktuellen Stand als Version „Vor dem Wiederherstellen“; offene Editoren übernehmen den Inhalt live. Bearbeiten-Zugriff nötig.',
		tags,
		permission: PERM.view,
		params: versionParams,
		handler: async ({ ctx, params }) => {
			const { backupId } = await restoreVersion(ctx, params.id, params.versionId);
			await core.audit.logFromContext(ctx, 'notes.version.restored', {
				target: params.id,
				metadata: { versionId: params.versionId, backupId }
			});
			return { restored: params.versionId, backupId };
		}
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/notes/:id/versions/:versionId',
		summary: 'Version löschen',
		description: 'Nur Eigentümer*in oder `notes.note.edit-all`.',
		tags,
		permission: PERM.view,
		params: versionParams,
		handler: async ({ ctx, params }) => {
			await deleteVersion(ctx, params.id, params.versionId);
			await core.audit.logFromContext(ctx, 'notes.version.deleted', {
				target: params.id,
				metadata: { versionId: params.versionId }
			});
			return { id: params.versionId, deleted: true };
		}
	})
];
