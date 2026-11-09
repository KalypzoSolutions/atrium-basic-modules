<script lang="ts">
	import { toast } from 'svelte-sonner';
	import ArrowDown from '@lucide/svelte/icons/arrow-down';
	import ArrowUp from '@lucide/svelte/icons/arrow-up';
	import Plus from '@lucide/svelte/icons/plus';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { apiFetch, ApiClientError } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import { ColorPicker } from '$lib/components/ui/color-picker';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { ConfirmDialog, FormField } from '$lib/components/layout';
	import {
		BOARD_COLORS,
		MAX_PHASE_NAME,
		MAX_PHASES,
		phaseInput,
		type BoardDetail,
		type Phase
	} from '../../schemas';
	import { BASE, errMsg } from '../helpers';

	/** Phasen eines Boards verwalten: Name, Farbe, Zeitraum, Reihenfolge; Änderungen speichern sofort */
	let {
		open = $bindable(false),
		board,
		onchanged
	}: {
		open?: boolean;
		board: BoardDetail;
		onchanged: (board: BoardDetail) => void;
	} = $props();

	const uid = $props.id();
	let name = $state('');
	let startsOn = $state('');
	let endsOn = $state('');
	let errors = $state<Record<string, string>>({});
	let rowErrors = $state<Record<string, string>>({});
	let busy = $state(false);
	let remove = $state<Phase | null>(null);
	let removeOpen = $state(false);

	const phases = $derived(board.phases);
	const nextColor = $derived(
		BOARD_COLORS.find((c) => !phases.some((p) => p.color === c)) ?? BOARD_COLORS[0]
	);

	async function call(
		path: string,
		init: Parameters<typeof apiFetch>[1],
		fallback: string,
		key = ''
	) {
		try {
			onchanged(await apiFetch<BoardDetail>(`${BASE}/boards/${board.id}${path}`, init));
			if (key) rowErrors = { ...rowErrors, [key]: '' };
			return true;
		} catch (e) {
			const detail =
				e instanceof ApiClientError && Array.isArray(e.details)
					? (e.details as { message: string }[])[0]?.message
					: undefined;
			if (key && detail) rowErrors = { ...rowErrors, [key]: detail };
			else toast.error(errMsg(e, fallback));
			return false;
		}
	}

	async function add(e: SubmitEvent) {
		e.preventDefault();
		const parsed = phaseInput.safeParse({
			name,
			color: nextColor,
			startsOn: startsOn || null,
			endsOn: endsOn || null
		});
		if (!parsed.success) {
			errors = Object.fromEntries(parsed.error.issues.map((i) => [String(i.path[0]), i.message]));
			return;
		}
		busy = true;
		errors = {};
		if (
			await call(
				'/phases',
				{ method: 'POST', body: JSON.stringify(parsed.data) },
				'Anlegen fehlgeschlagen'
			)
		) {
			name = '';
			startsOn = '';
			endsOn = '';
			document.getElementById(`${uid}-name`)?.focus();
		}
		busy = false;
	}

	const update = (p: Phase, body: Record<string, unknown>) =>
		call(
			`/phases/${p.id}`,
			{ method: 'PATCH', body: JSON.stringify(body) },
			'Speichern fehlgeschlagen',
			p.id
		);

	function rename(p: Phase, value: string) {
		const v = value.trim();
		if (!v) {
			rowErrors = { ...rowErrors, [p.id]: 'Name fehlt' };
			return;
		}
		if (v !== p.name) void update(p, { name: v });
	}

	const colorTimers = new Map<string, ReturnType<typeof setTimeout>>();
	function recolor(p: Phase, color: string | null) {
		clearTimeout(colorTimers.get(p.id));
		colorTimers.set(
			p.id,
			setTimeout(() => {
				if (color !== p.color) void update(p, { color });
			}, 600)
		);
	}

	function move(index: number, dir: -1 | 1) {
		const ids = phases.map((p) => p.id);
		const j = index + dir;
		if (j < 0 || j >= ids.length) return;
		[ids[index], ids[j]] = [ids[j]!, ids[index]!];
		void call(
			'/phases/order',
			{ method: 'PUT', body: JSON.stringify({ ids }) },
			'Umsortieren fehlgeschlagen'
		);
	}

	async function confirmRemove() {
		const p = remove;
		if (!p) return;
		remove = null;
		await call(`/phases/${p.id}`, { method: 'DELETE' }, 'Löschen fehlgeschlagen');
	}

	const countOf = (p: Phase) => board.tasks.filter((t) => t.phaseId === p.id).length;
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-2xl">
		<Dialog.Header>
			<Dialog.Title>Phasen</Dialog.Title>
			<Dialog.Description>
				Zeitabschnitte des Boards, z. B. Planung, Anmeldung, Durchführung, Nachbereitung. Daten sind
				optional, Änderungen werden sofort gespeichert.
			</Dialog.Description>
		</Dialog.Header>

		{#if phases.length}
			<ol class="divide-y rounded-md border" aria-label="Phasen">
				{#each phases as p, i (p.id)}
					<li class="space-y-2 px-3 py-2.5">
						<div class="flex flex-wrap items-center gap-2">
							<ColorPicker
								label={`Farbe von „${p.name}“`}
								value={p.color}
								presets={[...BOARD_COLORS]}
								onchange={(c) => recolor(p, c)}
								class="w-auto"
							/>
							<Input
								class="h-8 min-w-0 flex-1"
								value={p.name}
								maxlength={MAX_PHASE_NAME}
								aria-label="Name der Phase"
								onblur={(e) => rename(p, e.currentTarget.value)}
								onkeydown={(e) => {
									if (e.key === 'Enter') {
										e.preventDefault();
										e.currentTarget.blur();
									}
								}}
							/>
							<div class="flex items-center gap-0.5">
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label={`„${p.name}“ nach oben`}
									disabled={i === 0}
									onclick={() => move(i, -1)}
								>
									<ArrowUp />
								</Button>
								<Button
									variant="ghost"
									size="icon-sm"
									aria-label={`„${p.name}“ nach unten`}
									disabled={i === phases.length - 1}
									onclick={() => move(i, 1)}
								>
									<ArrowDown />
								</Button>
								<Button
									variant="ghost"
									size="icon-sm"
									class="text-destructive"
									aria-label={`„${p.name}“ löschen`}
									onclick={() => {
										remove = p;
										removeOpen = true;
									}}
								>
									<Trash2 />
								</Button>
							</div>
						</div>
						<div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
							<Input
								type="date"
								class="h-8"
								aria-label={`Beginn von „${p.name}“`}
								value={p.startsOn ?? ''}
								onchange={(e) => update(p, { startsOn: e.currentTarget.value || null })}
							/>
							<Input
								type="date"
								class="h-8"
								aria-label={`Ende von „${p.name}“`}
								value={p.endsOn ?? ''}
								onchange={(e) => update(p, { endsOn: e.currentTarget.value || null })}
							/>
						</div>
						{#if rowErrors[p.id]}
							<p role="alert" class="text-xs text-destructive">{rowErrors[p.id]}</p>
						{/if}
					</li>
				{/each}
			</ol>
		{:else}
			<p class="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
				Noch keine Phasen. Lege die erste unten an.
			</p>
		{/if}

		{#if phases.length < MAX_PHASES}
			<form class="space-y-3 rounded-md bg-muted/40 p-3" onsubmit={add} novalidate>
				<p class="text-sm font-medium">Neue Phase</p>
				<FormField label="Name" id={`${uid}-name`} required error={errors.name}>
					<Input
						id={`${uid}-name`}
						bind:value={name}
						maxlength={MAX_PHASE_NAME}
						autocomplete="off"
						placeholder="z. B. Vorbereitung"
					/>
				</FormField>
				<div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
					<FormField label="Beginn" id={`${uid}-start`} error={errors.startsOn}>
						<Input id={`${uid}-start`} type="date" bind:value={startsOn} />
					</FormField>
					<FormField label="Ende" id={`${uid}-end`} error={errors.endsOn}>
						<Input id={`${uid}-end`} type="date" bind:value={endsOn} />
					</FormField>
				</div>
				<div class="flex justify-end">
					<Button type="submit" disabled={busy}><Plus /> Phase anlegen</Button>
				</div>
			</form>
		{/if}

		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)}>Fertig</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<ConfirmDialog
	bind:open={removeOpen}
	title={`Phase „${remove?.name ?? ''}“ löschen?`}
	description={remove && countOf(remove)
		? `${countOf(remove)} Aufgaben bleiben erhalten und sind danach ohne Phase.`
		: 'Die Phase enthält keine Aufgaben.'}
	confirmLabel="Löschen"
	destructive
	onconfirm={confirmRemove}
/>
