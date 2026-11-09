/**
 * PDF-Export der Termine: `GET /events/export.pdf` (Terminliste, Monatskalender, Jahresplan) und
 * `GET /events/export/options` (Auswahl im Dialog). Sichtbar ist genau das, was `GET /events` zeigt
 * (`listVisibleOccurrences`); Aktionen kommen optional aus dem Modul `actions` (nur sichtbare bzw. eigene).
 */
import type { ActionsService } from './peer-contracts';
import { core, defineEndpoint, type PdfGenerateInput, type RequestContext } from '$lib/sdk/server';
import type { PdfBlock } from '$lib/sdk/types';
import { listVisibleOccurrences } from './events.endpoints';
import { buildItems, todayBerlin } from './events.service';
import {
	calendarBlocks,
	entryFromAction,
	entryFromEvent,
	exportFileName,
	exportTitle,
	listBlocks,
	matchesActionSearch,
	subtitleText,
	yearBlocks,
	type ExportEntry
} from './export';
import { loadGroupMap } from './groups';
import {
	MAX_EXPORT_DAYS,
	MODULE_ID,
	exportQuery,
	type ExportLayout,
	type ExportOptions,
	type ExportQuery
} from './schemas';

const tags = ['Modul: events'];

async function actionsService(): Promise<ActionsService | null> {
	return core.modules.useOptional<ActionsService>('actions', MODULE_ID);
}

/** Vorlage und Seitenformat je Ausführung; Briefkopf nur, wenn die Vorlage registriert ist */
function pageSetup(
	layout: ExportLayout,
	letterhead: boolean,
	available: string[]
): Pick<PdfGenerateInput, 'template' | 'orientation' | 'margins' | 'showHeader'> & {
	letterhead: boolean;
} {
	const want = layout === 'calendar' ? 'briefkopf-quer' : 'briefkopf';
	if (letterhead && available.includes(want)) return { template: want, letterhead: true };
	if (layout === 'list') return { template: 'compact', orientation: 'portrait', letterhead: false };
	// Kalender und Jahresplan ohne Briefkopf: A4 quer mit schmalen Rändern, ohne Kopfzeile (mehr Platz)
	return {
		template: 'compact',
		orientation: 'landscape',
		margins: { top: '10mm', right: '10mm', bottom: '14mm', left: '10mm' },
		showHeader: false,
		letterhead: false
	};
}

async function collectEntries(
	ctx: RequestContext,
	q: ExportQuery
): Promise<{ entries: ExportEntry[]; withActions: boolean }> {
	const { occurrences, access } = await listVisibleOccurrences(ctx, q);
	const items = await buildItems(ctx, occurrences, access);
	const entries = items.map(entryFromEvent);
	// Aktionen haben keine Gruppen/Tags: bei diesen Filtern entfallen sie
	const wanted = (q.includeActions ?? true) && !q.tag && !q.groupId;
	const actions = wanted ? await actionsService() : null;
	if (actions) {
		const list = await actions.listCalendarActions(ctx, { from: q.from, to: q.to });
		for (const a of list) {
			if (matchesActionSearch(a, q.search)) entries.push(entryFromAction(a));
		}
	}
	return { entries, withActions: !!actions };
}

export const exportEndpoints = [
	defineEndpoint({
		method: 'GET',
		path: '/events/export/options',
		summary: 'Auswahl für den PDF-Export der Termine',
		tags,
		permission: 'events.event.view',
		handler: async (): Promise<ExportOptions> => ({
			actionsAvailable: (await actionsService()) !== null,
			maxDays: MAX_EXPORT_DAYS
		})
	}),

	defineEndpoint({
		method: 'GET',
		path: '/events/export.pdf',
		summary: 'Termine als PDF: Terminliste, Monatskalender oder Jahresplan',
		tags,
		permission: 'events.event.view',
		rateLimit: { limit: 30, windowSec: 60 },
		query: exportQuery,
		handler: async ({ ctx, query: q }) => {
			const { entries, withActions } = await collectEntries(ctx, q);
			const setup = pageSetup(
				q.layout,
				q.letterhead ?? q.layout === 'list',
				core.pdf.listTemplates().map((t) => t.id)
			);
			const group = q.groupId ? (await loadGroupMap(ctx)).get(q.groupId)?.name : null;
			const content: PdfBlock[] = [
				{
					type: 'paragraph',
					text: subtitleText({
						search: q.search,
						group: group ?? (q.groupId ? 'Unbekannt' : null),
						tag: q.tag,
						withActions,
						today: todayBerlin()
					})
				}
			];
			if (q.layout === 'list') {
				const blocks = listBlocks(entries, {
					from: q.from,
					to: q.to,
					withDescription: q.withDescription ?? false
				});
				content.push(
					...(blocks.length
						? blocks
						: [
								{ type: 'paragraph', text: 'Im gewählten Zeitraum gibt es keine Termine.' } as const
							])
				);
			} else if (q.layout === 'calendar') {
				content.push(
					...calendarBlocks(entries, q.from, q.to, { minLines: setup.letterhead ? 4 : 6 })
				);
			} else {
				// Mit Briefkopf hochkant je Halbjahr (6 Spalten), sonst das ganze Jahr quer auf einer Seite
				content.push(
					...yearBlocks(
						entries,
						q.from,
						q.to,
						setup.letterhead
							? { monthsPerPage: 6, cellChars: 20 }
							: { monthsPerPage: 12, cellChars: 18 }
					)
				);
			}

			const { letterhead, ...pdfSetup } = setup;
			const result = await core.pdf.generate(ctx, {
				...pdfSetup,
				title: exportTitle(q.layout, q.from, q.to),
				content
			});
			await core.audit.logFromContext(ctx, 'events.events.exported', {
				metadata: { layout: q.layout, count: entries.length, withActions, letterhead }
			});
			return new Response(Buffer.from(result.buffer), {
				status: 200,
				headers: {
					'content-type': 'application/pdf',
					'content-disposition': `attachment; filename="${exportFileName(q.layout, q.from, q.to)}"`,
					'cache-control': 'private, no-store'
				}
			});
		}
	})
];
