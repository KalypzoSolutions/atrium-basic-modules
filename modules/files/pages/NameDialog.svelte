<script lang="ts">
	import { tick } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { FormField } from '$lib/components/layout';
	import { MAX_NAME, nodeName, type FileNode } from '../schemas';
	import { API, errorText } from './helpers';

	let {
		open = $bindable(false),
		mode,
		parentId = null,
		node = null,
		onsaved
	}: {
		open?: boolean;
		/** `create` = neuer Ordner in `parentId` (`null` = eigene Wurzel), `rename` = `node` umbenennen */
		mode: 'create' | 'rename';
		parentId?: string | null;
		node?: FileNode | null;
		onsaved: (node: FileNode) => void;
	} = $props();

	const fieldId = 'files-name-input';

	let name = $state('');
	let fieldError = $state<string | null>(null);
	let formError = $state<string | null>(null);
	let busy = $state(false);
	let inputEl = $state<HTMLInputElement | null>(null);

	const isRename = $derived(mode === 'rename');
	const title = $derived(
		isRename ? (node?.kind === 'folder' ? 'Ordner umbenennen' : 'Datei umbenennen') : 'Neuer Ordner'
	);

	/** Ende des Basisnamens (ohne Endung) – „.bashrc“ zählt als Name ohne Endung */
	function baseEnd(value: string): number {
		const dot = value.lastIndexOf('.');
		return dot > 0 ? dot : value.length;
	}

	/** Beim Öffnen zurücksetzen und Feld fokussieren (Basisname vorausgewählt) */
	let wasOpen = false;
	$effect(() => {
		if (open && !wasOpen) {
			name = isRename ? (node?.name ?? '') : '';
			fieldError = null;
			formError = null;
			busy = false;
			void tick().then(() => {
				if (!inputEl) return;
				inputEl.focus();
				if (isRename && node) {
					const end = node.kind === 'file' ? baseEnd(name) : name.length;
					inputEl.setSelectionRange(0, end);
				}
			});
		}
		wasOpen = open;
	});

	function firstIssueMessage(details: unknown): string | null {
		const issues = Array.isArray(details)
			? details
			: (details as { issues?: unknown[] } | null)?.issues;
		if (!Array.isArray(issues)) return null;
		const first = issues[0] as { message?: unknown } | undefined;
		return typeof first?.message === 'string' ? first.message : null;
	}

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (busy) return;
		fieldError = null;
		formError = null;
		const parsed = nodeName.safeParse(name);
		if (!parsed.success) {
			fieldError = parsed.error.issues[0]?.message ?? 'Ungültiger Name';
			inputEl?.focus();
			return;
		}
		const value = parsed.data;
		if (isRename && node && value === node.name) {
			open = false;
			return;
		}
		busy = true;
		try {
			let saved: FileNode;
			if (isRename) {
				if (!node) return;
				saved = await apiFetch<FileNode>(`${API}/nodes/${node.id}`, {
					method: 'PATCH',
					body: JSON.stringify({ name: value })
				});
				toast.success('Umbenannt');
			} else {
				saved = await apiFetch<FileNode>(`${API}/folders`, {
					method: 'POST',
					body: JSON.stringify({ parentId, name: value })
				});
				toast.success('Ordner angelegt');
			}
			open = false;
			onsaved(saved);
		} catch (err) {
			if (err instanceof ApiClientError && err.status === 409) {
				fieldError = err.message;
				inputEl?.focus();
			} else if (err instanceof ApiClientError && err.status === 422) {
				const msg = firstIssueMessage(err.details);
				if (msg) {
					fieldError = msg;
					inputEl?.focus();
				} else formError = errorText(err, 'Speichern fehlgeschlagen');
			} else {
				formError = errorText(err, 'Speichern fehlgeschlagen');
			}
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>{title}</Dialog.Title>
			<Dialog.Description>
				{isRename ? 'Gib den neuen Namen ein.' : 'Gib einen Namen für den neuen Ordner ein.'}
			</Dialog.Description>
		</Dialog.Header>
		<form class="grid gap-4" onsubmit={submit} novalidate>
			<FormField label="Name *" id={fieldId} error={fieldError}>
				<Input
					id={fieldId}
					bind:ref={inputEl}
					bind:value={name}
					maxlength={MAX_NAME}
					autocomplete="off"
					required
					aria-invalid={fieldError ? 'true' : undefined}
					aria-describedby={fieldError ? `${fieldId}-error` : undefined}
					oninput={() => (fieldError = null)}
				/>
			</FormField>
			{#if formError}
				<p role="alert" class="text-sm text-destructive">{formError}</p>
			{/if}
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)} disabled={busy}>
					Abbrechen
				</Button>
				<Button type="submit" disabled={busy}>
					{busy ? 'Speichert …' : isRename ? 'Umbenennen' : 'Anlegen'}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
