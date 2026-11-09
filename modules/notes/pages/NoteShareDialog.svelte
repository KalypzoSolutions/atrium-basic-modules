<script lang="ts">
	// Freigabe einer beliebigen Seite (aus dem Baum): lädt die Freigaben selbst, zeigt geerbte in der Beschreibung
	import { toast } from 'svelte-sonner';
	import { ShareDialog, type ShareCandidate } from '$lib/components/layout';
	import { shareKey } from '$lib/components/layout/share-types';
	import type { NoteNode, NoteShares } from '../schemas';
	import {
		errMsg,
		loadShares,
		saveShares,
		searchPrincipals,
		SHARE_LEVELS_UI,
		shareCandidateEntry,
		shareDescription,
		shareEntries
	} from './helpers';

	let {
		open = $bindable(false),
		node
	}: {
		open?: boolean;
		node: Pick<NoteNode, 'id' | 'title' | 'ownerId' | 'actionId'> | null;
	} = $props();

	let shares = $state<NoteShares | null>(null);

	$effect(() => {
		const id = node?.id;
		if (!open || !id) return;
		let stale = false;
		shares = null;
		loadShares(id)
			.then((s) => {
				if (!stale) shares = s;
			})
			.catch((e) => {
				if (stale) return;
				toast.error(errMsg(e, 'Freigaben konnten nicht geladen werden'));
				open = false;
			});
		return () => {
			stale = true;
		};
	});

	const entries = $derived(shares ? shareEntries(shares) : []);

	async function save(next: typeof entries) {
		if (!node) return;
		shares = await saveShares(node.id, next);
	}
</script>

{#if shares && node}
	<ShareDialog
		bind:open
		title={`„${node.title || 'Ohne Titel'}“ teilen`}
		description={shareDescription(shares, !!node.actionId)}
		shares={entries}
		owner={shares.owner ? { name: shares.owner.name, image: shares.owner.image } : undefined}
		levels={SHARE_LEVELS_UI}
		defaultLevel="edit"
		canManage={shares.canManage}
		search={(q) => searchPrincipals(q, node.ownerId)}
		onadd={async (c: ShareCandidate, level: string) => {
			const entry = shareCandidateEntry(c, level);
			if (entries.some((s) => shareKey(s) === shareKey(entry))) return;
			await save([...entries, entry]);
		}}
		onchange={(key, level) => save(entries.map((s) => (shareKey(s) === key ? { ...s, level } : s)))}
		onremove={(key) => save(entries.filter((s) => shareKey(s) !== key))}
		everyoneLabel={shares.everyoneLabel}
		placeholder="Gruppe, Rolle, Person suchen …"
		searchLabel="Freigabe hinzufügen"
		emptyResultText="Niemand gefunden"
	/>
{/if}
