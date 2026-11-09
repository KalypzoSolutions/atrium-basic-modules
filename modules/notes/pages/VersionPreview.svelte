<script lang="ts">
	// Schreibgeschützte Vorschau einer Version (eigener Tiptap ohne Collaboration)
	import { onMount } from 'svelte';
	import { Editor, type JSONContent } from '@tiptap/core';
	import { noteExtensions } from '../doc/extensions';
	import ListStyles from './editor/ListStyles.svelte';

	let { content }: { content: unknown } = $props();
	let element = $state<HTMLDivElement | null>(null);

	onMount(() => {
		if (!element) return;
		const editor = new Editor({
			element,
			editable: false,
			extensions: noteExtensions(),
			content: (content as JSONContent) ?? { type: 'doc', content: [] },
			editorProps: { attributes: { class: 'note-content', 'aria-label': 'Vorschau der Version' } }
		});
		return () => editor.destroy();
	});
</script>

<ListStyles />
<div bind:this={element} class="note-root note-preview"></div>

<style>
	.note-preview :global(.note-content) {
		outline: none;
		line-height: 1.6;
		overflow-wrap: anywhere;
	}
	.note-preview :global(.note-content > * + *) {
		margin-top: 0.5em;
	}
	.note-preview :global(h1) {
		font-size: 1.5rem;
		font-weight: 700;
	}
	.note-preview :global(h2) {
		font-size: 1.25rem;
		font-weight: 650;
	}
	.note-preview :global(h3) {
		font-size: 1.1rem;
		font-weight: 600;
	}
	.note-preview :global(ul) {
		list-style: disc;
		padding-left: 1.5rem;
	}
	.note-preview :global(ol) {
		list-style: decimal;
		padding-left: 1.5rem;
	}
	.note-preview :global(ul[data-type='taskList']) {
		list-style: none;
		padding-left: 0.25rem;
	}
	.note-preview :global(ul[data-type='taskList'] li) {
		display: flex;
		gap: 0.5rem;
	}
	.note-preview :global(blockquote) {
		border-left: 3px solid var(--border);
		padding-left: 1rem;
		color: var(--muted-foreground);
	}
	.note-preview :global(pre),
	.note-preview :global(code) {
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		background: var(--muted);
		border-radius: 0.25rem;
	}
	.note-preview :global(pre) {
		padding: 0.5rem 0.75rem;
		overflow-x: auto;
	}
	.note-preview :global(table) {
		border-collapse: collapse;
		width: 100%;
	}
	.note-preview :global(td),
	.note-preview :global(th) {
		border: 1px solid var(--border);
		padding: 0.25rem 0.5rem;
	}
	.note-preview :global(th) {
		background: var(--muted);
	}
	.note-preview :global(img) {
		max-width: 100%;
		height: auto;
	}
	.note-preview :global(a) {
		color: var(--link);
		text-decoration: underline;
	}
	.note-preview :global([data-embed]) {
		border: 1px dashed var(--border);
		border-radius: 0.5rem;
		padding: 0.75rem;
		color: var(--muted-foreground);
	}
	.note-preview :global([data-embed])::before {
		content: 'Eingebetteter Inhalt';
	}
</style>
