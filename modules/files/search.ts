/**
 * Globale Suche (Befehlspalette): Ordner und Dateien nach Name – nutzt `searchNodes` (gleiche
 * Sichtbarkeit wie `GET /search`: eigene, per Freigabe auch geerbt bzw. Stamm, nie Papierkorb).
 * Dateien verlinken auf ihren Ordner, wenn dieser sichtbar ist, sonst auf die Wurzel.
 */
import type { ModuleSearchProvider, RequestContext } from '$lib/sdk/server';
import type { SearchHit } from '$lib/sdk/types/search';
import { displayPath } from './names';
import { searchNodes } from './nodes.service';
import { PERMISSIONS, ROOT_LABEL } from './schemas';

const BASE = '/modules/files';

/** „512 B“, „1,2 MB“ (de-DE, Basis 1024) */
function formatSize(bytes: number | null): string {
	const n = bytes && bytes > 0 ? bytes : 0;
	if (n < 1024) return `${n} B`;
	const units = ['KB', 'MB', 'GB', 'TB'];
	let v = n / 1024;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v.toLocaleString('de-DE', { maximumFractionDigits: v < 10 ? 1 : 0 })} ${units[i]}`;
}

async function run(ctx: RequestContext, query: string, limit: number): Promise<SearchHit[]> {
	const { items } = await searchNodes(ctx, { q: query, limit });
	const rootOnly = displayPath([ROOT_LABEL]);
	return items.map((n): SearchHit => {
		// Pfad nur aus der Wurzel → kein Vorfahre sichtbar (fremder, direkt freigegebener Eintrag)
		const parentVisible = n.parentId !== null && n.path !== rootOnly;
		if (n.kind === 'folder') {
			return {
				id: n.id,
				title: n.name,
				subtitle: n.path,
				href: `${BASE}?folder=${encodeURIComponent(n.id)}`,
				icon: 'folder',
				type: 'Ordner'
			};
		}
		return {
			id: n.id,
			title: n.name,
			subtitle: `${n.path} · ${formatSize(n.sizeBytes)}`,
			href: parentVisible ? `${BASE}?folder=${encodeURIComponent(n.parentId!)}` : BASE,
			icon: 'file',
			type: 'Datei'
		};
	});
}

export const filesSearch: ModuleSearchProvider = {
	permission: PERMISSIONS.view,
	run
};
