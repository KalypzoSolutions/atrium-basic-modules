/** Versionsverlauf (`/api/v1/modules/whiteboard/boards/:id/snapshots…`) und Karten-Verweise (`/refs…`). */
import { type AnyApiEndpoint, core, defineEndpoint } from '$lib/sdk/server';
import { describeRefs, searchRefs } from './refs.service';
import { deleteSnapshot, listSnapshots, restoreSnapshot, saveSnapshot } from './snapshots.service';
import {
	idParams,
	PERM,
	refDescribeInput,
	refSearchQuery,
	snapshotInput,
	snapshotParams,
	type RefCard,
	type Snapshot
} from './schemas';

const tags = ['Whiteboard'];

export const snapshotEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/boards/:id/snapshots',
		summary: 'Versionen eines Whiteboards (automatisch stündlich und benannte)',
		tags,
		permission: PERM.view,
		params: idParams,
		handler: ({ ctx, params }): Promise<Snapshot[]> => listSnapshots(ctx, params.id)
	}),
	defineEndpoint({
		method: 'POST',
		path: '/boards/:id/snapshots',
		summary: 'Aktuellen Stand als benannte Version speichern',
		tags,
		permission: PERM.view,
		params: idParams,
		body: snapshotInput,
		handler: async ({ ctx, params, body }) => {
			const id = await saveSnapshot(ctx, params.id, body.label);
			await core.audit.logFromContext(ctx, 'whiteboard.snapshot.created', {
				target: params.id,
				metadata: { snapshotId: id }
			});
			return { id };
		}
	}),
	defineEndpoint({
		method: 'POST',
		path: '/boards/:id/snapshots/:snapshotId/restore',
		summary: 'Version wiederherstellen',
		description:
			'Sichert vorher den aktuellen Stand als Version „Vor dem Wiederherstellen“. Alle offenen Editoren laden neu.',
		tags,
		permission: PERM.view,
		params: snapshotParams,
		handler: async ({ ctx, params }) => {
			const elements = await restoreSnapshot(ctx, params.id, params.snapshotId);
			await core.audit.logFromContext(ctx, 'whiteboard.board.restored', {
				target: params.id,
				metadata: { snapshotId: params.snapshotId, elements }
			});
			return { elements };
		}
	}),
	defineEndpoint({
		method: 'DELETE',
		path: '/boards/:id/snapshots/:snapshotId',
		summary: 'Version löschen',
		tags,
		permission: PERM.view,
		params: snapshotParams,
		handler: async ({ ctx, params }) => {
			await deleteSnapshot(ctx, params.id, params.snapshotId);
			return { id: params.snapshotId, deleted: true };
		}
	}),

	// --- Karten ---
	defineEndpoint({
		method: 'GET',
		path: '/refs',
		summary: 'Datensätze für Karten suchen (Aktion, Aufgabe, Termin, Galerie, Datei, Whiteboard …)',
		description:
			'Nur, was die Person im jeweiligen Modul sehen darf; Modul inaktiv oder ohne Recht → leere Liste.',
		tags,
		permission: PERM.view,
		query: refSearchQuery,
		handler: ({ ctx, query }): Promise<RefCard[]> =>
			searchRefs(ctx, query.type, query.search, query.limit)
	}),
	defineEndpoint({
		method: 'POST',
		path: '/refs/describe',
		summary: 'Karten für die Anzeige auflösen (je Betrachter*in)',
		description: 'Unsichtbare oder gelöschte Datensätze kommen als `available: false` ohne Titel.',
		tags,
		permission: PERM.view,
		body: refDescribeInput,
		handler: ({ ctx, body }): Promise<RefCard[]> => describeRefs(ctx, body.items)
	})
];
