<script lang="ts">
	// Export: PNG, SVG, PDF (ganzes Board, Auswahl, ein Rahmen oder jeder Rahmen als Seite) und Archiv (.epwhiteboard)
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { todayBerlin } from '$lib/sdk/dates';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { SegmentedSlider } from '$lib/components/ui/segmented-slider';
	import { SelectField } from '$lib/components/ui/select-field';
	import { FormField } from '$lib/components/layout';
	import { API_BASE, type WbElement } from '../../schemas';
	import { downloadBlob, errMsg, fileNameFrom } from '../helpers';
	import { exportContext, exportRect, frameWithChildren, rasterize, renderSvg } from './export';
	import type { RenderContext } from './types';

	let {
		open = $bindable(false),
		boardId,
		boardName,
		elements,
		selection,
		rc,
		lookup
	}: {
		open?: boolean;
		boardId: string;
		boardName: string;
		elements: WbElement[];
		selection: string[];
		rc: RenderContext;
		lookup: (id: string) => WbElement | undefined;
	} = $props();

	type Format = 'png' | 'svg' | 'pdf' | 'archive';
	type Area = 'all' | 'selection' | 'frame' | 'frames';

	let format = $state<Format>('png');
	let area = $state<Area>('all');
	let frameId = $state<string | null>(null);
	let orientation = $state<'landscape' | 'portrait'>('landscape');
	let busy = $state(false);

	const frames = $derived(elements.filter((e) => e.type === 'frame'));
	const formatOptions = [
		{ value: 'png', label: 'Bild (PNG)' },
		{ value: 'svg', label: 'SVG' },
		{ value: 'pdf', label: 'PDF' },
		{ value: 'archive', label: 'Archiv' }
	];
	const areaOptions = $derived([
		{ value: 'all', label: 'Ganzes Board' },
		{
			value: 'selection',
			label: 'Auswahl',
			disabled: !selection.length,
			hint: selection.length ? undefined : 'Nichts ausgewählt'
		},
		{
			value: 'frame',
			label: 'Ein Rahmen',
			disabled: !frames.length,
			hint: frames.length ? undefined : 'Keine Rahmen'
		},
		...(format === 'pdf'
			? [{ value: 'frames', label: 'Jeder Rahmen eine Seite', disabled: !frames.length }]
			: [])
	]);
	const frameOptions = $derived(
		frames.map((f) => ({
			value: f.id,
			label: f.type === 'frame' ? f.data.title || 'Rahmen' : 'Rahmen'
		}))
	);

	$effect(() => {
		if (!open) return;
		untrack(() => {
			area = selection.length ? 'selection' : 'all';
			frameId = frames[0]?.id ?? null;
		});
	});

	$effect(() => {
		if (format !== 'pdf' && area === 'frames') area = 'all';
	});

	const slug = $derived(
		boardName
			.toLowerCase()
			.replace(/ä/g, 'ae')
			.replace(/ö/g, 'oe')
			.replace(/ü/g, 'ue')
			.replace(/ß/g, 'ss')
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 40) || 'whiteboard'
	);

	/** Seiten: Elemente + Titel */
	function pages(): { elements: WbElement[]; label: string | null }[] {
		if (area === 'frames') {
			return frames.map((f) => ({
				elements: frameWithChildren(f, elements),
				label: f.type === 'frame' ? f.data.title : null
			}));
		}
		if (area === 'frame') {
			const f = frames.find((x) => x.id === frameId);
			return f
				? [
						{
							elements: frameWithChildren(f, elements),
							label: f.type === 'frame' ? f.data.title : null
						}
					]
				: [];
		}
		if (area === 'selection') {
			const ids = new Set(selection);
			for (const id of selection) {
				const el = lookup(id);
				if (el?.type === 'frame') for (const c of frameWithChildren(el, elements)) ids.add(c.id);
			}
			return [{ elements: elements.filter((e) => ids.has(e.id)), label: null }];
		}
		return [{ elements, label: null }];
	}

	async function run() {
		busy = true;
		try {
			if (format === 'archive') {
				const res = await fetch(`${API_BASE}/boards/${boardId}/export`, {
					credentials: 'same-origin'
				});
				if (!res.ok) throw new Error('Export fehlgeschlagen');
				downloadBlob(await res.blob(), fileNameFrom(res, `${slug}.epwhiteboard`));
				open = false;
				return;
			}
			const list = pages().filter((p) => p.elements.length);
			if (!list.length) {
				toast.error('In diesem Bereich ist nichts zum Exportieren');
				return;
			}
			const ctx = await exportContext(
				rc,
				list.flatMap((p) => p.elements)
			);
			if (format === 'pdf') {
				const form = new FormData();
				form.set('orientation', orientation);
				for (const [i, p] of list.entries()) {
					const rect = exportRect(p.elements, lookup)!;
					const svg = renderSvg(p.elements, ctx, rect);
					const jpeg = await rasterize(svg, rect, { type: 'image/jpeg', quality: 0.9 });
					form.set(`page${i}`, new File([jpeg], `seite-${i + 1}.jpg`, { type: 'image/jpeg' }));
					if (p.label) form.set(`label${i}`, p.label);
				}
				const res = await fetch(`${API_BASE}/boards/${boardId}/export.pdf`, {
					method: 'POST',
					body: form,
					credentials: 'same-origin'
				});
				if (!res.ok) {
					const body = (await res.json().catch(() => null)) as {
						error?: { message?: string };
					} | null;
					throw new Error(body?.error?.message ?? 'PDF konnte nicht erzeugt werden');
				}
				downloadBlob(await res.blob(), fileNameFrom(res, `${slug}.pdf`));
			} else {
				const p = list[0]!;
				const rect = exportRect(p.elements, lookup)!;
				const svg = renderSvg(p.elements, ctx, rect);
				const name = `whiteboard-${slug}-${todayBerlin()}`;
				if (format === 'svg') {
					downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), `${name}.svg`);
				} else {
					downloadBlob(await rasterize(svg, rect), `${name}.png`);
				}
			}
			toast.success('Export erstellt');
			open = false;
		} catch (e) {
			toast.error(e instanceof Error && e.message ? e.message : errMsg(e, 'Export fehlgeschlagen'));
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Exportieren</Dialog.Title>
			<Dialog.Description>
				Als Bild, SVG oder PDF herunterladen – oder als Archiv, das sich wieder importieren lässt.
			</Dialog.Description>
		</Dialog.Header>
		<div class="space-y-4">
			<FormField label="Format" id="wb-export-format">
				<SegmentedSlider
					label="Format"
					options={formatOptions}
					value={format}
					onchange={(v) => (format = v as Format)}
				/>
			</FormField>
			{#if format === 'archive'}
				<p class="text-sm text-muted-foreground">
					Das Archiv enthält alle Elemente, Bilder und Dateien. Karten aus anderen Modulen bleiben
					als Verweis erhalten und zeigen nach dem Import nur, was die importierende Person sehen
					darf.
				</p>
			{:else}
				<FormField label="Bereich" id="wb-export-area">
					<SegmentedSlider
						label="Bereich"
						options={areaOptions}
						value={area}
						onchange={(v) => (area = v as Area)}
					/>
				</FormField>
				{#if area === 'frame'}
					<FormField label="Rahmen" id="wb-export-frame">
						<SelectField
							id="wb-export-frame"
							label="Rahmen"
							options={frameOptions}
							bind:value={frameId}
						/>
					</FormField>
				{/if}
				{#if format === 'pdf'}
					<FormField
						label="Seitenformat"
						id="wb-export-orientation"
						hint="A4, das Bild wird seitenfüllend eingepasst; davor steht ein Deckblatt."
					>
						<SegmentedSlider
							label="Seitenformat"
							options={[
								{ value: 'landscape', label: 'Quer' },
								{ value: 'portrait', label: 'Hoch' }
							]}
							value={orientation}
							onchange={(v) => (orientation = v as 'landscape' | 'portrait')}
						/>
					</FormField>
				{/if}
			{/if}
		</div>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
			<Button onclick={run} disabled={busy}>{busy ? 'Exportiert …' : 'Exportieren'}</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
