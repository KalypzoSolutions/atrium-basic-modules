<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import { ApiClientError, apiFetch } from '$lib/sdk/client';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { MultiSelect } from '$lib/components/ui/multi-select';
	import { Switch } from '$lib/components/ui/switch';
	import { TagInput } from '$lib/components/ui/tag-input';
	import { BUSY_SAVE, FormField } from '$lib/components/layout';
	import {
		MAX_FEED_NAME,
		MAX_TAG_LENGTH,
		MAX_TAGS,
		STAMM_GROUP_ID,
		calendarFeedInput,
		type CalendarFeed,
		type EventGroupRef
	} from '../schemas';

	/**
	 * Kalender-Abo anlegen oder ändern: Name, Termine und/oder Aktionen, Filter nach Gruppen und Tags.
	 * Ändern behält den Link; der Server prüft Gruppen und Grenzen erneut.
	 */
	let {
		open = $bindable(false),
		feed = null,
		actionsAvailable,
		tasksAvailable = false,
		onsaved
	}: {
		open?: boolean;
		/** `null` = neues Abo */
		feed?: CalendarFeed | null;
		actionsAvailable: boolean;
		/** Modul Aufgaben aktiv (Meilensteine wählbar) */
		tasksAvailable?: boolean;
		onsaved: (feed: CalendarFeed) => void;
	} = $props();

	const BASE = '/modules/events';
	const uid = $props.id();
	const ids = { name: `${uid}-name`, groups: `${uid}-groups`, tags: `${uid}-tags` };

	let name = $state('');
	let includeEvents = $state(true);
	let includeActions = $state(true);
	let includeTasks = $state(false);
	let groupIds = $state<string[]>([]);
	let tags = $state<string[]>([]);
	let groups = $state<EventGroupRef[]>([]);
	let errors = $state<Record<string, string>>({});
	let busy = $state(false);
	let nameEl = $state<HTMLInputElement | null>(null);

	const groupOptions = $derived(
		groups.map((g) => ({
			value: g.id,
			label: g.name,
			description: g.id === STAMM_GROUP_ID ? 'ganzer Stamm' : undefined
		}))
	);

	let wasOpen = false;
	$effect(() => {
		if (open && !wasOpen) {
			untrack(() => {
				name = feed?.name ?? 'Stammestermine';
				includeEvents = feed?.includeEvents ?? true;
				includeActions = actionsAvailable ? (feed?.includeActions ?? true) : false;
				includeTasks = tasksAvailable ? (feed?.includeTasks ?? false) : false;
				groupIds = [...(feed?.groupIds ?? [])];
				tags = [...(feed?.tags ?? [])];
				errors = {};
				busy = false;
				void apiFetch<EventGroupRef[]>(`${BASE}/groups`)
					.then((g) => (groups = g))
					.catch(() => (groups = []));
				void tick().then(() => nameEl?.select());
			});
		}
		wasOpen = open;
	});

	function loadTags(q: string): Promise<string[]> {
		const query = q.trim() ? `?search=${encodeURIComponent(q.trim())}` : '';
		return apiFetch<string[]>(`${BASE}/tags${query}`);
	}

	function mapIssues(issues: { path?: unknown; message?: unknown }[]) {
		const next: Record<string, string> = {};
		for (const i of issues) {
			const key = Array.isArray(i.path) && i.path.length ? String(i.path[0]) : 'form';
			if (!next[key] && typeof i.message === 'string') next[key] = i.message;
		}
		errors = next;
	}

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (busy) return;
		const body = { name, includeEvents, includeActions, includeTasks, groupIds, tags };
		const parsed = calendarFeedInput.safeParse(body);
		if (!parsed.success) {
			mapIssues(parsed.error.issues);
			if (errors.name) nameEl?.focus();
			return;
		}
		errors = {};
		busy = true;
		try {
			const saved = await apiFetch<CalendarFeed>(
				feed ? `${BASE}/calendar-feeds/${feed.id}` : `${BASE}/calendar-feeds`,
				{ method: feed ? 'PUT' : 'POST', body: JSON.stringify(parsed.data) }
			);
			toast.success(feed ? 'Kalender-Abo gespeichert' : 'Kalender-Abo angelegt');
			open = false;
			onsaved(saved);
		} catch (err) {
			if (err instanceof ApiClientError && Array.isArray(err.details)) {
				mapIssues(err.details as { path?: unknown; message?: unknown }[]);
			} else {
				errors = {
					form: err instanceof ApiClientError ? err.message : 'Speichern fehlgeschlagen'
				};
			}
		} finally {
			busy = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-lg">
		<Dialog.Header>
			<Dialog.Title>{feed ? 'Kalender-Abo bearbeiten' : 'Kalender-Abo anlegen'}</Dialog.Title>
			<Dialog.Description>
				Das Abo zeigt nur, was du auch hier siehst. Änderungen erscheinen in deiner Kalender-App
				nach dem nächsten Abruf (meist innerhalb weniger Stunden).
			</Dialog.Description>
		</Dialog.Header>
		<form class="grid gap-4" onsubmit={submit} novalidate>
			<FormField label="Name" id={ids.name} required error={errors.name}>
				<Input
					id={ids.name}
					bind:ref={nameEl}
					bind:value={name}
					maxlength={MAX_FEED_NAME}
					autocomplete="off"
					placeholder="z. B. Stammestermine"
				/>
			</FormField>

			<fieldset class="grid gap-3">
				<legend class="mb-1 text-sm font-medium">Inhalt</legend>
				<label class="flex items-center justify-between gap-3 text-sm">
					<span>
						Termine
						<span class="block text-xs text-muted-foreground">Inklusive Serien und Absagen</span>
					</span>
					<Switch bind:checked={includeEvents} aria-label="Termine im Abo" />
				</label>
				{#if actionsAvailable}
					<label class="flex items-center justify-between gap-3 text-sm">
						<span>
							Aktionen
							<span class="block text-xs text-muted-foreground">
								Freizeiten, auf die du Zugriff hast oder zu denen du (oder dein Kind) angemeldet
								bist
							</span>
						</span>
						<Switch bind:checked={includeActions} aria-label="Aktionen im Abo" />
					</label>
				{/if}
				{#if tasksAvailable}
					<label class="flex items-center justify-between gap-3 text-sm">
						<span>
							Meilensteine aus Aufgaben
							<span class="block text-xs text-muted-foreground">
								Deine Meilensteine aus Boards, bei denen das Kalender-Abo eingeschaltet ist
							</span>
						</span>
						<Switch bind:checked={includeTasks} aria-label="Meilensteine im Abo" />
					</label>
				{/if}
				{#if errors.includeEvents}
					<p role="alert" class="text-xs text-destructive">{errors.includeEvents}</p>
				{/if}
			</fieldset>

			{#if includeEvents}
				<FormField
					label="Nur Termine dieser Gruppen"
					id={ids.groups}
					hint="Leer = alle Termine, die du siehst"
					error={errors.groupIds}
				>
					<MultiSelect
						id={ids.groups}
						label="Gruppen"
						options={groupOptions}
						value={groupIds}
						onchange={(v) => (groupIds = v)}
						placeholder="Alle Gruppen"
						searchPlaceholder="Gruppe suchen …"
					/>
				</FormField>
				<FormField
					label="Nur Termine mit diesen Tags"
					id={ids.tags}
					hint="Leer = alle Tags"
					error={errors.tags}
				>
					<TagInput
						id={ids.tags}
						bind:value={tags}
						loadSuggestions={loadTags}
						max={MAX_TAGS}
						maxLength={MAX_TAG_LENGTH}
						label="Tags"
					/>
				</FormField>
			{/if}

			{#if errors.form}
				<p role="alert" class="text-sm text-destructive">{errors.form}</p>
			{/if}
			<Dialog.Footer>
				<Button type="button" variant="outline" onclick={() => (open = false)} disabled={busy}>
					Abbrechen
				</Button>
				<Button type="submit" disabled={busy}>
					{busy ? BUSY_SAVE : feed ? 'Speichern' : 'Anlegen'}
				</Button>
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>
