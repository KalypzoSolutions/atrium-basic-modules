/** KI-Schreibhilfe in Terminen: Beschreibung und Kontext `events:event` (Eckdaten, keine Personen). */
import { sql } from 'drizzle-orm';
import { formatDateDe } from '$lib/sdk/dates';
import {
	moduleDb,
	principalKeysFor,
	rowsOf,
	type ModuleAssist,
	type RequestContext
} from '$lib/sdk/server';
import { ASSIST_TEXT_TASKS } from '$lib/sdk/types/assist';
import { resolveAccess } from './access';
import { MODULE_ID } from './schemas';

export const PERM_AI = 'events.ai.use';

async function eventContext(ctx: RequestContext, id: string) {
	if (!ctx.permissions.has('events.event.view')) return null;
	const keys = await principalKeysFor(ctx, MODULE_ID);
	return moduleDb(MODULE_ID).transaction(async (tx) => {
		if (!(await resolveAccess(tx, ctx, id, keys))) return null;
		const [r] = await rowsOf(
			tx,
			sql`SELECT title, description, location, starts_at, ends_at,
					to_char(starts_on, 'YYYY-MM-DD') AS starts_on, to_char(ends_on, 'YYYY-MM-DD') AS ends_on
				FROM events WHERE id = ${id}`
		);
		if (!r) return null;
		const start = formatDateDe(String(r.starts_on ?? ''));
		const end = r.ends_on ? formatDateDe(String(r.ends_on)) : '';
		const facts: Record<string, string> = {
			Termin: String(r.title ?? ''),
			Datum: end && end !== start ? `${start} bis ${end}` : start,
			Uhrzeit: [r.starts_at, r.ends_at].filter(Boolean).join(' bis '),
			Ort: String(r.location ?? '')
		};
		if (r.description) facts['Bisherige Beschreibung'] = String(r.description).slice(0, 1500);
		return { facts };
	});
}

export const eventsAssist: ModuleAssist = {
	purposes: {
		'event-description': {
			label: 'Beschreibung eines Termins',
			description:
				'Kurzer Text zu einem Termin des Stamms (Gruppenstunde, Fahrt, Fest), intern und ggf. auf der Website. Zwei bis vier Sätze.',
			format: 'plain',
			maxChars: 10_000,
			tasks: ASSIST_TEXT_TASKS,
			contexts: ['events:event'],
			extraKeys: {
				title: 'Titel (Formular)',
				location: 'Ort (Formular)',
				startsOn: 'Datum (Formular)',
				startsAt: 'Beginn (Formular)',
				groups: 'Gruppen (Formular)',
				tags: 'Tags (Formular)'
			}
		}
	},
	contexts: { event: eventContext }
};
