<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { toast } from 'svelte-sonner';
	import Globe from '@lucide/svelte/icons/globe';
	import Pencil from '@lucide/svelte/icons/pencil';
	import Repeat from '@lucide/svelte/icons/repeat';
	import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
	import Trash2 from '@lucide/svelte/icons/trash-2';
	import { page } from '$app/state';
	import { ApiClientError, apiFetch, can } from '$lib/sdk/client';
	import type { PrincipalInfo } from '$lib/sdk/types/sharing';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import { Checkbox } from '$lib/components/ui/checkbox';
	import { ColorPicker } from '$lib/components/ui/color-picker';
	import * as Dialog from '$lib/components/ui/dialog';
	import { Input } from '$lib/components/ui/input';
	import { Label } from '$lib/components/ui/label';
	import { MultiSelect } from '$lib/components/ui/multi-select';
	import { Skeleton } from '$lib/components/ui/skeleton';
	import { TagInput } from '$lib/components/ui/tag-input';
	import {
		AssistTextarea,
		ColorBadge,
		ConfirmDialog,
		FormField,
		SharePanel,
		toastWithUndo
	} from '$lib/components/layout';
	import type { ShareCandidate, ShareEntry, ShareOwner } from '$lib/components/layout';
	import { shareKey } from '$lib/components/layout/share-types';
	import {
		COLOR_PRESETS,
		MAX_TAG_LENGTH,
		MAX_TAGS,
		PUBLISH_PERMISSION,
		SHARE_LEVELS,
		SHARE_LEVEL_LABELS,
		STAMM_GROUP_ID,
		checkEventDates,
		eventInput,
		isRealDate,
		occurrenceInput,
		type EventDates,
		type EventDetail,
		type EventGroupRef,
		type OccurrenceOverride,
		type RecurrenceRule
	} from '../schemas';
	import { todayBerlin } from '$lib/sdk/dates';
	import { formatEventDate, formatEventRange, isAllDay } from '../format';
	import { addDays, daysBetween, isoWeekday, nextWeekday } from '../recurrence';
	import RecurrenceField from './RecurrenceField.svelte';
	import SeriesChoiceDialog from './SeriesChoiceDialog.svelte';

	type Mode = 'view' | 'edit' | 'create';
	/** Intern zusätzlich: einzelnes Vorkommen einer Serie bearbeiten */
	type DialogMode = Mode | 'edit-occurrence';
	type SeriesText = { title: string; description: string | null; location: string | null };

	let {
		open = $bindable(false),
		eventId,
		occurrenceDate = null,
		mode,
		initialDate,
		onsaved,
		ondeleted
	}: {
		open?: boolean;
		/** `null` = neuer Termin */
		eventId: string | null;
		/** Serie: ursprüngliches Datum des Vorkommens (`?occurrence=` beim Laden) */
		occurrenceDate?: string | null;
		/** Standard: `eventId` → `view`, sonst `create` */
		mode?: Mode;
		/** Vorbelegung des Startdatums (`JJJJ-MM-TT`) beim Anlegen */
		initialDate?: string;
		onsaved: (event: EventDetail) => void;
		ondeleted?: (id: string) => void;
	} = $props();

	const BASE = '/modules/events';
	const LEVELS = SHARE_LEVELS.map((value) => ({ value, label: SHARE_LEVEL_LABELS[value] }));
	const PRESETS = [...COLOR_PRESETS];
	const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

	/** Aktueller Modus im Dialog („Bearbeiten“ wechselt ohne Neuladen) */
	let current = $state<DialogMode>('create');
	/** Zuletzt geladener bzw. gespeicherter Stand (für Ansicht und „Abbrechen“) */
	let loaded = $state<EventDetail | null>(null);
	// Veröffentlichen braucht ein eigenes Recht (#67, 01b-06); bereits veröffentlichte Termine dürfen zurückgenommen werden
	const canPublish = $derived(can((page.data.permissions ?? []) as string[], PUBLISH_PERMISSION));
	const publishLocked = $derived(!canPublish && !(loaded?.onWebsite ?? false));

	let title = $state('');
	let description = $state('');
	let location = $state('');
	let startsOn = $state('');
	let startsTime = $state('');
	let endsOn = $state('');
	let endsTime = $state('');
	let color = $state<string | null>(null);
	let groupIds = $state<string[]>([]);
	let tags = $state<string[]>([]);
	let shares = $state<ShareEntry[]>([]);
	let onWebsite = $state(false);
	/** Sichtbarkeit selbst verändert → folgt nicht mehr den Gruppen */
	let sharesTouched = $state(false);
	let owner = $state<ShareOwner | undefined>(undefined);
	let recurrence = $state<RecurrenceRule | null>(null);
	/** Auswahl „Nur dieser Termin / Ganze Serie“ (Bearbeiten bzw. Löschen) */
	let choice = $state<'edit' | 'delete' | null>(null);
	let choiceOpen = $state(false);
	/** Absagen/Wieder ansetzen/Zurücksetzen läuft */
	let actionBusy = $state(false);

	let groups = $state<EventGroupRef[]>([]);
	let loading = $state(false);
	let loadError = $state('');
	let busy = $state(false);
	let error = $state('');
	let fieldErrors = $state<Record<string, string>>({});
	let confirmOpen = $state(false);
	let deleting = $state(false);
	let seq = 0;

	const viewing = $derived(current === 'view');
	const occEdit = $derived(current === 'edit-occurrence');
	/** Serie (mit Vorkommen) */
	const isSeries = $derived(!!loaded?.recurrence);
	const occDate = $derived(loaded?.occurrenceDate ?? null);
	const isCancelled = $derived(
		!!loaded && !!occDate && (loaded.cancelledDates ?? []).includes(occDate)
	);
	const seriesStart = $derived(loaded?.series?.startsOn ?? loaded?.startsOn ?? '');
	const editingSeries = $derived(current === 'edit' && isSeries);
	const canEdit = $derived(loaded?.access.level === 'edit');
	const stammName = $derived(groups.find((g) => g.id === STAMM_GROUP_ID)?.name ?? 'Stamm');
	const groupOptions = $derived(
		groups.map((g) => ({
			value: g.id,
			label: g.name,
			description: g.id === STAMM_GROUP_ID ? 'ganzer Stamm' : undefined
		}))
	);
	const ownerLabel = $derived(
		loaded?.owner ? `${loaded.owner.name}${loaded.access.isOwner ? ' (du)' : ''}` : 'Unbekannt'
	);
	const titleColor = $derived(loaded?.color && COLOR_RE.test(loaded.color) ? loaded.color : null);

	const WEEKDAY_ADVERBS = [
		'montags',
		'dienstags',
		'mittwochs',
		'donnerstags',
		'freitags',
		'samstags',
		'sonntags'
	] as const;

	/** Vorschläge „Gruppenstunde übernehmen“ – nur solange keine Wiederholung gesetzt ist */
	const meetingSuggestions = $derived.by(() => {
		if (recurrence || (current !== 'create' && current !== 'edit')) return [];
		const out: { group: EventGroupRef; weekday: number; text: string }[] = [];
		for (const id of groupIds) {
			const g = groups.find((x) => x.id === id);
			const wd = g?.meetingWeekday;
			if (!g || !wd || wd < 1 || wd > 7) continue;
			const time = g.meetingTime?.slice(0, 5);
			const end = time ? g.meetingEndTime?.slice(0, 5) : undefined;
			const span = time && end && end > time ? `${time}–${end}` : time;
			const when = [WEEKDAY_ADVERBS[wd - 1], span].filter(Boolean).join(' ');
			const place = g.meetingPlace?.trim();
			out.push({ group: g, weekday: wd, text: place ? `${when}, ${place}` : when });
		}
		return out;
	});

	const choiceOptions = $derived.by(() => {
		const date = occDate ? formatEventDate(occDate) : '';
		if (choice === 'edit') {
			return [
				{
					value: 'occurrence',
					label: `Nur diesen Termin (${date})`,
					description: 'Titel, Beschreibung, Ort und Zeit nur für diesen Tag ändern.'
				},
				{
					value: 'series',
					label: 'Ganze Serie',
					description: 'Alle Termine der Serie inklusive Wiederholung ändern.'
				}
			];
		}
		return [
			{
				value: 'occurrence',
				label: 'Nur diesen Termin absagen',
				description: `Der Termin am ${date} fällt aus, die Serie bleibt bestehen.`
			},
			{
				value: 'series',
				label: 'Ganze Serie löschen',
				description: 'Alle Termine der Serie werden endgültig gelöscht.',
				destructive: true
			}
		];
	});

	// Beim Öffnen (bzw. Wechsel des Termins) Formular zurücksetzen und Daten laden.
	$effect(() => {
		if (!open) return;
		const id = eventId;
		const date = initialDate;
		const occ = occurrenceDate;
		const m: Mode = id ? (mode ?? 'view') : 'create';
		untrack(() => void init(id, date, occ, m));
	});

	function reset(date: string | undefined) {
		title = '';
		description = '';
		location = '';
		startsOn = date ?? '';
		startsTime = '';
		endsOn = '';
		endsTime = '';
		color = null;
		groupIds = [];
		tags = [];
		shares = [];
		onWebsite = false;
		sharesTouched = false;
		owner = { name: 'Du' };
		recurrence = null;
		choice = null;
		choiceOpen = false;
		actionBusy = false;
		error = '';
		fieldErrors = {};
		busy = false;
		loadError = '';
		loaded = null;
		confirmOpen = false;
	}

	function fill(e: EventDetail) {
		title = e.title;
		description = e.description ?? '';
		location = e.location ?? '';
		startsOn = e.startsOn;
		startsTime = e.startsTime?.slice(0, 5) ?? '';
		endsOn = e.endsOn ?? '';
		endsTime = e.endsTime?.slice(0, 5) ?? '';
		color = e.color;
		groupIds = e.groups.map((g) => g.id);
		tags = [...e.tags];
		shares = e.shares.map((s) => ({
			userId: s.id,
			type: s.type,
			name: s.name,
			detail: s.detail,
			color: s.color,
			image: s.image ?? null,
			level: s.level
		}));
		onWebsite = e.onWebsite;
		recurrence = e.recurrence ? structuredClone($state.snapshot(e.recurrence)) : null;
		owner = e.owner
			? {
					name: e.access.isOwner ? `${e.owner.name} (du)` : e.owner.name,
					image: e.owner.image ?? null
				}
			: undefined;
		// Bestehende Termine: Sichtbarkeit gilt als bewusst gewählt
		sharesTouched = true;
		error = '';
		fieldErrors = {};
	}

	function detailUrl(id: string, occ: string | null) {
		const q = occ ? `?occurrence=${encodeURIComponent(occ)}` : '';
		return `${BASE}/events/${encodeURIComponent(id)}${q}`;
	}

	async function init(
		id: string | null,
		date: string | undefined,
		occ: string | null,
		m: DialogMode
	) {
		const mine = ++seq;
		reset(date);
		current = m;
		loading = !!id;
		try {
			const [g, e] = await Promise.all([
				apiFetch<EventGroupRef[]>(`${BASE}/groups`),
				id ? apiFetch<EventDetail>(detailUrl(id, occ)) : null
			]);
			if (mine !== seq) return;
			groups = g;
			if (e) {
				loaded = e;
				fill(e);
				// Ohne Bearbeiten-Recht bleibt es bei der Ansicht
				if (current === 'edit' && e.access.level !== 'edit') current = 'view';
				// Serie direkt bearbeiten: Seriendaten statt Vorkommen
				else if (current === 'edit' && e.recurrence) {
					current = 'view';
					void editSeries();
				}
			}
		} catch (err) {
			if (mine !== seq) return;
			loadError = err instanceof Error && err.message ? err.message : 'Laden fehlgeschlagen';
		} finally {
			if (mine === seq) loading = false;
		}
	}

	function retry() {
		const m: Mode = eventId ? (mode ?? 'view') : 'create';
		void init(eventId, initialDate, occurrenceDate ?? null, m);
	}

	function sharesFromGroups(ids: readonly string[]): ShareEntry[] {
		const out: ShareEntry[] = [];
		for (const id of ids) {
			const g = groups.find((x) => x.id === id);
			if (id === STAMM_GROUP_ID) {
				out.push({ userId: '*', type: 'everyone', name: g?.name ?? stammName, level: 'read' });
			} else {
				out.push({
					userId: id,
					type: 'group',
					name: g?.name ?? id,
					color: g?.color ?? null,
					level: 'read'
				});
			}
		}
		return out;
	}

	function onGroupsChange(next: string[]) {
		groupIds = next;
		if (!sharesTouched) shares = sharesFromGroups(next);
	}

	async function searchPrincipals(q: string): Promise<ShareCandidate[]> {
		const found = await apiFetch<PrincipalInfo[]>(
			`${BASE}/principals?search=${encodeURIComponent(q)}`
		);
		return found.map((p) => ({
			id: p.id,
			type: p.type,
			name: p.name,
			detail: p.detail ?? null,
			color: p.color ?? null,
			image: p.image ?? null
		}));
	}

	async function loadTags(q: string): Promise<string[]> {
		const query = q.trim() ? `?search=${encodeURIComponent(q.trim())}` : '';
		return apiFetch<string[]>(`${BASE}/tags${query}`);
	}

	// Sichtbarkeit lokal ändern – gespeichert wird erst mit dem Formular
	async function addShare(c: ShareCandidate, level: string) {
		const entry: ShareEntry = {
			userId: c.id,
			type: c.type,
			name: c.name,
			email: c.email ?? null,
			detail: c.detail ?? null,
			color: c.color ?? null,
			level
		};
		if (shares.some((s) => shareKey(s) === shareKey(entry))) return;
		shares = [...shares, entry];
		sharesTouched = true;
	}

	async function changeShare(key: string, level: string) {
		shares = shares.map((s) => (shareKey(s) === key ? { ...s, level } : s));
		sharesTouched = true;
	}

	async function removeShare(key: string) {
		shares = shares.filter((s) => shareKey(s) !== key);
		sharesTouched = true;
	}

	// Ansicht: nichts ändern
	async function noop() {}

	const ids = {
		title: 'ev-title',
		description: 'ev-description',
		location: 'ev-location',
		startsOn: 'ev-starts-on',
		startsTime: 'ev-starts-time',
		endsOn: 'ev-ends-on',
		endsTime: 'ev-ends-time',
		color: 'ev-color',
		groupIds: 'ev-groups',
		tags: 'ev-tags',
		shares: 'ev-shares',
		onWebsite: 'ev-on-website'
	} as const;
	type FieldKey = keyof typeof ids;

	async function focusFirstError() {
		await tick();
		for (const [k, id] of Object.entries(ids)) {
			if (!fieldErrors[k]) continue;
			const el = document.getElementById(id);
			if (el) {
				el.focus();
				return;
			}
		}
		// Fehler in der Wiederholung: erstes Feld des Blocks
		if (Object.keys(fieldErrors).some((k) => k.startsWith('recurrence'))) {
			document.getElementById('ev-recurrence-freq')?.focus();
		}
	}

	type Issue = { path?: PropertyKey[]; message?: string };

	/** Feldschlüssel aus einem Zod-/Server-Pfad: `recurrence.*` vollständig, `override.<feld>` → `<feld>` */
	function issueKey(path: readonly PropertyKey[] | undefined): string {
		const p = (path ?? []).map(String);
		if (p[0] === 'recurrence') return p.join('.');
		if (p[0] === 'override') return p[1] ?? '';
		return p[0] ?? '';
	}

	function issuesToErrors(issues: readonly Issue[]): Record<string, string> {
		const out: Record<string, string> = {};
		for (const i of issues) {
			const key = issueKey(i.path);
			if (key && i.message && !out[key]) out[key] = i.message;
		}
		return out;
	}

	function detailsToErrors(details: unknown): Record<string, string> {
		if (Array.isArray(details)) return issuesToErrors(details as Issue[]);
		const issues = (details as { issues?: Issue[] } | null)?.issues;
		if (Array.isArray(issues)) return issuesToErrors(issues);
		const out: Record<string, string> = {};
		if (details && typeof details === 'object') {
			for (const [k, v] of Object.entries(details as Record<string, unknown>)) {
				const msg = Array.isArray(v) ? v.join(', ') : typeof v === 'string' ? v : '';
				if (msg) out[k.startsWith('override.') ? k.slice(9) : k] = msg;
			}
		}
		return out;
	}

	const describe = (key: FieldKey) => (fieldErrors[key] ? `${ids[key]}-error` : undefined);

	function errorMessage(err: unknown, fallback: string): string {
		return err instanceof Error && err.message ? err.message : fallback;
	}

	const blank = (v: string | null | undefined) => {
		const t = (v ?? '').trim();
		return t ? t : null;
	};

	function textOf(e: Pick<EventDetail, 'title' | 'description' | 'location'>): SeriesText {
		return { title: e.title, description: e.description, location: e.location };
	}

	/** Start/Ende eines Vorkommens ohne Override (Ende um die Seriendauer verschoben) */
	function baseDatesOf(series: EventDates, date: string): EventDates {
		let endsOn: string | null = null;
		if (series.endsOn) {
			try {
				endsOn = addDays(date, daysBetween(series.startsOn, series.endsOn));
			} catch {
				endsOn = series.endsOn;
			}
		}
		return { startsOn: date, startsTime: series.startsTime, endsOn, endsTime: series.endsTime };
	}

	/**
	 * Abweichungen eines Vorkommens gegenüber der Serie. Titel/Beschreibung/Ort gegenüber der Serie,
	 * Datum/Uhrzeit gegenüber dem Vorkommen ohne Override.
	 * Start- und Enddatum werden gemeinsam gesendet, damit das Ende nicht ungewollt mitwandert.
	 */
	function buildOverride(
		v: SeriesText & EventDates,
		text: SeriesText,
		base: EventDates
	): OccurrenceOverride | null {
		const out: OccurrenceOverride = {};
		const title = v.title.trim();
		const description = blank(v.description);
		const location = blank(v.location);
		if (title !== text.title.trim()) out.title = title;
		if (description !== blank(text.description)) out.description = description;
		if (location !== blank(text.location)) out.location = location;
		const endsOn = v.endsOn || null;
		if (v.startsOn !== base.startsOn || endsOn !== (base.endsOn ?? null)) {
			out.startsOn = v.startsOn;
			out.endsOn = endsOn;
		}
		const startsTime = v.startsTime?.slice(0, 5) || null;
		const endsTime = v.endsTime?.slice(0, 5) || null;
		if (startsTime !== (base.startsTime?.slice(0, 5) || null)) out.startsTime = startsTime;
		if (endsTime !== (base.endsTime?.slice(0, 5) || null)) out.endsTime = endsTime;
		return Object.keys(out).length ? out : null;
	}

	/** Titel/Beschreibung/Ort der Serie (bei Serien aus `detail.series`) */
	function seriesTextOf(e: EventDetail): SeriesText {
		return e.series ? textOf(e.series) : textOf(e);
	}

	function occurrenceUrl(id: string, date: string) {
		return `${BASE}/events/${encodeURIComponent(id)}/occurrences/${encodeURIComponent(date)}`;
	}

	async function putOccurrence(
		id: string,
		date: string,
		cancelled: boolean,
		override: OccurrenceOverride | null
	): Promise<EventDetail> {
		return apiFetch<EventDetail>(occurrenceUrl(id, date), {
			method: 'PUT',
			body: JSON.stringify({ cancelled, override })
		});
	}

	/** Vorkommen auf die Serie zurücksetzen und neu laden */
	async function resetOccurrence(id: string, date: string): Promise<EventDetail> {
		await apiFetch(occurrenceUrl(id, date), { method: 'DELETE' });
		return apiFetch<EventDetail>(detailUrl(id, date));
	}

	/** Von der Ansicht in die Bearbeitung wechseln (gleicher Dialog, kein Neuladen). */
	function startEdit() {
		if (!loaded || !canEdit) return;
		if (isSeries && occDate) {
			choice = 'edit';
			choiceOpen = true;
			return;
		}
		void editSeries();
	}

	async function focusTitle() {
		await tick();
		document.getElementById(ids.title)?.focus();
	}

	/** Ganze Serie (bzw. einmaligen Termin) bearbeiten: Seriendaten statt Vorkommen */
	async function editSeries() {
		const e = loaded;
		if (!e) return;
		fill(e);
		if (e.recurrence && e.series) {
			title = e.series.title;
			description = e.series.description ?? '';
			location = e.series.location ?? '';
			startsOn = e.series.startsOn;
			startsTime = e.series.startsTime?.slice(0, 5) ?? '';
			endsOn = e.series.endsOn ?? '';
			endsTime = e.series.endsTime?.slice(0, 5) ?? '';
		}
		current = 'edit';
		await focusTitle();
	}

	async function editOccurrence() {
		if (!loaded) return;
		fill(loaded);
		current = 'edit-occurrence';
		await focusTitle();
	}

	function startDelete() {
		if (!loaded || !canEdit) return;
		if (isSeries && occDate && !isCancelled) {
			choice = 'delete';
			choiceOpen = true;
			return;
		}
		confirmOpen = true;
	}

	function onChoose(value: string) {
		const which = choice;
		choice = null;
		if (which === 'edit') {
			if (value === 'occurrence') void editOccurrence();
			else void editSeries();
		} else if (which === 'delete') {
			if (value === 'occurrence') void cancelOccurrence();
			else confirmOpen = true;
		}
	}

	/** „Nur diesen Termin absagen“ – Override bleibt erhalten, Rückgängig per Toast */
	async function cancelOccurrence() {
		const e = loaded;
		const date = e?.occurrenceDate;
		if (!e || !date || actionBusy) return;
		actionBusy = true;
		try {
			// Gespeicherten Override beibehalten
			const prev = e.override ?? null;
			const saved = await putOccurrence(e.id, date, true, prev);
			open = false;
			onsaved(saved);
			toastWithUndo({
				message: `Termin am ${formatEventDate(date)} abgesagt`,
				undone: 'Termin wieder angesetzt',
				undo: async () => {
					const restored = prev
						? await putOccurrence(e.id, date, false, prev)
						: await resetOccurrence(e.id, date);
					onsaved(restored);
				}
			});
		} catch (err) {
			toast.error(errorMessage(err, 'Absagen fehlgeschlagen'));
		} finally {
			actionBusy = false;
		}
	}

	/**
	 * Abgesagtes Vorkommen wieder ansetzen. Ein vorhandener Override bleibt erhalten (PUT
	 * `cancelled: false`), ohne Override wird die Ausnahme gelöscht.
	 */
	async function reinstate(date: string) {
		const e = loaded;
		if (!e || actionBusy) return;
		actionBusy = true;
		try {
			const occ =
				e.occurrenceDate === date ? e : await apiFetch<EventDetail>(detailUrl(e.id, date));
			const ov = occ.override ?? null;
			const saved = ov
				? await putOccurrence(e.id, date, false, ov)
				: await resetOccurrence(e.id, date);
			toast.success(`Termin am ${formatEventDate(date)} wieder angesetzt`);
			if (loaded !== e) return;
			if (e.occurrenceDate === date) {
				loaded = saved;
				if (viewing) fill(saved);
			} else {
				// Serie in Bearbeitung: Formular behalten, nur die Liste aktualisieren
				loaded = {
					...e,
					cancelledDates: e.cancelledDates.filter((d) => d !== date),
					exceptionDates: ov
						? [...new Set([...e.exceptionDates, date])]
						: e.exceptionDates.filter((d) => d !== date)
				};
			}
			onsaved(saved);
		} catch (err) {
			toast.error(errorMessage(err, 'Wieder ansetzen fehlgeschlagen'));
		} finally {
			actionBusy = false;
		}
	}

	/** Bearbeitetes Vorkommen auf die Serie zurücksetzen */
	async function resetToSeries() {
		const e = loaded;
		const date = e?.occurrenceDate;
		if (!e || !date || actionBusy) return;
		actionBusy = true;
		try {
			const saved = await resetOccurrence(e.id, date);
			toast.success('Termin auf die Serie zurückgesetzt');
			loaded = saved;
			fill(saved);
			current = 'view';
			onsaved(saved);
		} catch (err) {
			toast.error(errorMessage(err, 'Zurücksetzen fehlgeschlagen'));
		} finally {
			actionBusy = false;
		}
	}

	/** Gruppenstunde als wöchentliche Serie übernehmen */
	function applyMeeting(g: EventGroupRef, weekday: number) {
		recurrence = { freq: 'weekly', interval: 1, byWeekday: [weekday], end: { type: 'never' } };
		const time = g.meetingTime?.slice(0, 5);
		if (time) startsTime = time;
		if (!location.trim() && g.meetingPlace?.trim()) location = g.meetingPlace.trim();
		const validStart = !!startsOn && isRealDate(startsOn);
		if (!validStart || isoWeekday(startsOn) !== weekday) {
			const next = nextWeekday(validStart ? startsOn : todayBerlin(), weekday);
			if (endsOn && validStart) {
				try {
					endsOn = addDays(endsOn, daysBetween(startsOn, next));
				} catch {
					endsOn = '';
				}
			} else if (endsOn && endsOn < next) {
				endsOn = '';
				endsTime = '';
			}
			startsOn = next;
		}
		// Ende der Gruppenstunde (members, Migration 0010): am selben Tag vorbelegen
		const end = g.meetingEndTime?.slice(0, 5);
		if (time && end && end > time && (!endsOn || endsOn === startsOn)) {
			endsOn = startsOn;
			endsTime = end;
		}
	}

	/** „Abbrechen“: bestehender Termin → zurück zur Ansicht mit den geladenen Daten */
	function cancel() {
		if ((current === 'edit' || current === 'edit-occurrence') && loaded) {
			fill(loaded);
			current = 'view';
			return;
		}
		open = false;
	}

	function showErrors(next: Record<string, string>, message: string) {
		fieldErrors = next;
		error = message;
		void focusFirstError();
	}

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		if (viewing || busy || loading) return;
		error = '';
		fieldErrors = {};
		if (occEdit) return submitOccurrence();
		const parsed = eventInput.safeParse({
			title,
			description: description || null,
			location: location || null,
			color,
			startsOn,
			startsTime: startsTime || null,
			endsOn: endsOn || null,
			endsTime: endsTime || null,
			tags,
			groupIds,
			shares: shares.map((s) => ({ type: s.type ?? 'user', id: s.userId, level: s.level })),
			onWebsite,
			recurrence: recurrence ? $state.snapshot(recurrence) : null
		});
		if (!parsed.success) {
			showErrors(issuesToErrors(parsed.error.issues), 'Bitte die markierten Felder prüfen.');
			return;
		}
		busy = true;
		const id = current === 'edit' ? (loaded?.id ?? eventId) : null;
		try {
			const saved = id
				? await apiFetch<EventDetail>(`${BASE}/events/${encodeURIComponent(id)}`, {
						method: 'PUT',
						body: JSON.stringify(parsed.data)
					})
				: await apiFetch<EventDetail>(`${BASE}/events`, {
						method: 'POST',
						body: JSON.stringify(parsed.data)
					});
			toast.success(
				id
					? parsed.data.recurrence
						? 'Serie gespeichert'
						: 'Termin gespeichert'
					: 'Termin angelegt'
			);
			if (id) {
				loaded = saved;
				fill(saved);
				current = 'view';
			} else {
				open = false;
			}
			onsaved(saved);
		} catch (err) {
			if (err instanceof ApiClientError) {
				showErrors(detailsToErrors(err.details), err.message);
			} else {
				error = 'Speichern fehlgeschlagen';
			}
		} finally {
			busy = false;
		}
	}

	/** Nur dieses Vorkommen speichern (Override gegenüber der Serie) */
	async function submitOccurrence() {
		const e = loaded;
		const date = e?.occurrenceDate;
		if (!e || !date) return;
		const values = {
			title,
			description,
			location,
			startsOn,
			startsTime: startsTime || null,
			endsOn: endsOn || null,
			endsTime: endsTime || null
		};
		// Datumsregeln wie beim Termin (Ende nach Beginn usw.)
		const local: Issue[] = [];
		if (!title.trim()) local.push({ path: ['title'], message: 'Pflichtfeld' });
		if (!startsOn) local.push({ path: ['startsOn'], message: 'Pflichtfeld' });
		else
			checkEventDates(values, {
				addIssue: (i: Issue) => local.push(i)
			} as unknown as Parameters<typeof checkEventDates>[1]);
		const override = local.length
			? null
			: buildOverride(values, seriesTextOf(e), baseDatesOf(e.series ?? e, date));
		const parsed = occurrenceInput.safeParse({ cancelled: false, override });
		if (local.length || !parsed.success) {
			const issues = local.length ? local : (parsed.error?.issues ?? []);
			showErrors(issuesToErrors(issues), 'Bitte die markierten Felder prüfen.');
			return;
		}
		if (!parsed.data.override && !e.isException) {
			// Nichts geändert
			fill(e);
			current = 'view';
			return;
		}
		busy = true;
		try {
			const saved = parsed.data.override
				? await putOccurrence(e.id, date, false, parsed.data.override)
				: await resetOccurrence(e.id, date);
			toast.success(`Termin am ${formatEventDate(date)} gespeichert`);
			loaded = saved;
			fill(saved);
			current = 'view';
			onsaved(saved);
		} catch (err) {
			if (err instanceof ApiClientError) {
				showErrors(detailsToErrors(err.details), err.message);
			} else {
				error = 'Speichern fehlgeschlagen';
			}
		} finally {
			busy = false;
		}
	}

	async function remove() {
		if (!loaded) return;
		const id = loaded.id;
		const series = isSeries;
		deleting = true;
		try {
			await apiFetch(`${BASE}/events/${encodeURIComponent(id)}`, { method: 'DELETE' });
			toast.success(series ? 'Serie gelöscht' : 'Termin gelöscht');
			open = false;
			ondeleted?.(id);
		} catch (err) {
			toast.error(errorMessage(err, 'Löschen fehlgeschlagen'));
		} finally {
			deleting = false;
		}
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="flex flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
		<Dialog.Header class="border-b p-4 pr-12">
			{#if viewing && loaded}
				<Dialog.Title class="flex flex-wrap items-center gap-2">
					{#if titleColor}
						<span
							class="size-3 shrink-0 rounded-full border border-border"
							style:background-color={titleColor}
							aria-hidden="true"
						></span>
					{/if}
					<span class="min-w-0 break-words">{loaded.title}</span>
					{#if loaded.onWebsite}
						<Badge variant="secondary"><Globe aria-hidden="true" /> Website</Badge>
					{/if}
					{#if isSeries}
						<Badge variant="secondary"><Repeat aria-hidden="true" /> Serie</Badge>
					{/if}
					{#if isCancelled}
						<Badge variant="outline" class="border-destructive/50 text-destructive">Abgesagt</Badge>
					{:else if loaded.isException}
						<Badge variant="outline">Geändert</Badge>
					{/if}
				</Dialog.Title>
				<Dialog.Description class={[isCancelled && 'line-through']}>
					{formatEventRange(loaded)}{#if isAllDay(loaded)}&nbsp;(ganztägig){/if}
				</Dialog.Description>
			{:else if viewing}
				<Dialog.Title>Termin</Dialog.Title>
				<Dialog.Description class="sr-only">Details zum Termin</Dialog.Description>
			{:else if occEdit}
				<Dialog.Title>Termin bearbeiten</Dialog.Title>
				<Dialog.Description>
					Nur der Termin am {occDate ? formatEventDate(occDate) : ''}. Pflichtfelder sind mit *
					markiert.
				</Dialog.Description>
			{:else}
				<Dialog.Title>
					{current === 'edit'
						? isSeries
							? 'Serie bearbeiten'
							: 'Termin bearbeiten'
						: 'Termin anlegen'}
				</Dialog.Title>
				<Dialog.Description>
					{#if editingSeries}Änderungen gelten für alle Termine der Serie.{/if}
					Pflichtfelder sind mit * markiert.
				</Dialog.Description>
			{/if}
		</Dialog.Header>

		<form class="flex min-h-0 flex-1 flex-col" onsubmit={submit} novalidate>
			<div class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
				{#if loading}
					<div class="space-y-4" aria-busy="true" aria-label="Termin wird geladen">
						<Skeleton class="h-9 w-full" />
						<Skeleton class="h-24 w-full" />
						<div class="grid gap-4 sm:grid-cols-2">
							<Skeleton class="h-9 w-full" />
							<Skeleton class="h-9 w-full" />
							<Skeleton class="h-9 w-full" />
							<Skeleton class="h-9 w-full" />
						</div>
					</div>
				{:else if loadError}
					<div class="space-y-3 rounded-md border border-destructive/40 p-4">
						<p class="text-sm text-destructive" role="alert">{loadError}</p>
						<Button type="button" variant="outline" size="sm" onclick={retry}>
							Erneut versuchen
						</Button>
					</div>
				{:else}
					{#if viewing && isCancelled && occDate}
						<div
							class="mb-4 flex flex-col gap-3 rounded-md border border-destructive/40 p-3 sm:flex-row sm:items-center sm:justify-between"
						>
							<p class="text-sm text-destructive">
								Der Termin am {formatEventDate(occDate)} ist abgesagt.
							</p>
							{#if canEdit}
								<Button
									type="button"
									variant="outline"
									size="sm"
									disabled={actionBusy}
									onclick={() => reinstate(occDate)}
								>
									<RotateCcw />
									{actionBusy ? 'Setzt an …' : 'Wieder ansetzen'}
								</Button>
							{/if}
						</div>
					{/if}
					<!-- Ansicht: das deaktivierte fieldset sperrt alle Felder; gesperrte Felder bleiben gut lesbar -->
					<fieldset
						disabled={viewing}
						class={[
							'min-w-0 space-y-6',
							viewing &&
								'[&_:disabled]:cursor-default [&_:disabled]:opacity-100 [&_input:disabled]:bg-muted/40 [&_label]:opacity-100'
						]}
					>
						<div class="space-y-4">
							{#if !viewing}
								<FormField label="Titel *" id={ids.title} error={fieldErrors.title}>
									<Input
										id={ids.title}
										bind:value={title}
										required
										maxlength={200}
										aria-invalid={!!fieldErrors.title}
										aria-describedby={describe('title')}
									/>
								</FormField>
							{/if}
							{#if viewing}
								{#if description}
									<div class="grid gap-1.5">
										<span class="text-sm font-medium">Beschreibung</span>
										<p
											class="rounded-md border bg-muted/40 px-3 py-2 text-sm break-words whitespace-pre-wrap"
										>
											{description}
										</p>
									</div>
								{/if}
							{:else}
								<FormField
									label="Beschreibung"
									id={ids.description}
									error={fieldErrors.description}
								>
									<AssistTextarea
										id={ids.description}
										bind:value={description}
										rows={4}
										maxlength={10000}
										assist={{
											module: 'events',
											purpose: 'event-description',
											context: loaded
												? { module: 'events', kind: 'event', id: loaded.id }
												: undefined,
											extra: () => ({
												title,
												location,
												startsOn,
												startsAt: startsTime,
												tags: tags.join(', ')
											})
										}}
										aria-invalid={!!fieldErrors.description}
										aria-describedby={describe('description')}
									/>
								</FormField>
							{/if}
							{#if !viewing || location}
								<FormField label="Ort" id={ids.location} error={fieldErrors.location}>
									<Input
										id={ids.location}
										bind:value={location}
										maxlength={300}
										aria-invalid={!!fieldErrors.location}
										aria-describedby={describe('location')}
									/>
								</FormField>
							{/if}
							<div class="grid gap-4 sm:grid-cols-2">
								<FormField
									label={viewing ? 'Startdatum' : 'Startdatum *'}
									id={ids.startsOn}
									error={fieldErrors.startsOn}
								>
									<Input
										id={ids.startsOn}
										type="date"
										bind:value={startsOn}
										required
										aria-invalid={!!fieldErrors.startsOn}
										aria-describedby={describe('startsOn')}
									/>
								</FormField>
								{#if !viewing || startsTime}
									<FormField
										label="Startuhrzeit"
										id={ids.startsTime}
										error={fieldErrors.startsTime}
									>
										<Input
											id={ids.startsTime}
											type="time"
											bind:value={startsTime}
											aria-invalid={!!fieldErrors.startsTime}
											aria-describedby={describe('startsTime')}
										/>
									</FormField>
								{/if}
								{#if !viewing || endsOn}
									<FormField label="Enddatum" id={ids.endsOn} error={fieldErrors.endsOn}>
										<Input
											id={ids.endsOn}
											type="date"
											bind:value={endsOn}
											min={startsOn || undefined}
											aria-invalid={!!fieldErrors.endsOn}
											aria-describedby={describe('endsOn')}
										/>
									</FormField>
								{/if}
								{#if !viewing || endsTime}
									<FormField label="Enduhrzeit" id={ids.endsTime} error={fieldErrors.endsTime}>
										<Input
											id={ids.endsTime}
											type="time"
											bind:value={endsTime}
											aria-invalid={!!fieldErrors.endsTime}
											aria-describedby={describe('endsTime')}
										/>
									</FormField>
								{/if}
							</div>
							{#if !viewing}
								<p class="-mt-2 text-xs text-muted-foreground">
									Ohne Uhrzeit gilt der Termin als ganztägig.
								</p>
							{/if}

							{#if viewing}
								{#if loaded?.recurrence}
									<RecurrenceField
										value={loaded.recurrence}
										startsOn={seriesStart}
										readonly
										idPrefix="ev-recurrence"
									/>
								{/if}
							{:else if !occEdit}
								{#each meetingSuggestions as s (s.group.id)}
									<div
										class="flex flex-col gap-3 rounded-lg border bg-muted/40 p-3 sm:flex-row sm:items-center sm:justify-between"
									>
										<p class="flex items-start gap-2 text-sm">
											<Repeat
												class="mt-0.5 size-4 shrink-0 text-muted-foreground"
												aria-hidden="true"
											/>
											<span>
												<span class="font-medium">Gruppenstunde {s.group.name}:</span>
												{s.text}
											</span>
										</p>
										<Button
											type="button"
											variant="outline"
											size="sm"
											aria-label="Gruppenstunde {s.group.name} als Wiederholung übernehmen"
											onclick={() => applyMeeting(s.group, s.weekday)}
										>
											Übernehmen
										</Button>
									</div>
								{/each}
								<RecurrenceField
									bind:value={recurrence}
									{startsOn}
									errors={fieldErrors}
									idPrefix="ev-recurrence"
								/>
								{#if editingSeries && loaded}
									{#if loaded.exceptionDates.length > 0}
										<p class="text-xs text-muted-foreground">
											{loaded.exceptionDates.length === 1
												? '1 einzeln geänderter Termin bleibt erhalten, sofern er weiter zur Serie gehört.'
												: `${loaded.exceptionDates.length} einzeln geänderte Termine bleiben erhalten, sofern sie weiter zur Serie gehören.`}
										</p>
									{/if}
									{#if loaded.cancelledDates.length > 0}
										<section class="grid gap-1.5" aria-labelledby="ev-cancelled-heading">
											<h3 id="ev-cancelled-heading" class="text-sm font-medium">
												Abgesagte Termine
											</h3>
											<ul class="divide-y rounded-md border">
												{#each [...loaded.cancelledDates].sort() as d (d)}
													<li class="flex items-center justify-between gap-3 px-3 py-1.5 text-sm">
														<span class="tabular-nums">{formatEventDate(d)}</span>
														<Button
															type="button"
															variant="ghost"
															size="sm"
															disabled={actionBusy}
															aria-label="Termin am {formatEventDate(d)} wieder ansetzen"
															onclick={() => reinstate(d)}
														>
															<RotateCcw /> Wieder ansetzen
														</Button>
													</li>
												{/each}
											</ul>
										</section>
									{/if}
								{/if}
							{/if}

							{#if viewing}
								{#if loaded && loaded.groups.length > 0}
									<div class="grid gap-1.5">
										<span class="text-sm font-medium">Gruppen</span>
										<div class="flex flex-wrap gap-1.5">
											{#each loaded.groups as g (g.id)}
												<ColorBadge color={g.color}>{g.name}</ColorBadge>
											{/each}
										</div>
									</div>
								{/if}
								{#if tags.length > 0}
									<div class="grid gap-1.5">
										<span class="text-sm font-medium">Tags</span>
										<div class="flex flex-wrap gap-1.5">
											{#each tags as t (t)}
												<Badge variant="outline">{t}</Badge>
											{/each}
										</div>
									</div>
								{/if}
								{#if !canEdit}
									<!-- Mit Bearbeiten-Recht steht die Ersteller*in in der Sichtbarkeit -->
									<div class="grid gap-1.5">
										<span class="text-sm font-medium">Ersteller*in</span>
										<p class="text-sm">{ownerLabel}</p>
									</div>
								{/if}
							{:else if occEdit && loaded}
								<!-- Einzelnes Vorkommen: Serienfelder nur anzeigen -->
								<section
									class="space-y-3 rounded-md border border-dashed p-3"
									aria-labelledby="ev-series-fields"
								>
									<p
										id="ev-series-fields"
										class="flex items-start gap-1.5 text-xs text-muted-foreground"
									>
										<Repeat class="mt-px size-3.5 shrink-0" aria-hidden="true" />
										<span>
											Gilt für die ganze Serie – Farbe, Gruppen, Tags, Sichtbarkeit, Website und
											Wiederholung änderst du über „Bearbeiten“ → „Ganze Serie“.
										</span>
									</p>
									{#if loaded.recurrence}
										<RecurrenceField
											value={loaded.recurrence}
											startsOn={seriesStart}
											readonly
											idPrefix="ev-recurrence"
										/>
									{/if}
									<dl class="grid gap-2 text-sm sm:grid-cols-[auto_1fr] sm:gap-x-4">
										<dt class="text-muted-foreground">Farbe</dt>
										<dd class="flex items-center gap-2">
											{#if titleColor}
												<span
													class="size-3 rounded-full border border-border"
													style:background-color={titleColor}
													aria-hidden="true"
												></span>
												<span class="font-mono text-xs">{titleColor}</span>
											{:else}
												Keine
											{/if}
										</dd>
										<dt class="text-muted-foreground">Gruppen</dt>
										<dd class="flex flex-wrap gap-1.5">
											{#each loaded.groups as g (g.id)}
												<ColorBadge color={g.color}>{g.name}</ColorBadge>
											{:else}
												Keine
											{/each}
										</dd>
										<dt class="text-muted-foreground">Tags</dt>
										<dd class="flex flex-wrap gap-1.5">
											{#each loaded.tags as t (t)}
												<Badge variant="outline">{t}</Badge>
											{:else}
												Keine
											{/each}
										</dd>
										<dt class="text-muted-foreground">Website</dt>
										<dd>{loaded.onWebsite ? 'Wird auf der Stammeswebsite angezeigt' : 'Nein'}</dd>
									</dl>
								</section>
							{:else}
								<div class="grid gap-4 sm:grid-cols-2">
									<FormField label="Farbe" id={ids.color} error={fieldErrors.color}>
										<ColorPicker
											id={ids.color}
											label="Farbe"
											bind:value={color}
											presets={PRESETS}
											allowClear
											invalid={!!fieldErrors.color}
										/>
									</FormField>
									<FormField label="Gruppen" id={ids.groupIds} error={fieldErrors.groupIds}>
										<MultiSelect
											id={ids.groupIds}
											label="Gruppen"
											options={groupOptions}
											value={groupIds}
											onchange={onGroupsChange}
											placeholder="Keine Gruppe"
											searchPlaceholder="Gruppe suchen …"
											invalid={!!fieldErrors.groupIds}
										/>
									</FormField>
								</div>
								<FormField
									label="Tags"
									id={ids.tags}
									error={fieldErrors.tags}
									hint="Enter oder Komma legt einen Tag an. Höchstens {MAX_TAGS} Tags."
								>
									<TagInput
										id={ids.tags}
										bind:value={tags}
										loadSuggestions={loadTags}
										max={MAX_TAGS}
										maxLength={MAX_TAG_LENGTH}
										invalid={!!fieldErrors.tags}
										describedby={fieldErrors.tags ? `${ids.tags}-error` : `${ids.tags}-hint`}
									/>
								</FormField>
							{/if}
						</div>

						{#if !viewing || canEdit}
							<section class="space-y-3" aria-labelledby="ev-shares-heading">
								<div>
									<h3 id="ev-shares-heading" class="font-semibold">Sichtbarkeit</h3>
									{#if occEdit}
										<p class="text-xs text-muted-foreground">Gilt für die ganze Serie.</p>
									{:else if viewing}
										{#if shares.length === 0}
											<p class="text-xs text-muted-foreground">
												Nicht freigegeben – nur Ersteller*in und Berechtigte sehen den Termin.
											</p>
										{/if}
									{:else}
										<p class="text-xs text-muted-foreground">
											{current === 'create'
												? 'Du (Ersteller*in) kannst den Termin immer bearbeiten.'
												: 'Die Ersteller*in kann den Termin immer bearbeiten.'}
											{#if !sharesTouched}
												Sichtbarkeit folgt den Gruppen, bis du sie änderst.
											{/if}
										</p>
									{/if}
								</div>
								<div
									id={ids.shares}
									tabindex="-1"
									class="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
								>
									{#if viewing || occEdit}
										<SharePanel
											{shares}
											{owner}
											levels={LEVELS}
											canManage={false}
											everyoneLabel={stammName}
											search={searchPrincipals}
											onadd={noop}
											onchange={noop}
											onremove={noop}
										/>
									{:else}
										<SharePanel
											{shares}
											{owner}
											levels={LEVELS}
											defaultLevel="read"
											everyoneLabel={stammName}
											placeholder="Name, Gruppe, Rolle oder Mitglied suchen …"
											searchLabel="Freigabe suchen"
											emptyResultText="Keine passenden Einträge"
											search={searchPrincipals}
											onadd={addShare}
											onchange={changeShare}
											onremove={removeShare}
										/>
									{/if}
								</div>
								{#if fieldErrors.shares}
									<p id="{ids.shares}-error" role="alert" class="text-xs text-destructive">
										{fieldErrors.shares}
									</p>
								{/if}
							</section>
						{/if}

						{#if !viewing && !occEdit}
							<div class="flex items-start gap-2">
								<Checkbox
									id={ids.onWebsite}
									checked={onWebsite}
									disabled={publishLocked}
									onCheckedChange={(v) => (onWebsite = v === true)}
									aria-describedby="{ids.onWebsite}-hint"
									class="mt-0.5"
								/>
								<div class="grid gap-0.5">
									<Label for={ids.onWebsite}>Auf der Stammeswebsite anzeigen</Label>
									<p id="{ids.onWebsite}-hint" class="text-xs text-muted-foreground">
										Für alle im Internet sichtbar (Titel, Beschreibung, Ort, Zeit, Tags, Gruppen).
										{#if publishLocked}
											Veröffentlichen darf nur, wer das Recht dazu hat.
										{/if}
									</p>
								</div>
							</div>
						{/if}
					</fieldset>
				{/if}

				{#if error}<p class="mt-4 text-sm text-destructive" role="alert">{error}</p>{/if}
			</div>

			<Dialog.Footer class="mx-0 mb-0">
				{#if viewing}
					{#if loaded && canEdit}
						<Button
							type="button"
							variant="outline"
							class="text-destructive hover:text-destructive sm:mr-auto"
							disabled={deleting || actionBusy}
							onclick={startDelete}
						>
							<Trash2 />
							{deleting ? 'Löscht …' : 'Löschen'}
						</Button>
					{/if}
					<Button type="button" variant="outline" onclick={() => (open = false)}>Schließen</Button>
					{#if loaded && canEdit}
						<Button type="button" onclick={startEdit} disabled={deleting || actionBusy}>
							<Pencil /> Bearbeiten
						</Button>
					{/if}
				{:else}
					{#if occEdit && loaded?.isException}
						<Button
							type="button"
							variant="outline"
							class="sm:mr-auto"
							disabled={busy || actionBusy}
							onclick={resetToSeries}
						>
							<RotateCcw />
							{actionBusy ? 'Setzt zurück …' : 'Auf Serie zurücksetzen'}
						</Button>
					{/if}
					<Button type="button" variant="outline" onclick={cancel} disabled={busy}>
						Abbrechen
					</Button>
					<Button type="submit" disabled={busy || loading || !!loadError}>
						{busy ? 'Speichert …' : 'Speichern'}
					</Button>
				{/if}
			</Dialog.Footer>
		</form>
	</Dialog.Content>
</Dialog.Root>

<ConfirmDialog
	bind:open={confirmOpen}
	title={isSeries ? 'Ganze Serie löschen?' : 'Termin löschen?'}
	description={loaded
		? isSeries
			? `Alle Termine der Serie „${loaded.title}“ werden endgültig gelöscht – auch abgesagte und einzeln geänderte. Das lässt sich nicht rückgängig machen.`
			: `„${loaded.title}“ wird endgültig gelöscht. Das lässt sich nicht rückgängig machen.`
		: undefined}
	confirmLabel="Löschen"
	destructive
	onconfirm={remove}
/>

<SeriesChoiceDialog
	bind:open={choiceOpen}
	title={choice === 'delete' ? 'Serientermin löschen' : 'Serientermin bearbeiten'}
	description={choice === 'delete'
		? 'Soll nur dieser Termin ausfallen oder die ganze Serie gelöscht werden?'
		: 'Was möchtest du bearbeiten?'}
	options={choiceOptions}
	onchoose={onChoose}
/>
