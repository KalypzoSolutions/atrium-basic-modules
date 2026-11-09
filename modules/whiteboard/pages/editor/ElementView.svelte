<script lang="ts">
	// Darstellung eines Elements (Ansicht und Export): verteilt auf die Typ-Komponenten
	import CalendarDays from '@lucide/svelte/icons/calendar-days';
	import FileArchive from '@lucide/svelte/icons/file-archive';
	import FileImage from '@lucide/svelte/icons/file-image';
	import FileSpreadsheet from '@lucide/svelte/icons/file-spreadsheet';
	import FileText from '@lucide/svelte/icons/file-text';
	import File from '@lucide/svelte/icons/file';
	import Folder from '@lucide/svelte/icons/folder';
	import Images from '@lucide/svelte/icons/images';
	import Link2 from '@lucide/svelte/icons/link-2';
	import ListTodo from '@lucide/svelte/icons/list-todo';
	import Presentation from '@lucide/svelte/icons/presentation';
	import Backpack from '@lucide/svelte/icons/backpack';
	import SquareKanban from '@lucide/svelte/icons/square-kanban';
	import Mail from '@lucide/svelte/icons/mail';
	import NotebookPen from '@lucide/svelte/icons/notebook-pen';
	import { REF_LABELS, type RefType, type WbElement } from '../../schemas';
	import CardView from './CardView.svelte';
	import ConnectorView from './ConnectorView.svelte';
	import FreehandView from './FreehandView.svelte';
	import ShapeView from './ShapeView.svelte';
	import {
		extensionLabel,
		FILE_COLORS,
		fileKind,
		formatBytes,
		hostOf,
		ink,
		REF_COLORS,
		type FileKind
	} from './render';
	import { FONT_FAMILY } from './text-layout';
	import { refKey, type RenderContext } from './types';

	let { el, rc }: { el: WbElement; rc: RenderContext } = $props();

	const FILE_ICONS: Record<FileKind, typeof File> = {
		pdf: FileText,
		doc: FileText,
		sheet: FileSpreadsheet,
		slides: Presentation,
		image: FileImage,
		archive: FileArchive,
		text: FileText,
		other: File
	};
	const REF_ICONS: Record<RefType, typeof File> = {
		action: Backpack,
		task: ListTodo,
		taskboard: SquareKanban,
		event: CalendarDays,
		gallery: Images,
		file: File,
		whiteboard: Presentation,
		note: NotebookPen
	};

	const rot = (d: { x: number; y: number; w: number; h: number; rotation: number }) =>
		`rotate(${d.rotation} ${d.x + d.w / 2} ${d.y + d.h / 2})`;
</script>

