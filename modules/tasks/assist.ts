/** KI-Schreibhilfe in Aufgaben: Beschreibung und Zerlegen in Unteraufgaben. */
import type { ModuleAssist } from '$lib/sdk/server';
import { MAX_TASK_DESCRIPTION } from './schemas';

export const PERM_AI = 'tasks.ai.use';

export const tasksAssist: ModuleAssist = {
	purposes: {
		'task-description': {
			label: 'Beschreibung einer Aufgabe',
			description:
				'Beschreibung einer Aufgabe im Kanban-Board des Stamms: was zu tun ist, worauf zu achten ist. Unteraufgaben werden als Schritte vorgeschlagen.',
			format: 'plain',
			maxChars: MAX_TASK_DESCRIPTION,
			tasks: ['draft', 'rewrite', 'shorter', 'spelling', 'split'],
			extraKeys: { title: 'Titel (Formular)' }
		}
	}
};
