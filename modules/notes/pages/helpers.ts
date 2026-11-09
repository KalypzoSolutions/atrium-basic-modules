/** Kleine UI-Hilfen der Notizen-Seiten (ohne Server-Importe). */
import { ApiClientError, apiFetch } from '$lib/sdk/client';
import type { PrincipalInfo } from '$lib/sdk/types/sharing';
import type { ShareCandidate, ShareEntry } from '$lib/components/layout';
import { BASE_PATH, type NoteAsset, type NoteDetail, type NoteShares } from '../schemas';

export const BASE = BASE_PATH;
/** Pfad für `apiFetch` (ohne `/api/v1`) */
export const API = '/modules/notes';

export const notePath = (id: string) => `${BASE}/${id}`;

export function errMsg(e: unknown, fallback: string): string {
	return e instanceof ApiClientError && e.message ? e.message : fallback;
}

/** „vor 5 Min.“, „gestern“, sonst Datum */
export function relativeTime(iso: string): string {
	const then = new Date(iso).getTime();
	const diff = Date.now() - then;
	const min = Math.round(diff / 60_000);
	if (min < 1) return 'gerade eben';
	if (min < 60) return `vor ${min} Min.`;
	const h = Math.round(min / 60);
	if (h < 24) return `vor ${h} Std.`;
	const d = Math.round(h / 24);
	if (d === 1) return 'gestern';
	if (d < 7) return `vor ${d} Tagen`;
	return new Date(iso).toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' });
}

export const noteTitle = (title: string | null | undefined) => title?.trim() || 'Ohne Titel';

export async function createNote(input: {
	title?: string;
	parentId?: string | null;
	actionId?: string | null;
}): Promise<NoteDetail> {
	return apiFetch<NoteDetail>(`${API}/notes`, { method: 'POST', body: JSON.stringify(input) });
}

/** .md/.zip importieren (optional als Unterseite) */
export async function importNote(file: File, parentId?: string | null): Promise<{ id: string }> {
	const form = new FormData();
	form.set('file', file);
	if (parentId) form.set('parentId', parentId);
	return apiFetch<{ id: string }>(`${API}/notes/import`, { method: 'POST', body: form });
}

export const IMPORT_ACCEPT = '.md,.markdown,.zip,text/markdown,application/zip';

export async function uploadAsset(noteId: string, file: File): Promise<NoteAsset> {
	const form = new FormData();
	form.set('file', file);
	return apiFetch<NoteAsset>(`${API}/notes/${noteId}/assets`, { method: 'POST', body: form });
}

// --- Teilen -------------------------------------------------------------------

export const SHARE_LEVELS_UI = [
	{ value: 'read', label: 'Ansehen' },
	{ value: 'edit', label: 'Bearbeiten' }
];

export function loadShares(noteId: string): Promise<NoteShares> {
	return apiFetch<NoteShares>(`${API}/notes/${noteId}/shares`);
}

export async function searchPrincipals(
	q: string,
	ownerId: string | null
): Promise<ShareCandidate[]> {
	const found = await apiFetch<PrincipalInfo[]>(
		`${API}/principals?search=${encodeURIComponent(q)}`
	);
	return found
		.filter((p) => !(p.type === 'user' && p.id === ownerId))
		.map((p) => ({
			id: p.id,
			type: p.type,
			name: p.name,
			detail: p.detail ?? null,
			color: p.color ?? null,
			image: p.image ?? null
		}));
}

export async function saveShares(noteId: string, next: ShareEntry[]): Promise<NoteShares> {
	try {
		return await apiFetch<NoteShares>(`${API}/notes/${noteId}/shares`, {
			method: 'PUT',
			body: JSON.stringify({
				shares: next.map((s) => ({ type: s.type ?? 'user', id: s.userId, level: s.level }))
			})
		});
	} catch (e) {
		throw new Error(errMsg(e, 'Freigabe fehlgeschlagen'), { cause: e });
	}
}

export function shareEntries(shares: NoteShares): ShareEntry[] {
	return shares.shares.map((s) => ({
		userId: s.userId,
		type: s.type,
		name: s.name,
		detail: s.detail,
		color: s.color,
		image: s.image,
		level: s.level
	}));
}

export function shareCandidateEntry(c: ShareCandidate, level: string): ShareEntry {
	return {
		userId: c.id,
		type: c.type ?? 'user',
		name: c.name,
		detail: c.detail ?? null,
		color: c.color ?? null,
		image: c.image ?? null,
		level
	};
}

/** Beschreibung inkl. geerbter Freigaben (die Bausteine zeigen nur eigene) */
export function shareDescription(shares: NoteShares | null, actionLinked: boolean): string {
	let text = 'Wer diese Seite sehen oder mitbearbeiten darf. Unterseiten erben die Freigaben.';
	if (actionLinked) text += ' Zusätzlich alle mit Zugriff auf die Aktion.';
	const inherited = shares?.inherited ?? [];
	if (inherited.length) {
		const byPage = new Map<string, string[]>();
		for (const s of inherited) {
			const list = byPage.get(s.fromTitle) ?? [];
			list.push(`${s.name} (${s.level === 'edit' ? 'Bearbeiten' : 'Ansehen'})`);
			byPage.set(s.fromTitle, list);
		}
		text +=
			' Geerbt: ' +
			[...byPage.entries()]
				.map(([title, names]) => `von „${noteTitle(title)}“: ${names.join(', ')}`)
				.join('; ') +
			'.';
	}
	return text;
}
