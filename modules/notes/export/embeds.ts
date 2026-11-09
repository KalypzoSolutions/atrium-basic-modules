/** Reine Hilfen für Einbettungen im Export (ohne Server-Importe, auch in Unit-Tests nutzbar). */
import type { EmbedRef } from '$lib/sdk/types/embeds';

export interface ResolvedEmbed {
	title: string;
	/** Art, z. B. „Whiteboard“ */
	kindLabel: string;
	/** Absolute Adresse der Vollansicht (`null` = nicht verfügbar) */
	href: string | null;
}

export const embedKey = (r: EmbedRef) => `${r.module}:${r.kind}:${r.refId}`;

/** Anzeige eines eingebetteten Inhalts („Whiteboard: Lagerplan“, sonst „Eingebetteter Inhalt“) */
export function embedLabel(info: ResolvedEmbed | undefined): string {
	if (!info) return 'Eingebetteter Inhalt';
	return info.kindLabel ? `${info.kindLabel}: ${info.title}` : info.title;
}
