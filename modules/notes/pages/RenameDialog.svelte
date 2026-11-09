<script lang="ts">
	// Seite umbenennen (PATCH title)
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { apiFetch } from '$lib/sdk/client';
	import { BUSY_SAVE, FormField } from '$lib/components/layout';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { MAX_TITLE, type NoteDetail, type NoteNode } from '../schemas';
	import { API, errMsg } from './helpers';

	let {
		open = $bindable(false),
		node,
		onsaved
	}: {
		open?: boolean;
		node: Pick<NoteNode, 'id' | 'title'> | null;
		onsaved: (note: NoteDetail) => void;
	} = $props();

	let title = $state('');
	let busy = $state(false);

	$effect(() => {
		if (!open) return;
		untrack(() => (title = node?.title ?? ''));
	});

	async function save(e: SubmitEvent) {
		e.preventDefault();
		if (!node) return;
		busy = true;
		try {
			const note = await apiFetch<NoteDetail>(`${API}/notes/${node.id}`, {
				method: 'PATCH',
				body: JSON.stringify({ title: title.trim() })
			});
			open = false;
			onsaved(note);
		} catch (err) {
			toast.error(errMsg(err, 'Umbenennen fehlgeschlagen'));
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-md">
		<form class="grid gap-4" onsubmit={save}>
			<Dialog.Header>
				<Dialog.Title>Umbenennen</Dialog.Title>
			</Dialog.Header>
			<FormField label="Titel" id="note-rename">
				<Input id="note-rename" bind:value={title} maxlength={MAX_TITLE} placeholder="Ohne Titel" />
			</FormField>
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
				<Button type="submit" disabled={busy}>{busy ? BUSY_SAVE : 'Speichern'}</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
