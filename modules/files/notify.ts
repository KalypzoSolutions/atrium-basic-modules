/**
 * Benachrichtigungen der Dateiablage (core.notifications): Ordner/Datei mit mir geteilt (neu hinzugekommene
 * Freigaben, nicht „ganzer Stamm“) und neue Dateien über einen öffentlichen Upload-Link (an die
 * Eigentümer*in des Ordners). Immer nach der Transaktion; wirft nie.
 */
import {
	addedPrincipals,
	bestEffort,
	core,
	principalUserIds,
	type Principal,
	type RequestContext
} from '$lib/sdk/server';
import { MODULE_ID, NOTIFY_FILE_SHARED, NOTIFY_LINK_UPLOAD, PERMISSIONS } from './schemas';

const BASE = '/modules/files';

export async function notifyNodeShared(
	ctx: RequestContext,
	input: {
		nodeId: string;
		name: string;
		kind: 'folder' | 'file';
		before: readonly Principal[];
		after: readonly Principal[];
	}
): Promise<void> {
	const added = addedPrincipals(input.before, input.after).filter((p) => p.type !== 'everyone');
	if (!added.length) return;
	await bestEffort(
		'files.notify.shared',
		async () => {
			const userIds = await principalUserIds(MODULE_ID, added, {
				permission: PERMISSIONS.view,
				exclude: [ctx.userId]
			});
			if (!userIds.length) return;
			const me = ctx.userId ? (await core.users.byIds(ctx, [ctx.userId])).get(ctx.userId) : null;
			const what = input.kind === 'folder' ? 'den Ordner' : 'die Datei';
			await core.notifications.send(ctx, MODULE_ID, [
				{
					type: NOTIFY_FILE_SHARED,
					userIds,
					title: `${input.kind === 'folder' ? 'Ordner' : 'Datei'} geteilt: ${input.name}`,
					body: `${me?.name ?? 'Jemand'} hat ${what} „${input.name}“ mit dir geteilt.`,
					link:
						input.kind === 'folder' ? `${BASE}?folder=${encodeURIComponent(input.nodeId)}` : BASE
				}
			]);
		},
		{ ctx, target: input.nodeId }
	);
}

export async function notifyLinkUpload(
	ctx: RequestContext,
	input: {
		ownerId: string;
		folderId: string;
		folderName: string;
		count: number;
		uploader: string | null;
	}
): Promise<void> {
	if (!input.count) return;
	await bestEffort(
		'files.notify.link-upload',
		async () => {
			const who = input.uploader?.trim() ? ` von ${input.uploader.trim().slice(0, 80)}` : '';
			await core.notifications.send(ctx, MODULE_ID, [
				{
					type: NOTIFY_LINK_UPLOAD,
					userIds: [input.ownerId],
					title: `${input.count === 1 ? 'Neue Datei' : `${input.count} neue Dateien`} in „${input.folderName}“`,
					body: `Über den Upload-Link wurde${input.count === 1 ? ' eine Datei' : `n ${input.count} Dateien`}${who} in den Ordner „${input.folderName}“ hochgeladen.`,
					link: `${BASE}?folder=${encodeURIComponent(input.folderId)}`
				}
			]);
		},
		{ ctx, target: input.folderId }
	);
}
