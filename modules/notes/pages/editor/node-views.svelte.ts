/**
 * Browser-Verhalten für die Schema-Knoten (ohne das Schema zu ändern): Node-View für `embed` (Svelte-Komponente
 * per `mount`) und Bildadresse aus der Asset-ID (damit die Tiptap-Größenänderung ein `src` bekommt).
 */
import { mount, unmount } from 'svelte';
import type { NodeViewRendererProps } from '@tiptap/core';
import type { Node as PmNode } from '@tiptap/pm/model';
import { assetUrl, Embed, isUuid, noteImage } from '../../doc/extensions';
import { DEFAULT_EMBED_HEIGHT } from '../../schemas';
import EmbedView from './EmbedView.svelte';

export const BrowserEmbed = Embed.extend({
	addNodeView() {
		return (props: NodeViewRendererProps) => createEmbedView(props);
	}
});

/**
 * Gäste (öffentlicher Link): Einbettungen nur als Hinweis – die Einbett-Seiten der anderen Module brauchen ein Konto.
 */
export const GuestEmbed = Embed.extend({
	addNodeView() {
		return () => {
			const dom = document.createElement('div');
			dom.className =
				'note-embed my-2 rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground';
			dom.contentEditable = 'false';
			dom.textContent = 'Eingebetteter Inhalt – nur für angemeldete Personen sichtbar';
			return { dom, ignoreMutation: () => true };
		};
	}
});

/** Bild: `src` für die Darstellung aus der Asset-ID (das Dokument speichert nur die ID) */
export function browserImage(
	src: (assetId: string, variant: 'thumb' | 'web' | 'file') => string = assetUrl
) {
	return noteImage({ resizableImages: true }).extend({
		addAttributes() {
			const parent = (this.parent?.() ?? {}) as Record<string, Record<string, unknown>>;
			return {
				...parent,
				assetId: {
					...parent.assetId,
					renderHTML: (attrs: Record<string, unknown>) =>
						isUuid(attrs.assetId)
							? { 'data-asset-id': attrs.assetId, src: src(attrs.assetId, 'web') }
							: {}
				}
			};
		}
	});
}

function createEmbedView({ node, getPos, editor }: NodeViewRendererProps) {
	const dom = document.createElement('div');
	dom.className = 'note-embed';
	dom.contentEditable = 'false';

	const state = $state({
		attrs: { ...(node.attrs as Record<string, unknown>) },
		editable: editor.isEditable,
		selected: false
	});

	const posOf = () => {
		const pos = typeof getPos === 'function' ? getPos() : undefined;
		return typeof pos === 'number' ? pos : null;
	};

	const component = mount(EmbedView, {
		target: dom,
		props: {
			get module() {
				return (state.attrs.module as string | null) ?? null;
			},
			get kind() {
				return (state.attrs.kind as string | null) ?? null;
			},
			get refId() {
				return (state.attrs.refId as string | null) ?? null;
			},
			get height() {
				return Number(state.attrs.height) || DEFAULT_EMBED_HEIGHT;
			},
			get editable() {
				return state.editable;
			},
			get selected() {
				return state.selected;
			},
			onheight: (h: number) => {
				const pos = posOf();
				if (pos === null || !editor.isEditable) return;
				editor
					.chain()
					.command(({ tr }) => {
						tr.setNodeAttribute(pos, 'height', h);
						return true;
					})
					.run();
			},
			onremove: () => {
				const pos = posOf();
				if (pos === null || !editor.isEditable) return;
				const current = editor.state.doc.nodeAt(pos);
				if (!current) return;
				editor
					.chain()
					.focus()
					.deleteRange({ from: pos, to: pos + current.nodeSize })
					.run();
			}
		}
	});

	const syncEditable = () => {
		if (state.editable !== editor.isEditable) state.editable = editor.isEditable;
	};
	editor.on('transaction', syncEditable);
	editor.on('update', syncEditable);

	return {
		dom,
		update(next: PmNode) {
			if (next.type.name !== 'embed') return false;
			state.attrs = { ...(next.attrs as Record<string, unknown>) };
			syncEditable();
			return true;
		},
		selectNode() {
			state.selected = true;
		},
		deselectNode() {
			state.selected = false;
		},
		// Klicks/Tasten im iframe, auf Knöpfen und am Höhengriff gehören der Ansicht, nicht dem Editor
		stopEvent(event: Event) {
			const target = event.target as HTMLElement | null;
			if (!target) return false;
			if (event.type === 'dragstart' || event.type === 'drop' || event.type === 'dragover')
				return false;
			return !!target.closest('button, a, iframe, [role="slider"]');
		},
		ignoreMutation() {
			return true;
		},
		destroy() {
			editor.off('transaction', syncEditable);
			editor.off('update', syncEditable);
			void unmount(component);
		}
	};
}
