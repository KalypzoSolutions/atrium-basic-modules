/**
 * Vertrag der Website-Endpunkte von `events` (#48): Zod-Schemas der öffentlichen DTOs (Antworten) und
 * die Paging-Eingabe. Die Integrationstests parsen die Antworten dagegen; die Typprüfung unten hält
 * Schema und `WebsiteEvent` deckungsgleich (eine Feldumbenennung bricht `npm run check` bzw. die Tests).
 * Die Stammeswebsite (`website/src/lib/server/backend-types.ts`) wird in `tests/unit/website-contract.test.ts`
 * gegen dieselben Typen geprüft.
 */
import { z } from 'zod';
import { websiteQuery, type WebsiteEvent } from './schemas';

/** Exakte Typgleichheit (beide Richtungen) */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const hhmm = z.string().regex(/^\d{2}:\d{2}$/);

export const websiteEventSchema = z
	.object({
		id: z.string(),
		title: z.string(),
		description: z.string().nullable(),
		location: z.string().nullable(),
		color: z.string().nullable(),
		startsOn: isoDate,
		startsTime: hhmm.nullable(),
		endsOn: isoDate.nullable(),
		endsTime: hhmm.nullable(),
		tags: z.array(z.string()),
		groups: z.array(z.string()),
		groupIds: z.array(z.string()),
		recurring: z.boolean(),
		occurrenceDate: isoDate.nullable()
	})
	.strict();

const _eventExact: Exact<z.infer<typeof websiteEventSchema>, WebsiteEvent> = true;
void _eventExact;

/** Höchstwert für `offset` (Schutz vor unsinnigen Abfragen; Kandidaten sind ohnehin begrenzt) */
export const WEBSITE_MAX_OFFSET = 100_000;

/** Query-Flag `true`/`false`/`1`/`0` (z. B. `paged=1`) */
const queryFlag = z
	.enum(['true', 'false', '1', '0'])
	.transform((v) => v === 'true' || v === '1')
	.optional();

/**
 * `GET /website/events`: bisherige Felder plus Paging. Ohne `paged` bleibt die Antwort ein reines Array
 * (abwärtskompatibel, `offset` wirkt trotzdem); mit `paged=1` kommt `WebsiteEventPage`.
 */
export const websiteEventsQuery = websiteQuery.extend({
	offset: z.coerce.number().int().min(0).max(WEBSITE_MAX_OFFSET).default(0),
	paged: queryFlag
});
export type WebsiteEventsQuery = z.infer<typeof websiteEventsQuery>;

/** Antwort mit `paged=1`: eine Seite plus Gesamtzahl der Vorkommen im Zeitraum */
export interface WebsiteEventPage {
	items: WebsiteEvent[];
	/** Alle Vorkommen im Zeitraum (nach Filtern), unabhängig von `limit`/`offset` */
	total: number;
	offset: number;
	limit: number;
	/** Es gibt weitere Einträge ab `offset + items.length` */
	hasMore: boolean;
}

export const websiteEventPageSchema = z
	.object({
		items: z.array(websiteEventSchema),
		total: z.number().int().min(0),
		offset: z.number().int().min(0),
		limit: z.number().int().min(1),
		hasMore: z.boolean()
	})
	.strict();

const _pageExact: Exact<z.infer<typeof websiteEventPageSchema>, WebsiteEventPage> = true;
void _pageExact;
