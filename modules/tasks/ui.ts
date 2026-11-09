import type { ModuleUi } from '$lib/sdk/types/module-ui';

export default {
	routes: {
		'': () => import('./pages/BoardsPage.svelte'),
		':id': () => import('./pages/BoardPage.svelte')
	},
	dashboardWidgets: [
		{
			id: 'my-tasks',
			/** Inhalt steht in „Zu erledigen“/„Diese Woche“; bleibt auswählbar */
			defaultHidden: true,
			title: 'Meine Aufgaben',
			description: 'Offene Aufgaben und Unteraufgaben, die dir zugewiesen sind',
			order: 15,
			size: 'md',
			permission: 'tasks.board.view',
			component: () => import('./pages/widgets/MyTasksWidget.svelte')
		}
	]
} satisfies ModuleUi;
