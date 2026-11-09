/** Datenbank- und Anzeige-Grundhelfer des Moduls `notes`. */
import { core, moduleDb, type RequestContext } from '$lib/sdk/server';
import { MODULE_ID, type UserRef } from './schemas';

export const mdb = () => moduleDb(MODULE_ID);

/** Systemkontext für Storage (nach der Objektprüfung) */
export const filesCtx = () => core.auth.systemContext('notes-files');

/** Benutzer-Anzeige (aktive Konten; Unbekannte fehlen in der Map) – NACH der Transaktion aufrufen */
export async function userRefs(
	ctx: RequestContext,
	ids: Iterable<string | null | undefined>
): Promise<Map<string, UserRef>> {
	const unique = [...new Set(ids)].filter((v): v is string => !!v);
	const map = new Map<string, UserRef>();
	if (!unique.length) return map;
	for (const u of (await core.users.byIds(ctx, unique)).values()) {
		map.set(u.id, { id: u.id, name: u.name, image: u.image ?? null });
	}
	return map;
}

/** Eintrag aus `userRefs` oder „Unbekannt“ (`null` bei fehlender ID) */
export function refOf(
	map: ReadonlyMap<string, UserRef>,
	id: string | null | undefined
): UserRef | null {
	if (!id) return null;
	return map.get(id) ?? { id, name: 'Unbekannt', image: null };
}
