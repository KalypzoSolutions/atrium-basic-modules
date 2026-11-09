/**
 * Gruppen für die Zuordnung von Terminen: „ganzer Stamm“ plus Gruppen aus `members` (optional).
 * Ruft Core-Dienste auf: nie innerhalb einer offenen Modul-Transaktion verwenden.
 */
import { core, type PrincipalProvider } from '$lib/sdk/server';
import type { RequestContext } from '$lib/sdk/types';
import {
	DEFAULT_STAMM_NAME,
	MODULE_ID,
	STAMM_GROUP_ID,
	STAMM_NAME_SETTING,
	type EventGroupRef
} from './schemas';

/** Anzeigename des Stamms aus den Modul-Einstellungen (Fallback: Standardname) */
export async function stammName(): Promise<string> {
	try {
		const value = await core.settings.get<unknown>(STAMM_NAME_SETTING);
		if (typeof value === 'string' && value.trim()) return value.trim();
	} catch {
		// Einstellung nicht registriert (z. B. Modul nicht geladen) → Standard
	}
	return DEFAULT_STAMM_NAME;
}

/**
 * Alle zuordenbaren Gruppen: zuerst `stamm`, danach die Gruppen aus `members` (nach Name).
 * Ist `members` nicht aktiv, enthält die Map nur den Stamm.
 */
export async function loadGroupMap(_ctx: RequestContext): Promise<Map<string, EventGroupRef>> {
	const map = new Map<string, EventGroupRef>();
	map.set(STAMM_GROUP_ID, {
		id: STAMM_GROUP_ID,
		name: await stammName(),
		color: null,
		meetingWeekday: null,
		meetingTime: null,
		meetingEndTime: null,
		meetingPlace: null
	});
	const members = await core.modules.useOptional<PrincipalProvider>('members', MODULE_ID);
	if (members) {
		for (const g of await members.listGroups()) {
			if (g.id === STAMM_GROUP_ID) continue;
			map.set(g.id, {
				id: g.id,
				name: g.name,
				color: g.color ?? null,
				meetingWeekday: g.meetingWeekday ?? null,
				meetingTime: g.meetingTime ?? null,
				meetingEndTime: g.meetingEndTime ?? null,
				meetingPlace: g.meetingPlace ?? null
			});
		}
	}
	return map;
}
