<script lang="ts">
	// Persönlicher Hintergrund der Notizen: feste Farbe (Weiß, Papier, Schwarz, eigene) oder wie Modus/Theme
	import PaintBucket from '@lucide/svelte/icons/paint-bucket';
	import { Button } from '$lib/components/ui/button';
	import { ColorPicker } from '$lib/components/ui/color-picker';
	import { Label } from '$lib/components/ui/label';
	import * as Popover from '$lib/components/ui/popover';
	import { Switch } from '$lib/components/ui/switch';
	import { SURFACE_PRESETS, type UserPrefs } from '../schemas';

	let { prefs, onchange }: { prefs: UserPrefs; onchange: (next: UserPrefs['surface']) => void } =
		$props();

	const surface = $derived(prefs.surface);
	const fixed = $derived(surface.mode === 'fixed');
	const isPreset = $derived(SURFACE_PRESETS.some((p) => p.value === surface.color));
</script>

<Popover.Root>
	<Popover.Trigger>
		{#snippet child({ props })}
			<Button
				{...props}
				variant="ghost"
				size="icon-sm"
				aria-label="Hintergrund einstellen"
				title="Hintergrund einstellen"
			>
				<PaintBucket />
			</Button>
		{/snippet}
	</Popover.Trigger>
	<Popover.Content align="end" class="w-72 space-y-4 p-3">
		<div class="flex items-start justify-between gap-3">
			<div class="space-y-0.5">
				<Label for="notes-surface-fixed" class="text-sm font-medium">Feste Hintergrundfarbe</Label>
				<p class="text-xs text-muted-foreground">
					Bleibt gleich – egal ob hell, dunkel oder mit Farbverlauf-Theme. Ausgeschaltet folgt der
					Hintergrund deinem Design.
				</p>
			</div>
			<Switch
				id="notes-surface-fixed"
				checked={fixed}
				onCheckedChange={(v) => onchange({ ...surface, mode: v ? 'fixed' : 'theme' })}
			/>
		</div>
		{#if fixed}
			<fieldset class="space-y-2">
				<legend class="text-xs font-medium text-muted-foreground">Farbe</legend>
				<div class="grid grid-cols-3 gap-2">
					{#each SURFACE_PRESETS as p (p.value)}
						<button
							type="button"
							class={[
								'flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-sm hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
								surface.color === p.value && 'ring-2 ring-ring'
							]}
							aria-pressed={surface.color === p.value}
							onclick={() => onchange({ mode: 'fixed', color: p.value })}
						>
							<span class="size-4 shrink-0 rounded-full border" style:background-color={p.value}
							></span>
							{p.label}
						</button>
					{/each}
				</div>
				<ColorPicker
					label="Eigene Hintergrundfarbe"
					value={isPreset ? null : surface.color}
					onchange={(c) => c && onchange({ mode: 'fixed', color: c })}
				/>
			</fieldset>
		{/if}
		<p class="text-xs text-muted-foreground">Gilt nur für dich, in allen Notizen.</p>
	</Popover.Content>
</Popover.Root>
