<script lang="ts">
	// Werkzeugleiste: links (Desktop) bzw. unten (mobil, waagrecht scrollbar). Formen über ein Popover,
	// Einfügen (Bild/Datei, Link, Karte, Datei aus „Dateien“) über ein Menü.
	import Eraser from '@lucide/svelte/icons/eraser';
	import FolderOpen from '@lucide/svelte/icons/folder-open';
	import Frame from '@lucide/svelte/icons/frame';
	import Hand from '@lucide/svelte/icons/hand';
	import Highlighter from '@lucide/svelte/icons/highlighter';
	import ImagePlus from '@lucide/svelte/icons/image-plus';
	import LayoutGrid from '@lucide/svelte/icons/layout-grid';
	import Link2 from '@lucide/svelte/icons/link-2';
	import MousePointer2 from '@lucide/svelte/icons/mouse-pointer-2';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Plus from '@lucide/svelte/icons/plus';
	import Shapes from '@lucide/svelte/icons/shapes';
	import Spline from '@lucide/svelte/icons/spline';
	import StickyNote from '@lucide/svelte/icons/sticky-note';
	import Type from '@lucide/svelte/icons/type';
	import { Button } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import * as Popover from '$lib/components/ui/popover';
	import { SHAPE_KINDS, SHAPE_LABELS, type ShapeKind } from '../../schemas';
	import type { EditorController, Tool } from './controller.svelte';
	import { shapePath } from './geometry';

	let {
		ctrl,
		canEdit,
		onupload,
		onlink,
		onref
	}: {
		ctrl: EditorController;
		canEdit: boolean;
		onupload: () => void;
		onlink: () => void;
		onref: (type?: 'file') => void;
	} = $props();

	const tools: { tool: Tool; label: string; key: string; icon: typeof Hand; edit: boolean }[] = [
		{ tool: 'select', label: 'Auswählen', key: 'V', icon: MousePointer2, edit: false },
		{ tool: 'hand', label: 'Verschieben', key: 'H', icon: Hand, edit: false },
		{ tool: 'note', label: 'Notizzettel', key: 'N', icon: StickyNote, edit: true },
		{ tool: 'text', label: 'Text', key: 'T', icon: Type, edit: true },
		{ tool: 'connector', label: 'Verbinden', key: 'L', icon: Spline, edit: true },
		{ tool: 'pen', label: 'Stift', key: 'P', icon: Pencil, edit: true },
		{ tool: 'marker', label: 'Marker', key: 'M', icon: Highlighter, edit: true },
		{ tool: 'eraser', label: 'Radierer (nur Freihand)', key: 'E', icon: Eraser, edit: true },
		{ tool: 'frame', label: 'Rahmen', key: 'F', icon: Frame, edit: true }
	];
	const shapes = SHAPE_KINDS.filter((k) => k !== 'note' && k !== 'text');
	let shapesOpen = $state(false);

	function pickShape(kind: ShapeKind) {
		ctrl.shapeKind = kind;
		ctrl.tool = 'shape';
		shapesOpen = false;
	}
</script>

{#snippet toolButton(t: (typeof tools)[number])}
	<Button
		variant={ctrl.tool === t.tool ? 'secondary' : 'ghost'}
		size="icon"
		aria-label={`${t.label} (${t.key})`}
		aria-pressed={ctrl.tool === t.tool}
		title={`${t.label} (${t.key})`}
		onclick={() => (ctrl.tool = t.tool)}
		class={ctrl.tool === t.tool ? 'text-link' : ''}
	>
		<t.icon />
	</Button>
{/snippet}

<div
	class="pointer-events-auto absolute bottom-3 left-1/2 z-10 flex max-w-[calc(100%-1.5rem)] -translate-x-1/2 items-center gap-0.5 overflow-x-auto rounded-xl border bg-popover p-1 shadow-lg sm:top-1/2 sm:bottom-auto sm:left-3 sm:max-w-none sm:-translate-y-1/2 sm:translate-x-0 sm:flex-col sm:overflow-visible"
	role="toolbar"
	aria-label="Werkzeuge"
	aria-orientation="vertical"
>
	{#each tools.filter((t) => !t.edit || canEdit).slice(0, 4) as t (t.tool)}
		{@render toolButton(t)}
	{/each}
	{#if canEdit}
		<Popover.Root bind:open={shapesOpen}>
			<Popover.Trigger>
				{#snippet child({ props })}
					<Button
						{...props}
						variant={ctrl.tool === 'shape' ? 'secondary' : 'ghost'}
						size="icon"
						aria-label="Formen (R)"
						aria-pressed={ctrl.tool === 'shape'}
						title="Formen (R)"
						class={ctrl.tool === 'shape' ? 'text-link' : ''}
					>
						<Shapes />
					</Button>
				{/snippet}
			</Popover.Trigger>
			<Popover.Content side="right" align="center" class="w-auto p-2">
				<div class="grid grid-cols-3 gap-1" role="group" aria-label="Form wählen">
					{#each shapes as kind (kind)}
						<button
							type="button"
							class={[
								'flex flex-col items-center gap-1 rounded-md p-2 text-xs hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
								ctrl.shapeKind === kind && ctrl.tool === 'shape' && 'bg-muted'
							]}
							onclick={() => pickShape(kind)}
							aria-pressed={ctrl.shapeKind === kind && ctrl.tool === 'shape'}
						>
							<svg viewBox="-2 -2 40 30" class="h-7 w-9" aria-hidden="true">
								<path
									d={shapePath(kind, 36, 26)}
									fill="none"
									stroke="currentColor"
									stroke-width="2"
									stroke-linejoin="round"
								/>
							</svg>
							{SHAPE_LABELS[kind]}
						</button>
					{/each}
				</div>
			</Popover.Content>
		</Popover.Root>
	{/if}
	{#each tools.filter((t) => !t.edit || canEdit).slice(4) as t (t.tool)}
		{@render toolButton(t)}
	{/each}
	{#if canEdit}
		<div class="mx-0.5 h-6 w-px bg-border sm:my-0.5 sm:h-px sm:w-6" aria-hidden="true"></div>
		<DropdownMenu.Root>
			<DropdownMenu.Trigger>
				{#snippet child({ props })}
					<Button {...props} variant="ghost" size="icon" aria-label="Einfügen" title="Einfügen">
						<Plus />
					</Button>
				{/snippet}
			</DropdownMenu.Trigger>
			<DropdownMenu.Content side="right" align="end">
				<DropdownMenu.Item onclick={onupload}
					><ImagePlus /> Bild oder Datei hochladen …</DropdownMenu.Item
				>
				<DropdownMenu.Item onclick={onlink}><Link2 /> Link …</DropdownMenu.Item>
				<DropdownMenu.Item onclick={() => onref()}
					><LayoutGrid /> Karte (Aktion, Termin, Aufgabe …) …</DropdownMenu.Item
				>
				<DropdownMenu.Item onclick={() => onref('file')}
					><FolderOpen /> Aus „Dateien“ …</DropdownMenu.Item
				>
			</DropdownMenu.Content>
		</DropdownMenu.Root>
	{/if}
</div>
