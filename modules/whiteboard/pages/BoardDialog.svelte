<script lang="ts">
	// Whiteboard anlegen bzw. Eigenschaften ändern (Name, Beschreibung, Farbe, Hintergrund, Aktion)
	import { tick, untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Textarea } from '$lib/components/ui/textarea';
	import { ColorPicker } from '$lib/components/ui/color-picker';
	import { SegmentedSlider } from '$lib/components/ui/segmented-slider';
	import { SelectField } from '$lib/components/ui/select-field';
	import { BUSY_SAVE, FormField } from '$lib/components/layout';
	import {
		BACKGROUNDS,
		BACKGROUND_LABELS,
		BOARD_COLORS,
		MAX_BOARD_DESCRIPTION,
		MAX_BOARD_NAME,
		boardInput,
		type Background,
		type Board,
		type BoardDetail,
		type RefCard
	} from '../schemas';
	import { BASE, errMsg, fieldErrors } from './helpers';

	let {
		open = $bindable(false),
		board = null,
		presetActionId = null,
		onsaved
	}: {
		open?: boolean;
		board?: Board | null;
		/** Aktion vorbelegen (Aufruf aus einer Aktion) */
		presetActionId?: string | null;
		onsaved: (board: Board | BoardDetail) => void;
	} = $props();

	let name = $state('');
	let description = $state('');
	let color = $state<string | null>(null);
	let background = $state<Background>('dots');
	let actionId = $state<string | null>(null);
	let actions = $state<RefCard[]>([]);
	let errors = $state<Record<string, string>>({});
	let busy = $state(false);

	const editing = $derived(!!board);
	/** Aktion ändern darf nur, wer teilen darf (Eigentümer*in); beim Anlegen alle */
	const canChangeAction = $derived(!board || board.access.canShare);
	const actionOptions = $derived(
		actions
			.filter((a) => a.available && a.badge !== 'nur lesen')
			.map((a) => ({ value: a.id, label: a.title }))
	);
	const backgroundOptions = BACKGROUNDS.map((b) => ({ value: b, label: BACKGROUND_LABELS[b] }));

	$effect(() => {
		if (!open) return;
		untrack(() => {
			name = board?.name ?? '';
			description = board?.description ?? '';
			color = board?.color ?? BOARD_COLORS[0];
			background = board?.background ?? 'dots';
			actionId = board?.actionId ?? presetActionId;
			errors = {};
			void loadActions();
		});
		void tick().then(() => document.getElementById('wb-name')?.focus());
	});

	async function loadActions() {
		try {
			actions = await apiFetch<RefCard[]>(`${BASE}/refs?type=action&limit=100`);
			// aktuell verknüpfte Aktion auch ohne Treffer anzeigen
			if (board?.actionId && board.actionName && !actions.some((a) => a.id === board?.actionId)) {
				actions = [
					...actions,
					{
						type: 'action',
						id: board.actionId,
						available: true,
						title: board.actionName,
						subtitle: null,
						href: null,
						color: null,
						imageUrl: null,
						badge: null
					}
				];
			}
		} catch {
			actions = []; // Modul „Aktionen“ nicht aktiv oder kein Recht → keine Auswahl
		}
	}

	async function save(e: SubmitEvent) {
		e.preventDefault();
		const parsed = boardInput.safeParse({ name, description, color, background, actionId });
		if (!parsed.success) {
			errors = Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message]));
			return;
		}
		busy = true;
		try {
			const body: Record<string, unknown> = {
				name: parsed.data.name,
				description: parsed.data.description,
				color: parsed.data.color,
				background: parsed.data.background
			};
			if (!editing || (canChangeAction && parsed.data.actionId !== (board?.actionId ?? null))) {
				body.actionId = parsed.data.actionId;
			}
			const saved = await apiFetch<Board | BoardDetail>(
				editing ? `${BASE}/boards/${board!.id}` : `${BASE}/boards`,
				{ method: editing ? 'PATCH' : 'POST', body: JSON.stringify(body) }
			);
			toast.success(editing ? 'Whiteboard gespeichert' : 'Whiteboard angelegt');
			open = false;
			onsaved(saved);
		} catch (err) {
			errors = fieldErrors(err);
			toast.error(errMsg(err, 'Speichern fehlgeschlagen'));
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>{editing ? 'Whiteboard bearbeiten' : 'Neues Whiteboard'}</Dialog.Title>
			<Dialog.Description>
				{editing
					? 'Name, Beschreibung, Farbe, Hintergrund und Aktion.'
					: 'Ein leeres Whiteboard für Ideen, Planung und Notizen – gemeinsam und live.'}
			</Dialog.Description>
		</Dialog.Header>
		<form class="space-y-4" onsubmit={save} novalidate>
			<FormField label="Name" id="wb-name" required error={errors.name}>
				<Input id="wb-name" bind:value={name} maxlength={MAX_BOARD_NAME} autocomplete="off" />
			</FormField>
			<FormField label="Beschreibung" id="wb-description" error={errors.description}>
				<Textarea
					id="wb-description"
					bind:value={description}
					rows={3}
					maxlength={MAX_BOARD_DESCRIPTION}
				/>
			</FormField>
			<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
				<FormField label="Farbe" id="wb-color" error={errors.color}>
					<ColorPicker id="wb-color" label="Farbe" bind:value={color} presets={[...BOARD_COLORS]} />
				</FormField>
				<FormField label="Hintergrund" id="wb-background">
					<SegmentedSlider
						label="Hintergrund"
						options={backgroundOptions}
						value={background}
						onchange={(v) => (background = v as Background)}
					/>
				</FormField>
			</div>
			{#if canChangeAction && (actionOptions.length || presetActionId || board?.actionId)}
				<FormField
					label="Aktion"
					id="wb-action"
					error={errors.actionId}
					hint="Wer die Aktion sehen oder bearbeiten darf, darf das auch beim Whiteboard."
				>
					<SelectField
						id="wb-action"
						label="Aktion"
						options={actionOptions}
						bind:value={actionId}
						emptyLabel="Keine Aktion"
						placeholder="Keine Aktion"
					/>
				</FormField>
			{/if}
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
				<Button type="submit" disabled={busy}>
					{busy ? BUSY_SAVE : editing ? 'Speichern' : 'Anlegen'}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
