<script lang="ts">
	// Link einfügen oder bearbeiten (http(s), mailto oder interne Seite wie /modules/…)
	import { tick, untrack } from 'svelte';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { FormField } from '$lib/components/layout';
	import { isAllowedLink, type LinkData } from '../../schemas';

	let {
		open = $bindable(false),
		link = null,
		onsave
	}: {
		open?: boolean;
		link?: Pick<LinkData, 'url' | 'title' | 'note'> | null;
		onsave: (v: { url: string; title: string; note: string }) => void;
	} = $props();

	let url = $state('');
	let title = $state('');
	let note = $state('');
	let error = $state('');

	$effect(() => {
		if (!open) return;
		untrack(() => {
			url = link?.url ?? '';
			title = link?.title ?? '';
			note = link?.note ?? '';
			error = '';
		});
		void tick().then(() => document.getElementById('wb-link-url')?.focus());
	});

	/** „example.org“ → „https://example.org“ */
	function normalize(v: string): string {
		const t = v.trim();
		if (!t || t.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(t)) return t;
		if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) return `mailto:${t}`;
		return `https://${t}`;
	}

	function submit(e: SubmitEvent) {
		e.preventDefault();
		const value = normalize(url);
		if (!isAllowedLink(value)) {
			error =
				'Bitte eine Webadresse (https://…), E-Mail-Adresse oder interne Seite (/modules/…) eingeben';
			return;
		}
		onsave({ url: value, title: title.trim(), note: note.trim() });
		open = false;
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>{link ? 'Link bearbeiten' : 'Link einfügen'}</Dialog.Title>
			<Dialog.Description
				>Webseite, E-Mail-Adresse oder eine Seite hier im System.</Dialog.Description
			>
		</Dialog.Header>
		<form class="space-y-4" onsubmit={submit} novalidate>
			<FormField label="Adresse" id="wb-link-url" required {error}>
				<Input
					id="wb-link-url"
					bind:value={url}
					placeholder="https://…"
					autocomplete="off"
					inputmode="url"
				/>
			</FormField>
			<FormField label="Titel" id="wb-link-title" hint="Optional, sonst wird die Adresse gezeigt.">
				<Input id="wb-link-title" bind:value={title} maxlength={200} />
			</FormField>
			<FormField label="Notiz" id="wb-link-note">
				<Input id="wb-link-note" bind:value={note} maxlength={500} />
			</FormField>
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
				<Button type="submit">{link ? 'Speichern' : 'Einfügen'}</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
