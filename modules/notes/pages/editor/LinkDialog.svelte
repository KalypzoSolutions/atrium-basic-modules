<script lang="ts">
	// Link setzen/ändern/entfernen (nur http, https, mailto oder interne Pfade)
	import { untrack } from 'svelte';
	import { FormField } from '$lib/components/layout';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';

	let {
		open = $bindable(false),
		initial = '',
		onapply
	}: {
		open?: boolean;
		initial?: string;
		/** `''` = Link entfernen */
		onapply: (href: string) => void;
	} = $props();

	let url = $state('');
	let error = $state('');

	$effect(() => {
		if (!open) return;
		untrack(() => {
			url = initial;
			error = '';
		});
	});

	/** Eingabe prüfen und ergänzen (`example.org` → `https://example.org`) */
	function normalizeLink(raw: string): string | null {
		const v = raw.trim();
		if (!v) return '';
		if (/^\/(?!\/)/.test(v)) return v;
		if (/^mailto:[^\s@]+@[^\s@]+$/i.test(v)) return v;
		if (/^[^\s@/]+@[^\s@]+\.[^\s@]+$/.test(v)) return `mailto:${v}`;
		const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(v) ? v : `https://${v}`;
		try {
			const u = new URL(withScheme);
			if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
			if (!u.hostname.includes('.') && u.hostname !== 'localhost') return null;
			return u.href;
		} catch {
			return null;
		}
	}

	function submit(e: SubmitEvent) {
		e.preventDefault();
		const href = normalizeLink(url);
		if (href === null) {
			error = 'Bitte eine gültige Adresse mit http(s) oder eine E-Mail-Adresse eingeben.';
			return;
		}
		onapply(href);
		open = false;
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-md">
		<form onsubmit={submit} class="grid gap-4">
			<Dialog.Header>
				<Dialog.Title>Link</Dialog.Title>
				<Dialog.Description>Adresse einer Webseite oder E-Mail-Adresse.</Dialog.Description>
			</Dialog.Header>
			<FormField label="Adresse" id="note-link-url" {error}>
				<Input
					id="note-link-url"
					bind:value={url}
					placeholder="https://…"
					autocomplete="off"
					inputmode="url"
				/>
			</FormField>
			<Dialog.Footer class="sm:justify-between">
				{#if initial}
					<Button
						type="button"
						variant="ghost"
						onclick={() => {
							onapply('');
							open = false;
						}}>Link entfernen</Button
					>
				{:else}
					<span></span>
				{/if}
				<div class="flex flex-col-reverse gap-2 sm:flex-row">
					<Button type="button" variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
					<Button type="submit">Übernehmen</Button>
				</div>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
