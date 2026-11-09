/** Gemeinsame Typen der Editor-Komponenten */
import type { Asset, RefCard, WbElement } from '../../schemas';
import type { Palette } from './render';
import type { Measure } from './text-layout';

/** Alles, was eine Element-Darstellung braucht (Ansicht UND Export nutzen dieselben Komponenten) */
export interface RenderContext {
	lookup(id: string): WbElement | undefined;
	assets: ReadonlyMap<string, Asset>;
	refs: ReadonlyMap<string, RefCard>;
	measure: Measure;
	zoom: number;
	/** Element, dessen Text gerade bearbeitet wird (Text dann ausgeblendet) */
	editingId: string | null;
	/** Adresse einer Datei-Variante (Export: Data-URL) */
	assetHref(assetId: string, variant: 'thumb' | 'web'): string | null;
	/** Farben der Fläche (Theme/Dunkelmodus; Export immer hell) */
	palette: Palette;
	/** Export: keine Treffer-Flächen, keine Hinweise für die Bedienung */
	exporting: boolean;
}

export const refKey = (type: string, id: string) => `${type}:${id}`;
