<script lang="ts">
	import { goto, replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import { untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import CalendarRange from '@lucide/svelte/icons/calendar-range';
	import CopyPlus from '@lucide/svelte/icons/copy-plus';
	import Ellipsis from '@lucide/svelte/icons/ellipsis';
	import Flag from '@lucide/svelte/icons/flag';
	import MoveHorizontal from '@lucide/svelte/icons/move-horizontal';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Pin from '@lucide/svelte/icons/pin';
	import Plus from '@lucide/svelte/icons/plus';
	import Tent from '@lucide/svelte/icons/tent';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import type { ModulePageProps } from '$lib/sdk/types/module-ui';
	import type { PrincipalInfo } from '$lib/sdk/types/sharing';
	import { apiFetch, can } from '$lib/sdk/client';
	import { todayBerlin } from '$lib/sdk/dates';
	import { Alert, AlertDescription } from '$lib/components/ui/alert';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu';
	import { Input } from '$lib/components/ui/input';
	import { SelectField } from '$lib/components/ui/select-field';
	import * as Tabs from '$lib/components/ui/tabs';
	import {
		ConfirmDialog,
		deviceLayout,
		EmptyState,
		ErrorState,
		FormField,
		LoadingState,
		NumberStepper,
		PageHeader,
		PageTitle,
		ShareMenu,
		toastWithUndo,
		type ShareCandidate,
		type ShareEntry
	} from '$lib/components/layout';
	import { shareKey } from '$lib/components/layout/share-types';
	import {
		MAX_COLUMN_NAME,
		MAX_SHIFT_DAYS,
		MAX_TASKS_PER_BOARD,
		MAX_TEMPLATE_NAME,
		PERM,
		SHARE_LEVEL_LABELS,
		SHARE_LEVELS,
		VIEW_LABELS,
		VIEWS,
		type BoardDetail,
		type BoardShares,
		type BoardView,
		type Column,
		type TaskCard,
		type UserRef
	} from '../schemas';
	import type { DateRange, TimelineTarget } from '../timeline';
	import BoardDialog from './BoardDialog.svelte';
	import BoardFilters from './board/BoardFilters.svelte';
	import MobileBoard from './board/MobileBoard.svelte';
	import PhaseStrip from './board/PhaseStrip.svelte';
	import PhasesDialog from './board/PhasesDialog.svelte';
	import { emptyFilter, matchesFilter, activeFilterCount, type TaskFilter } from './filter';
	import { BASE, errMsg } from './helpers';
	import TaskSheet from './task/TaskSheet.svelte';
	import CalendarView from './views/CalendarView.svelte';
	import KanbanView from './views/KanbanView.svelte';
	import ListView from './views/ListView.svelte';
	import TimelineView from './views/TimelineView.svelte';

	let { params }: ModulePageProps = $props();
	const id = $derived(params.id ?? '');
	const myId = $derived((page.data.user as { id?: string } | null | undefined)?.id ?? null);
	const permissions = $derived((page.data.permissions ?? []) as string[]);
	const phone = $derived(deviceLayout() === 'phone');

	let board = $state<BoardDetail | null>(null);
	let loading = $state(true);
	let loadError = $state('');
	let notFound = $state(false);
	let shares = $state<BoardShares | null>(null);

	let filter = $state<TaskFilter>(emptyFilter());
	let grouping = $state(false);

	// Aufgaben-Blatt
	let sheetOpen = $state(false);
	let sheetTask = $state<string | null>(null);
	let sheetDefaults = $state<{
		columnId?: string | null;
		phaseId?: string | null;
		dueOn?: string | null;
	}>({});

	// Dialoge
	let editOpen = $state(false);
	let phasesOpen = $state(false);
	let deleteOpen = $state(false);
	let columnOpen = $state(false);
	let columnEdit = $state<Column | null>(null);
	let columnName = $state('');
	let columnError = $state('');
	let columnDelete = $state<Column | null>(null);
	let columnMoveTo = $state<string | null>(null);
	let templateOpen = $state(false);
	let templateName = $state('');
	let templateError = $state('');
	let shiftOpen = $state(false);
	let shiftDays = $state(7);

	const canEdit = $derived(board?.access.level === 'edit');
	const shareLevels = SHARE_LEVELS.map((l) => ({ value: l, label: SHARE_LEVEL_LABELS[l] }));
	const doneIds = $derived(new Set(board?.columns.filter((c) => c.isDone).map((c) => c.id) ?? []));
	const isDone = (t: TaskCard) => doneIds.has(t.columnId);

	// --- Ansicht (URL `?view=`, sonst Standard des Boards) ---
	const urlView = $derived(page.url.searchParams.get('view'));
	const view = $derived<BoardView>(
		urlView && (VIEWS as readonly string[]).includes(urlView)
			? (urlView as BoardView)
			: (board?.defaultView ?? 'board')
	);

	function setView(v: string) {
		const url = new URL(page.url);
		url.searchParams.set('view', v);
		void goto(url, { replaceState: true, keepFocus: true, noScroll: true });
	}

	async function load() {
		try {
			board = await apiFetch<BoardDetail>(`${BASE}/boards/${id}`);
			notFound = false;
			loadError = '';
		} catch (e) {
			if ((e as { status?: number }).status === 404) notFound = true;
			else loadError = errMsg(e, 'Board konnte nicht geladen werden');
		} finally {
			loading = false;
		}
	}

	async function loadShares() {
		try {
			shares = await apiFetch<BoardShares>(`${BASE}/boards/${id}/shares`);
		} catch {
			shares = null;
		}
	}

	$effect(() => {
		void id;
		untrack(() => {
			loading = true;
			filter = emptyFilter();
			void load();
			void loadShares();
			// Deep-Link `?task=<id>` (Benachrichtigung, Suche) öffnet die Aufgabe
			const fromUrl = page.url.searchParams.get('task');
			if (fromUrl) {
				openTask(fromUrl);
				const url = new URL(page.url);
				url.searchParams.delete('task');
				replaceState(url, page.state);
			}
		});
	});

	// --- Filter ---
	const today = todayBerlin();
	const visible = $derived(
		(board?.tasks ?? []).filter((t) => matchesFilter(t, filter, { myId, canEdit, today, isDone }))
	);
	const filtering = $derived(activeFilterCount(filter) > 0);
	const people = $derived.by(() => {
		const map = new Map<string, UserRef>();
		for (const t of board?.tasks ?? []) for (const a of t.assignees) map.set(a.id, a);
		return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'de'));
	});
	/** Reihenfolge für Vor/Zurück im Blatt: wie im Board (Spalte, Position) */
	const order = $derived(
		[...visible]
			.sort(
				(a, b) =>
					(board?.columns.findIndex((c) => c.id === a.columnId) ?? 0) -
						(board?.columns.findIndex((c) => c.id === b.columnId) ?? 0) || a.position - b.position
			)
			.map((t) => t.id)
	);

	// --- Aufgaben ---
	function openTask(tid: string) {
		sheetTask = tid;
		sheetOpen = true;
	}

	function newTask(defaults: typeof sheetDefaults = {}) {
		sheetDefaults = {
			phaseId: filter.phaseId && filter.phaseId !== 'none' ? filter.phaseId : null,
			...defaults
		};
		sheetTask = null;
		sheetOpen = true;
	}

	async function moveTask(
		taskId: string,
		columnId: string,
		position: number,
		phaseId?: string | null
	) {
		if (!board) return;
		// sofort anzeigen, danach mit dem Server abgleichen
		const done = board.columns.find((c) => c.id === columnId)?.isDone ?? false;
		const others = board.tasks
			.filter((t) => t.columnId === columnId && t.id !== taskId)
			.sort((a, b) => a.position - b.position);
		const task = board.tasks.find((t) => t.id === taskId);
		if (!task) return;
		others.splice(Math.min(position, others.length), 0, task);
		const pos = new Map(others.map((t, i) => [t.id, i]));
		board.tasks = board.tasks.map((t) =>
			t.id === taskId
				? {
						...t,
						columnId,
						position: pos.get(t.id)!,
						phaseId: phaseId === undefined ? t.phaseId : phaseId,
						completedAt: done ? (t.completedAt ?? new Date().toISOString()) : null
					}
				: pos.has(t.id)
					? { ...t, position: pos.get(t.id)! }
					: t
		);
		try {
			await apiFetch(`${BASE}/tasks/${taskId}/move`, {
				method: 'POST',
				body: JSON.stringify({ columnId, position })
			});
			if (phaseId !== undefined) {
				await apiFetch(`${BASE}/tasks/${taskId}`, {
					method: 'PATCH',
					body: JSON.stringify({ phaseId })
				});
			}
		} catch (e) {
			toast.error(errMsg(e, 'Verschieben fehlgeschlagen'));
		}
		await load();
	}

	function moveToEnd(taskId: string, columnId: string) {
		void moveTask(taskId, columnId, MAX_TASKS_PER_BOARD);
	}

	function toggleDone(t: TaskCard, done: boolean) {
		if (!board) return;
		const target = done
			? board.columns.find((c) => c.isDone)
			: board.columns.find((c) => !c.isDone);
		if (!target) {
			toast.error(done ? 'Das Board hat keine Erledigt-Spalte' : 'Keine offene Spalte vorhanden');
			return;
		}
		moveToEnd(t.id, target.id);
	}

	async function quickAdd(
		columnId: string,
		phaseId: string | null,
		title: string
	): Promise<boolean> {
		try {
			await apiFetch(`${BASE}/boards/${id}/tasks`, {
				method: 'POST',
				body: JSON.stringify({ columnId, title, phaseId })
			});
			await load();
			return true;
		} catch (e) {
			toast.error(errMsg(e, 'Anlegen fehlgeschlagen'));
			return false;
		}
	}

	async function assignMe(t: TaskCard) {
		if (!myId) return;
		try {
			await apiFetch(`${BASE}/tasks/${t.id}`, {
				method: 'PATCH',
				body: JSON.stringify({ assigneeIds: [...t.assignees.map((a) => a.id), myId] })
			});
			toast.success('Dir zugewiesen');
			await load();
		} catch (e) {
			toast.error(errMsg(e, 'Zuweisen fehlgeschlagen'));
		}
	}

	// --- Zeitleiste ---
	function datesFor(target: TimelineTarget, r: DateRange): Record<string, string | null> | null {
		if (!board) return null;
		if (target.kind === 'task') {
			const t = board.tasks.find((x) => x.id === target.id);
			if (!t) return null;
			if (t.isMilestone || (!t.startsOn && r.from === r.to)) return { dueOn: r.to };
			if (!t.dueOn) return { startsOn: r.from };
			return { startsOn: r.from, dueOn: r.to };
		}
		const p = board.phases.find((x) => x.id === target.id);
		if (!p) return null;
		if ((p.startsOn && p.endsOn) || r.from !== r.to) return { startsOn: r.from, endsOn: r.to };
		return p.startsOn ? { startsOn: r.from } : { endsOn: r.to };
	}

	async function patchDates(target: TimelineTarget, body: Record<string, string | null>) {
		const path =
			target.kind === 'task'
				? `${BASE}/tasks/${target.id}`
				: `${BASE}/boards/${id}/phases/${target.id}`;
		await apiFetch(path, { method: 'PATCH', body: JSON.stringify(body) });
	}

	async function changeDates(target: TimelineTarget, next: DateRange, prev: DateRange) {
		const body = datesFor(target, next);
		if (!body || !board) return;
		let before: Record<string, string | null>;
		if (target.kind === 'task') {
			const t = board.tasks.find((x) => x.id === target.id)!;
			before = t.isMilestone ? { dueOn: t.dueOn } : { startsOn: t.startsOn, dueOn: t.dueOn };
		} else {
			const p = board.phases.find((x) => x.id === target.id)!;
			before = { startsOn: p.startsOn, endsOn: p.endsOn };
		}
		try {
			await patchDates(target, body);
			await load();
			toastWithUndo({
				message: prev.from === next.from && prev.to !== next.to ? 'Ende geändert' : 'Verschoben',
				undo: () => patchDates(target, before),
				onundone: load
			});
		} catch (e) {
			toast.error(errMsg(e, 'Speichern fehlgeschlagen'));
			await load();
		}
	}

	// --- Spalten ---
	function openColumn(col: Column | null) {
		columnEdit = col;
		columnName = col?.name ?? '';
		columnError = '';
		columnOpen = true;
	}

	async function saveColumn(e: SubmitEvent) {
		e.preventDefault();
		const name = columnName.trim();
		if (!name) {
			columnError = 'Pflichtfeld';
			return;
		}
		try {
			board = await apiFetch<BoardDetail>(
				columnEdit
					? `${BASE}/boards/${id}/columns/${columnEdit.id}`
					: `${BASE}/boards/${id}/columns`,
				{ method: columnEdit ? 'PATCH' : 'POST', body: JSON.stringify({ name }) }
			);
			columnOpen = false;
		} catch (err) {
			columnError = errMsg(err, 'Speichern fehlgeschlagen');
		}
	}

	async function boardAction(path: string, init: Parameters<typeof apiFetch>[1], fallback: string) {
		try {
			board = await apiFetch<BoardDetail>(`${BASE}/boards/${id}${path}`, init);
			return true;
		} catch (e) {
			toast.error(errMsg(e, fallback));
			return false;
		}
	}

	function toggleDoneColumn(col: Column) {
		void boardAction(
			`/columns/${col.id}`,
			{ method: 'PATCH', body: JSON.stringify({ isDone: !col.isDone }) },
			'Speichern fehlgeschlagen'
		);
	}

	function moveColumn(col: Column, dir: -1 | 1) {
		if (!board) return;
		const ids = board.columns.map((c) => c.id);
		const i = ids.indexOf(col.id);
		const j = i + dir;
		if (j < 0 || j >= ids.length) return;
		[ids[i], ids[j]] = [ids[j]!, ids[i]!];
		void boardAction(
			'/columns/order',
			{ method: 'PUT', body: JSON.stringify({ ids }) },
			'Umsortieren fehlgeschlagen'
		);
	}

	const countOf = (columnId: string) =>
		board?.tasks.filter((t) => t.columnId === columnId).length ?? 0;

	function askDeleteColumn(col: Column) {
		columnDelete = col;
		columnMoveTo = board?.columns.find((c) => c.id !== col.id)?.id ?? null;
	}

	async function deleteColumn() {
		const col = columnDelete;
		if (!col) return;
		const hasTasks = countOf(col.id) > 0;
		await boardAction(
			`/columns/${col.id}${hasTasks && columnMoveTo ? `?moveTo=${columnMoveTo}` : ''}`,
			{ method: 'DELETE' },
			'Löschen fehlgeschlagen'
		);
		columnDelete = null;
	}

	// --- Board ---
	async function deleteBoard() {
		try {
			await apiFetch(`${BASE}/boards/${id}`, { method: 'DELETE' });
			toast.success('Board gelöscht');
			await goto(BASE);
		} catch (e) {
			toast.error(errMsg(e, 'Löschen fehlgeschlagen'));
		}
	}

	async function setDefaultView() {
		if (
			await boardAction(
				'',
				{ method: 'PATCH', body: JSON.stringify({ defaultView: view }) },
				'Speichern fehlgeschlagen'
			)
		) {
			toast.success(`„${VIEW_LABELS[view]}“ ist jetzt die Standardansicht`);
		}
	}

	async function shift(days: number, apply = true) {
		const before = board?.anchorOn;
		if (
			await boardAction(
				'/shift',
				{ method: 'POST', body: JSON.stringify({ days, apply }) },
				'Verschieben fehlgeschlagen'
			)
		) {
			if (apply) {
				toastWithUndo({
					message: `Alle Daten um ${Math.abs(days)} ${Math.abs(days) === 1 ? 'Tag' : 'Tage'} verschoben`,
					undo: () =>
						apiFetch(`${BASE}/boards/${id}/shift`, {
							method: 'POST',
							body: JSON.stringify({ days: -days })
						}),
					onundone: load
				});
			} else if (before !== board?.anchorOn) {
				toast.success('Hinweis ausgeblendet, Daten bleiben unverändert');
			}
		}
	}

	async function saveTemplate(e: SubmitEvent) {
		e.preventDefault();
		const name = templateName.trim();
		if (!name) {
			templateError = 'Pflichtfeld';
			return;
		}
		try {
			await apiFetch(`${BASE}/boards/${id}/template`, {
				method: 'POST',
				body: JSON.stringify({ name })
			});
			templateOpen = false;
			toast.success('Vorlage gespeichert – sie steht beim Anlegen neuer Boards zur Auswahl');
		} catch (err) {
			templateError = errMsg(err, 'Speichern fehlgeschlagen');
		}
	}

	// --- Freigaben ---
	async function searchPrincipals(q: string): Promise<ShareCandidate[]> {
		const found = await apiFetch<PrincipalInfo[]>(
			`${BASE}/principals?search=${encodeURIComponent(q)}`
		);
		return found
			.filter((p) => !(p.type === 'user' && p.id === board?.owner.id))
			.map((p) => ({
				id: p.id,
				type: p.type,
				name: p.name,
				detail: p.detail ?? null,
				color: p.color ?? null,
				image: p.image ?? null
			}));
	}

	async function saveShares(next: ShareEntry[]) {
		try {
			shares = await apiFetch<BoardShares>(`${BASE}/boards/${id}/shares`, {
				method: 'PUT',
				body: JSON.stringify({
					shares: next.map((s) => ({ type: s.type ?? 'user', id: s.userId, level: s.level }))
				})
			});
		} catch (e) {
			throw new Error(errMsg(e, 'Freigabe fehlgeschlagen'), { cause: e });
		}
	}

	async function addShare(c: ShareCandidate, level: string) {
		const current = shares?.shares ?? [];
		const entry: ShareEntry = {
			userId: c.id,
			type: c.type ?? 'user',
			name: c.name,
			detail: c.detail ?? null,
			color: c.color ?? null,
			image: c.image ?? null,
			level
		};
		if (current.some((s) => shareKey(s) === shareKey(entry))) return;
		await saveShares([...current, entry]);
	}

	const subtitle = $derived.by(() => {
		if (!board) return undefined;
		const parts = [board.description];
		if (board.counts.total)
			parts.push(`${board.counts.total} Aufgaben, ${board.counts.done} erledigt`);
		return parts.filter(Boolean).join(' · ') || undefined;
	});
