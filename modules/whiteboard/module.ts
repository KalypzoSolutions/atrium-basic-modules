import { z } from 'zod';
import { defineModule, manifestFromPackage } from '$lib/sdk/server';
import pkg from './atrium-module.json';
import { withBoardContext } from './access';
import { assetEndpoints } from './assets.endpoints';
import { boardEndpoints } from './boards.endpoints';
import { boardEmbed } from './embeds';
import { liveEndpoints } from './live.endpoints';
import { prefsEndpoints } from './prefs.endpoints';
import { onMemberDeleted, onUserDeleted, resetAreas, resetUsers, subjectExport } from './privacy';
import { whiteboardSearch } from './search';
import { snapshotEndpoints } from './snapshots.endpoints';
import { runAutoSnapshots, runCleanup } from './snapshots.service';
import { transferEndpoints } from './transfer.endpoints';
import { DEFAULT_BOARD_MB, NOTIFY_BOARD_SHARED, PERM, SETTING_BOARD_MB } from './schemas';
import m0001 from './migrations/0001_init.sql?raw';
import m0002 from './migrations/0002_user_prefs.sql?raw';

export default defineModule({
	package: pkg,
	manifest: {
		// Kennung, Name, Beschreibung, Version, Abhängigkeiten: atrium-module.json
		/** Gruppen/Mitglieder als Freigabe-Ziele, Boards an Aktionen, Karten aus Aufgaben/Terminen/Galerien/Dateien/Notizen */
		...manifestFromPackage(pkg),
		permissions: [PERM.view, PERM.create, PERM.viewAll, PERM.editAll],
		permissionDescriptions: {
			[PERM.view]:
				'Whiteboards nutzen: eigene, freigegebene und über Aktionen sichtbare ansehen und – je nach Freigabe – live mitbearbeiten',
			[PERM.create]: 'Whiteboards anlegen und importieren (auch für Aktionen mit Bearbeiten-Recht)',
			[PERM.viewAll]: 'Alle Whiteboards ansehen, auch ohne Freigabe',
			[PERM.editAll]: 'Alle Whiteboards bearbeiten, teilen und löschen'
		},
		navigation: [
			{
				label: 'Whiteboards',
				icon: 'presentation',
				path: '/modules/whiteboard',
				permission: PERM.view,
				order: 76
			}
		]
	},
	settings: [
		{
			key: SETTING_BOARD_MB,
			label: 'Whiteboards: Speicherplatz je Whiteboard für Bilder und Dateien (MB, 0 = unbegrenzt)',
			schema: z.number().int().min(0).max(100_000),
			default: DEFAULT_BOARD_MB
		}
	],
	migrations: [
		{ name: '0001_init', sql: m0001 },
		{ name: '0002_user_prefs', sql: m0002 }
	],
	search: whiteboardSearch,
	/** Einbetten in andere Module (z. B. Notizen), Seite `ui.ts` `embedRoutes` */
	embeds: [boardEmbed],
	notifications: {
		types: [
			{
				key: NOTIFY_BOARD_SHARED,
				label: 'Whiteboard mit mir geteilt',
				description:
					'Wenn ein Whiteboard mit dir, deiner Gruppe, deinem Mitglied oder deiner Rolle geteilt wird.',
				digest: true,
				permission: PERM.view
			}
		]
	},
	jobs: [
		{
			id: 'snapshots',
			summary: 'Automatische Version geänderter Whiteboards speichern',
			schedule: 'hourly',
			run: async () => `${await runAutoSnapshots()} Versionen gespeichert`
		},
		{
			id: 'cleanup',
			summary: 'Alte gelöschte Elemente und nicht mehr verwendete Dateien entfernen',
			schedule: 'daily',
			run: async () => {
				const { tombstones, assets } = await runCleanup();
				return `${tombstones} gelöschte Elemente, ${assets} Dateien entfernt`;
			}
		}
	],
	resetAreas,
	resetUsers,
	onUserDeleted,
	onMemberDeleted,
	subjectExport,
	// Reihenfolge: erster Treffer gewinnt (`/boards/recent`, `/boards/import`, `/boards/by-action/…` vor `/boards/:id`)
	endpoints: withBoardContext([
		...prefsEndpoints,
		...boardEndpoints,
		...transferEndpoints,
		...liveEndpoints,
		...assetEndpoints,
		...snapshotEndpoints
	])
});
