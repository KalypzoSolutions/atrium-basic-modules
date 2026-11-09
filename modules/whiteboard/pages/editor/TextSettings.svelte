<script lang="ts">
	// Text-Einstellungen einer Form/Notiz/eines Textfelds: Schriftart, Größe, Ausrichtung (waagrecht/senkrecht),
	// Stil (fett, kursiv, unterstrichen, durchgestrichen), automatische Schriftgröße bzw. mitwachsende Höhe.
	import AlignCenter from '@lucide/svelte/icons/align-center';
	import AlignLeft from '@lucide/svelte/icons/align-left';
	import AlignRight from '@lucide/svelte/icons/align-right';
	import AlignVerticalJustifyCenter from '@lucide/svelte/icons/align-vertical-justify-center';
	import AlignVerticalJustifyEnd from '@lucide/svelte/icons/align-vertical-justify-end';
	import AlignVerticalJustifyStart from '@lucide/svelte/icons/align-vertical-justify-start';
	import Bold from '@lucide/svelte/icons/bold';
	import Italic from '@lucide/svelte/icons/italic';
	import Strikethrough from '@lucide/svelte/icons/strikethrough';
	import Type from '@lucide/svelte/icons/type';
	import Underline from '@lucide/svelte/icons/underline';
	import { Button } from '$lib/components/ui/button';
	import { Label } from '$lib/components/ui/label';
	import * as Popover from '$lib/components/ui/popover';
	import { Switch } from '$lib/components/ui/switch';
	import { NumberStepper } from '$lib/components/layout';
	import {
		FONT_FAMILIES,
		FONT_FAMILY_LABELS,
		type ShapeData,
		type TextAlign,
		type VAlign
	} from '../../schemas';
	import { FONT_STACKS } from './text-layout';

	let {
		data,
		onchange
	}: {
		/** Werte der ersten ausgewählten Form (Änderungen gelten für alle ausgewählten) */
		data: ShapeData;
		onchange: (values: Partial<ShapeData>) => void;
	} = $props();

	const SIZES = [
		{ label: 'S', value: 14 },
		{ label: 'M', value: 20 },
		{ label: 'L', value: 28 },
		{ label: 'XL', value: 40 },
		{ label: 'XXL', value: 64 }
	];
	const ALIGNS: { value: TextAlign; icon: typeof Bold; label: string }[] = [
		{ value: 'left', icon: AlignLeft, label: 'Linksbündig' },
		{ value: 'center', icon: AlignCenter, label: 'Zentriert' },
		{ value: 'right', icon: AlignRight, label: 'Rechtsbündig' }
	];
	const VALIGNS: { value: VAlign; icon: typeof Bold; label: string }[] = [
		{ value: 'top', icon: AlignVerticalJustifyStart, label: 'Oben' },
		{ value: 'middle', icon: AlignVerticalJustifyCenter, label: 'Mitte' },
		{ value: 'bottom', icon: AlignVerticalJustifyEnd, label: 'Unten' }
	];
	const STYLES = [
		{ key: 'bold', icon: Bold, label: 'Fett' },
		{ key: 'italic', icon: Italic, label: 'Kursiv' },
		{ key: 'underline', icon: Underline, label: 'Unterstrichen' },
		{ key: 'strike', icon: Strikethrough, label: 'Durchgestrichen' }
	] as const;
	const isText = $derived(data.kind === 'text');
	const family = $derived(data.fontFamily ?? 'sans');
</script>

<Popover.Root>
	<Popover.Trigger>
		{#snippet child({ props })}
			<Button
				{...props}
				variant="ghost"
				size="sm"
				aria-label="Text einstellen"
				title="Text einstellen"
			>
				<Type />
				<span class="tabular-nums">{data.fontSize}</span>
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content class="w-72 space-y-4 p-3">
		<fieldset class="space-y-1.5">
			<legend class="text-xs font-medium text-muted-foreground">Schriftart</legend>
			<div class="grid grid-cols-2 gap-1">
				{#each FONT_FAMILIES as f (f)}
					<Button
						size="sm"
						variant={family === f ? 'secondary' : 'ghost'}
						aria-pressed={family === f}
						style={`font-family:${FONT_STACKS[f]}`}
						onclick={() => onchange({ fontFamily: f })}>{FONT_FAMILY_LABELS[f]}</Button
					>
				{/each}
			</div>
		</fieldset>

		<fieldset class="space-y-1.5">
			<legend class="text-xs font-medium text-muted-foreground">Größe</legend>
			<NumberStepper
				label="Schriftgröße"
				unit="px"
				min={8}
				max={160}
				step={2}
				value={data.fontSize}
				onchange={(v) => onchange({ fontSize: Math.round(v) })}
			/>
			<div class="flex flex-wrap gap-1">
				{#each SIZES as s (s.value)}
					<Button
						size="sm"
						variant={data.fontSize === s.value ? 'secondary' : 'ghost'}
						aria-label={`Schriftgröße ${s.label} (${s.value} px)`}
						onclick={() => onchange({ fontSize: s.value })}>{s.label}</Button
					>
				{/each}
			</div>
		</fieldset>

		<fieldset class="space-y-1.5">
			<legend class="text-xs font-medium text-muted-foreground">Ausrichtung</legend>
			<div class="flex flex-wrap items-center gap-1">
				{#each ALIGNS as a (a.value)}
					<Button
						variant={data.align === a.value ? 'secondary' : 'ghost'}
						size="icon"
						aria-label={a.label}
						aria-pressed={data.align === a.value}
						title={a.label}
						onclick={() => onchange({ align: a.value })}><a.icon /></Button
					>
				{/each}
				<div class="mx-1 h-6 w-px bg-border" aria-hidden="true"></div>
				{#each VALIGNS as a (a.value)}
					<Button
						variant={data.valign === a.value ? 'secondary' : 'ghost'}
						size="icon"
						aria-label={`Senkrecht: ${a.label}`}
						aria-pressed={data.valign === a.value}
						title={`Senkrecht: ${a.label}`}
						onclick={() => onchange({ valign: a.value })}><a.icon /></Button
					>
				{/each}
			</div>
		</fieldset>

		<fieldset class="space-y-1.5">
			<legend class="text-xs font-medium text-muted-foreground">Stil</legend>
			<div class="flex gap-1">
				{#each STYLES as st (st.key)}
					<Button
						variant={data[st.key] ? 'secondary' : 'ghost'}
						size="icon"
						aria-label={st.label}
						aria-pressed={!!data[st.key]}
						title={st.label}
						onclick={() => onchange({ [st.key]: !data[st.key] })}><st.icon /></Button
					>
				{/each}
			</div>
		</fieldset>

		<div class="flex items-start justify-between gap-3">
			{#if isText}
				<Label for="wb-auto-height" class="text-sm leading-snug font-normal">
					Höhe passt sich dem Text an
				</Label>
				<Switch
					id="wb-auto-height"
					checked={data.autoHeight}
					onCheckedChange={(v) => onchange({ autoHeight: v })}
				/>
			{:else}
				<Label for="wb-auto-fit" class="text-sm leading-snug font-normal">
					Schrift automatisch verkleinern, damit alles hineinpasst
				</Label>
				<Switch
					id="wb-auto-fit"
					checked={data.autoFit}
					onCheckedChange={(v) => onchange({ autoFit: v })}
				/>
			{/if}
		</div>
	</Popover.Content>
</Popover.Root>
