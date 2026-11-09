/** Persönliche Ansicht-Einstellungen (`/api/v1/modules/notes/me/prefs`): je Konto, gelten für alle Notizen. */
import { sql } from 'drizzle-orm';
import { type AnyApiEndpoint, defineEndpoint, errors, rowsOf } from '$lib/sdk/server';
import { mdb } from './db';
import { DEFAULT_USER_PREFS, PERM, userPrefsInput, type UserPrefs } from './schemas';

const tags = ['Notizen'];

/** Gespeicherte Werte prüfen; Ungültiges/Unbekanntes → Standard */
export function readPrefs(raw: unknown): UserPrefs {
	let value: unknown = raw;
	if (typeof raw === 'string') {
		try {
			value = JSON.parse(raw);
		} catch {
			return DEFAULT_USER_PREFS;
		}
	}
	const parsed = userPrefsInput.safeParse(value ?? {});
	return parsed.success ? parsed.data : DEFAULT_USER_PREFS;
}

export const prefsEndpoints: AnyApiEndpoint[] = [
	defineEndpoint({
		method: 'GET',
		path: '/me/prefs',
		summary: 'Eigene Ansicht-Einstellungen (Hintergrund)',
		description: 'Ohne gespeicherte Werte: Hintergrund wie Modus/Theme.',
		tags,
		permission: PERM.view,
		handler: async ({ ctx }): Promise<UserPrefs> => {
			if (!ctx.userId) throw errors.unauthenticated();
			const [row] = await mdb().transaction((tx) =>
				rowsOf(tx, sql`SELECT prefs FROM user_prefs WHERE user_id = ${ctx.userId}`)
			);
			return readPrefs(row?.prefs);
		}
	}),
	defineEndpoint({
		method: 'PUT',
		path: '/me/prefs',
		summary: 'Eigene Ansicht-Einstellungen speichern',
		description:
			'`surface.mode`: `fixed` (Hintergrund behält `surface.color` in Hell/Dunkel und mit jedem Theme) oder `theme` (folgt Modus und Theme).',
		tags,
		permission: PERM.view,
		body: userPrefsInput,
		handler: async ({ ctx, body }): Promise<UserPrefs> => {
			if (!ctx.userId) throw errors.unauthenticated();
			await mdb().transaction((tx) =>
				tx.execute(
					sql`INSERT INTO user_prefs (user_id, prefs) VALUES (${ctx.userId}, ${JSON.stringify(body)}::jsonb)
						ON CONFLICT (user_id) DO UPDATE SET prefs = EXCLUDED.prefs, updated_at = now()`
				)
			);
			return body;
		}
	})
];
