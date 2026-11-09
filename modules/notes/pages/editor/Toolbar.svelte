<script lang="ts">
	// Werkzeugleiste des Notiz-Editors (sticky, mobil waagrecht scrollbar). Zustände über `tick` (gedrosselt aus
	// `editor.on('transaction')`), nie aus einer Kopie des Inhalts.
	import type { Editor } from '@tiptap/core';
	import AlignCenter from '@lucide/svelte/icons/align-center';
	import AlignJustify from '@lucide/svelte/icons/align-justify';
	import AlignLeft from '@lucide/svelte/icons/align-left';
	import AlignRight from '@lucide/svelte/icons/align-right';
	import Baseline from '@lucide/svelte/icons/baseline';
	import Bold from '@lucide/svelte/icons/bold';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import Code from '@lucide/svelte/icons/code';
	import CodeXml from '@lucide/svelte/icons/code-xml';
	import Highlighter from '@lucide/svelte/icons/highlighter';
	import ImagePlus from '@lucide/svelte/icons/image-plus';
	import Italic from '@lucide/svelte/icons/italic';
	import LayoutTemplate from '@lucide/svelte/icons/layout-template';
	import Link from '@lucide/svelte/icons/link';
	import Sparkles from '@lucide/svelte/icons/sparkles';
	import List from '@lucide/svelte/icons/list';
	import ListChecks from '@lucide/svelte/icons/list-checks';
	import ListOrdered from '@lucide/svelte/icons/list-ordered';
	import Minus from '@lucide/svelte/icons/minus';
	import Quote from '@lucide/svelte/icons/quote';
	import Redo2 from '@lucide/svelte/icons/redo-2';
	import RemoveFormatting from '@lucide/svelte/icons/remove-formatting';
	import Strikethrough from '@lucide/svelte/icons/strikethrough';
	import Table from '@lucide/svelte/icons/table';
	import Underline from '@lucide/svelte/icons/underline';
	import Undo2 from '@lucide/svelte/icons/undo-2';
	import { Button } from '$lib/components/ui/button';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import * as Tooltip from '$lib/components/ui/tooltip';
	import { FONT_SIZES, HIGHLIGHT_COLORS, TEXT_COLORS } from '../../schemas';
	import { LIST_STYLE_OPTIONS, ownListStyle } from '../../doc/list-style';
	import ColorMenu from './ColorMenu.svelte';
	import { MOD } from './keys';
	import ToolButton from './ToolButton.svelte';

	let {
		editor,
		tick,
		canEdit,
		onlink,
		onliststyle,
		onimage,
		onembed,
		onassist
	}: {
		editor: Editor | null;
		tick: number;
		canEdit: boolean;
		onlink: () => void;
		/** Nummerierte Liste mit dieser Art (`null` = Standard) */
		onliststyle?: (style: string | null) => void;
		/** ohne Angabe kein Knopf (Gäste) */
		onimage?: () => void;
		onembed?: () => void;
		/** KI-Schreibhilfe (Auswahl überarbeiten bzw. an der Cursorposition schreiben); ohne Angabe kein Knopf */
		onassist?: () => void;
	} = $props();

	const off = $derived(!canEdit || !editor);

	const is = (name: string, attrs?: Record<string, unknown>) => {
		void tick;
		return editor?.isActive(name, attrs) ?? false;
	};
	const isAttr = (attrs: Record<string, unknown>) => {
		void tick;
		return editor?.isActive(attrs) ?? false;
	};
	const chain = () => editor!.chain().focus();
	const run = (fn: (c: ReturnType<typeof chain>) => { run: () => boolean }) => {
		if (!editor || !canEdit) return;
		fn(chain()).run();
	};

	const blockLabel = $derived.by(() => {
		void tick;
		for (const level of [1, 2, 3] as const)
			if (is('heading', { level })) return `Überschrift ${level}`;
		if (is('codeBlock')) return 'Code';
		return 'Text';
	});

	const fontSize = $derived.by(() => {
		void tick;
		const v = editor?.getAttributes('textStyle').fontSize as string | undefined;
		return v ? Number.parseInt(v, 10) : null;
	});

	const textColor = $derived.by(() => {
		void tick;
		return (editor?.getAttributes('textStyle').color as string | undefined) ?? null;
	});
	const highlight = $derived.by(() => {
		void tick;
		return (editor?.getAttributes('highlight').color as string | undefined) ?? null;
	});

	const align = $derived.by(() => {
		void tick;
		for (const a of ['center', 'right', 'justify'] as const) if (isAttr({ textAlign: a })) return a;
		return 'left';
	});
	const ALIGNS = [
		{ value: 'left', label: 'Linksbündig', icon: AlignLeft, key: `${MOD}+Umschalt+L` },
		{ value: 'center', label: 'Zentriert', icon: AlignCenter, key: `${MOD}+Umschalt+E` },
		{ value: 'right', label: 'Rechtsbündig', icon: AlignRight, key: `${MOD}+Umschalt+R` },
		{ value: 'justify', label: 'Blocksatz', icon: AlignJustify, key: `${MOD}+Umschalt+J` }
	] as const;
	const AlignIcon = $derived(ALIGNS.find((a) => a.value === align)?.icon ?? AlignLeft);

	const inTable = $derived(is('table'));
	/** Wirksame Nummerierungsart am Cursor (innerste geordnete Liste mit eigener Art, sonst Standard) */
	const listStyle = $derived.by(() => {
		void tick;
		if (!editor || !is('orderedList')) return null;
		const from = editor.state.selection.$from;
		for (let d = from.depth; d > 0; d--) {
			const node = from.node(d);
			if (node.type.name !== 'orderedList') continue;
			const own = ownListStyle(node.attrs);
			if (own) return own;
		}
		return 'decimal';
	});
	const canUndo = $derived.by(() => {
		void tick;
		return !!editor && canEdit && editor.can().undo();
	});
	const canRedo = $derived.by(() => {
		void tick;
		return !!editor && canEdit && editor.can().redo();
	});
