<script lang="ts">
	// Tiptap-Editor einer Notiz mit Yjs (Collaboration + Carets). Der Inhalt lebt NUR im Y.Doc/Editor – keine
	// Svelte-Kopie (große Dokumente); die Leisten lesen ihren Zustand über `tick` (gedrosselt per requestAnimationFrame).
	import { onMount, type Snippet } from 'svelte';
	import { goto } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { Editor } from '@tiptap/core';
	import Collaboration from '@tiptap/extension-collaboration';
	import { CollaborationCaret } from '@tiptap/extension-collaboration-caret';
	import { Placeholder } from '@tiptap/extensions';
	import { Markdown } from '@tiptap/markdown';
	import CodeXml from '@lucide/svelte/icons/code-xml';
	import FilePlus from '@lucide/svelte/icons/file-plus';
	import Heading1 from '@lucide/svelte/icons/heading-1';
	import Heading2 from '@lucide/svelte/icons/heading-2';
	import Heading3 from '@lucide/svelte/icons/heading-3';
	import ImagePlus from '@lucide/svelte/icons/image-plus';
	import List from '@lucide/svelte/icons/list';
	import ListChecks from '@lucide/svelte/icons/list-checks';
	import ListOrdered from '@lucide/svelte/icons/list-ordered';
	import ListTree from '@lucide/svelte/icons/list-tree';
	import Minus from '@lucide/svelte/icons/minus';
	import Pilcrow from '@lucide/svelte/icons/pilcrow';
	import Presentation from '@lucide/svelte/icons/presentation';
	import Quote from '@lucide/svelte/icons/quote';
	import Table from '@lucide/svelte/icons/table';
	import { contrastTextColor } from '$lib/components/ui/color-picker';
	import { noteExtensions, setListStyleAt } from '../../doc/extensions';
	import { MAX_ASSET_BYTES, YDOC_FIELD } from '../../schemas';
	import { errMsg, uploadAsset } from '../helpers';
	import BubbleMenu from './BubbleMenu.svelte';
	import EmbedPicker from './EmbedPicker.svelte';
	import LinkDialog from './LinkDialog.svelte';
	import { BrowserEmbed, browserImage, GuestEmbed } from './node-views.svelte';
	import SlashMenu, { type SlashItem } from './SlashMenu.svelte';
	import type { NoteSync } from './sync.svelte';
	import Sparkles from '@lucide/svelte/icons/sparkles';
	import Toolbar from './Toolbar.svelte';
	import ListStyles from './ListStyles.svelte';
	import NoteAssist from './NoteAssist.svelte';

	let {
		sync,
		noteId,
		canEdit,
		user,
		editor = $bindable(null),
		header,
		oncreatesubpage,
		guest
	}: {
		sync: NoteSync;
		noteId: string;
		canEdit: boolean;
		user: { name: string; color: string };
		editor?: Editor | null;
		/** Inhalt zwischen Werkzeugleiste und Text (Titel) */
		header?: Snippet;
		/** Unterseite anlegen → Titel und ID für den Link im Text */
		oncreatesubpage?: () => Promise<{ id: string; title: string } | null>;
		/**
		 * Gast über einen öffentlichen Link: nur Text – keine Bild-Uploads, Einbettungen, Unterseiten oder KI.
		 * `assetSrc` = Bildadresse über den Link, `openHref` öffnet interne Links (z. B. Unterseiten) auf der Link-Seite.
		 */
		guest?: {
			assetSrc: (assetId: string, variant: 'thumb' | 'web' | 'file') => string;
			openHref?: (href: string) => boolean;
		};
	} = $props();

	let element = $state<HTMLDivElement | null>(null);
	let assist = $state<NoteAssist | null>(null);
	/** Schreibhilfe freigegeben (Recht `notes.ai.use`, KI eingerichtet) und Notiz bearbeitbar */
	const assistOn = $derived(assist?.available() ?? false);
	let tick = $state(0);
	let frame = 0;
	let fileInput = $state<HTMLInputElement | null>(null);
	let linkOpen = $state(false);
	let linkInitial = $state('');
	let embedOpen = $state(false);
	let slash = $state<{ onKeyDown: (e: KeyboardEvent) => boolean } | null>(null);
	let pendingImageAt: number | undefined;

	const bump = () => {
		if (frame) return;
		frame = requestAnimationFrame(() => {
			frame = 0;
			tick++;
		});
	};

	/** Schema-Erweiterungen; Bild und Einbettung bekommen Browser-Verhalten (gleiche Knoten) */
	function extensions() {
		return noteExtensions({ resizableImages: true }).map((ext) =>
			ext.name === 'embed'
				? guest
					? GuestEmbed
					: BrowserEmbed
				: ext.name === 'image'
					? browserImage(guest?.assetSrc)
					: ext
		);
	}

	const imageFiles = (list: FileList | null | undefined) =>
		[...(list ?? [])].filter((f) => f.type.startsWith('image/'));

	async function insertImages(files: File[], at?: number) {
		if (!editor || !canEdit) return;
		if (guest) {
			toast.info('Über diesen Link kannst du keine Bilder hochladen.');
			return;
		}
		for (const file of files) {
			if (file.size > MAX_ASSET_BYTES) {
				toast.error(`„${file.name}“ ist zu groß (höchstens ${MAX_ASSET_BYTES / 1024 / 1024} MB).`);
				continue;
			}
			const id = toast.loading(`„${file.name}“ wird hochgeladen …`);
			try {
				const asset = await uploadAsset(noteId, file);
				if (!editor) return;
				const chain = editor.chain().focus();
				if (at !== undefined) chain.setTextSelection(Math.min(at, editor.state.doc.content.size));
				chain
					.insertContent({
						type: 'image',
						attrs: { assetId: asset.id, alt: file.name.replace(/\.[^.]+$/, '') }
					})
					.run();
				toast.success('Bild eingefügt', { id });
			} catch (e) {
				toast.error(errMsg(e, 'Bild konnte nicht hochgeladen werden'), { id });
			}
		}
	}

	const MD_HINT =
		/^(?:#{1,6}\s|[-*+]\s+\S|\d+[.)]\s+\S|>\s|```|\|.+\|\s*$|- \[[ xX]\]\s)|\*\*[^*\n]+\*\*|__[^_\n]+__|\[[^\]\n]+\]\([^)\s]+\)|`[^`\n]+`|~~[^~\n]+~~/m;

	function openLink() {
		if (!editor || !canEdit) return;
		linkInitial = (editor.getAttributes('link').href as string | undefined) ?? '';
		linkOpen = true;
	}

	function applyLink(href: string) {
		if (!editor) return;
		const chain = editor.chain().focus().extendMarkRange('link');
		if (!href) chain.unsetLink().run();
		else if (editor.state.selection.empty && !editor.isActive('link'))
			chain
				.insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] })
				.run();
		else chain.setLink({ href }).run();
	}

	function pickImage(at?: number) {
		pendingImageAt = at;
		fileInput?.click();
	}

	async function createSubpage() {
		if (!editor || !oncreatesubpage) return;
		const pos = editor.state.selection.from;
		const page = await oncreatesubpage();
		if (!page || !editor) return;
		editor
			.chain()
			.focus()
			.setTextSelection(Math.min(pos, editor.state.doc.content.size))
			.insertContent({
				type: 'paragraph',
				content: [
					{
						type: 'text',
						text: `📄 ${page.title || 'Ohne Titel'}`,
						marks: [{ type: 'link', attrs: { href: `/modules/notes/${page.id}`, target: null } }]
					}
				]
			})
			.run();
	}

	/** Geordnete Liste am Cursor mit Nummerierungsart (vorher in eine Liste umwandeln, falls nötig) */
	function orderedListWith(style: string | null) {
		if (!editor || !canEdit) return;
		if (!editor.isActive('orderedList')) editor.chain().focus().toggleOrderedList().run();
		setListStyleAt(editor, style);
		editor.commands.focus();
	}

	const slashItems: SlashItem[] = [
		{
			id: 'text',
			label: 'Text',
			description: 'Normaler Absatz',
			icon: Pilcrow,
			keywords: 'absatz paragraph',
			run: () => editor?.chain().focus().setParagraph().run()
		},
		{
			id: 'h1',
			label: 'Überschrift 1',
			description: 'Große Überschrift',
			icon: Heading1,
			keywords: 'h1 titel heading',
			run: () => editor?.chain().focus().setHeading({ level: 1 }).run()
		},
		{
			id: 'h2',
			label: 'Überschrift 2',
			description: 'Mittlere Überschrift',
			icon: Heading2,
			keywords: 'h2 heading',
			run: () => editor?.chain().focus().setHeading({ level: 2 }).run()
		},
		{
			id: 'h3',
			label: 'Überschrift 3',
			description: 'Kleine Überschrift',
			icon: Heading3,
			keywords: 'h3 heading',
			run: () => editor?.chain().focus().setHeading({ level: 3 }).run()
		},
		{
			id: 'bullet',
			label: 'Aufzählung',
			description: 'Liste mit Punkten',
			icon: List,
			keywords: 'liste bullet ul',
			run: () => editor?.chain().focus().toggleBulletList().run()
		},
		{
			id: 'ordered',
			label: 'Nummerierung',
			description: 'Nummerierte Liste',
			icon: ListOrdered,
			keywords: 'liste nummer ol',
			run: () => editor?.chain().focus().toggleOrderedList().run()
		},
		{
			id: 'outline',
			label: 'Gliederung',
			description: 'Nummerierte Liste 1. 1.1. 1.1.1. (mit Tab einrücken)',
			icon: ListTree,
			keywords: 'liste nummer gliederung outline 1.1',
			run: () => orderedListWith('outline')
		},
		{
			id: 'tasks',
			label: 'Aufgabenliste',
			description: 'Liste mit Kästchen zum Abhaken',
			icon: ListChecks,
			keywords: 'todo checkliste aufgaben',
			run: () => editor?.chain().focus().toggleTaskList().run()
		},
		{
			id: 'quote',
			label: 'Zitat',
			description: 'Hervorgehobenes Zitat',
			icon: Quote,
			keywords: 'blockquote',
			run: () => editor?.chain().focus().toggleBlockquote().run()
		},
		{
			id: 'code',
			label: 'Codeblock',
			description: 'Code in fester Schriftbreite',
			icon: CodeXml,
			keywords: 'code pre',
			run: () => editor?.chain().focus().toggleCodeBlock().run()
		},
		{
			id: 'table',
			label: 'Tabelle',
			description: 'Tabelle mit 3 × 3 Zellen',
			icon: Table,
			keywords: 'table raster',
			run: () =>
				editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()
		},
		{
			id: 'image',
			label: 'Bild',
			description: 'Bild hochladen',
			icon: ImagePlus,
			keywords: 'foto image bild',
			run: () => pickImage()
		},
		{
			id: 'hr',
			label: 'Trennlinie',
			description: 'Waagrechte Linie',
			icon: Minus,
			keywords: 'linie hr trenner',
			run: () => editor?.chain().focus().setHorizontalRule().run()
		},
		{
			id: 'embed',
			label: 'Whiteboard einbetten',
			description: 'Whiteboard live in der Notiz',
			icon: Presentation,
			keywords: 'whiteboard einbetten embed',
			run: () => (embedOpen = true)
		},
		{
			id: 'subpage',
			label: 'Unterseite',
			description: 'Neue Seite unter dieser anlegen',
			icon: FilePlus,
			keywords: 'seite page unterseite',
			run: () => void createSubpage()
		}
	];
	/** Slash-Menü mit Schreibhilfe, wenn sie freigegeben ist (Gäste: ohne Bild, Einbettung, Unterseite) */
	const GUEST_HIDDEN = new Set(['image', 'embed', 'subpage']);
	const slashWithAssist = $derived<SlashItem[]>(
		guest
			? slashItems.filter((i) => !GUEST_HIDDEN.has(i.id))
			: assistOn
				? [
						...slashItems,
						{
							id: 'assist',
							label: 'Schreibhilfe',
							description: 'Entwurf, Zusammenfassung, Fortsetzung oder Aufgaben mit KI',
							icon: Sparkles,
							keywords: 'ki ai schreiben zusammenfassen assistent',
							run: () => assist?.start()
						}
					]
				: slashItems
	);

	onMount(() => {
		if (!element) return;
		const instance = new Editor({
			element,
			editable: canEdit,
			extensions: [
				...extensions(),
				Collaboration.configure({ document: sync.doc, field: YDOC_FIELD }),
				CollaborationCaret.configure({
					provider: { awareness: sync.awareness },
					user: { name: user.name, color: user.color },
					render: (u: Record<string, unknown>) => {
						const color = typeof u.color === 'string' ? u.color : '#6b7280';
						const caret = document.createElement('span');
						caret.classList.add('collaboration-carets__caret');
						caret.style.borderColor = color;
						const label = document.createElement('div');
						label.classList.add('collaboration-carets__label');
						label.style.backgroundColor = color;
						label.style.color = contrastTextColor(color);
						label.textContent = typeof u.name === 'string' ? u.name : 'Unbekannt';
						caret.append(label);
						return caret;
					}
				}),
				Placeholder.configure({
					placeholder: ({ node, pos }) =>
						pos === 0 && node.type.name === 'paragraph'
							? 'Schreibe etwas oder tippe / für Befehle …'
							: node.type.name === 'heading'
								? 'Überschrift'
								: ''
				}),
				Markdown
			],
			editorProps: {
				attributes: {
					class: 'note-content',
					role: 'textbox',
					'aria-multiline': 'true',
					'aria-label': 'Inhalt der Notiz',
					spellcheck: 'true'
				},
				handleKeyDown: (_view, event) => {
					if (slash?.onKeyDown(event)) {
						event.preventDefault();
						return true;
					}
					if (
						(event.ctrlKey || event.metaKey) &&
						!event.altKey &&
						event.key.toLowerCase() === 'k'
					) {
						event.preventDefault();
						openLink();
						return true;
					}
					return false;
				},
				handlePaste: (_view, event) => {
					if (!canEdit) return false;
					const files = imageFiles(event.clipboardData?.files);
					if (files.length) {
						void insertImages(files);
						return true;
					}
					const html = event.clipboardData?.getData('text/html');
					const text = event.clipboardData?.getData('text/plain') ?? '';
					if (!html && text && MD_HINT.test(text) && !instance.isActive('codeBlock')) {
						instance.commands.insertContent(text, { contentType: 'markdown' });
						return true;
					}
					return false;
				},
				handleDrop: (view, event, _slice, moved) => {
					if (moved || !canEdit) return false;
					const files = imageFiles(event.dataTransfer?.files);
					if (!files.length) return false;
					event.preventDefault();
					const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
					void insertImages(files, pos);
					return true;
				},
				handleDOMEvents: {
					click: (_view, event) => {
						const a = (event.target as HTMLElement | null)?.closest('a[href]');
						if (!a) return false;
						const href = a.getAttribute('href') ?? '';
						if (!(event.ctrlKey || event.metaKey || !instance.isEditable)) return false;
						event.preventDefault();
						if (guest?.openHref?.(href)) return true;
						if (href.startsWith('/') && !href.startsWith('//')) void goto(href);
						else if (/^(https?:|mailto:)/i.test(href)) window.open(href, '_blank', 'noopener');
						return true;
					}
				}
			},
			onTransaction: bump,
			onFocus: bump,
			onBlur: bump
		});
		editor = instance;
		return () => {
			if (frame) cancelAnimationFrame(frame);
			instance.destroy();
			editor = null;
		};
	});

	$effect(() => {
		const ed = editor;
		const editable = canEdit;
		if (ed && ed.isEditable !== editable) {
			ed.setEditable(editable, false);
			bump();
		}
	});

	export function focusStart() {
		editor?.chain().focus('start').run();
	}
