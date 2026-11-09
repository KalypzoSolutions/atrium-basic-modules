<script lang="ts">
	// Karte im Whiteboard (Datei, Link, Datensatz aus einem anderen Modul): Symbol oder Bild, Typ, Titel, Unterzeile
	import type { Component } from 'svelte';
	import type { Palette } from './render';
	import { FONT_FAMILY, wrapText, type Measure } from './text-layout';

	let {
		id,
		x,
		y,
		w,
		h,
		rotation = 0,
		accent,
		icon: Icon,
		kicker,
		title,
		subtitle = null,
		badge = null,
		imageHref = null,
		unavailable = false,
		measure,
		palette
	}: {
		id: string;
		x: number;
		y: number;
		w: number;
		h: number;
		rotation?: number;
		accent: string;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		icon: Component<any>;
		kicker: string;
		title: string;
		subtitle?: string | null;
		badge?: string | null;
		imageHref?: string | null;
		unavailable?: boolean;
		measure: Measure;
		palette: Palette;
	} = $props();

	const pad = 12;
	const withImage = $derived(!!imageHref && h >= 140 && w >= 120);
	const imageH = $derived(withImage ? Math.round(h * 0.55) : 0);
	const iconSize = 28;
	const textX = $derived(withImage ? pad + 6 : pad + 6 + iconSize + 10);
	const textW = $derived(Math.max(10, w - textX - pad));
	const top = $derived(imageH + pad);
	const titleLines = $derived(
		wrapText(title, textW, 15, { bold: true, measure })
			.slice(0, Math.max(1, Math.floor((h - top - 40) / 19) + 1))
			.slice(0, 3)
	);
	const fitSub = (s: string) => {
		let out = s;
		while (out.length > 1 && measure(out, 12, false, false) > textW) out = out.slice(0, -2) + '…';
		return out;
	};
	const transform = $derived(`rotate(${rotation} ${x + w / 2} ${y + h / 2}) translate(${x} ${y})`);
	const clipId = $derived(`wb-card-${id}`);
	const badgeW = $derived(badge ? measure(badge, 11, false, false) + 12 : 0);
</script>

<g data-el={id} {transform} opacity={unavailable ? 0.7 : 1}>
	<rect
		x="2"
		y="3"
		width={w}
		height={h}
		rx="10"
		fill="#000000"
		opacity={palette.dark ? 0.35 : 0.06}
	/>
	<rect
		width={w}
		height={h}
		rx="10"
		fill={palette.card}
		stroke={palette.cardBorder}
		stroke-width="1"
		stroke-dasharray={unavailable ? '6 4' : undefined}
	/>
	{#if withImage}
		<clipPath id={clipId}>
			<rect width={w} height={imageH} rx="10" />
			<rect y="10" width={w} height={imageH - 10} />
		</clipPath>
		<rect width={w} height={imageH} fill={palette.placeholder} clip-path={`url(#${clipId})`} />
		<image
			href={imageHref}
			width={w}
			height={imageH}
			preserveAspectRatio="xMidYMid slice"
			clip-path={`url(#${clipId})`}
		/>
	{:else}
		<rect x="0" y="0" width="5" height={h} rx="2" fill={accent} />
		<circle
			cx={pad + 6 + iconSize / 2}
			cy={pad + iconSize / 2 + 4}
			r={iconSize / 2 + 4}
			fill={accent}
			opacity="0.12"
		/>
		<g style={`color:${accent}`}>
			<Icon
				x={pad + 6 + 5}
				y={pad + 9}
				width={iconSize - 10}
				height={iconSize - 10}
				stroke-width={2}
			/>
		</g>
	{/if}
	<text
		x={textX}
		y={top + 10}
		font-family={FONT_FAMILY}
		font-size="10"
		font-weight="700"
		letter-spacing="0.06em"
		fill={accent}>{kicker.toUpperCase()}</text
	>
	{#if badge}
		<rect
			x={w - pad - badgeW}
			y={top - 2}
			width={badgeW}
			height="17"
			rx="8.5"
			fill={accent}
			opacity="0.12"
		/>
		<text
			x={w - pad - badgeW / 2}
			y={top + 10}
			text-anchor="middle"
			font-family={FONT_FAMILY}
			font-size="11"
			fill={accent}>{badge}</text
		>
	{/if}
	<text
		font-family={FONT_FAMILY}
		font-size="15"
		font-weight="700"
		fill={unavailable ? palette.muted : palette.ink}
		style="white-space: pre"
	>
		{#each titleLines as line, i (i)}
			<tspan x={textX} y={top + 30 + i * 19}>{line}</tspan>
		{/each}
	</text>
	{#if subtitle}
		<text
			x={textX}
			y={top + 30 + titleLines.length * 19 + 2}
			font-family={FONT_FAMILY}
			font-size="12"
			fill={palette.muted}
			style="white-space: pre">{fitSub(subtitle)}</text
		>
	{/if}
</g>
