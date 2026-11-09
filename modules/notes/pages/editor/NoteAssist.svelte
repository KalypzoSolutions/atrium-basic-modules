<script lang="ts">
	// KI-Schreibhilfe im Notiz-Editor. Mit Auswahl: markierten Abschnitt überarbeiten und ersetzen.
	// Ohne Auswahl: ganze Notiz als Grundlage (Klartext) – Entwurf, Zusammenfassung, Fortsetzung oder
	// Aufgabenliste werden an der Cursorposition eingefügt. Nie die ganze Notiz ersetzen: andere bearbeiten live mit.
	import { getHTMLFromFragment, type Editor } from '@tiptap/core';
	import { TextSelection } from '@tiptap/pm/state';
	import { assistPurpose, WritingAssistant, type AssistConfig } from '$lib/components/layout';

	/** Höchstlänge des Textes, der an die KI geht (Server erlaubt 20 000 Zeichen) */
	const NOTE_ASSIST_MAX = 18_000;

	let { editor, noteId, canEdit }: { editor: Editor | null; noteId: string; canEdit: boolean } =
		$props();

	const context = $derived({ module: 'notes', kind: 'note', id: noteId });
	const selectionConfig = $derived<AssistConfig>({
		module: 'notes',
		purpose: 'note-selection',
		context
	});
	const writeConfig = $derived<AssistConfig>({ module: 'notes', purpose: 'note-write', context });
	const selHandle = assistPurpose(() => selectionConfig);
	const writeHandle = assistPurpose(() => writeConfig);

	/** Schreibhilfe überhaupt verfügbar (Recht + Einrichtung) */
	export const available = () => canEdit && !!(selHandle.info || writeHandle.info);

	let open = $state(false);
	let mode = $state<'selection' | 'write'>('write');
	let text = $state('');
	let notice = $state<string | undefined>(undefined);

	const handle = $derived(mode === 'selection' ? selHandle : writeHandle);
	const config = $derived(mode === 'selection' ? selectionConfig : writeConfig);

	/** Blatt öffnen; mit nicht leerer Auswahl im Auswahl-Modus */
	export function start() {
		if (!editor || !canEdit) return;
		const sel = editor.state.selection;
		const hasSelection = sel instanceof TextSelection && !sel.empty && !!selHandle.info;
		notice = undefined;
		if (hasSelection) {
			mode = 'selection';
			const slice = sel.content();
			text = getHTMLFromFragment(slice.content, editor.schema).slice(0, 19_500);
			let special = false;
			slice.content.descendants((node) => {
				if (['image', 'embed', 'codeBlock'].includes(node.type.name)) special = true;
			});
			if (special) {
				notice =
					'Die Auswahl enthält Bilder, eingebettete Inhalte oder Code. Diese bleiben beim Ersetzen nicht erhalten – lieber nur den Text markieren.';
			}
		} else if (writeHandle.info) {
			mode = 'write';
			text = editor.getText({ blockSeparator: '\n\n' }).slice(0, NOTE_ASSIST_MAX);
		} else {
			return;
		}
		open = true;
	}

	function escape(s: string): string {
		return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
	}

	function apply(html: string) {
		if (!editor) return;
		if (mode === 'selection') {
			// ersetzt die (von Yjs mitgeführte) Auswahl; ein Schritt für Rückgängig
			editor.chain().focus().insertContent(html).run();
		} else {
			const at = editor.state.selection.to;
			editor.chain().focus().setTextSelection(at).insertContent(html).run();
		}
	}

	function applyItems(items: string[]) {
		if (!editor || !items.length) return;
		const list = `<ul data-type="taskList">${items
			.map((i) => `<li data-type="taskItem" data-checked="false"><p>${escape(i)}</p></li>`)
			.join('')}</ul>`;
		const at = editor.state.selection.to;
		editor.chain().focus().setTextSelection(at).insertContent(list).run();
	}
</script>

{#if handle.info}
	<WritingAssistant
		bind:open
		{config}
		info={handle.info}
		address={handle.status?.address}
		{text}
		compare={mode === 'selection'}
		applyLabel={mode === 'selection' ? 'Ersetzen' : 'Einfügen'}
		{notice}
		onapply={apply}
		onitems={applyItems}
	/>
{/if}
