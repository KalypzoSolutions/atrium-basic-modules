<script lang="ts">
	// Aussehen einer Seite: Icon (Icon-Bibliothek) und Farbe (Vorschläge + ColorPicker), sichtbar für alle mit Zugriff
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import Check from '@lucide/svelte/icons/check';
	import { apiFetch } from '$lib/sdk/client';
	import { STYLE_COLORS } from '$lib/sdk/style-presets';
	import { BUSY_SAVE } from '$lib/components/layout';
	import { Button } from '$lib/components/ui/button';
	import { ColorPicker, contrastTextColor } from '$lib/components/ui/color-picker';
	import * as Dialog from '$lib/components/ui/dialog';
	import { IconPicker } from '$lib/components/ui/icon-picker';
	import { cn } from '$lib/utils';
	import type { NoteDetail, NoteNode } from '../schemas';
	import NoteIcon from './NoteIcon.svelte';
	import { API, errMsg, noteTitle } from './helpers';

	let {
		open = $bindable(false),
		node,
		onsaved
	}: {
		open?: boolean;
		node: Pick<NoteNode, 'id' | 'title' | 'icon' | 'color'> | null;
		onsaved: (note: NoteDetail) => void;
	} = $props();

	let icon = $state<string | null>(null);
	let color = $state<string | null>(null);
	let busy = $state(false);

	$effect(() => {
		if (!open) return;
		untrack(() => {
			icon = node?.icon ?? null;
			color = node?.color ?? null;
		});
	});

	const presets = STYLE_COLORS.map((c) => c.value);
	const changed = $derived(
		!!node && (icon !== (node.icon ?? null) || color !== (node.color ?? null))
	);

	async function save() {
		if (!node) return;
		busy = true;
		try {
			const note = await apiFetch<NoteDetail>(`${API}/notes/${node.id}`, {
				method: 'PATCH',
				body: JSON.stringify({ icon, color })
			});
			toast.success('Aussehen gespeichert');
			open = false;
			onsaved(note);
		} catch (e) {
			toast.error(errMsg(e, 'Speichern fehlgeschlagen'));
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>Aussehen</Dialog.Title>
			<Dialog.Description>
				Icon und Farbe von „{noteTitle(node?.title)}“ – sehen alle, die die Seite sehen.
			</Dialog.Description>
		</Dialog.Header>
		<div class="grid gap-5">
			<div class="flex items-center gap-3 rounded-lg border bg-muted/30 p-3">
				<NoteIcon {icon} {color} class="size-8" />
				<span class="truncate text-lg font-semibold">{noteTitle(node?.title)}</span>
			</div>
			<fieldset class="grid gap-2">
				<legend class="mb-1 text-sm font-medium">Farbe</legend>
				<div
					class="flex flex-wrap items-center gap-2"
					role="radiogroup"
					aria-label="Vorschlagsfarben"
				>
					{#each STYLE_COLORS as c (c.value)}
						{@const active = color === c.value}
						<button
							type="button"
							role="radio"
							aria-checked={active}
							aria-label={c.label}
							title={c.label}
							class={cn(
								'flex size-8 items-center justify-center rounded-full border-2 border-background ring-1 ring-border outline-none focus-visible:ring-2 focus-visible:ring-ring',
								active && 'ring-2 ring-foreground'
							)}
							style:background-color={c.value}
							onclick={() => (color = c.value)}
						>
							{#if active}
								<Check
									class="size-4"
									style="color: {contrastTextColor(c.value)}"
									aria-hidden="true"
								/>
							{/if}
						</button>
					{/each}
					<ColorPicker
						label="Eigene Farbe"
						value={color}
						onchange={(v) => (color = v ? v.toLowerCase() : null)}
						{presets}
						class="w-40"
					/>
					<Button type="button" variant="ghost" size="sm" onclick={() => (color = null)}
						>Keine</Button
					>
				</div>
			</fieldset>
			<fieldset class="grid gap-2">
				<div class="flex items-center justify-between gap-2">
					<legend class="text-sm font-medium">Icon</legend>
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={icon === null}
						onclick={() => (icon = null)}>Kein Icon</Button
					>
				</div>
				<div class="max-h-[min(22rem,45dvh)] overflow-y-auto rounded-md border p-2">
					<IconPicker bind:value={icon} />
				</div>
			</fieldset>
		</div>
		<Dialog.Footer sticky>
			<Button type="button" variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
			<Button type="button" disabled={busy || !changed} onclick={save}>
				{busy ? BUSY_SAVE : 'Speichern'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
