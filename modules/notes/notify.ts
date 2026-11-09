/**
 * Benachrichtigungen der Notizen über `core.notifications` (Kanal wählt jede Person im Profil):
 * neu geteilte Notizen. Immer nach der Transaktion, nie an die handelnde Person, wirft nie.
 */
import {
	bestEffort,
	core,
	principalUserIds,
	type RequestContext,
	type StoredShare
} from '$lib/sdk/server';
import { BASE_PATH, MODULE_ID, NOTIFY_NOTE_SHARED, PERM } from './schemas';

export const noteLink = (noteId: string) => `${BASE_PATH}/${encodeURIComponent(noteId)}`;

async function actorName(ctx: RequestContext): Promise<string> {
	if (!ctx.userId) return 'Jemand';
	return (await core.users.byIds(ctx, [ctx.userId])).get(ctx.userId)?.name ?? 'Jemand';
}

/** Notiz neu geteilt oder hochgestuft: an die Konten hinter den Freigaben (ohne „ganzer Stamm“) */
export async function notifyNoteShared(
	ctx: RequestContext,
	input: { noteId: string; title: string; ownerId: string | null; principals: StoredShare[] }
): Promise<void> {
	await bestEffort(
		'notes.notify.shared',
		async () => {
			const userIds = await principalUserIds(MODULE_ID, input.principals, {
				permission: PERM.view,
				exclude: [ctx.userId, input.ownerId]
			});
			if (!userIds.length) return;
			const who = await actorName(ctx);
			const title = input.title.trim() || 'Ohne Titel';
			await core.notifications.send(ctx, MODULE_ID, [
				{
					type: NOTIFY_NOTE_SHARED,
					userIds,
					title: `${who} hat die Notiz „${title}“ mit dir geteilt`.slice(0, 150),
					body: `Du kannst die Notiz „${title}“ jetzt öffnen und – je nach Freigabe – mitbearbeiten. Unterseiten sind mit freigegeben.`,
					link: noteLink(input.noteId)
				}
			]);
		},
		{ ctx, target: input.noteId }
	);
}
