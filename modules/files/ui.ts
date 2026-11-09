import type { ModuleUi } from '$lib/sdk/types/module-ui';

export default {
	routes: {
		'': () => import('./pages/FilesPage.svelte')
	},
	publicRoutes: {
		'link/:token': () => import('./pages/PublicLinkPage.svelte')
	},
	userAdminSections: [
		{
			id: 'quota',
			title: 'Speicherplatz',
			permission: 'files.quota.manage',
			component: () => import('./pages/UserQuotaSection.svelte')
		}
	],
	dashboardWidgets: [
		{
			id: 'recent',
			title: 'Zuletzt geändert',
			description: 'Zuletzt geänderte eigene und für dich freigegebene Dateien',
			order: 70,
			defaultHidden: true,
			size: 'sm',
			permission: 'files.file.view',
			component: () => import('./pages/widgets/RecentFilesWidget.svelte')
		}
	]
} satisfies ModuleUi;
