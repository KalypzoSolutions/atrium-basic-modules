/** Zustand des Seitenbaums: Wurzeln, Kinder (lazy), aufgeklappte Seiten */
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { apiFetch } from '$lib/sdk/client';
import type { NoteNode, NoteRoots } from '../../schemas';
import { API } from '../helpers';

export type RootSection = 'own' | 'shared' | 'actions';

export class NoteTreeState {
	roots = $state<NoteRoots | null>(null);
	rootsError = $state('');
	children = new SvelteMap<string, NoteNode[]>();
	loading = new SvelteSet<string>();
	expanded = new SvelteSet<string>();
	/** Alle bekannten Knoten (für Eltern-Ketten) */
	private known = new Map<string, NoteNode>();

	async loadRoots(): Promise<void> {
		try {
			const r = await apiFetch<NoteRoots>(`${API}/notes/roots`);
			for (const n of [...r.own, ...r.shared, ...r.actions]) this.known.set(n.id, n);
			this.roots = r;
			this.rootsError = '';
		} catch {
			this.rootsError = 'Seiten konnten nicht geladen werden';
		}
	}

	async loadChildren(id: string): Promise<NoteNode[]> {
		this.loading.add(id);
		try {
			const list = await apiFetch<NoteNode[]>(`${API}/notes/${id}/children`);
			for (const n of list) this.known.set(n.id, n);
			this.children.set(id, list);
			return list;
		} catch {
			return this.children.get(id) ?? [];
		} finally {
			this.loading.delete(id);
		}
	}

	async toggle(id: string): Promise<void> {
		if (this.expanded.has(id)) {
			this.expanded.delete(id);
			return;
		}
		this.expanded.add(id);
		if (!this.children.has(id)) await this.loadChildren(id);
	}

	async expand(id: string): Promise<void> {
		this.expanded.add(id);
		if (!this.children.has(id)) await this.loadChildren(id);
	}

	/** Container neu laden (`null` = Wurzeln) */
	async refresh(parentId: string | null): Promise<void> {
		if (parentId === null) await this.loadRoots();
		else if (this.children.has(parentId) || this.expanded.has(parentId)) {
			await this.loadChildren(parentId);
		}
		if (parentId !== null) {
			// „hat Unterseiten“ am Elternteil aktualisieren
			const node = this.known.get(parentId);
			if (node?.parentId !== undefined) {
				const grand = node.parentId;
				if (grand === null) await this.loadRoots();
				else if (this.children.has(grand)) await this.loadChildren(grand);
			}
		}
	}

	get(id: string): NoteNode | undefined {
		return this.known.get(id);
	}

	/** Liegt `id` in `ancestorId` (oder ist es selbst)? Nur bekannte Ketten */
	isInside(id: string, ancestorId: string): boolean {
		let cur: string | null | undefined = id;
		for (let i = 0; cur && i < 50; i++) {
			if (cur === ancestorId) return true;
			cur = this.known.get(cur)?.parentId;
		}
		return false;
	}

	/** Titel/Icon/Farbe aus Live-Ereignissen oder nach PATCH übernehmen */
	patch(id: string, data: Partial<Pick<NoteNode, 'title' | 'icon' | 'color'>>): void {
		const update = (list: NoteNode[]) => list.map((n) => (n.id === id ? { ...n, ...data } : n));
		for (const [key, list] of this.children) {
			if (list.some((n) => n.id === id)) this.children.set(key, update(list));
		}
		if (this.roots) {
			const r = this.roots;
			this.roots = {
				...r,
				own: update(r.own),
				shared: update(r.shared),
				actions: r.actions.map((n) => (n.id === id ? { ...n, ...data } : n))
			};
		}
		const known = this.known.get(id);
		if (known) this.known.set(id, { ...known, ...data });
	}

	/** Geschwister einer Seite (bekannt) */
	siblingsOf(node: NoteNode): NoteNode[] {
		if (node.parentId) return this.children.get(node.parentId) ?? [];
		const r = this.roots;
		if (!r) return [];
		for (const list of [r.own, r.shared, r.actions] as NoteNode[][])
			if (list.some((n) => n.id === node.id)) return list;
		return [];
	}
}