{#if el.type === 'shape'}
	<ShapeView id={el.id} data={el.data} {rc} />
{:else if el.type === 'connector'}
	<ConnectorView id={el.id} data={el.data} {rc} />
{:else if el.type === 'freehand'}
	<FreehandView id={el.id} data={el.data} {rc} />
{:else if el.type === 'image'}
	{@const d = el.data}
	{@const asset = rc.assets.get(d.assetId)}
	{@const href = asset
		? rc.assetHref(d.assetId, d.w * rc.zoom > 700 || rc.exporting ? 'web' : 'thumb')
		: null}
	<g data-el={el.id} transform={rot(d)}>
		{#if href}
			<image {href} x={d.x} y={d.y} width={d.w} height={d.h} preserveAspectRatio="none">
				<title>{d.alt || asset?.name || 'Bild'}</title>
			</image>
		{:else}
			<rect
				x={d.x}
				y={d.y}
				width={d.w}
				height={d.h}
				fill={rc.palette.placeholder}
				stroke={rc.palette.cardBorder}
				stroke-dasharray="6 4"
			/>
			<text
				x={d.x + d.w / 2}
				y={d.y + d.h / 2}
				text-anchor="middle"
				font-family={FONT_FAMILY}
				font-size="14"
				fill={rc.palette.muted}>Bild nicht verfügbar</text
			>
		{/if}
		{#if d.stroke !== 'transparent' && d.strokeWidth > 0}
			<rect
				x={d.x}
				y={d.y}
				width={d.w}
				height={d.h}
				fill="none"
				stroke={ink(d.stroke, rc.palette)}
				stroke-width={d.strokeWidth}
			/>
		{/if}
		{#if !rc.exporting}
			<rect x={d.x} y={d.y} width={d.w} height={d.h} fill="transparent" />
		{/if}
	</g>
{:else if el.type === 'file'}
	{@const d = el.data}
	{@const asset = rc.assets.get(d.assetId)}
	{@const kind = asset ? fileKind(asset.contentType, asset.name) : 'other'}
	<CardView
		id={el.id}
		x={d.x}
		y={d.y}
		w={d.w}
		h={d.h}
		rotation={d.rotation}
		accent={d.color ?? FILE_COLORS[kind]}
		icon={FILE_ICONS[kind]}
		kicker={asset ? extensionLabel(asset.name) || 'Datei' : 'Datei'}
		title={asset?.name ?? 'Datei nicht verfügbar'}
		subtitle={asset ? formatBytes(asset.sizeBytes) : null}
		imageHref={asset?.hasThumb ? rc.assetHref(d.assetId, 'thumb') : null}
		unavailable={!asset}
		measure={rc.measure}
		palette={rc.palette}
	/>
{:else if el.type === 'link'}
	{@const d = el.data}
	<CardView
		id={el.id}
		x={d.x}
		y={d.y}
		w={d.w}
		h={d.h}
		rotation={d.rotation}
		accent={d.color ?? '#0891b2'}
		icon={d.url.startsWith('mailto:') ? Mail : Link2}
		kicker={hostOf(d.url)}
		title={d.title || d.url}
		subtitle={d.note || (d.title ? d.url : null)}
		measure={rc.measure}
		palette={rc.palette}
	/>
{:else if el.type === 'ref'}
	{@const d = el.data}
	{@const card = rc.refs.get(refKey(d.refType, d.refId))}
	<CardView
		id={el.id}
		x={d.x}
		y={d.y}
		w={d.w}
		h={d.h}
		rotation={d.rotation}
		accent={d.color ?? card?.color ?? REF_COLORS[d.refType]}
		icon={d.refType === 'file' && card?.subtitle === 'Ordner' ? Folder : REF_ICONS[d.refType]}
		kicker={REF_LABELS[d.refType]}
		title={card ? card.title : 'Lädt …'}
		subtitle={card?.subtitle ?? null}
		badge={card?.badge ?? null}
		imageHref={card?.imageUrl ?? null}
		unavailable={card ? !card.available : false}
		measure={rc.measure}
		palette={rc.palette}
	/>
{:else if el.type === 'frame'}
	{@const d = el.data}
	{@const stroke = d.color ?? '#94a3b8'}
	<g data-el={el.id} data-frame="1" transform={rot(d)}>
		<rect
			x={d.x}
			y={d.y}
			width={d.w}
			height={d.h}
			rx="8"
			fill={d.fill === 'transparent' ? 'none' : d.fill}
			fill-opacity={d.fill === 'transparent' ? 0 : 0.35}
			{stroke}
			stroke-width="2"
			pointer-events="none"
		/>
		{#if !rc.exporting}
			<!-- nur Rand und Titel sind anfassbar, die Fläche bleibt frei für Inhalte -->
			<rect
				x={d.x}
				y={d.y}
				width={d.w}
				height={d.h}
				rx="8"
				fill="none"
				stroke="transparent"
				stroke-width={Math.max(12, 12 / rc.zoom)}
			/>
		{/if}
		{#if rc.editingId !== el.id}
			<text
				x={d.x + 4}
				y={d.y - 10}
				font-family={FONT_FAMILY}
				font-size="16"
				font-weight="700"
				fill={d.color ?? rc.palette.ink}
				style="white-space: pre">{d.title}</text
			>
		{/if}
	</g>
{/if}
