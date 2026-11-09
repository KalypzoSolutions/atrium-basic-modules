/**
 * Benachrichtigungen der Whiteboards über `core.notifications` (Kanal wählt jede Person im Profil):
 * neu geteilte Boards. Immer nach der Transaktion, nie an die handelnde Person, wirft nie.
 */
import {
	bestEffort,
	core,
	principalUserIds,
	type RequestContext,
	type StoredShare
} from '$lib/sdk/server';
import { BASE_PATH, MODULE_ID, NOTIFY_BOARD_SHARED, PERM } from './schemas';

export const boardLink = (boardId: string) => `${BASE_PATH}/${encodeURIComponent(boardId)}`;

async function actorName(ctx: RequestContext): Promise<string> {
	if (!ctx.userId) return 'Jemand';
	return (await core.users.byIds(ctx, [ctx.userId])).get(ctx.userId)?.name ?? 'Jemand';
}

/** Board neu geteilt oder hochgestuft: an die Konten hinter den Freigaben (ohne „ganzer Stamm“) */
export async function notifyBoardShared(
	ctx: RequestContext,
	input: { boardId: string; boardName: string; ownerId: string; principals: StoredShare[] }
): Promise<void> {
	await bestEffort(
		'whiteboard.notify.shared',
		async () => {
			const userIds = await principalUserIds(MODULE_ID, input.principals, {
				permission: PERM.view,
				exclude: [ctx.userId, input.ownerId]
			});
			if (!userIds.length) return;
			const who = await actorName(ctx);
			await core.notifications.send(ctx, MODULE_ID, [
				{
					type: NOTIFY_BOARD_SHARED,
					userIds,
					title: `${who} hat das Whiteboard „${input.boardName}“ mit dir geteilt`,
					body: `Du kannst das Whiteboard „${input.boardName}“ jetzt öffnen und – je nach Freigabe – mitbearbeiten.`,
					link: boardLink(input.boardId)
				}
			]);
		},
		{ ctx, target: input.boardId }
	);
}