</script>

<PageTitle title={board?.name ?? 'Board'} />

<nav aria-label="Navigation" class="mb-2">
	<a
		href={BASE}
		class="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
	>
		<ArrowLeft class="size-4" aria-hidden="true" /> Alle Boards
	</a>
</nav>

{#if loading && !board}
	<LoadingState label="Board" rows={1} rowClass="h-96 w-full" />
{:else if notFound}
	<EmptyState
		title="Board nicht gefunden"
		description="Das Board existiert nicht oder du hast keinen Zugriff darauf."
	>
		<Button href={BASE} variant="outline"><ArrowLeft /> Zurück zu den Boards</Button>
	</EmptyState>
{:else if loadError && !board}
	<ErrorState message={loadError} onretry={load} />
{:else if board}
	<PageHeader title={board.name} description={subtitle}>
		{#snippet actions()}
			{#if board?.action}
				<Button variant="outline" href={`/modules/actions/${board.action.id}`}>
					<Tent />
					<span class="max-w-40 truncate">{board.action.name}</span>
				</Button>
			{/if}
			{#if shares && board}
				<ShareMenu
					shares={shares.shares}
					owner={{
						name: board.access.isOwner ? `${shares.owner.name} (du)` : shares.owner.name,
						image: shares.owner.image
					}}
					levels={shareLevels}
					defaultLevel="edit"
					canManage={shares.canManage}
					search={searchPrincipals}
					onadd={addShare}
					onchange={(key, level) =>
						saveShares(
							(shares?.shares ?? []).map((s) => (shareKey(s) === key ? { ...s, level } : s))
						)}
					onremove={(key) => saveShares((shares?.shares ?? []).filter((s) => shareKey(s) !== key))}
					description={board.action
						? 'Wer das Board sehen oder bearbeiten darf – zusätzlich alle mit Zugriff auf die Aktion.'
						: 'Wer das Board sehen oder bearbeiten darf.'}
					everyoneLabel={shares.everyoneLabel}
					placeholder="Gruppe, Rolle, Person suchen …"
					searchLabel="Freigabe hinzufügen"
					emptyResultText="Niemand gefunden"
				/>
			{/if}
			{#if canEdit}
				<Button onclick={() => newTask()}><Plus /> Aufgabe</Button>
			{/if}
			<DropdownMenu.Root>
				<DropdownMenu.Trigger>
					{#snippet child({ props })}
						<Button {...props} variant="outline" size="icon" aria-label="Mehr zum Board"
							><Ellipsis /></Button
						>
					{/snippet}
				</DropdownMenu.Trigger>
				<DropdownMenu.Content align="end" class="w-64">
					{#if canEdit}
						<DropdownMenu.Item onclick={() => (editOpen = true)}
							><Pencil /> Board bearbeiten</DropdownMenu.Item
						>
						<DropdownMenu.Item onclick={() => (phasesOpen = true)}
							><Flag /> Phasen verwalten</DropdownMenu.Item
						>
						<DropdownMenu.Item onclick={() => openColumn(null)}
							><Plus /> Spalte hinzufügen</DropdownMenu.Item
						>
						<DropdownMenu.Item onclick={() => (shiftOpen = true)}>
							<MoveHorizontal /> Alle Daten verschieben …
						</DropdownMenu.Item>
						<DropdownMenu.Item disabled={board?.defaultView === view} onclick={setDefaultView}>
							<Pin /> „{VIEW_LABELS[view]}“ als Standardansicht
						</DropdownMenu.Item>
					{/if}
					{#if can(permissions, PERM.create)}
						<DropdownMenu.Item
							onclick={() => {
								templateName = board?.name ?? '';
								templateError = '';
								templateOpen = true;
							}}
						>
							<CopyPlus /> Als Vorlage speichern
						</DropdownMenu.Item>
					{/if}
					{#if board?.access.canShare}
						<DropdownMenu.Separator />
						<DropdownMenu.Item class="text-destructive" onclick={() => (deleteOpen = true)}>
							<Trash2 /> Board löschen
						</DropdownMenu.Item>
					{/if}
				</DropdownMenu.Content>
			</DropdownMenu.Root>
		{/snippet}
	</PageHeader>

	<div class="space-y-4">
		{#if board.actionShift && canEdit}
			{@const days = board.actionShift}
			<Alert variant="info">
				<CalendarRange />
				<AlertDescription class="flex flex-wrap items-center gap-x-3 gap-y-2">
					<span>
						Die Aktion beginnt jetzt {Math.abs(days)}
						{Math.abs(days) === 1 ? 'Tag' : 'Tage'}
						{days > 0 ? 'später' : 'früher'}. Sollen Phasen und Fristen mitwandern?
					</span>
					<span class="flex gap-2">
						<Button size="sm" onclick={() => shift(days)}>Mitverschieben</Button>
						<Button size="sm" variant="outline" onclick={() => shift(days, false)}
							>Nicht verschieben</Button
						>
					</span>
				</AlertDescription>
			</Alert>
		{/if}

		{#if board.phases.length}
			<PhaseStrip
				phases={board.phases}
				tasks={board.tasks}
				{isDone}
				selected={filter.phaseId}
				{canEdit}
				onselect={(pid) => (filter.phaseId = pid)}
				onmanage={() => (phasesOpen = true)}
			/>
		{:else if canEdit}
			<button
				type="button"
				class="focus-ring inline-flex items-center gap-1.5 rounded-sm text-sm text-link hover:underline"
				onclick={() => (phasesOpen = true)}
			>
				<Flag class="size-4" aria-hidden="true" /> Phasen anlegen (z. B. Planung, Durchführung, Nachbereitung)
			</button>
		{/if}

		<div class="flex flex-wrap items-center justify-between gap-2">
			<Tabs.Root value={view} onValueChange={setView}>
				<Tabs.List aria-label="Ansicht">
					{#each VIEWS as v (v)}
						<Tabs.Trigger value={v}>{VIEW_LABELS[v]}</Tabs.Trigger>
					{/each}
				</Tabs.List>
			</Tabs.Root>
			<div class="flex flex-wrap items-center gap-2">
				{#if board.access.level === 'read'}
					<Badge variant="secondary">
						Nur Ansicht{board.tasks.some((t) => t.canMove) ? ' – eigene Aufgaben verschiebbar' : ''}
					</Badge>
				{/if}
				<BoardFilters
					bind:filter
					bind:grouping
					{people}
					phases={board.phases}
					showMine={!!myId}
					canGroup={view === 'board' && !phone}
				/>
			</div>
		</div>

		{#if view === 'board'}
			{#if phone}
				<MobileBoard
					{board}
					{visible}
					{myId}
					{canEdit}
					{isDone}
					onopen={openTask}
					onmove={moveToEnd}
					onassignme={assignMe}
				/>
			{:else}
				<KanbanView
					{board}
					{visible}
					{canEdit}
					{filtering}
					{grouping}
					onopen={openTask}
					onmove={moveTask}
					onquickadd={quickAdd}
					onrename={openColumn}
					ontoggledone={toggleDoneColumn}
					onmovecolumn={moveColumn}
					ondeletecolumn={askDeleteColumn}
				/>
			{/if}
		{:else if view === 'list'}
			<ListView {board} {visible} {isDone} ontoggle={toggleDone} onopen={openTask} />
		{:else if view === 'timeline'}
			<TimelineView {board} {visible} {isDone} {canEdit} onopen={openTask} onchange={changeDates} />
		{:else}
			<CalendarView
				{board}
				{visible}
				{isDone}
				{canEdit}
				onopen={openTask}
				onday={(date) => newTask({ dueOn: date })}
			/>
		{/if}
	</div>

	<TaskSheet
		bind:open={sheetOpen}
		bind:taskId={sheetTask}
		boardId={board.id}
		boardName={board.name}
		columns={board.columns}
		phases={board.phases}
		tasks={board.tasks}
		{order}
		defaults={sheetDefaults}
		canEditBoard={canEdit}
		onchanged={load}
	/>
	<BoardDialog bind:open={editOpen} {board} onsaved={(b) => (board = b)} />
	<PhasesDialog bind:open={phasesOpen} {board} onchanged={(b) => (board = b)} />
{/if}

<Dialog.Root bind:open={columnOpen}>
	<Dialog.Content class="sm:max-w-sm">
		<Dialog.Header>
			<Dialog.Title>{columnEdit ? 'Spalte umbenennen' : 'Neue Spalte'}</Dialog.Title>
			<Dialog.Description class="sr-only">Name der Spalte</Dialog.Description>
		</Dialog.Header>
		<form class="space-y-4" onsubmit={saveColumn} novalidate>
			<FormField label="Name" id="column-name" required error={columnError}>
				<Input
					id="column-name"
					bind:value={columnName}
					maxlength={MAX_COLUMN_NAME}
					autocomplete="off"
				/>
			</FormField>
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (columnOpen = false)}
					>Abbrechen</Button
				>
				<Button type="submit">{columnEdit ? 'Speichern' : 'Anlegen'}</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root open={!!columnDelete} onOpenChange={(v) => !v && (columnDelete = null)}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>Spalte „{columnDelete?.name}“ löschen?</Dialog.Title>
			<Dialog.Description>
				{columnDelete && countOf(columnDelete.id)
					? `Die ${countOf(columnDelete.id)} Aufgaben der Spalte werden verschoben.`
					: 'Die Spalte ist leer.'}
			</Dialog.Description>
		</Dialog.Header>
		{#if columnDelete && countOf(columnDelete.id) && board}
			<FormField label="Aufgaben verschieben nach" id="column-move-to">
				<SelectField
					id="column-move-to"
					label="Aufgaben verschieben nach"
					options={board.columns
						.filter((c) => c.id !== columnDelete?.id)
						.map((c) => ({ value: c.id, label: c.name }))}
					bind:value={columnMoveTo}
				/>
			</FormField>
		{/if}
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (columnDelete = null)}>Abbrechen</Button>
			<Button variant="destructive-solid" onclick={deleteColumn}>Löschen</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={templateOpen}>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>Als Vorlage speichern</Dialog.Title>
			<Dialog.Description>
				Spalten, Phasen und Aufgaben samt Unteraufgaben werden gespeichert, ohne Zuständige und
				Erledigt-Stand. Daten zählen ab dem Beginn der Aktion bzw. des Boards.
			</Dialog.Description>
		</Dialog.Header>
		<form class="space-y-4" onsubmit={saveTemplate} novalidate>
			<FormField label="Name der Vorlage" id="template-name" required error={templateError}>
				<Input
					id="template-name"
					bind:value={templateName}
					maxlength={MAX_TEMPLATE_NAME}
					autocomplete="off"
				/>
			</FormField>
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (templateOpen = false)}
					>Abbrechen</Button
				>
				<Button type="submit">Speichern</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<Dialog.Root bind:open={shiftOpen}>
	<Dialog.Content class="sm:max-w-sm">
		<Dialog.Header>
			<Dialog.Title>Alle Daten verschieben</Dialog.Title>
			<Dialog.Description>
				Phasen, Beginn und Fälligkeit aller Aufgaben und Unteraufgaben wandern um die gewählte Zahl
				an Tagen (negativ = früher).
			</Dialog.Description>
		</Dialog.Header>
		<FormField label="Tage" id="shift-days">
			<NumberStepper
				id="shift-days"
				label="Tage"
				unit="Tage"
				bind:value={shiftDays}
				min={-MAX_SHIFT_DAYS}
				max={MAX_SHIFT_DAYS}
			/>
		</FormField>
		<Dialog.Footer>
			<Button variant="outline" onclick={() => (shiftOpen = false)}>Abbrechen</Button>
			<Button
				disabled={!shiftDays}
				onclick={() => {
					shiftOpen = false;
					void shift(shiftDays);
				}}
			>
				Verschieben
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>

<ConfirmDialog
	bind:open={deleteOpen}
	title="Board löschen?"
	description="Das Board mit allen Spalten, Phasen, Aufgaben und Unteraufgaben wird endgültig gelöscht."
	confirmLabel="Löschen"
	destructive
	onconfirm={deleteBoard}
/>
