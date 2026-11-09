<script lang="ts">
	import { onDestroy, tick, untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import CalendarClock from '@lucide/svelte/icons/calendar-clock';
	import ChevronDown from '@lucide/svelte/icons/chevron-down';
	import ChevronUp from '@lucide/svelte/icons/chevron-up';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import Plus from '@lucide/svelte/icons/plus';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
	import X from '@lucide/svelte/icons/x';
	import { apiFetch, ApiClientError } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Input } from '$lib/components/ui/input';
	import { Switch } from '$lib/components/ui/switch';
	import { Textarea } from '$lib/components/ui/textarea';
	import { MultiSelect } from '$lib/components/ui/multi-select';
	import { SelectField } from '$lib/components/ui/select-field';
	import {
		AssistTextarea,
		ConfirmDialog,
		ErrorState,
		FormField,
		LoadingState
	} from '$lib/components/layout';
	import { startsBeforeBlocker } from '../../dependencies';
	import {
		MAX_CHECKLIST_TITLE,
		MAX_TASK_DESCRIPTION,
		MAX_TASK_TITLE,
		MAX_TASKS_PER_BOARD,
		PRIORITIES,
		PRIORITY_LABELS,
		type ChecklistItem,
		type Column,
		type Phase,
		type TaskCard,
		type TaskDetail,
		type UserRef
	} from '../../schemas';
	import { BASE, dueClass, dueLabel, errMsg } from '../helpers';

	/**
	 * Inhalt des Aufgaben-Blatts: Anlegen (nur Titel) bzw. Ansehen/Bearbeiten mit Autosave.
	 * Texte speichern nach 800 ms bzw. beim Verlassen des Feldes, Auswahlfelder sofort.
	 */
	let {
		taskId = null,
		boardId,
		boardName,
		columns,
		phases,
		tasks,
		defaults = {},
		canEditBoard,
		onchanged,
		oncreated,
		onclose,
		onnavigate
	}: {
		/** `null` = neue Aufgabe */
		taskId?: string | null;
		boardId: string;
		boardName: string;
		columns: Column[];
		phases: Phase[];
		/** Aufgaben des Boards (Vorgänger-Auswahl, Vor/Zurück) */
		tasks: TaskCard[];
		defaults?: { columnId?: string | null; phaseId?: string | null; dueOn?: string | null };
		canEditBoard: boolean;
		/** Board neu laden (nach jeder Änderung) */
		onchanged: () => void;
		oncreated: (id: string) => void;
		onclose: () => void;
		/** vorige/nächste sichtbare Aufgabe öffnen; `null` = kein Nachbar */
		onnavigate?: { prev: (() => void) | null; next: (() => void) | null };
	} = $props();

	const uid = $props.id();
	const id = (name: string) => `${uid}-${name}`;
	const priorityOptions = PRIORITIES.map((p) => ({ value: p, label: PRIORITY_LABELS[p] }));
	const columnOptions = $derived(columns.map((c) => ({ value: c.id, label: c.name })));
	const phaseOptions = $derived(phases.map((p) => ({ value: p.id, label: p.name })));

	let detail = $state<TaskDetail | null>(null);
	let loading = $state(false);
	let loadError = $state('');
	let people = $state<UserRef[]>([]);
	let title = $state('');
	let description = $state('');
	let newItem = $state('');
	let errors = $state<Record<string, string>>({});
	let status = $state<'idle' | 'saving' | 'saved' | 'error'>('idle');
	let deleteOpen = $state(false);
	let creating = $state(false);

	const isNew = $derived(!taskId);
	const canEdit = $derived(isNew ? canEditBoard : (detail?.canEdit ?? false));
	const canMove = $derived(detail?.canMove ?? false);
	const peopleOptions = $derived.by(() => {
		const map = new Map<string, UserRef>();
		for (const p of people) map.set(p.id, p);
		for (const a of detail?.assignees ?? []) map.set(a.id, a);
		for (const i of detail?.items ?? []) if (i.assignee) map.set(i.assignee.id, i.assignee);
		return [...map.values()]
			.sort((a, b) => a.name.localeCompare(b.name, 'de'))
			.map((p) => ({ value: p.id, label: p.name }));
	});
	const blockerOptions = $derived(
		tasks.filter((t) => t.id !== taskId).map((t) => ({ value: t.id, label: t.title }))
	);
	const conflicts = $derived(
		detail
			? tasks.filter(
					(t) =>
						detail!.blockedBy.includes(t.id) &&
						startsBeforeBlocker({ startsOn: detail!.startsOn, dueOn: detail!.dueOn }, t)
				)
			: []
	);
	const doneColumn = $derived(columns.find((c) => c.id === detail?.columnId)?.isDone ?? false);

	$effect(() => {
		const tid = taskId;
		untrack(() => {
			flush();
			errors = {};
			newItem = '';
			status = 'idle';
			detail = null;
			loadError = '';
			if (tid) void load(tid);
			else {
				title = '';
				void tick().then(() => document.getElementById(id('title'))?.focus());
			}
			if (canEditBoard && !people.length) void loadPeople();
		});
	});

	async function load(tid: string) {
		loading = true;
		try {
			fill(await apiFetch<TaskDetail>(`${BASE}/tasks/${tid}`), true);
		} catch (e) {
			loadError = errMsg(e, 'Aufgabe konnte nicht geladen werden');
		} finally {
			loading = false;
		}
	}

	/** Antwort übernehmen; laufende Texteingaben bleiben stehen */
	function fill(d: TaskDetail, all = false) {
		detail = d;
		if (all || !titleTimer) title = d.title;
		if (all || !descTimer) description = d.description ?? '';
	}

	async function loadPeople() {
		try {
			people = await apiFetch<UserRef[]>(`${BASE}/boards/${boardId}/people`);
		} catch {
			people = [];
		}
	}

	function fieldErrors(e: unknown) {
		if (e instanceof ApiClientError && Array.isArray(e.details)) {
			errors = Object.fromEntries(
				(e.details as { path?: (string | number)[]; message: string }[]).map((d) => [
					String(d.path?.[0] ?? ''),
					d.message
				])
			);
		}
	}

	// --- Anlegen ---------------------------------------------------------------

	async function create(e: SubmitEvent) {
		e.preventDefault();
		const value = title.trim();
		if (!value) {
			errors = { title: 'Pflichtfeld' };
			return;
		}
		creating = true;
		try {
			const t = await apiFetch<TaskDetail>(`${BASE}/boards/${boardId}/tasks`, {
				method: 'POST',
				body: JSON.stringify({
					title: value,
					columnId: defaults.columnId ?? undefined,
					phaseId: defaults.phaseId ?? null,
					dueOn: defaults.dueOn ?? null
				})
			});
			onchanged();
			oncreated(t.id);
		} catch (err) {
			fieldErrors(err);
			toast.error(errMsg(err, 'Anlegen fehlgeschlagen'));
		} finally {
			creating = false;
		}
	}

	// --- Speichern -------------------------------------------------------------

	async function run(path: string, init: Parameters<typeof apiFetch>[1], fallback: string) {
		status = 'saving';
		try {
			fill(await apiFetch<TaskDetail>(`${BASE}${path}`, init));
			errors = {};
			status = 'saved';
			onchanged();
		} catch (err) {
			fieldErrors(err);
			status = 'error';
			toast.error(errMsg(err, fallback));
			if (detail) await load(detail.id);
		}
	}

	const patch = (body: Record<string, unknown>) =>
		detail
			? run(
					`/tasks/${detail.id}`,
					{ method: 'PATCH', body: JSON.stringify(body) },
					'Speichern fehlgeschlagen'
				)
			: Promise.resolve();

	let titleTimer: ReturnType<typeof setTimeout> | null = null;
	let descTimer: ReturnType<typeof setTimeout> | null = null;

	function saveTitle() {
		if (titleTimer) clearTimeout(titleTimer);
		titleTimer = null;
		const value = title.trim();
		if (!detail || !canEdit) return;
		if (!value) {
			errors = { ...errors, title: 'Pflichtfeld' };
			return;
		}
		if (value !== detail.title) void patch({ title: value });
	}

	function saveDescription() {
		if (descTimer) clearTimeout(descTimer);
		descTimer = null;
		if (!detail || !canEdit) return;
		if (description !== (detail.description ?? '')) void patch({ description });
	}

	function queue(kind: 'title' | 'description') {
		if (isNew) return;
		status = 'idle';
		if (kind === 'title') {
			if (titleTimer) clearTimeout(titleTimer);
			titleTimer = setTimeout(saveTitle, 800);
		} else {
			if (descTimer) clearTimeout(descTimer);
			descTimer = setTimeout(saveDescription, 800);
		}
	}

	/** Ausstehende Texte sofort speichern (Schließen, andere Aufgabe) */
	function flush() {
		if (titleTimer) saveTitle();
		if (descTimer) saveDescription();
	}
	onDestroy(flush);

	function close() {
		flush();
		onclose();
	}

	async function moveTo(next: string | null) {
		if (!detail || !next || next === detail.columnId) return;
		await run(
			`/tasks/${detail.id}/move`,
			{ method: 'POST', body: JSON.stringify({ columnId: next, position: MAX_TASKS_PER_BOARD }) },
			'Verschieben fehlgeschlagen'
		);
	}

	function setDate(field: 'startsOn' | 'dueOn', value: string) {
		void patch({ [field]: value || null });
	}

	function setDependencies(ids: string[]) {
		if (!detail) return;
		void run(
			`/tasks/${detail.id}/dependencies`,
			{ method: 'PUT', body: JSON.stringify({ ids }) },
			'Speichern fehlgeschlagen'
		);
	}

	// --- Unteraufgaben ---

	async function addItem() {
		const value = newItem.trim();
		if (!value || !detail) return;
		newItem = '';
		await run(
			`/tasks/${detail.id}/checklist`,
			{ method: 'POST', body: JSON.stringify({ title: value }) },
			'Hinzufügen fehlgeschlagen'
		);
	}

	/** Unteraufgaben aus der Schreibhilfe nacheinander anlegen */
	async function addSuggestedItems(items: string[]) {
		if (!detail) return;
		for (const raw of items) {
			const value = raw.trim().slice(0, MAX_CHECKLIST_TITLE);
			if (!value) continue;
			await run(
				`/tasks/${detail.id}/checklist`,
				{ method: 'POST', body: JSON.stringify({ title: value }) },
				'Hinzufügen fehlgeschlagen'
			);
		}
	}

	const patchItem = (item: ChecklistItem, body: Record<string, unknown>) =>
		detail
			? run(
					`/tasks/${detail.id}/checklist/${item.id}`,
					{ method: 'PATCH', body: JSON.stringify(body) },
					'Speichern fehlgeschlagen'
				)
			: Promise.resolve();

	const removeItem = (item: ChecklistItem) =>
		detail
			? run(
					`/tasks/${detail.id}/checklist/${item.id}`,
					{ method: 'DELETE' },
					'Löschen fehlgeschlagen'
				)
			: Promise.resolve();

	function renameItem(item: ChecklistItem, value: string) {
		const v = value.trim();
		if (v && v !== item.title) void patchItem(item, { title: v });
	}

	async function deleteTask() {
		if (!detail) return;
		try {
			await apiFetch(`${BASE}/tasks/${detail.id}`, { method: 'DELETE' });
			toast.success('Aufgabe gelöscht');
			onchanged();
			onclose();
		} catch (err) {
			toast.error(errMsg(err, 'Löschen fehlgeschlagen'));
		}
	}

	const columnName = $derived(columns.find((c) => c.id === detail?.columnId)?.name ?? '');
