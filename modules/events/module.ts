import { z } from 'zod';
import { eventsAssist, PERM_AI } from './assist';
import { NOTIFY_EVENT_CANCELLED, NOTIFY_EVENT_CHANGED, NOTIFY_EVENT_NEW } from './schemas';
import { defineModule, manifestFromPackage } from '$lib/sdk/server';
import pkg from './atrium-module.json';
import { eventsSearch } from './search';
import { eventsDashboard } from './dashboard';
import { eventEndpoints } from './events.endpoints';
import { exportEndpoints } from './export.endpoints';
import { metaEndpoints } from './meta.endpoints';
import { websiteEndpoints } from './website.endpoints';
import { resetAreas, resetUsers } from './reset';
import { onUserDeleted } from './user-deleted';
import { subjectExport } from './subject-export';
import { eventRefsService } from './refs.service';
import type { EventRefsService } from './contract';
import { DEFAULT_STAMM_NAME, STAMM_NAME_SETTING } from './schemas';
import m0001 from './migrations/0001_init.sql?raw';
import m0002 from './migrations/0002_recurrence.sql?raw';
import m0003 from './migrations/0003_checks.sql?raw';
import m0004 from './migrations/0004_calendar_feeds.sql?raw';
import m0005 from './migrations/0005_feed_tasks.sql?raw';
import { calendarEndpoints } from './calendar.endpoints';
import { calendarFeedsBackup } from './calendar-feeds.service';

export default defineModule({
	package: pkg,
	manifest: {
		// Kennung, Name, Beschreibung, Version, Abhängigkeiten: atrium-module.json
		/** Gruppen und Mitglieder für Zuordnung und Sichtbarkeit (ohne `members`: nur Stamm, Rollen, Benutzer) */
		...manifestFromPackage(pkg),
		/** Verknüpfungs-Konten (Rolle „Mitglied“) sehen die für sie sichtbaren Termine */
		defaultRoleGrants: { Mitglied: ['events.event.view'] },
		permissions: [
			PERM_AI,
			'events.event.view',
			'events.event.create',
			'events.event.view-all',
			'events.event.edit-all',
			'events.event.publish',
			'events.website.read'
		],
		permissionDescriptions: {
			[PERM_AI]: 'KI-Schreibhilfe für Terminbeschreibungen nutzen',
			'events.event.view': 'Termine ansehen (eigene und freigegebene); Grundrecht für das Modul',
			'events.event.create': 'Termine und Serien anlegen',
			'events.event.view-all': 'Alle Termine ansehen, auch ohne Freigabe',
			'events.event.edit-all': 'Alle Termine bearbeiten und löschen',
			'events.event.publish':
				'Termine auf der öffentlichen Stammeswebsite anzeigen („Auf der Stammeswebsite anzeigen“ einschalten)',
			'events.website.read':
				'Termine für die Stammeswebsite abrufen (nur API-Key-Scope, kein Zugriff auf interne Funktionen)'
		},
		navigation: [
			{
				label: 'Termine',
				icon: 'calendar',
				path: '/modules/events',
				permission: 'events.event.view',
				order: 10
			}
		]
	},
	settings: [
		{
			key: STAMM_NAME_SETTING,
			label: 'Name des Stamms',
			description:
				'Wird als Gruppe „ganzer Stamm“ bei Zuordnung, Sichtbarkeit und auf der Website angezeigt.',
			schema: z.string().trim().min(1).max(100),
			default: DEFAULT_STAMM_NAME
		}
	],
	migrations: [
		{ name: '0001_init', sql: m0001 },
		{ name: '0002_recurrence', sql: m0002 },
		{ name: '0003_checks', sql: m0003 },
		{ name: '0004_calendar_feeds', sql: m0004 },
		{ name: '0005_feed_tasks', sql: m0005 }
	],
	assist: eventsAssist,
	search: eventsSearch,
	/** Übersicht: Termine der Woche (Serien je Vorkommen) */
	dashboard: eventsDashboard,
	notifications: {
		// Standard aus: wer will, schaltet es im Profil ein (sonst Mail an alle Eltern bei jedem Termin)
		types: [
			{
				key: NOTIFY_EVENT_NEW,
				label: 'Neuer Termin',
				description: 'Wenn ein Termin angelegt oder für dich sichtbar wird.',
				defaultChannel: 'off',
				digest: true,
				permission: 'events.event.view'
			},
			{
				key: NOTIFY_EVENT_CHANGED,
				label: 'Termin verschoben',
				description: 'Nur bei geändertem Datum, Uhrzeit oder Ort.',
				defaultChannel: 'off',
				digest: true,
				permission: 'events.event.view'
			},
			{
				key: NOTIFY_EVENT_CANCELLED,
				label: 'Termin abgesagt',
				defaultChannel: 'off',
				permission: 'events.event.view'
			}
		]
	},
	resetAreas,
	resetUsers,
	onUserDeleted,
	subjectExport,
	/** Datensicherung: Link-Hashes der Kalender-Abos mit dem Zielschlüssel neu berechnen */
	backup: calendarFeedsBackup,
	/** Dienst für andere Module (`EventRefsService`, siehe `contract.ts`) */
	provides: eventRefsService satisfies EventRefsService,
	// Export vor `eventEndpoints`, sonst greift `/events/:id`
	endpoints: [
		...websiteEndpoints,
		...calendarEndpoints,
		...metaEndpoints,
		...exportEndpoints,
		...eventEndpoints
	]
});
