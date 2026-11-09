<script lang="ts">
	// Eigenständiges SVG eines Ausschnitts für den Export (gleiche Element-Komponenten wie die Ansicht)
	import type { WbElement } from '../../schemas';
	import ElementView from './ElementView.svelte';
	import type { Rect } from './geometry';
	import { LIGHT } from './render';
	import type { RenderContext } from './types';

	let {
		elements,
		rc,
		rect,
		transparent = false
	}: { elements: WbElement[]; rc: RenderContext; rect: Rect; transparent?: boolean } = $props();
</script>

<svg
	xmlns="http://www.w3.org/2000/svg"
	width={Math.ceil(rect.w)}
	height={Math.ceil(rect.h)}
	viewBox={`${rect.x} ${rect.y} ${rect.w} ${rect.h}`}
>
	{#if !transparent}
		<rect x={rect.x} y={rect.y} width={rect.w} height={rect.h} fill={LIGHT.paper} />
	{/if}
	{#each elements as el (el.id)}
		<ElementView {el} {rc} />
	{/each}
</svg>
