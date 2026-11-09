import { defineModule, manifestFromPackage } from '$lib/sdk/server';
import pkg from './atrium-module.json';
import { notesAssist, PERM_AI } from './assist';
import { withNoteContext } from './access';
import { assetEndpoints } from './assets.endpoints';
import { purgeUnusedAssets } from './assets.service';
import { discardAllDocs, flushAll } from './doc.service';
import { linkEndpoints, publicLinkEndpoints } from './links.endpoints';
import { notesBackup } from './backup';
import { liveEndpoints } from './live.endpoints';
import { noteEndpoints } from './notes.endpoints';
import { prefsEndpoints } from './prefs.endpoints';
import { onMemberDeleted, onUserDeleted, resetAreas, resetUsers, subjectExport } from './privacy';
import { noteRefsService } from './refs.service';
import { notesSearch } from './search';
import { transferEndpoints } from './transfer.endpoints';
import { purgeExpiredTrash } from './trash.service';
import { runAutoVersions } from './versions.service';
import { versionEndpoints } from './versions.endpoints';
import { NOTIFY_NOTE_SHARED, PERM } from './schemas';
import type { NoteRefsService } from './contract';
import m0001 from './migrations/0001_init.sql?raw';
import m0002 from './migrations/0002_user_prefs.sql?raw';
import m0003 from './migrations/0003_public_links.sql?raw';

export default defineModule({
	package: pkg,
	manifest: {
		// Kennung, Name, Beschreibung, Version, Abhängigkeiten: atrium-module.json
		/** Gruppen/Mitglieder als Freigabe-Ziele, Notizen an Aktionen */
		...manifestFromPackage(pkg),
		permissions: [PERM.view, PERM.create, PERM.viewAll, PERM.editAll, PERM.linkCreate, PERM_AI],
		permissionDescriptions: {
			[PERM.view]:
				'Notizen nutzen: eigene, freigegebene und über Aktionen sichtbare Notizen ansehen und – je nach Freigabe – live mitbearbeiten',
			[PERM.create]:
				'Eigene Notizen anlegen und importieren (auch für Aktionen mit Bearbeiten-Recht)',
			[PERM.viewAll]: 'Alle Notizen ansehen, auch ohne Freigabe',
			[PERM.editAll]: 'Alle Notizen bearbeiten, teilen, verschieben und löschen',
			[PERM.linkCreate]:
				'Öffentliche Links auf eigene Notizen anlegen – Personen ohne Konto können sie damit ansehen oder live mitbearbeiten',
			[PERM_AI]:
				'KI-Schreibhilfe in Notizen nutzen (markierten Text überarbeiten, zusammenfassen, weiterschreiben, Aufgaben ableiten)'
		},
		navigation: [
			{
				label: 'Notizen',
				icon: 'notebook-pen',
				path: '/modules/notes',
				permission: PERM.view,
				order: 72
			}
		]
	},
	migrations: [
		{ name: '0001_init', sql: m0001 },
		{ name: '0002_user_prefs', sql: m0002 },
		{ name: '0003_public_links', sql: m0003 }
	],
	assist: notesAssist,
	search: notesSearch,
	provides: noteRefsService satisfies NoteRefsService,
	notifications: {
		types: [
			{
				key: NOTIFY_NOTE_SHARED,
				label: 'Notiz mit mir geteilt',
				description:
					'Wenn eine Notiz mit dir, deiner Gruppe, deinem Mitglied oder deiner Rolle geteilt wird.',
				digest: true,
				permission: PERM.view
			}
		]
	},
	jobs: [
		{
			id: 'versions',
			summary: 'Automatische Version geänderter Notizen speichern und Änderungen verdichten',
			schedule: 'hourly',
			run: async () => {
				const flushed = await flushAll();
				const versions = await runAutoVersions();
				return `${versions} Versionen gespeichert, ${flushed} Notizen verdichtet`;
			}
		},
		{
			id: 'purge-trash',
			summary: 'Abgelaufene Notizen im Papierkorb und nicht mehr genutzte Bilder endgültig löschen',
			schedule: 'daily',
			run: async () => {
				const notes = await purgeExpiredTrash();
				const images = await purgeUnusedAssets();
				return `${notes} Notizen und ${images} ungenutzte Bilder endgültig gelöscht`;
			}
		}
	],
	resetAreas,
	resetUsers,
	onUserDeleted,
	onMemberDeleted,
	subjectExport,
	backup: notesBackup,
	// Zurücksetzen/Wiederherstellen: alte Dokumente im Speicher dürfen die neuen Daten nie überschreiben
	onDataReplaced: async () => discardAllDocs(),
	// Deaktivieren: noch Offenes sichern, dann Speicher und Verbindungen freigeben
	onDisable: async () => {
		await flushAll();
		discardAllDocs();
	},
	// Reihenfolge: erster Treffer gewinnt (feste Pfade wie `/notes/roots`, `/notes/by-action/…` vor `/notes/:id`).
	// Öffentliche Link-Endpunkte (`/public/links/…`) ohne Notiz-Kontext (keine Person).
	endpoints: [
		...publicLinkEndpoints,
		...withNoteContext([
			...prefsEndpoints,
			...linkEndpoints,
			...transferEndpoints,
			...noteEndpoints,
			...liveEndpoints,
			...assetEndpoints,
			...versionEndpoints
		])
	]
});
