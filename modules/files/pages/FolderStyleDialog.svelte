<script lang="ts">
	// Dialog „Ordner gestalten“: Icon aus der Icon-Bibliothek und Farbe (Vorschläge + ColorPicker) mit Vorschau.
	// Gilt für alle mit Zugriff auf den Ordner; der Server prüft Bearbeiten-Zugriff und das Icon.
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import Check from '@lucide/svelte/icons/check';
	import { BUSY_SAVE } from '$lib/components/layout';
	import { Button } from '$lib/components/ui/button';
	import { ColorPicker, contrastTextColor } from '$lib/components/ui/color-picker';
	import * as Dialog from '$lib/components/ui/dialog';
	import { IconPicker } from '$lib/components/ui/icon-picker';
	import { apiFetch } from '$lib/sdk/client';
	import { iconLabel } from '$lib/sdk/icons';
	import { cn } from '$lib/utils';
	import { FOLDER_COLORS, type BulkResult, type FileNode } from '../schemas';
	import FolderGlyph from './FolderGlyph.svelte';
	import { API, errorText } from './helpers';

	let {
		open = $bindable(false),
		node,
		onsaved
	}: {
		open?: boolean;
		node: FileNode | null;
		onsaved: () => void;
	} = $props();

	let icon = $state<string | null>(null);
	let color = $state<string | null>(null);
	let busy = $state(false);

	// Beim Öffnen den aktuellen Stand übernehmen
	$effect(() => {
		if (!open) return;
		untrack(() => {
			icon = node?.icon ?? null;
			color = node?.color ?? null;
		});
	});

	const presetValues = FOLDER_COLORS.map((c) => c.value);
	const colorLabel = $derived(
		color ? (FOLDER_COLORS.find((c) => c.value === color)?.label ?? color.toUpperCase()) : 'Keine'
	);
	const changed = $derived(
		!!node && (icon !== (node.icon ?? null) || color !== (node.color ?? null))
	);

	async function save() {
		if (!node) return;
		busy = true;
		try {
			await apiFetch<BulkResult>(`${API}/nodes/style`, {
				method: 'POST',
				body: JSON.stringify({ ids: [node.id], icon, color })
			});
			toast.success('Aussehen gespeichert');
			open = false;
			onsaved();
		} catch (e) {
			toast.error(errorText(e, 'Speichern fehlgeschlagen'));
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-2xl">
		<Dialog.Header>
			<Dialog.Title class="break-words">Ordner gestalten</Dialog.Title>
			<Dialog.Description>
				„{node?.name ?? ''}“ – Icon und Farbe sehen alle, die den Ordner sehen.
			</Dialog.Description>
		</Dialog.Header>

		<div class="grid gap-5">
			<!-- Vorschau -->
			<div class="flex items-center gap-4 rounded-lg border bg-muted/30 p-3">
				<span
					class="flex h-[5.5rem] w-28 shrink-0 items-center justify-center rounded-md bg-muted/50"
					style:background-color={color
						? `color-mix(in srgb, ${color} 12%, transparent)`
						: undefined}
				>
					<FolderGlyph {icon} {color} size="lg" />
				</span>
				<div class="grid min-w-0 gap-1.5">
					<span class="text-xs font-medium text-muted-foreground">Vorschau</span>
					<span class="flex min-w-0 items-center gap-2 text-sm font-medium">
						<FolderGlyph {icon} {color} size="sm" />
						<span class="truncate">{node?.name ?? ''}</span>
					</span>
					<span class="text-xs text-muted-foreground">
						Icon: {icon ? iconLabel(icon) : 'keins'} · Farbe: {colorLabel}
					</span>
				</div>
			</div>

			<!-- Farbe -->
			<fieldset class="grid gap-2">
				<legend class="mb-1 text-sm font-medium">Farbe</legend>
				<div
					class="flex flex-wrap items-center gap-2"
					role="radiogroup"
					aria-label="Vorschlagsfarben"
				>
					{#each FOLDER_COLORS as c (c.value)}
						{@const active = color === c.value}
						<button
							type="button"
							role="radio"
							aria-checked={active}
							aria-label={c.label}
							title={c.label}
							class={cn(
								'flex size-8 items-center justify-center rounded-full border-2 border-background ring-1 ring-border transition-shadow outline-none focus-visible:ring-2 focus-visible:ring-ring',
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
					<span class="mx-1 h-6 w-px bg-border" aria-hidden="true"></span>
					<ColorPicker
						label="Eigene Farbe"
						value={color}
						onchange={(v) => (color = v ? v.toLowerCase() : null)}
						presets={presetValues}
						class="w-40"
					/>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						aria-pressed={color === null}
						onclick={() => (color = null)}
					>
						Keine
					</Button>
				</div>
				<p class="text-xs text-muted-foreground">
					Die Farbe des Icons auf dem Ordner wird automatisch hell oder dunkel gewählt.
				</p>
			</fieldset>

			<!-- Icon -->
			<fieldset class="grid gap-2">
				<div class="flex items-center justify-between gap-2">
					<legend class="text-sm font-medium">Icon</legend>
					<Button
						type="button"
						variant="outline"
						size="sm"
						disabled={icon === null}
						onclick={() => (icon = null)}
					>
						Kein Icon
					</Button>
				</div>
				<div class="max-h-[min(22rem,45dvh)] overflow-y-auto rounded-md border p-2">
					<IconPicker bind:value={icon} />
				</div>
			</fieldset>
		</div>

		<Dialog.Footer sticky class="sm:justify-between">
			<Button
				type="button"
				variant="ghost"
				disabled={icon === null && color === null}
				onclick={() => {
					icon = null;
					color = null;
				}}
			>
				Auf Standard zurücksetzen
			</Button>
			<div class="flex flex-col-reverse gap-2 sm:flex-row">
				<Button type="button" variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
				<Button type="button" disabled={busy || !changed} onclick={save}>
					{busy ? BUSY_SAVE : 'Speichern'}
				</Button>
			</div>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
