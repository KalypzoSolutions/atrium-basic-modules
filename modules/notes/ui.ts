import type { ModuleUi } from '$lib/sdk/types/module-ui';

export default {
	routes: {
		'': () => import('./pages/NotesPage.svelte'),
		':id': () => import('./pages/NotePage.svelte')
	},
	fullBleedRoutes: [':id'],
	publicRoutes: {
		'link/:token': () => import('./pages/PublicNotePage.svelte')
	},
	publicWideRoutes: ['link/:token'],
	dashboardWidgets: [
		{
			id: 'recent',
			title: 'Notizen',
			description: 'Zuletzt bearbeitete Notizen',
			order: 45,
			size: 'md',
			permission: 'notes.note.view',
			component: () => import('./pages/widgets/RecentNotesWidget.svelte')
		}
	]
} satisfies ModuleUi;
