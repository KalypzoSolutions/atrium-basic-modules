/**
 * KI-Schreibhilfe in Notizen: Auswahl überarbeiten (`note-selection`) oder an der Cursorposition schreiben,
 * zusammenfassen, weiterschreiben, Aufgaben ableiten (`note-write`). Kontext `notes:note` = Titel und Seitenpfad
 * (Zugriff wie die Notiz selbst, sonst 404). Der Text der Notiz kommt nur als Feldinhalt, den die Person auslöst.
 */
import type { ModuleAssist, RequestContext } from '$lib/sdk/server';
import { chainOf, loadNoteContext, resolveNoteAccess } from './access';
import { mdb } from './db';
import { PERM } from './schemas';

export const PERM_AI = 'notes.ai.use';

async function noteContext(ctx: RequestContext, id: string) {
	if (!ctx.permissions.has(PERM.view)) return null;
	const nc = await loadNoteContext(ctx);
	return mdb().transaction(async (tx) => {
		const access = await resolveNoteAccess(tx, ctx, id);
		if (!access) return null;
		const chain = await chainOf(tx, id);
		const self = chain[chain.length - 1];
		const facts: Record<string, string> = { 'Titel der Notiz': self?.title ?? '' };
		const path = chain
			.slice(0, -1)
			.map((n) => n.title)
			.filter(Boolean);
		if (path.length) facts['Oberseiten'] = path.join(' › ');
		const actionId = chain.find((n) => n.actionId)?.actionId;
		const action = actionId ? nc.actionNames.get(actionId) : undefined;
		if (action) facts['Gehört zur Aktion'] = action;
		return { facts };
	});
}

const CONTEXTS = ['notes:note'];

export const notesAssist: ModuleAssist = {
	purposes: {
		'note-selection': {
			label: 'Markierter Text in einer Notiz',
			description:
				'Abschnitt aus einer internen Notiz des Stamms (Protokoll, Planung, Ideensammlung). Gliederung mit Überschriften, Listen und Tabellen beibehalten.',
			format: 'rich',
			richTables: true,
			maxChars: 40_000,
			tasks: [
				'rewrite',
				'friendly',
				'shorter',
				'simple',
				'spelling',
				'english',
				'summarize',
				'todos'
			],
			contexts: CONTEXTS
		},
		'note-write': {
			label: 'Text an der Cursorposition einer Notiz',
			description:
				'Interne Notiz des Stamms (Protokoll, Planung, Ideensammlung). Der bisherige Text ist die ganze Notiz; das Ergebnis wird an der Cursorposition eingefügt.',
			format: 'rich',
			richTables: true,
			maxChars: 40_000,
			tasks: ['draft', 'summarize', 'continue', 'todos'],
			contexts: CONTEXTS
		}
	},
	contexts: { note: noteContext }
};
