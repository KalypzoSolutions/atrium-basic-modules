/**
 * Live-Verbindungen der Notizen über den SDK-Hub (`createLiveHub`): je Notiz die offenen Editoren. Yjs-Updates
 * verteilt `doc.service.ts`, Anwesenheit (Awareness, Cursor) wird nur weitergereicht, nie gespeichert.
 */
import { createLiveHub, type LiveSubscriber } from '$lib/sdk/server';
import { loadNoteContext, resolveNoteAccess } from './access';
import { mdb } from './db';
import { MAX_STREAMS_PER_USER, type LiveEvent, type Peer, type ShareLevel } from './schemas';

export const hub = createLiveHub<ShareLevel, Peer>({
	name: 'notes',
	maxStreamsPerUser: MAX_STREAMS_PER_USER,
	async resolveLevel(ctx, noteId) {
		await loadNoteContext(ctx);
		const access = await mdb().transaction((tx) => resolveNoteAccess(tx, ctx, noteId));
		return access?.level ?? null;
	},
	onLevelChange(sub, level) {
		sub.peer = { ...sub.peer, canEdit: level === 'edit' };
		hub.broadcast(sub.objectId, { type: 'peer', peer: sub.peer } satisfies LiveEvent, sub.client);
	},
	onLeave(sub) {
		hub.broadcast(sub.objectId, {
			type: 'leave',
			client: sub.client,
			awarenessId: sub.peer.awarenessId
		} satisfies LiveEvent);
	}
});

export type NoteSubscriber = LiveSubscriber<ShareLevel, Peer>;

/** Anwesende einer Notiz */
export function peersOf(noteId: string): Peer[] {
	return hub.subscribers(noteId).map((s) => s.peer);
}

/** Notizen eines Teilbaums sofort neu prüfen (Freigaben, Verschieben, Aktion) */
export async function recheckNotes(noteIds: readonly string[]): Promise<void> {
	const open = new Set(hub.openObjects());
	for (const id of noteIds) if (open.has(id)) await hub.recheck(id);
}

/** Verbindungen gelöschter Notizen schließen */
export function closeNotes(noteIds: readonly string[]): void {
	for (const id of noteIds) hub.closeObject(id, { type: 'deleted' } satisfies LiveEvent);
}
