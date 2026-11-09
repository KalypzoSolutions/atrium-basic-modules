<script lang="ts">
	// Seitenbaum (links bzw. mobil im Blatt): Abschnitte Meine · Geteilt · Aktionen, Kinder lazy, Menüs, Ziehen
	import { goto } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import FilePlus from '@lucide/svelte/icons/file-plus';
	import FileUp from '@lucide/svelte/icons/file-up';
	import FolderInput from '@lucide/svelte/icons/folder-input';
	import Palette from '@lucide/svelte/icons/palette';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Plus from '@lucide/svelte/icons/plus';
	import Share2 from '@lucide/svelte/icons/share-2';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { apiFetch } from '$lib/sdk/client';
	import { ConfirmDialog } from '$lib/components/layout';
	import { Button } from '$lib/components/ui/button';
	import { MAX_CHILDREN, type NoteDetail, type NoteNode } from '../../schemas';
	import MoveDialog from '../MoveDialog.svelte';
	import NoteShareDialog from '../NoteShareDialog.svelte';
	import RenameDialog from '../RenameDialog.svelte';
	import StyleDialog from '../StyleDialog.svelte';
	import {
		API,
		BASE,
		createNote,
		errMsg,
		IMPORT_ACCEPT,
		importNote,
		noteTitle,
		notePath
	} from '../helpers';
	import type { NoteTreeState } from './tree-state.svelte';
	import TreeItem, { type DropWhere, type TreeMenuEntry } from './TreeItem.svelte';

	let {
		tree,
		activeId,
		onchanged,
		ondeleted,
		onnavigate
	}: {
		tree: NoteTreeState;
		activeId: string | null;
		/** Seite geändert (Titel, Aussehen, Ort) */
		onchanged?: (note: NoteDetail) => void;
		/** Seite in den Papierkorb gelegt */
		ondeleted?: (id: string) => void;
		/** Link geklickt (mobil: Blatt schließen) */
		onnavigate?: () => void;
	} = $props();

	let dragging = $state<NoteNode | null>(null);
	let target = $state<NoteNode | null>(null);
	let renameOpen = $state(false);
	let styleOpen = $state(false);
	let moveOpen = $state(false);
	let shareOpen = $state(false);
	let deleteOpen = $state(false);
	let fileInput = $state<HTMLInputElement | null>(null);
	let importParent: NoteNode | null = null;
	let creating = $state(false);

	const sections = $derived.by(() => {
		const r = tree.roots;
		if (!r) return [];
		return [
			{ id: 'own', label: 'Meine', items: r.own },
			{ id: 'shared', label: 'Geteilt', items: r.shared },
			{ id: 'actions', label: 'Aktionen', items: r.actions as NoteNode[] }
		];
	});

	async function createChild(parent: NoteNode | null) {
		creating = true;
		try {
			const note = await createNote({ parentId: parent?.id ?? null, title: '' });
			if (parent) {
				await tree.expand(parent.id);
				await tree.refresh(parent.id);
			} else await tree.loadRoots();
			onnavigate?.();
			await goto(notePath(note.id));
		} catch (e) {
			toast.error(errMsg(e, 'Seite konnte nicht angelegt werden'));
		} finally {
			creating = false;
		}
	}

	async function importInto(file: File) {
		const parent = importParent;
		importParent = null;
		try {
			const res = await importNote(file, parent?.id ?? null);
			toast.success('Importiert');
			if (parent) {
				await tree.expand(parent.id);
				await tree.refresh(parent.id);
			} else await tree.loadRoots();
			await goto(notePath(res.id));
		} catch (e) {
			toast.error(errMsg(e, 'Import fehlgeschlagen'));
		}
	}

	async function trash() {
		const node = target;
		if (!node) return;
		try {
			await apiFetch(`${API}/notes/${node.id}`, { method: 'DELETE' });
			toast.success(`„${noteTitle(node.title)}“ liegt im Papierkorb`, {
				action: { label: 'Papierkorb', onClick: () => void goto(`${BASE}?view=trash`) }
			});
			await tree.refresh(node.parentId);
			ondeleted?.(node.id);
		} catch (e) {
			toast.error(errMsg(e, 'Löschen fehlgeschlagen'));
		}
	}

	function changed(note: NoteDetail) {
		tree.patch(note.id, { title: note.title, icon: note.icon, color: note.color });
		onchanged?.(note);
	}

	function entries(node: NoteNode): TreeMenuEntry[] {
		const list: TreeMenuEntry[] = [];
		const pick = (fn: () => void) => () => {
			target = node;
			fn();
		};
		if (node.level === 'edit') {
			list.push(
				{ label: 'Unterseite anlegen', icon: FilePlus, onclick: () => void createChild(node) },
				{
					label: 'Unterseite importieren …',
					icon: FileUp,
					onclick: () => {
						importParent = node;
						fileInput?.click();
					}
				},
				{
					label: 'Umbenennen …',
					icon: Pencil,
					onclick: pick(() => (renameOpen = true)),
					separatorBefore: true
				},
				{ label: 'Aussehen …', icon: Palette, onclick: pick(() => (styleOpen = true)) },
				{ label: 'Verschieben …', icon: FolderInput, onclick: pick(() => (moveOpen = true)) }
			);
		}
		list.push({
			label: node.canShare ? 'Teilen …' : 'Freigaben ansehen …',
			icon: Share2,
			onclick: pick(() => (shareOpen = true)),
			separatorBefore: node.level === 'edit'
		});
		if (node.canShare) {
			list.push({
				label: 'In den Papierkorb',
				icon: Trash2,
				destructive: true,
				separatorBefore: true,
				onclick: pick(() => (deleteOpen = true))
			});
		}
		return list;
	}

	async function dropOn(dest: NoteNode, where: DropWhere) {
		const node = dragging;
		dragging = null;
		if (!node || node.id === dest.id) return;
		let parentId: string | null;
		let position: number;
		if (where === 'inside') {
			parentId = dest.id;
			position = MAX_CHILDREN;
		} else {
			parentId = dest.parentId;
			const ownRoots = tree.roots?.own ?? [];
			const siblings = (parentId ? tree.siblingsOf(dest) : ownRoots).filter(
				(n) => n.id !== node.id
			);
			const idx = siblings.findIndex((n) => n.id === dest.id);
			position = idx < 0 ? MAX_CHILDREN : where === 'before' ? idx : idx + 1;
		}
		try {
			const note = await apiFetch<NoteDetail>(`${API}/notes/${node.id}/move`, {
				method: 'POST',
				body: JSON.stringify({ parentId, position })
			});
			await tree.refresh(node.parentId);
			if (parentId !== node.parentId) await tree.refresh(parentId);
			if (parentId) await tree.expand(parentId);
			onchanged?.(note);
		} catch (e) {
			toast.error(errMsg(e, 'Verschieben fehlgeschlagen'));
		}
	}
