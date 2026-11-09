/**
 * Objektbezogene Zugriffsprüfung für Termine – Konfiguration des SDK-Bausteins `createShareAccess`
 * (Regeln dort). `keys` = `principalKeysFor(ctx, 'events')`, immer VOR der Transaktion ermittelt.
 */
import type { SQL } from 'drizzle-orm';
import { createShareAccess, type RequestContext } from '$lib/sdk/server';

export const eventAccess = createShareAccess({
	table: 'events',
	shareTable: 'event_shares',
	fk: 'event_id',
	perms: { viewAll: 'events.event.view-all', editAll: 'events.event.edit-all' },
	notFoundText: 'Termin nicht gefunden',
	forbiddenText: 'Keine Berechtigung zum Bearbeiten dieses Termins'
});

export const { resolveAccess, requireAccess, accessForMany, loadShares, replaceShares } =
	eventAccess;

/** SQL-Bedingung für Listen (Alias `e` für `events`): alles oder eigene + freigegebene */
export const visibleEventsFilter = (ctx: RequestContext, keys: readonly string[]): SQL =>
	eventAccess.visibleFilter(ctx, keys, 'e');
