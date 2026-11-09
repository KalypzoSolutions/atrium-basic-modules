<script lang="ts">
	// Schwebende Leiste bei Textauswahl (ohne @tiptap/extension-bubble-menu): Position aus `coordsAtPos`
	import type { Editor } from '@tiptap/core';
	import { TextSelection } from '@tiptap/pm/state';
	import Baseline from '@lucide/svelte/icons/baseline';
	import Bold from '@lucide/svelte/icons/bold';
	import Highlighter from '@lucide/svelte/icons/highlighter';
	import Italic from '@lucide/svelte/icons/italic';
	import Link from '@lucide/svelte/icons/link';
	import Sparkles from '@lucide/svelte/icons/sparkles';
	import Strikethrough from '@lucide/svelte/icons/strikethrough';
	import Underline from '@lucide/svelte/icons/underline';
	import { Button } from '$lib/components/ui/button';
	import { HIGHLIGHT_COLORS, TEXT_COLORS } from '../../schemas';
	import ColorMenu from './ColorMenu.svelte';

	let {
		editor,
		tick,
		onlink,
		onassist
	}: {
		editor: Editor | null;
		tick: number;
		onlink: () => void;
		/** Schreibhilfe für die Auswahl (nur, wenn verfügbar) */
		onassist?: () => void;
	} = $props();

	let menuOpen = $state(false);

	const position = $derived.by(() => {
		void tick;
		if (!editor || !editor.isEditable) return null;
		const sel = editor.state.selection;
		if (!(sel instanceof TextSelection) || sel.empty) return null;
		if (!editor.isFocused && !menuOpen) return null;
		if (sel.$from.parent.type.spec.code) return null;
		try {
			const a = editor.view.coordsAtPos(sel.from);
			const b = editor.view.coordsAtPos(sel.to);
			const top = Math.min(a.top, b.top);
			const center = a.top === b.top ? (a.left + b.right) / 2 : a.left;
			return {
				left: Math.max(8, Math.min(center - 130, window.innerWidth - 268)),
				top: top > 60 ? top - 46 : Math.max(a.bottom, b.bottom) + 8
			};
		} catch {
			return null;
		}
	});

	const is = (name: string) => {
		void tick;
		return editor?.isActive(name) ?? false;
	};
	const color = $derived.by(() => {
		void tick;
		return (editor?.getAttributes('textStyle').color as string | undefined) ?? null;
	});
	const highlight = $derived.by(() => {
		void tick;
		return (editor?.getAttributes('highlight').color as string | undefined) ?? null;
	});

	type Mark = 'bold' | 'italic' | 'underline' | 'strike';
	const MARKS: { name: Mark; label: string; icon: typeof Bold }[] = [
		{ name: 'bold', label: 'Fett', icon: Bold },
		{ name: 'italic', label: 'Kursiv', icon: Italic },
		{ name: 'underline', label: 'Unterstrichen', icon: Underline },
		{ name: 'strike', label: 'Durchgestrichen', icon: Strikethrough }
	];

	function toggle(name: Mark) {
		const c = editor?.chain().focus();
		if (!c) return;
		if (name === 'bold') c.toggleBold().run();
		else if (name === 'italic') c.toggleItalic().run();
		else if (name === 'underline') c.toggleUnderline().run();
		else c.toggleStrike().run();
	}
</script>

{#if position}
	<div
		class="fixed z-40 flex items-center gap-0.5 rounded-lg border bg-popover p-1 text-popover-foreground shadow-md"
		style:left={`${position.left}px`}
		style:top={`${position.top}px`}
		role="toolbar"
		aria-label="Auswahl formatieren"
		tabindex="-1"
		onmousedown={(e) => {
			// Fokus und Auswahl im Editor behalten
			if (!(e.target as HTMLElement).closest('[data-keep-focus]')) e.preventDefault();
		}}
	>
		{#each MARKS as m (m.name)}
			<Button
				type="button"
				variant="ghost"
				size="icon-xs"
				class={is(m.name) ? 'bg-muted text-foreground' : 'text-muted-foreground'}
				aria-label={m.label}
				aria-pressed={is(m.name)}
				title={m.label}
				onclick={() => toggle(m.name)}
			>
				<m.icon class="size-3.5" />
			</Button>
		{/each}
		<Button
			type="button"
			variant="ghost"
			size="icon-xs"
			class={is('link') ? 'bg-muted text-foreground' : 'text-muted-foreground'}
			aria-label="Link"
			title="Link"
			onclick={onlink}
		>
			<Link class="size-3.5" />
		</Button>
		{#if onassist}
			<Button
				type="button"
				variant="ghost"
				size="icon-xs"
				class="text-link"
				aria-label="Schreibhilfe für die Auswahl"
				title="Schreibhilfe für die Auswahl"
				onclick={onassist}
			>
				<Sparkles class="size-3.5" />
			</Button>
		{/if}
		<span class="mx-0.5 h-4 w-px bg-border" aria-hidden="true"></span>
		<ColorMenu
			label="Textfarbe"
			icon={Baseline}
			size="xs"
			value={color}
			presets={[...TEXT_COLORS]}
			onopenchange={(o) => (menuOpen = o)}
			onpick={(c) => {
				const ch = editor?.chain().focus();
				if (ch) (c ? ch.setColor(c) : ch.unsetColor()).run();
			}}
		/>
		<ColorMenu
			label="Markierung"
			icon={Highlighter}
			size="xs"
			value={highlight}
			presets={[...HIGHLIGHT_COLORS]}
			onopenchange={(o) => (menuOpen = o)}
			onpick={(c) => {
				const ch = editor?.chain().focus();
				if (ch) (c ? ch.setHighlight({ color: c }) : ch.unsetHighlight()).run();
			}}
		/>
	</div>
{/if}
