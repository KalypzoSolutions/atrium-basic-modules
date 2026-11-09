<script lang="ts">
	// Verbinder: Linie/Pfeil mit Spitzen und Beschriftung; breite unsichtbare Fläche zum Antippen
	import type { ConnectorData } from '../../schemas';
	import { arrowHeadPath, resolveConnector } from './connectors';
	import { ink } from './render';
	import { FONT_FAMILY } from './text-layout';
	import type { RenderContext } from './types';

	let { id, data, rc }: { id: string; data: ConnectorData; rc: RenderContext } = $props();

	const geo = $derived(resolveConnector(data, (x) => rc.lookup(x)));
	const start = $derived(arrowHeadPath(data.startHead, geo.a, geo.startAngle, data.strokeWidth));
	const end = $derived(arrowHeadPath(data.endHead, geo.b, geo.endAngle, data.strokeWidth));
	const dash = $derived(
		data.strokeStyle === 'dashed'
			? `${data.strokeWidth * 3} ${data.strokeWidth * 2}`
			: data.strokeStyle === 'dotted'
				? `${data.strokeWidth} ${data.strokeWidth * 1.6}`
				: undefined
	);
	const labelSize = 14;
	const labelWidth = $derived(
		data.label ? rc.measure(data.label, labelSize, false, false) + 12 : 0
	);
	const hidden = $derived(rc.editingId === id);
	const stroke = $derived(ink(data.stroke, rc.palette));
</script>

<g data-el={id}>
	{#if !rc.exporting}
		<path d={geo.path} fill="none" stroke="transparent" stroke-width={Math.max(16, 16 / rc.zoom)} />
	{/if}
	<path
		d={geo.path}
		fill="none"
		{stroke}
		stroke-width={data.strokeWidth}
		stroke-dasharray={dash}
		stroke-linecap="round"
		stroke-linejoin="round"
	/>
	{#each [start, end] as head, i (i)}
		{#if head}
			<path
				d={head.d}
				fill={head.filled ? stroke : 'none'}
				{stroke}
				stroke-width={data.strokeWidth}
				stroke-linecap="round"
				stroke-linejoin="round"
			/>
		{/if}
	{/each}
	{#if data.label && !hidden}
		<rect
			x={geo.mid.x - labelWidth / 2}
			y={geo.mid.y - labelSize * 0.85}
			width={labelWidth}
			height={labelSize * 1.7}
			rx="4"
			fill={rc.palette.paper}
		/>
		<text
			x={geo.mid.x}
			y={geo.mid.y + labelSize * 0.35}
			text-anchor="middle"
			font-family={FONT_FAMILY}
			font-size={labelSize}
			fill={rc.palette.ink}
			style="white-space: pre">{data.label}</text
		>
	{/if}
</g>
