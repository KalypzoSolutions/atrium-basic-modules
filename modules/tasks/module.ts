import { defineModule, manifestFromPackage } from '$lib/sdk/server';
import pkg from './atrium-module.json';
import { tasksAssist, PERM_AI } from './assist';
import { withTaskContext } from './access';
import { boardEndpoints } from './boards.endpoints';
import { taskEndpoints } from './tasks.endpoints';
import { planningEndpoints } from './planning.endpoints';
import { sendDueReminders } from './notify';
import { onUserDeleted, resetAreas, resetUsers, subjectExport } from './privacy';
import { tasksSearch } from './search';
import { tasksDashboard } from './dashboard';
import { taskRefsService } from './refs.service';
import type { TaskRefsService } from './contract';
import { NOTIFY_BOARD_SHARED, NOTIFY_TASK_ASSIGNED, NOTIFY_TASK_DUE, PERM } from './schemas';
import m0001 from './migrations/0001_init.sql?raw';
import m0002 from './migrations/0002_planning.sql?raw';

export default defineModule({
	package: pkg,
	manifest: {
		// Kennung, Name, Beschreibung, Version, Abhängigkeiten: atrium-module.json
		/** Gruppen/Mitglieder als Freigabe-Ziele, Boards an Aktionen (Zugriff wird vererbt) */
		...manifestFromPackage(pkg),
		permissions: [PERM_AI, PERM.view, PERM.create, PERM.viewAll, PERM.editAll],
		permissionDescriptions: {
			[PERM_AI]: 'KI-Schreibhilfe für Aufgabenbeschreibungen und Unteraufgaben nutzen',
			[PERM.view]:
				'Aufgaben-Boards nutzen: eigene, freigegebene, über Aktionen sichtbare und solche mit eigenen Aufgaben',
			[PERM.create]: 'Boards anlegen (auch für Aktionen mit Bearbeiten-Recht)',
			[PERM.viewAll]: 'Alle Boards ansehen, auch ohne Freigabe',
			[PERM.editAll]: 'Alle Boards bearbeiten, teilen und löschen'
		},
		navigation: [
			{
				label: 'Aufgaben',
				icon: 'kanban',
				path: '/modules/tasks',
				permission: PERM.view,
				order: 75
			}
		]
	},
	migrations: [
		{ name: '0001_init', sql: m0001 },
		{ name: '0002_planning', sql: m0002 }
	],
	assist: tasksAssist,
	search: tasksSearch,
	/** Übersicht: eigene fällige Aufgaben („Zu erledigen“, „Diese Woche“) */
	dashboard: tasksDashboard,
	/** Verweise auf Boards/Aufgaben für andere Module (z. B. Whiteboard-Karten) */
	provides: taskRefsService satisfies TaskRefsService,
	notifications: {
		types: [
			{
				key: NOTIFY_TASK_ASSIGNED,
				label: 'Aufgabe zugewiesen',
				description: 'Wenn dir jemand eine Aufgabe oder Unteraufgabe zuweist.',
				digest: true,
				permission: PERM.view
			},
			{
				key: NOTIFY_TASK_DUE,
				label: 'Aufgabe fällig',
				description: 'Morgens, wenn eine deiner offenen Aufgaben heute oder morgen fällig ist.',
				permission: PERM.view
			},
			{
				key: NOTIFY_BOARD_SHARED,
				label: 'Board mit mir geteilt',
				description:
					'Wenn ein Board mit dir, deiner Gruppe, deinem Mitglied oder deiner Rolle geteilt wird.',
				digest: true,
				permission: PERM.view
			}
		]
	},
	jobs: [
		{
			id: 'due-reminders',
			summary: 'Zuständige an heute/morgen fällige Aufgaben erinnern',
			schedule: 'daily',
			run: async (ctx) => {
				const { tasks, people } = await sendDueReminders(ctx);
				return `${tasks} Erinnerungen an ${people} Personen`;
			}
		}
	],
	resetAreas,
	resetUsers,
	onUserDeleted,
	subjectExport,
	// Reihenfolge: erster Treffer gewinnt (`/boards/by-action/…` vor `/boards/:id/…`)
	endpoints: withTaskContext([...taskEndpoints, ...planningEndpoints, ...boardEndpoints])
});