</script>

<div class="note-editor flex min-h-full flex-col">
	<Toolbar
		{editor}
		{tick}
		{canEdit}
		onlink={openLink}
		onliststyle={orderedListWith}
		onimage={guest ? undefined : () => pickImage()}
		onembed={guest ? undefined : () => (embedOpen = true)}
		onassist={assistOn ? () => assist?.start() : undefined}
	/>
	<div class="mx-auto w-full max-w-[52rem] flex-1 px-4 pt-8 pb-32 sm:px-10">
		{@render header?.()}
		<div bind:this={element} class="note-root"></div>
	</div>
</div>

<ListStyles />
<SlashMenu bind:this={slash} {editor} {tick} items={slashWithAssist} />
<BubbleMenu
	{editor}
	{tick}
	onlink={openLink}
	onassist={assistOn ? () => assist?.start() : undefined}
/>
{#if !guest}
	<NoteAssist bind:this={assist} {editor} {noteId} {canEdit} />
{/if}
<LinkDialog bind:open={linkOpen} initial={linkInitial} onapply={applyLink} />
{#if !guest}
	<EmbedPicker
		bind:open={embedOpen}
		onpick={(ref) =>
			editor
				?.chain()
				.focus()
				.insertContent({ type: 'embed', attrs: { ...ref } })
				.run()}
	/>
{/if}
<input
	bind:this={fileInput}
	type="file"
	accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
	multiple
	class="hidden"
	onchange={(e) => {
		const input = e.currentTarget as HTMLInputElement;
		const files = imageFiles(input.files);
		input.value = '';
		void insertImages(files, pendingImageAt);
		pendingImageAt = undefined;
	}}
/>

<style>
	.note-root :global(.note-content) {
		outline: none;
		min-height: 40dvh;
		font-size: 1rem;
		line-height: 1.7;
		color: var(--foreground);
		overflow-wrap: anywhere;
	}
	/*
	 * Bewusst KEIN `content-visibility: auto` für die Blöcke: Safari (iPad/iPhone) zeichnet übersprungene Blöcke in
	 * einem contenteditable nach Änderungen (z. B. Enter → neue Zeile) nicht neu – Zeilen verschwanden; außerdem
	 * schneidet es das Namensschild fremder Cursor ab.
	 */
	.note-root :global(.note-content > * + *) {
		margin-top: 0.6em;
	}
	.note-root :global(.note-content h1) {
		font-size: 1.875rem;
		font-weight: 700;
		line-height: 1.25;
		margin-top: 1.4em;
	}
	.note-root :global(.note-content h2) {
		font-size: 1.5rem;
		font-weight: 650;
		line-height: 1.3;
		margin-top: 1.3em;
	}
	.note-root :global(.note-content h3) {
		font-size: 1.2rem;
		font-weight: 600;
		line-height: 1.35;
		margin-top: 1.1em;
	}
	.note-root :global(.note-content > :first-child) {
		margin-top: 0;
	}
	.note-root :global(.note-content a) {
		color: var(--link);
		text-decoration: underline;
		text-underline-offset: 2px;
		cursor: pointer;
	}
	.note-root :global(.note-content ul) {
		list-style: disc;
		padding-left: 1.5rem;
	}
	.note-root :global(.note-content ol) {
		list-style: decimal;
		padding-left: 1.5rem;
	}
	.note-root :global(.note-content li > p) {
		margin: 0.15em 0;
	}
	.note-root :global(.note-content ul[data-type='taskList']) {
		list-style: none;
		padding-left: 0.25rem;
	}
	.note-root :global(.note-content ul[data-type='taskList'] li) {
		display: flex;
		align-items: flex-start;
		gap: 0.5rem;
	}
	.note-root :global(.note-content ul[data-type='taskList'] li > label) {
		flex: none;
		margin-top: 0.3em;
		user-select: none;
	}
	.note-root :global(.note-content ul[data-type='taskList'] li > div) {
		flex: 1;
		min-width: 0;
	}
	.note-root :global(.note-content ul[data-type='taskList'] input[type='checkbox']) {
		width: 1rem;
		height: 1rem;
		accent-color: var(--primary);
		cursor: pointer;
	}
	.note-root :global(.note-content li[data-checked='true'] > div) {
		color: var(--muted-foreground);
		text-decoration: line-through;
	}
	.note-root :global(.note-content blockquote) {
		border-left: 3px solid var(--border);
		padding-left: 1rem;
		color: var(--muted-foreground);
	}
	.note-root :global(.note-content code) {
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 0.875em;
		background: var(--muted);
		border-radius: 0.25rem;
		padding: 0.1em 0.3em;
	}
	.note-root :global(.note-content pre) {
		font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
		font-size: 0.875rem;
		line-height: 1.55;
		background: var(--muted);
		border: 1px solid var(--border);
		border-radius: 0.5rem;
		padding: 0.75rem 1rem;
		overflow-x: auto;
	}
	.note-root :global(.note-content pre code) {
		background: none;
		padding: 0;
		font-size: inherit;
	}
	.note-root :global(.note-content hr) {
		border: none;
		border-top: 1px solid var(--border);
		margin: 1.5em 0;
	}
	.note-root :global(.note-content hr.ProseMirror-selectednode) {
		border-top-color: var(--ring);
	}
	.note-root :global(.note-content mark) {
		border-radius: 0.15rem;
		padding: 0 0.1em;
		color: inherit;
	}
	/* Tabellen */
	.note-root :global(.note-content .tableWrapper) {
		overflow-x: auto;
		margin: 1em 0;
	}
	.note-root :global(.note-content table) {
		border-collapse: collapse;
		table-layout: fixed;
		width: 100%;
		overflow: hidden;
	}
	.note-root :global(.note-content td),
	.note-root :global(.note-content th) {
		border: 1px solid var(--border);
		padding: 0.35rem 0.6rem;
		vertical-align: top;
		position: relative;
		min-width: 4rem;
		box-sizing: border-box;
	}
	.note-root :global(.note-content th) {
		background: var(--muted);
		font-weight: 600;
		text-align: left;
	}
	.note-root :global(.note-content td > p),
	.note-root :global(.note-content th > p) {
		margin: 0;
	}
	.note-root :global(.note-content .selectedCell::after) {
		content: '';
		position: absolute;
		inset: 0;
		background: color-mix(in srgb, var(--primary) 15%, transparent);
		pointer-events: none;
	}
	.note-root :global(.note-content .column-resize-handle) {
		position: absolute;
		top: 0;
		bottom: -1px;
		right: -2px;
		width: 4px;
		background: var(--ring);
		pointer-events: none;
	}
	.note-root :global(.note-content.resize-cursor) {
		cursor: col-resize;
	}
	/* Bilder (Tiptap-Größenänderung) */
	.note-root :global(.note-content img) {
		max-width: 100%;
		height: auto;
		border-radius: 0.375rem;
	}
	.note-root :global(.note-content [data-resize-container]) {
		position: relative;
		display: inline-block;
		max-width: 100%;
	}
	.note-root :global(.note-content [data-resize-handle]) {
		position: absolute;
		width: 0.75rem;
		height: 0.75rem;
		background: var(--background);
		border: 2px solid var(--ring);
		border-radius: 999px;
		opacity: 0;
		transition: opacity 0.15s;
		z-index: 2;
	}
	.note-root :global(.note-content [data-resize-container]:hover [data-resize-handle]),
	.note-root :global(.note-content .ProseMirror-selectednode [data-resize-handle]),
	.note-root :global(.note-content [data-resize-state='true'] [data-resize-handle]) {
		opacity: 1;
	}
	.note-root :global(.note-content [data-resize-handle='top-left']) {
		top: -0.375rem;
		left: -0.375rem;
		cursor: nwse-resize;
	}
	.note-root :global(.note-content [data-resize-handle='top-right']) {
		top: -0.375rem;
		right: -0.375rem;
		cursor: nesw-resize;
	}
	.note-root :global(.note-content [data-resize-handle='bottom-left']) {
		bottom: -0.375rem;
		left: -0.375rem;
		cursor: nesw-resize;
	}
	.note-root :global(.note-content [data-resize-handle='bottom-right']) {
		bottom: -0.375rem;
		right: -0.375rem;
		cursor: nwse-resize;
	}
	.note-root :global(.note-content img.ProseMirror-selectednode),
	.note-root :global(.note-content .ProseMirror-selectednode img) {
		outline: 2px solid var(--ring);
		outline-offset: 2px;
	}
	/* Platzhalter */
	.note-root :global(.note-content .is-empty::before),
	.note-root :global(.note-content .is-editor-empty:first-child::before) {
		content: attr(data-placeholder);
		color: var(--muted-foreground);
		opacity: 0.7;
		float: left;
		height: 0;
		pointer-events: none;
	}
	.note-root :global(.note-content ::selection) {
		background: color-mix(in srgb, var(--primary) 25%, transparent);
	}
	/* Cursor anderer Personen */
	.note-root :global(.collaboration-carets__caret) {
		border-left: 1px solid;
		border-right: 1px solid;
		margin-left: -1px;
		margin-right: -1px;
		pointer-events: none;
		position: relative;
		word-break: normal;
	}
	/* Namensschild direkt über dem Cursor – unabhängig von Schriftgröße/Formatierung der Zeile */
	.note-root :global(.collaboration-carets__label) {
		position: absolute;
		bottom: 100%;
		left: -1px;
		z-index: 20;
		max-width: 12rem;
		overflow: hidden;
		text-overflow: ellipsis;
		border-radius: 0.25rem 0.25rem 0.25rem 0;
		font-family: var(--font-sans, ui-sans-serif, system-ui, sans-serif);
		font-size: 0.75rem;
		font-style: normal;
		font-weight: 600;
		letter-spacing: normal;
		line-height: 1.25;
		text-decoration: none;
		text-transform: none;
		padding: 0.125rem 0.375rem;
		box-shadow: 0 1px 2px rgb(0 0 0 / 0.25);
		user-select: none;
		white-space: nowrap;
	}
	.note-root :global(.collaboration-carets__selection) {
		opacity: 0.85;
	}
	.note-root :global(.note-embed) {
		display: block;
	}
	.note-root :global(.ProseMirror-gapcursor::after) {
		border-top-color: var(--foreground);
	}
</style>
