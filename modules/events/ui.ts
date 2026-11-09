import type { ModuleUi } from '$lib/sdk/types/module-ui';

export default {
	routes: {
		'': () => import('./pages/EventsPage.svelte')
	},
	dashboardWidgets: [
		{
			id: 'upcoming',
			title: 'Nächste Termine',
			description: 'Die nächsten Termine ab heute',
			order: 10,
			size: 'sm',
			permission: 'events.event.view',
			// Die Woche steht schon im Wochenstreifen der Übersicht
			defaultHidden: true,
			component: () => import('./pages/widgets/UpcomingEventsWidget.svelte')
		}
	],
	profileSections: [
		{
			id: 'calendar-feeds',
			title: 'Kalender-Abo',
			order: 40,
			permission: 'events.event.view',
			component: () => import('./pages/CalendarFeedsCard.svelte')
		}
	]
} satisfies ModuleUi;
