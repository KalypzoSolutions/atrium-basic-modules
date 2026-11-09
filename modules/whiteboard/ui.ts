import type { ModuleUi } from '$lib/sdk/types/module-ui';

export default {
	routes: {
		'': () => import('./pages/BoardsPage.svelte'),
		':id': () => import('./pages/BoardPage.svelte')
	},
	fullBleedRoutes: [':id'],
	/** Kompakter Editor im iframe unter `/embed/whiteboard/<id>` (z. B. in Notizen) */
	embedRoutes: {
		':id': () => import('./pages/EmbedBoardPage.svelte')
	},
	dashboardWidgets: [
		{
			id: 'recent-boards',
			title: 'Whiteboards',
			description: 'Zuletzt bearbeitete Whiteboards',
			order: 40,
			defaultHidden: true,
			size: 'md',
			permission: 'whiteboard.board.view',
			component: () => import('./pages/widgets/RecentBoardsWidget.svelte')
		}
	]
} satisfies ModuleUi;
