/**
 * Zustand eines geöffneten Whiteboards im Browser: Elemente (unveränderliche Objekte in einer `SvelteMap`),
 * Auswahl, Rückgängig/Wiederholen (je Schritt die Stände vorher/nachher), Abgleich mit dem Server über
 * `BoardSync`. Jede lokale Änderung geht sofort in die Ansicht und gebündelt an den Server.
 */
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import {
	parseElementData,
	type Asset,
	type BoardDetail,
	type ElementOp,
	type LiveElement,
	type ShareLevel,
	type WbElement
} from '../../schemas';
import type { BoardSync } from './sync.svelte';

export interface Change {
	id: string;
	before: WbElement | null;
	after: WbElement | null;
}

const MAX_HISTORY = 200;

function toOp(el: WbElement | null, id: string): ElementOp {
	return el ? { id, type: el.type, data: el.data, z: el.z } : { id, deleted: true };
}

export class BoardStore {
	elements = new SvelteMap<string, WbElement>();
	assets = new SvelteMap<string, Asset>();
	selection = new SvelteSet<string>();
	level = $state<ShareLevel>('read');
	/** Zeichenreihenfolge (z, dann ID) */
	ordered = $derived(
		[...this.elements.values()].sort((a, b) => a.z - b.z || (a.id < b.id ? -1 : 1))
	);
	canUndo = $state(false);
	canRedo = $state(false);

	private undoStack: Change[][] = [];
	private redoStack: Change[][] = [];
	/** Stände zu Beginn einer laufenden Geste (Ziehen, Zeichnen …) */
	private gesture: Map<string, WbElement | null> | null = null;
	sync: BoardSync | null = null;

	get canEdit(): boolean {
		return this.level === 'edit';
	}

	load(detail: Pick<BoardDetail, 'elements' | 'assets' | 'access'>): void {
		const keep = new Map<string, WbElement>();
		// eigene, noch nicht bestätigte Änderungen bleiben beim Neuladen erhalten
		for (const [id, el] of this.elements) if (this.sync?.isPending(id)) keep.set(id, el);
		this.elements.clear();
		for (const el of detail.elements) {
			// Standardwerte neuerer Felder ergänzen (ältere Elemente)
			const data = parseElementData(el.type, el.data);
			this.elements.set(el.id, data ? ({ ...el, data } as WbElement) : el);
		}
		for (const [id, el] of keep) this.elements.set(id, el);
		this.assets.clear();
		for (const a of detail.assets) this.assets.set(a.id, a);
		this.level = detail.access.level;
		for (const id of [...this.selection]) if (!this.elements.has(id)) this.selection.delete(id);
	}

	get(id: string): WbElement | undefined {
		return this.elements.get(id);
	}

	maxZ(): number {
		let max = 0;
		for (const el of this.elements.values()) max = Math.max(max, el.z);
		return max;
	}

	minZ(): number {
		let min = 0;
		for (const el of this.elements.values()) min = Math.min(min, el.z);
		return min;
	}

	// --- lokale Änderungen ------------------------------------------------------

	private write(id: string, el: WbElement | null): void {
		if (el) this.elements.set(id, el);
		else {
			this.elements.delete(id);
			this.selection.delete(id);
		}
		this.sync?.queue(toOp(el, id));
	}

	/** Änderungen anwenden und als einen Schritt merken */
	apply(next: (WbElement | { id: string; deleted: true })[]): void {
		if (!this.canEdit || !next.length) return;
		const changes: Change[] = [];
		for (const n of next) {
			const before = this.elements.get(n.id) ?? null;
			const after = 'deleted' in n ? null : n;
			if (!before && !after) continue;
			this.write(n.id, after);
			changes.push({ id: n.id, before, after });
		}
		this.record(changes);
	}

	/** Geste beginnen: Stände der betroffenen Elemente merken */
	begin(ids: Iterable<string>): void {
		this.gesture = new Map();
		for (const id of ids) this.gesture.set(id, this.elements.get(id) ?? null);
	}

	/** Zwischenstand während einer Geste (sofort sichtbar, live an andere, ohne eigenen Rückgängig-Schritt) */
	preview(next: WbElement[]): void {
		if (!this.canEdit) return;
		for (const el of next) {
			if (this.gesture && !this.gesture.has(el.id)) {
				this.gesture.set(el.id, this.elements.get(el.id) ?? null);
			}
			this.write(el.id, el);
		}
	}

	/** Element während einer Geste entfernen (Radierer) */
	previewRemove(id: string): void {
		if (!this.canEdit || !this.elements.has(id)) return;
		if (this.gesture && !this.gesture.has(id)) this.gesture.set(id, this.elements.get(id) ?? null);
		this.write(id, null);
	}

	/** Geste abschließen: ein Rückgängig-Schritt von den Anfangs- zu den End-Ständen */
	end(): void {
		const g = this.gesture;
		this.gesture = null;
		if (!g) return;
		const changes: Change[] = [];
		for (const [id, before] of g) {
			const after = this.elements.get(id) ?? null;
			if (before === after) continue;
			changes.push({ id, before, after });
		}
		this.record(changes);
	}

	/** Geste abbrechen: Anfangsstände zurückschreiben */
	cancel(): void {
		const g = this.gesture;
		this.gesture = null;
		if (!g) return;
		for (const [id, before] of g) if (this.elements.get(id) !== before) this.write(id, before);
	}

	private record(changes: Change[]): void {
		if (!changes.length) return;
		this.undoStack.push(changes);
		if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
		this.redoStack = [];
		this.updateFlags();
	}

	private updateFlags(): void {
		this.canUndo = this.undoStack.length > 0;
		this.canRedo = this.redoStack.length > 0;
	}

	undo(): void {
		const step = this.undoStack.pop();
		if (!step || !this.canEdit) return;
		for (const c of [...step].reverse()) this.write(c.id, c.before);
		this.redoStack.push(step);
		this.updateFlags();
	}

	redo(): void {
		const step = this.redoStack.pop();
		if (!step || !this.canEdit) return;
		for (const c of step) this.write(c.id, c.after);
		this.undoStack.push(step);
		this.updateFlags();
	}

	// --- Server -------------------------------------------------------------------

	/** Änderungen anderer übernehmen (nur neuere Versionen, eigene ausstehende haben Vorrang) */
	applyRemote(list: LiveElement[]): void {
		for (const r of list) {
			const local = this.elements.get(r.id);
			if (this.sync?.isPending(r.id)) continue;
			if (local && local.version >= r.version) continue;
			if (r.deleted) {
				if (local) {
					this.elements.delete(r.id);
					this.selection.delete(r.id);
				}
				continue;
			}
			const data = parseElementData(r.type, r.data);
			if (!data) continue;
			this.elements.set(r.id, {
				id: r.id,
				type: r.type,
				data,
				z: r.z,
				version: r.version
			} as WbElement);
		}
	}

	/** Bestätigte Versionen eintragen (Element-Objekt bleibt, damit laufende Gesten nicht springen) */
	ack(applied: { id: string; version: number }[]): void {
		for (const a of applied) {
			const el = this.elements.get(a.id);
			if (el && el.version < a.version && !this.sync?.isPending(a.id)) {
				this.elements.set(a.id, { ...el, version: a.version });
			}
		}
	}
}