</script>

<div class="flex h-full min-h-0 flex-col">
	<!-- Kopf: Pfad, Speicherstand, Vor/Zurück, Menü, Schließen -->
	<div class="flex items-center gap-1 border-b px-4 py-2.5">
		<p class="min-w-0 flex-1 truncate text-xs text-muted-foreground">
			{boardName}{#if columnName}&nbsp;› {columnName}{/if}
		</p>
		<span class="text-xs whitespace-nowrap" aria-live="polite">
			{#if status === 'saving'}
				<span class="text-muted-foreground">Speichert …</span>
			{:else if status === 'saved'}
				<span class="text-success">Gespeichert</span>
			{:else if status === 'error'}
				<span class="text-destructive">Nicht gespeichert</span>
			{/if}
		</span>
		{#if onnavigate && !isNew}
			<Button
				variant="ghost"
				size="icon-sm"
				aria-label="Vorige Aufgabe"
				disabled={!onnavigate.prev}
				onclick={() => {
					flush();
					onnavigate?.prev?.();
				}}
			>
				<ChevronUp />
			</Button>
			<Button
				variant="ghost"
				size="icon-sm"
				aria-label="Nächste Aufgabe"
				disabled={!onnavigate.next}
				onclick={() => {
					flush();
					onnavigate?.next?.();
				}}
			>
				<ChevronDown />
			</Button>
		{/if}
		{#if detail && canEdit}
			<DropdownMenu.Root>
				<DropdownMenu.Trigger>
					{#snippet child({ props })}
						<Button {...props} variant="ghost" size="icon-sm" aria-label="Mehr zur Aufgabe">
							<Ellipsis />
						</Button>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content align="end" class="w-48">
					<DropdownMenu.Item class="text-destructive" onclick={() => (deleteOpen = true)}>
						<Trash2 /> Aufgabe löschen
					</DropdownMenu.Item>
				</DropdownMenu.Content>
			</DropdownMenu.Root>
		{/if}
		<Button variant="ghost" size="icon-sm" aria-label="Schließen" onclick={close}>
			<X />
		</Button>
	</div>

	<div class="min-h-0 flex-1 overflow-y-auto px-4 py-4">
		{#if isNew}
			<form class="space-y-3" onsubmit={create} novalidate>
				<FormField label="Titel" id={id('title')} required error={errors.title}>
					<Input
						id={id('title')}
						bind:value={title}
						maxlength={MAX_TASK_TITLE}
						autocomplete="off"
						placeholder="Was ist zu tun?"
					/>
				</FormField>
				<p class="text-xs text-muted-foreground">
					Nach dem Anlegen kannst du Zuständige, Zeitraum und Unteraufgaben ergänzen.
				</p>
				<div class="flex justify-end gap-2">
					<Button type="button" variant="outline" onclick={close}>Abbrechen</Button>
					<Button type="submit" disabled={creating}>
						{creating ? 'Legt an …' : 'Anlegen'}
					</Button>
				</div>
			</form>
		{:else if loading && !detail}
			<LoadingState label="Aufgabe" rows={5} />
		{:else if loadError}
			<ErrorState message={loadError} onretry={() => (taskId ? load(taskId) : undefined)} compact />
		{:else if detail}
			<div class="space-y-5">
				<div>
					<label for={id('title')} class="sr-only">Titel</label>
					{#if canEdit}
						<Textarea
							id={id('title')}
							class="min-h-0 resize-none border-transparent px-1 text-lg font-semibold shadow-none hover:border-input focus-visible:border-input"
							rows={1}
							maxlength={MAX_TASK_TITLE}
							bind:value={title}
							aria-invalid={errors.title ? true : undefined}
							oninput={() => queue('title')}
							onblur={saveTitle}
							onkeydown={(e) => {
								if (e.key === 'Enter') {
									e.preventDefault();
									e.currentTarget.blur();
								}
							}}
						/>
					{:else}
						<h3 id={id('title')} class="px-1 text-lg font-semibold">{detail.title}</h3>
					{/if}
					{#if errors.title}
						<p role="alert" class="px-1 text-xs text-destructive">{errors.title}</p>
					{/if}
				</div>

				<dl class="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2.5 text-sm">
					<dt class="text-muted-foreground"><label for={id('column')}>Stand</label></dt>
					<dd>
						<SelectField
							id={id('column')}
							size="sm"
							label="Stand"
							options={columnOptions}
							value={detail.columnId}
							onchange={moveTo}
							disabled={!canMove}
						/>
					</dd>

					{#if phases.length}
						<dt class="text-muted-foreground"><label for={id('phase')}>Phase</label></dt>
						<dd>
							<SelectField
								id={id('phase')}
								size="sm"
								label="Phase"
								options={phaseOptions}
								value={detail.phaseId}
								emptyLabel="Ohne Phase"
								placeholder="Ohne Phase"
								onchange={(v) => patch({ phaseId: v })}
								disabled={!canEdit}
							/>
						</dd>
					{/if}

					<dt class="text-muted-foreground"><label for={id('milestone')}>Meilenstein</label></dt>
					<dd class="flex items-center gap-2">
						<Switch
							id={id('milestone')}
							checked={detail.isMilestone}
							disabled={!canEdit}
							onCheckedChange={(v) => patch({ isMilestone: v })}
						/>
						<span class="text-xs text-muted-foreground">
							{detail.isMilestone ? 'ein Stichtag, als Raute dargestellt' : 'nein'}
						</span>
					</dd>

					{#if !detail.isMilestone}
						<dt class="text-muted-foreground"><label for={id('start')}>Beginn</label></dt>
						<dd>
							<Input
								id={id('start')}
								type="date"
								class="h-8"
								value={detail.startsOn ?? ''}
								disabled={!canEdit}
								aria-invalid={errors.startsOn ? true : undefined}
								onchange={(e) => setDate('startsOn', e.currentTarget.value)}
							/>
							{#if errors.startsOn}
								<p role="alert" class="mt-1 text-xs text-destructive">{errors.startsOn}</p>
							{/if}
						</dd>
					{/if}

					<dt class="text-muted-foreground">
						<label for={id('due')}>{detail.isMilestone ? 'Datum' : 'Fällig am'}</label>
					</dt>
					<dd>
						<Input
							id={id('due')}
							type="date"
							class="h-8"
							value={detail.dueOn ?? ''}
							disabled={!canEdit}
							aria-invalid={errors.dueOn ? true : undefined}
							onchange={(e) => setDate('dueOn', e.currentTarget.value)}
						/>
						{#if errors.dueOn}
							<p role="alert" class="mt-1 text-xs text-destructive">{errors.dueOn}</p>
						{/if}
					</dd>

					<dt class="text-muted-foreground"><label for={id('assignees')}>Zuständig</label></dt>
					<dd>
						<MultiSelect
							id={id('assignees')}
							label="Zuständig"
							options={peopleOptions}
							value={detail.assignees.map((a) => a.id)}
							onchange={(v: string[]) => patch({ assigneeIds: v })}
							placeholder="Niemand"
							searchPlaceholder="Person suchen …"
							emptyText="Niemand gefunden – weitere über „Teilen“"
							disabled={!canEdit}
						/>
					</dd>

					<dt class="text-muted-foreground"><label for={id('priority')}>Priorität</label></dt>
					<dd>
						<SelectField
							id={id('priority')}
							size="sm"
							label="Priorität"
							options={priorityOptions}
							value={detail.priority}
							onchange={(v) => v && patch({ priority: v })}
							disabled={!canEdit}
						/>
					</dd>

					{#if canEdit || detail.blockedBy.length}
						<dt class="text-muted-foreground"><label for={id('blocked')}>Wartet auf</label></dt>
						<dd>
							<MultiSelect
								id={id('blocked')}
								label="Wartet auf"
								options={blockerOptions}
								value={detail.blockedBy}
								onchange={setDependencies}
								placeholder="Keine anderen Aufgaben"
								searchPlaceholder="Aufgabe suchen …"
								emptyText="Keine Aufgabe gefunden"
								disabled={!canEdit}
							/>
						</dd>
					{/if}
				</dl>
				{#if errors.ids}
					<p role="alert" class="text-xs text-destructive">{errors.ids}</p>
				{/if}
				{#if conflicts.length}
					<p class="flex items-start gap-1.5 text-xs text-warning" role="status">
						<TriangleAlert class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
						Beginnt vor der Fälligkeit von „{conflicts.map((c) => c.title).join('“, „')}“.
					</p>
				{/if}

				<FormField label="Beschreibung" id={id('description')} error={errors.description}>
					<AssistTextarea
						id={id('description')}
						bind:value={description}
						assist={canEdit
							? { module: 'tasks', purpose: 'task-description', extra: () => ({ title }) }
							: undefined}
						onassist={() => saveDescription()}
						onitems={addSuggestedItems}
						rows={4}
						maxlength={MAX_TASK_DESCRIPTION}
						placeholder={canEdit ? 'Details, Links, Absprachen …' : ''}
						readonly={!canEdit}
						oninput={() => queue('description')}
						onblur={saveDescription}
					/>
				</FormField>

				<section class="space-y-2" aria-labelledby={id('checklist')}>
					<div class="flex items-baseline justify-between">
						<h3 id={id('checklist')} class="text-sm font-medium">Unteraufgaben</h3>
						{#if detail.checklist.total}
							<span class="text-xs text-muted-foreground tabular-nums">
								{detail.checklist.done} von {detail.checklist.total} erledigt
							</span>
						{/if}
					</div>
					{#if detail.items.length}
						<ul class="divide-y rounded-md border">
							{#each detail.items as item (item.id)}
								<li class="flex flex-wrap items-center gap-2 px-3 py-2">
									<Checkbox
										checked={item.done}
										disabled={!canMove}
										aria-label={`„${item.title}“ erledigt`}
										onCheckedChange={(v) => patchItem(item, { done: v === true })}
									/>
									{#if canEdit}
										<Input
											class={`h-8 min-w-0 flex-1 border-transparent shadow-none hover:border-input ${item.done ? 'text-muted-foreground line-through' : ''}`}
											value={item.title}
											maxlength={MAX_CHECKLIST_TITLE}
											aria-label="Titel der Unteraufgabe"
											onblur={(e) => renameItem(item, e.currentTarget.value)}
											onkeydown={(e) => {
												if (e.key === 'Enter') {
													e.preventDefault();
													e.currentTarget.blur();
												}
											}}
										/>
									{:else}
										<span
											class="min-w-0 flex-1 text-sm"
											class:line-through={item.done}
											class:text-muted-foreground={item.done}>{item.title}</span
										>
									{/if}
									{#if canEdit}
										<div class="flex w-full items-center gap-2 pl-6">
											<SelectField
												size="sm"
												class="min-w-0 flex-1"
												label={`Zuständig für „${item.title}“`}
												options={peopleOptions}
												value={item.assignee?.id ?? null}
												emptyLabel="Niemand"
												placeholder="Niemand"
												onchange={(v) => patchItem(item, { assigneeId: v })}
											/>
											<Input
												type="date"
												class="h-8 w-36"
												aria-label={`Fällig am (${item.title})`}
												value={item.dueOn ?? ''}
												onchange={(e) => patchItem(item, { dueOn: e.currentTarget.value || null })}
											/>
											<Button
												type="button"
												variant="ghost"
												size="icon-sm"
												aria-label={`„${item.title}“ löschen`}
												onclick={() => removeItem(item)}
											>
												<Trash2 />
											</Button>
										</div>
									{:else if item.assignee || item.dueOn}
										<span class="w-full pl-6 text-xs text-muted-foreground">
											{item.assignee?.name ?? ''}
											{#if item.dueOn}
												<span class={dueClass(item.dueOn, item.done)}>
													{item.assignee ? '· ' : ''}{dueLabel(item.dueOn, item.done)}
												</span>
											{/if}
										</span>
									{/if}
								</li>
							{/each}
						</ul>
					{/if}
					{#if canEdit}
						<form
							class="flex gap-2"
							onsubmit={(e) => {
								e.preventDefault();
								void addItem();
							}}
						>
							<Input
								bind:value={newItem}
								maxlength={MAX_CHECKLIST_TITLE}
								placeholder="Unteraufgabe hinzufügen …"
								aria-label="Neue Unteraufgabe"
							/>
							<Button type="submit" variant="outline" disabled={!newItem.trim()}>
								<Plus /> Hinzufügen
							</Button>
						</form>
					{/if}
				</section>

				<p class="flex items-center gap-1.5 text-xs text-muted-foreground">
					<CalendarClock class="size-3.5" aria-hidden="true" />
					Angelegt {detail.createdBy ? `von ${detail.createdBy.name} ` : ''}am
					{new Date(detail.createdAt).toLocaleDateString('de-DE')}
					{#if doneColumn && detail.completedAt}
						· erledigt am {new Date(detail.completedAt).toLocaleDateString('de-DE')}
					{/if}
				</p>
			</div>
		{/if}
	</div>
</div>

<ConfirmDialog
	bind:open={deleteOpen}
	title="Aufgabe löschen?"
	description="Die Aufgabe und ihre Unteraufgaben werden endgültig gelöscht."
	confirmLabel="Löschen"
	destructive
	onconfirm={deleteTask}
/>
