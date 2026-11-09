<script lang="ts">
	// Freihand-Strich: Umriss aus den gespeicherten Punkten, in den Rahmen x/y/w/h eingepasst
	import type { FreehandData } from '../../schemas';
	import { strokePath } from './freehand';
	import { ink } from './render';
	import type { RenderContext } from './types';

	let { id, data, rc }: { id: string; data: FreehandData; rc: RenderContext } = $props();

	const d = $derived(
		strokePath(data.points, {
			size: data.size,
			marker: data.marker,
			simulatePressure: !data.points.some((p) => p[2] !== 0.5)
		})
	);
	const transform = $derived(
		`rotate(${data.rotation} ${data.x + data.w / 2} ${data.y + data.h / 2}) translate(${data.x} ${data.y}) scale(${data.w / data.vw} ${data.h / data.vh})`
	);
</script>

<g data-el={id} {transform}>
	{#if !rc.exporting}
		<!-- etwas breitere Trefferfläche zum Antippen dünner Striche -->
		<path {d} fill="transparent" stroke="transparent" stroke-width={10 / rc.zoom} />
	{/if}
	<path
		{d}
		fill={ink(data.color, rc.palette)}
		opacity={data.marker ? Math.min(data.opacity, 0.45) : data.opacity}
	/>
</g>