</script>

<Tooltip.Provider delayDuration={500}>
	<div
		class="note-toolbar sticky top-0 z-20 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80"
		role="toolbar"
		aria-label="Formatierung"
	>
		<div class="flex items-center gap-0.5 overflow-x-auto px-2 py-1 [scrollbar-width:thin]">
			<ToolButton
				label="Rückgängig"
				shortcut={`${MOD}+Z`}
				icon={Undo2}
				disabled={!canUndo}
				onclick={() => run((c) => c.undo())}
			/>
			<ToolButton
				label="Wiederholen"
				shortcut={`${MOD}+Umschalt+Z`}
				icon={Redo2}
				disabled={!canRedo}
				onclick={() => run((c) => c.redo())}
			/>
			<span class="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden="true"></span>

			<DropdownMenu.Root>
				<DropdownMenu.Trigger disabled={off}>
					{#snippet child({ props })}
						<Button
							{...props}
							variant="ghost"
							size="sm"
							class="w-32 shrink-0 justify-between"
							aria-label={`Absatzformat: ${blockLabel}`}
						>
							<span class="truncate">{blockLabel}</span>
							<ChevronDown class="size-3.5 opacity-60" />
						</Button>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content align="start" class="w-52">
					<DropdownMenu.Item onclick={() => run((c) => c.setParagraph())}>
						Text <DropdownMenu.Shortcut>{MOD}+Alt+0</DropdownMenu.Shortcut>
					</DropdownMenu.Item>
					{#each [1, 2, 3] as const as level (level)}
						<DropdownMenu.Item onclick={() => run((c) => c.toggleHeading({ level }))}>
							<span
								class={level === 1
									? 'text-lg font-bold'
									: level === 2
										? 'text-base font-semibold'
										: 'text-sm font-semibold'}>Überschrift {level}</span
							>
							<DropdownMenu.Shortcut>{MOD}+Alt+{level}</DropdownMenu.Shortcut>
						</DropdownMenu.Item>
					{/each}
					<DropdownMenu.Item onclick={() => run((c) => c.toggleCodeBlock())}>
						Codeblock <DropdownMenu.Shortcut>{MOD}+Alt+C</DropdownMenu.Shortcut>
					</DropdownMenu.Item>
				</DropdownMenu.Content>
			</DropdownMenu.Root>

			<DropdownMenu.Root>
				<DropdownMenu.Trigger disabled={off}>
					{#snippet child({ props })}
						<Button
							{...props}
							variant="ghost"
							size="sm"
							class="w-16 shrink-0 justify-between tabular-nums"
							aria-label={`Schriftgröße: ${fontSize ?? 'Standard'}`}
						>
							{fontSize ?? '–'}
							<ChevronDown class="size-3.5 opacity-60" />
						</Button>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content align="start" class="w-36">
					<DropdownMenu.Item onclick={() => run((c) => c.unsetFontSize())}
						>Standard</DropdownMenu.Item
					>
					<DropdownMenu.Separator />
					{#each FONT_SIZES as size (size)}
						<DropdownMenu.Item onclick={() => run((c) => c.setFontSize(`${size}px`))}>
							<span class={fontSize === size ? 'font-semibold' : ''}>{size} px</span>
						</DropdownMenu.Item>
					{/each}
				</DropdownMenu.Content>
			</DropdownMenu.Root>
			<span class="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden="true"></span>

			<ToolButton
				label="Fett"
				shortcut={`${MOD}+B`}
				icon={Bold}
				active={is('bold')}
				disabled={off}
				onclick={() => run((c) => c.toggleBold())}
			/>
			<ToolButton
				label="Kursiv"
				shortcut={`${MOD}+I`}
				icon={Italic}
				active={is('italic')}
				disabled={off}
				onclick={() => run((c) => c.toggleItalic())}
			/>
			<ToolButton
				label="Unterstrichen"
				shortcut={`${MOD}+U`}
				icon={Underline}
				active={is('underline')}
				disabled={off}
				onclick={() => run((c) => c.toggleUnderline())}
			/>
			<ToolButton
				label="Durchgestrichen"
				shortcut={`${MOD}+Umschalt+S`}
				icon={Strikethrough}
				active={is('strike')}
				disabled={off}
				onclick={() => run((c) => c.toggleStrike())}
			/>
			<ToolButton
				label="Code"
				shortcut={`${MOD}+E`}
				icon={Code}
				active={is('code')}
				disabled={off}
				onclick={() => run((c) => c.toggleCode())}
			/>
			<ColorMenu
				label="Textfarbe"
				icon={Baseline}
				value={textColor}
				presets={[...TEXT_COLORS]}
				disabled={off}
				onpick={(color) => run((c) => (color ? c.setColor(color) : c.unsetColor()))}
			/>
			<ColorMenu
				label="Markierung"
				icon={Highlighter}
				value={highlight}
				presets={[...HIGHLIGHT_COLORS]}
				disabled={off}
				onpick={(color) => run((c) => (color ? c.setHighlight({ color }) : c.unsetHighlight()))}
			/>
			<span class="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden="true"></span>

			<DropdownMenu.Root>
				<DropdownMenu.Trigger disabled={off}>
					{#snippet child({ props })}
						<Button
							{...props}
							variant="ghost"
							size="sm"
							class="shrink-0 px-1.5 text-muted-foreground"
							aria-label="Ausrichtung"
							title="Ausrichtung"
						>
							<AlignIcon class="size-4" />
							<ChevronDown class="size-3 opacity-60" />
						</Button>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content align="start" class="w-56">
					{#each ALIGNS as a (a.value)}
						<DropdownMenu.Item onclick={() => run((c) => c.setTextAlign(a.value))}>
							<a.icon class="size-4" />
							<span class={align === a.value ? 'font-semibold' : ''}>{a.label}</span>
							<DropdownMenu.Shortcut>{a.key}</DropdownMenu.Shortcut>
						</DropdownMenu.Item>
					{/each}
				</DropdownMenu.Content>
			</DropdownMenu.Root>
			<ToolButton
				label="Aufzählung"
				shortcut={`${MOD}+Umschalt+8`}
				icon={List}
				active={is('bulletList')}
				disabled={off}
				onclick={() => run((c) => c.toggleBulletList())}
			/>
			<ToolButton
				label="Nummerierung"
				shortcut={`${MOD}+Umschalt+7`}
				icon={ListOrdered}
				active={is('orderedList')}
				disabled={off}
				onclick={() => run((c) => c.toggleOrderedList())}
			/>
			{#if onliststyle}
				<DropdownMenu.Root>
					<DropdownMenu.Trigger disabled={off}>
						{#snippet child({ props })}
							<Button
								{...props}
								variant="ghost"
								size="sm"
								class="-ml-0.5 h-8 w-5 shrink-0 px-0 text-muted-foreground"
								aria-label="Nummerierungsart"
								title="Nummerierungsart"
							>
								<ChevronDown class="size-3 opacity-60" />
							</Button>
						{/snippet}
					</DropdownMenu.Trigger>
					<DropdownMenu.Content align="start" class="w-64">
						<DropdownMenu.Label class="text-xs font-normal text-muted-foreground">
							Nummerierung – Unterpunkte mit Tab einrücken
						</DropdownMenu.Label>
						{#each LIST_STYLE_OPTIONS as o (o.value)}
							<DropdownMenu.Item onclick={() => onliststyle(o.value)}>
								<span class={listStyle === o.value ? 'font-semibold' : ''}>{o.label}</span>
								<span class="ml-auto font-mono text-xs text-muted-foreground">{o.example}</span>
							</DropdownMenu.Item>
						{/each}
					</DropdownMenu.Content>
				</DropdownMenu.Root>
			{/if}
			<ToolButton
				label="Aufgabenliste"
				shortcut={`${MOD}+Umschalt+9`}
				icon={ListChecks}
				active={is('taskList')}
				disabled={off}
				onclick={() => run((c) => c.toggleTaskList())}
			/>
			<ToolButton
				label="Zitat"
				shortcut={`${MOD}+Umschalt+B`}
				icon={Quote}
				active={is('blockquote')}
				disabled={off}
				onclick={() => run((c) => c.toggleBlockquote())}
			/>
			<ToolButton
				label="Codeblock"
				shortcut={`${MOD}+Alt+C`}
				icon={CodeXml}
				active={is('codeBlock')}
				disabled={off}
				onclick={() => run((c) => c.toggleCodeBlock())}
			/>
			<span class="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden="true"></span>

			<ToolButton
				label="Link"
				shortcut={`${MOD}+K`}
				icon={Link}
				active={is('link')}
				disabled={off}
				onclick={onlink}
			/>
			<DropdownMenu.Root>
				<DropdownMenu.Trigger disabled={off}>
					{#snippet child({ props })}
						<Button
							{...props}
							variant="ghost"
							size="sm"
							class={[
								'shrink-0 px-1.5',
								inTable ? 'bg-muted text-foreground' : 'text-muted-foreground'
							]}
							aria-label="Tabelle"
							title="Tabelle"
						>
							<Table class="size-4" />
							<ChevronDown class="size-3 opacity-60" />
						</Button>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content align="start" class="w-60">
					<DropdownMenu.Item
						onclick={() => run((c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }))}
					>
						Tabelle einfügen (3 × 3)
					</DropdownMenu.Item>
					{#if inTable}
						<DropdownMenu.Separator />
						<DropdownMenu.Item onclick={() => run((c) => c.addRowBefore())}
							>Zeile davor</DropdownMenu.Item
						>
						<DropdownMenu.Item onclick={() => run((c) => c.addRowAfter())}
							>Zeile danach</DropdownMenu.Item
						>
						<DropdownMenu.Item onclick={() => run((c) => c.deleteRow())}
							>Zeile löschen</DropdownMenu.Item
						>
						<DropdownMenu.Separator />
						<DropdownMenu.Item onclick={() => run((c) => c.addColumnBefore())}>
							Spalte davor
						</DropdownMenu.Item>
						<DropdownMenu.Item onclick={() => run((c) => c.addColumnAfter())}>
							Spalte danach
						</DropdownMenu.Item>
						<DropdownMenu.Item onclick={() => run((c) => c.deleteColumn())}>
							Spalte löschen
						</DropdownMenu.Item>
						<DropdownMenu.Separator />
						<DropdownMenu.Item onclick={() => run((c) => c.toggleHeaderRow())}>
							Kopfzeile umschalten
						</DropdownMenu.Item>
						<DropdownMenu.Item onclick={() => run((c) => c.mergeCells())}>
							Zellen verbinden
						</DropdownMenu.Item>
						<DropdownMenu.Item onclick={() => run((c) => c.splitCell())}
							>Zelle teilen</DropdownMenu.Item
						>
						<DropdownMenu.Separator />
						<DropdownMenu.Item variant="destructive" onclick={() => run((c) => c.deleteTable())}>
							Tabelle löschen
						</DropdownMenu.Item>
					{/if}
				</DropdownMenu.Content>
			</DropdownMenu.Root>
			{#if onimage}
				<ToolButton label="Bild einfügen" icon={ImagePlus} disabled={off} onclick={onimage} />
			{/if}
			<ToolButton
				label="Trennlinie"
				icon={Minus}
				disabled={off}
				onclick={() => run((c) => c.setHorizontalRule())}
			/>
			{#if onembed}
				<ToolButton
					label="Whiteboard o. Ä. einbetten"
					icon={LayoutTemplate}
					disabled={off}
					onclick={onembed}
				/>
			{/if}
			<span class="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden="true"></span>
			<ToolButton
				label="Formatierung entfernen"
				icon={RemoveFormatting}
				disabled={off}
				onclick={() => run((c) => c.unsetAllMarks().clearNodes())}
			/>
			{#if onassist}
				<span class="mx-1 h-5 w-px shrink-0 bg-border" aria-hidden="true"></span>
				<Button
					type="button"
					variant="ghost"
					size="sm"
					class="h-8 shrink-0 gap-1.5 px-2 text-link"
					disabled={off}
					onmousedown={(e) => e.preventDefault()}
					onclick={onassist}
				>
					<Sparkles class="size-4" aria-hidden="true" />
					<span>Schreibhilfe</span>
				</Button>
			{/if}
		</div>
	</div>
</Tooltip.Provider>
