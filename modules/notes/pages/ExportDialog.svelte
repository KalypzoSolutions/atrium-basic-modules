<script lang="ts">
	// Export einer Notiz: Format wählen, optional mit Unterseiten, PDF optional mit Stammes-Briefkopf
	import { untrack } from 'svelte';
	import Download from '@lucide/svelte/icons/download';
	import { ChoiceChips } from '$lib/components/layout';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Label } from '$lib/components/ui/label';
	import { Switch } from '$lib/components/ui/switch';
	import { API_BASE, EXPORT_FORMAT_LABELS, EXPORT_FORMATS, type ExportFormat } from '../schemas';

	let {
		open = $bindable(false),
		noteId,
		hasChildren
	}: {
		open?: boolean;
		noteId: string;
		hasChildren: boolean;
	} = $props();

	let format = $state<ExportFormat>('md');
	let subpages = $state(false);
	let letterhead = $state(false);

	$effect(() => {
		if (!open) return;
		untrack(() => (subpages = false));
	});

	const options = EXPORT_FORMATS.map((f) => ({ value: f, label: EXPORT_FORMAT_LABELS[f] }));
	const url = $derived(
		`${API_BASE}/notes/${noteId}/export?${new URLSearchParams({
			format,
			subpages: subpages ? '1' : '0',
			letterhead: format === 'pdf' && letterhead ? '1' : '0'
		})}`
	);
	const hint = $derived(
		format === 'md'
			? 'Reiner Text mit Markdown-Formatierung; Bilder als Verweise.'
			: format === 'zip'
				? 'Markdown-Dateien mit allen Bildern – lässt sich wieder importieren.'
				: format === 'html'
					? 'Eine Datei zum Öffnen im Browser, Bilder eingebettet.'
					: format === 'docx'
						? 'Zum Weiterbearbeiten in Word oder LibreOffice.'
						: 'Zum Drucken oder Versenden.'
	);
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>Exportieren</Dialog.Title>
			<Dialog.Description>{hint}</Dialog.Description>
		</Dialog.Header>
		<div class="grid gap-4">
			<ChoiceChips legend="Format" {options} value={format} onchange={(v) => (format = v)} />
			{#if hasChildren}
				<div class="flex items-center justify-between gap-3">
					<Label for="note-export-subpages">Mit Unterseiten</Label>
					<Switch id="note-export-subpages" bind:checked={subpages} />
				</div>
			{/if}
			{#if format === 'pdf'}
				<div class="flex items-center justify-between gap-3">
					<Label for="note-export-letterhead">Mit Stammes-Briefkopf</Label>
					<Switch id="note-export-letterhead" bind:checked={letterhead} />
				</div>
			{/if}
			<p class="text-xs text-muted-foreground">
				Eingebettete Whiteboards erscheinen im Export als Link.
			</p>
		</div>
		<Dialog.Footer>
			<Button type="button" variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
			<Button href={url} download onclick={() => setTimeout(() => (open = false), 100)}>
				<Download /> Herunterladen
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
