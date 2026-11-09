/**
 * PDF-Export über `core.pdf.generate` mit dem Core-Block `richText` (HTML wird im Core erneut bereinigt).
 * Bilder als data-URL im HTML; `letterhead` → Vorlage `briefkopf`, sonst `default`. Den Titel der ersten Seite
 * druckt die Vorlage selbst, Unterseiten bekommen eine eigene Überschrift und beginnen auf einer neuen Seite.
 */
import { core, type RequestContext } from '$lib/sdk/server';
import type { ExportBundle } from './collect';
import { dataUrl, pagesFragment } from './html';

export async function exportPdf(
	ctx: RequestContext,
	bundle: ExportBundle,
	opts: { letterhead: boolean }
): Promise<Uint8Array> {
	const html = pagesFragment(bundle.pages, {
		skipFirstTitle: true,
		pageBreaks: true,
		embeds: bundle.embeds,
		imageSrc: (id) => {
			const img = bundle.images.get(id);
			return img ? dataUrl(img.contentType, img.bytes) : null;
		}
	});
	const result = await core.pdf.generate(ctx, {
		template: opts.letterhead ? 'briefkopf' : 'default',
		title: (bundle.root.title || 'Notiz').slice(0, 200),
		content: [{ type: 'richText', html }]
	});
	return result.buffer;
}
