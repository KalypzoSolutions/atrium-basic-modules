<script lang="ts" module>
	/** Was exportiert wird */
	export type ExportTarget =
		| {
				kind: 'board';
				boardId: string;
				hasPhases: boolean;
				/** IDs der gefilterten Aufgaben, `null` = kein Filter aktiv */
				filteredIds: string[] | null;
				/** Beschreibung der aktiven Filter für die Kopfzeile */
				filterLabel?: string;
		  }
		| { kind: 'task'; taskId: string; title: string }
		| { kind: 'my' };
</script>

<script lang="ts">
	import Check from '@lucide/svelte/icons/check';
	import FileCode from '@lucide/svelte/icons/file-code';
	import FileImage from '@lucide/svelte/icons/file-image';
	import FileSpreadsheet from '@lucide/svelte/icons/file-spreadsheet';
	import FileText from '@lucide/svelte/icons/file-text';
	import FileType from '@lucide/svelte/icons/file-type';
	// Dialog „Exportieren“ für ein Board, eine Aufgabe oder „Meine Aufgaben“: Format (PDF, PNG, HTML, CSV,
	// Markdown) und Ausführung wählen, Datei erzeugt der Server (`…/export`).
	import { toast } from 'svelte-sonner';
	import { downloadPdf } from '$lib/components/layout/download';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Label } from '$lib/components/ui/label';
	import { SegmentedSlider } from '$lib/components/ui/segmented-slider';
	import { cn } from '$lib/utils';
	import {
		BOARD_GROUP_LABELS,
		BOARD_GROUPS,
		type BoardGroup,
		EXPORT_FORMAT_DESCRIPTIONS,
		EXPORT_FORMAT_LABELS,
		EXPORT_FORMATS,
		type ExportFormat
	} from '../export';

	let { open = $bindable(false), target }: { open?: boolean; target: ExportTarget | null } =
		$props();

	const ICONS = {
		pdf: FileText,
		png: FileImage,
		html: FileCode,
		csv: FileSpreadsheet,
		md: FileType
	} as const;

	let format = $state<ExportFormat>('pdf');
	let groupBy = $state<BoardGroup>('column');
	let detailed = $state(false);
	let includeDone = $state(true);
	let onlyFiltered = $state(true);
	let letterhead = $state(false);
	let busy = $state(false);

	// Beim Öffnen auf sinnvolle Vorgaben je Ziel setzen
	$effect(() => {
		if (!open || !target) return;
		groupBy = 'column';
		detailed = false;
		includeDone = target.kind !== 'my';
		onlyFiltered = true;
	});

	const kind = $derived(target?.kind ?? 'board');
	const printable = $derived(format === 'pdf' || format === 'png');
	/** CSV hat immer alle Felder; einzelne Aufgabe ist immer ausführlich */
	const showDetailed = $derived(kind !== 'task' && format !== 'csv');
	const filteredCount = $derived(
		target?.kind === 'board' && target.filteredIds ? target.filteredIds.length : null
	);

	const title = $derived(
		kind === 'task'
			? 'Aufgabe exportieren'
			: kind === 'my'
				? 'Meine Aufgaben exportieren'
				: 'Board exportieren'
	);
	const description = $derived(
		target?.kind === 'task'
			? `„${target.title}“ mit Beschreibung und Unteraufgaben.`
			: kind === 'my'
				? 'Alle Aufgaben, die dir zugewiesen sind – gruppiert nach Board.'
				: 'Alle Aufgaben des Boards als Datei zum Drucken, Weitergeben oder Weiterbearbeiten.'
	);

	function request(): { url: string; body: Record<string, unknown>; fallback: string } | null {
		if (!target) return null;
		const base = '/api/v1/modules/tasks';
		if (target.kind === 'task') {
			return {
				url: `${base}/tasks/${target.taskId}/export`,
				body: { format, letterhead },
				fallback: `aufgabe.${format}`
			};
		}
		if (target.kind === 'my') {
			return {
				url: `${base}/my/tasks/export`,
				body: { format, detailed, includeDone, letterhead },
				fallback: `meine-aufgaben.${format}`
			};
		}
		const filtered = target.filteredIds && onlyFiltered;
		return {
			url: `${base}/boards/${target.boardId}/export`,
			body: {
				format,
				groupBy,
				detailed,
				includeDone,
				letterhead,
				...(filtered ? { taskIds: target.filteredIds, filterLabel: target.filterLabel } : {})
			},
			fallback: `board.${format}`
		};
	}

	async function run() {
		const r = request();
		if (!r) return;
		busy = true;
		try {
			await downloadPdf(r.url, { method: 'POST', body: JSON.stringify(r.body) }, r.fallback);
			open = false;
		} catch (e) {
			toast.error(e instanceof Error ? e.message : 'Export fehlgeschlagen');
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>{title}</Dialog.Title>
			<Dialog.Description class="break-words">{description}</Dialog.Description>
		</Dialog.Header>

		<div class="space-y-5">
			<fieldset class="space-y-2">
				<legend class="mb-2 text-sm font-medium">Format</legend>
				<div class="grid grid-cols-2 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Format">
					{#each EXPORT_FORMATS as f (f)}
						{@const Icon = ICONS[f]}
						{@const active = format === f}
						<button
							type="button"
							role="radio"
							aria-checked={active}
							class={cn(
								'relative flex items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring',
								active && 'border-primary bg-primary/5 ring-1 ring-primary'
							)}
							onclick={() => (format = f)}
						>
							<Icon class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
							<span class="truncate">{EXPORT_FORMAT_LABELS[f]}</span>
							{#if active}
								<Check class="ml-auto size-4 shrink-0 text-primary" aria-hidden="true" />
							{/if}
						</button>
					{/each}
				</div>
				<p class="text-xs text-muted-foreground">{EXPORT_FORMAT_DESCRIPTIONS[format]}</p>
			</fieldset>

			{#if target?.kind === 'board'}
				<div class="space-y-2">
					<p class="text-sm font-medium">Gruppierung</p>
					<SegmentedSlider
						value={groupBy}
						label="Gruppierung"
						class="max-w-none"
						options={BOARD_GROUPS.filter((g) => g !== 'phase' || target.hasPhases).map((g) => ({
							value: g,
							label: BOARD_GROUP_LABELS[g]
						}))}
						onchange={(v) => (groupBy = v as BoardGroup)}
					/>
				</div>
			{/if}

			<div class="space-y-3">
				{#if showDetailed}
					<div class="flex items-start gap-2">
						<Checkbox
							id="tasks-export-detailed"
							checked={detailed}
							onCheckedChange={(v) => (detailed = v === true)}
						/>
						<div class="grid gap-0.5">
							<Label for="tasks-export-detailed" class="font-normal">
								Mit Beschreibung und Unteraufgaben
							</Label>
							<span class="text-xs text-muted-foreground">
								Jede Aufgabe einzeln statt einer kompakten Tabelle.
							</span>
						</div>
					</div>
				{/if}
				{#if kind !== 'task'}
					<div class="flex items-center gap-2">
						<Checkbox
							id="tasks-export-done"
							checked={includeDone}
							onCheckedChange={(v) => (includeDone = v === true)}
						/>
						<Label for="tasks-export-done" class="font-normal"
							>Erledigte Aufgaben einbeziehen</Label
						>
					</div>
				{/if}
				{#if filteredCount !== null}
					<div class="flex items-start gap-2">
						<Checkbox
							id="tasks-export-filtered"
							checked={onlyFiltered}
							onCheckedChange={(v) => (onlyFiltered = v === true)}
						/>
						<div class="grid gap-0.5">
							<Label for="tasks-export-filtered" class="font-normal">
								Nur gefilterte Aufgaben ({filteredCount})
							</Label>
							<span class="text-xs text-muted-foreground">
								Wie gerade auf der Seite angezeigt.
							</span>
						</div>
					</div>
				{/if}
				{#if printable}
					<div class="flex items-center gap-2">
						<Checkbox
							id="tasks-export-letterhead"
							checked={letterhead}
							onCheckedChange={(v) => (letterhead = v === true)}
						/>
						<Label for="tasks-export-letterhead" class="font-normal">Mit Briefkopf</Label>
					</div>
				{/if}
			</div>
		</div>

		<Dialog.Footer>
			<Button variant="outline" onclick={() => (open = false)}>Abbrechen</Button>
			<Button onclick={run} disabled={busy || !target}>
				{busy ? 'Wird erstellt …' : 'Exportieren'}
			</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
