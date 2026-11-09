/** Eingebettete Inhalte: Beschreibung gebündelt und zwischengespeichert abrufen (Core `/embeds/describe`). */
import { apiFetch } from '$lib/sdk/client';
import type { EmbedHit, EmbedInfo, EmbedRef } from '$lib/sdk/types/embeds';

const cache = new Map<string, Promise<EmbedInfo>>();
let batch: { ref: EmbedRef; resolve: (i: EmbedInfo) => void; reject: (e: unknown) => void }[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;

export const embedKey = (r: EmbedRef) => `${r.module}:${r.kind}:${r.refId}`;

function unavailable(ref: EmbedRef): EmbedInfo {
	return {
		...ref,
		available: false,
		title: 'Nicht verfügbar',
		icon: 'box',
		kindLabel: '',
		embedPath: null,
		openHref: null,
		canEdit: false
	};
}

async function run() {
	timer = null;
	const items = batch;
	batch = [];
	try {
		const infos = await apiFetch<EmbedInfo[]>('/embeds/describe', {
			method: 'POST',
			body: JSON.stringify({ items: items.map((i) => i.ref) })
		});
		items.forEach((item, i) => item.resolve(infos[i] ?? unavailable(item.ref)));
	} catch (e) {
		for (const item of items) {
			cache.delete(embedKey(item.ref));
			item.reject(e);
		}
	}
}

/** Beschreibung eines Verweises (je Betrachter*in; `force` lädt neu) */
export function describeEmbed(ref: EmbedRef, force = false): Promise<EmbedInfo> {
	const key = embedKey(ref);
	if (!force) {
		const hit = cache.get(key);
		if (hit) return hit;
	}
	const promise = new Promise<EmbedInfo>((resolve, reject) => {
		batch.push({ ref, resolve, reject });
		if (batch.length >= 50) {
			if (timer) clearTimeout(timer);
			void run();
		} else if (!timer) timer = setTimeout(() => void run(), 30);
	});
	cache.set(key, promise);
	return promise;
}

export function searchEmbeds(q: string): Promise<EmbedHit[]> {
	return apiFetch<EmbedHit[]>(`/embeds?q=${encodeURIComponent(q)}`);
}