</script>

<nav class="flex flex-col gap-4 p-2 text-sm" aria-label="Seiten">
	{#if tree.rootsError && !tree.roots}
		<div class="p-2 text-sm text-destructive">
			{tree.rootsError}
			<Button size="sm" variant="outline" class="mt-2" onclick={() => tree.loadRoots()}
				>Erneut versuchen</Button
			>
		</div>
	{:else if !tree.roots}
		<p class="p-2 text-muted-foreground">Lädt …</p>
	{:else}
		{#each sections as s (s.id)}
			{#if s.items.length || (s.id === 'own' && tree.roots.canCreate)}
				<section>
					<div class="flex h-7 items-center justify-between px-2">
						<h2 class="text-xs font-medium tracking-wide text-muted-foreground uppercase">
							{s.label}
						</h2>
						{#if s.id === 'own' && tree.roots.canCreate}
							<Button
								variant="ghost"
								size="icon-xs"
								aria-label="Neue Notiz"
								title="Neue Notiz"
								disabled={creating}
								onclick={() => createChild(null)}
							>
								<Plus />
							</Button>
						{/if}
					</div>
					{#if s.items.length}
						<ul role="tree" aria-label={s.label}>
							{#each s.items as node (node.id)}
								<TreeItem
									{node}
									depth={0}
									{tree}
									{activeId}
									{dragging}
									{entries}
									oncreatechild={(n) => void createChild(n)}
									ondragstart={(n) => (dragging = n)}
									ondragend={() => (dragging = null)}
									ondropon={(t, w) => void dropOn(t, w)}
									{onnavigate}
								/>
							{/each}
						</ul>
					{:else}
						<p class="px-2 py-1 text-xs text-muted-foreground">Noch keine eigenen Notizen.</p>
					{/if}
				</section>
			{/if}
		{/each}
	{/if}
</nav>

<input
	bind:this={fileInput}
	type="file"
	accept={IMPORT_ACCEPT}
	class="hidden"
	onchange={(e) => {
		const input = e.currentTarget as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (file) void importInto(file);
	}}
/>

<RenameDialog bind:open={renameOpen} node={target} onsaved={changed} />
<StyleDialog bind:open={styleOpen} node={target} onsaved={changed} />
<MoveDialog
	bind:open={moveOpen}
	node={target}
	onmoved={async (note, oldParent) => {
		await tree.refresh(oldParent);
		await tree.refresh(note.parentId);
		onchanged?.(note);
	}}
/>
<NoteShareDialog bind:open={shareOpen} node={target} />
<ConfirmDialog
	bind:open={deleteOpen}
	title="In den Papierkorb legen?"
	description={target
		? `„${noteTitle(target.title)}“${target.hasChildren ? ' und alle Unterseiten werden' : ' wird'} in den Papierkorb gelegt. Dort lässt sich alles wiederherstellen.`
		: ''}
	confirmLabel="In den Papierkorb"
	destructive
	onconfirm={trash}
/>
