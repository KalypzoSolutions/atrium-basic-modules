<script lang="ts">
	// Anwesenheit: Avatare der anderen Personen in dieser Notiz (je Person einmal, Farbe wie ihr Cursor)
	import { EntityAvatar } from '$lib/components/layout';
	import type { Peer } from '../schemas';

	let { peers, myId }: { peers: Peer[]; myId: string | null } = $props();

	const people = $derived.by(() => {
		const map = new Map<string, Peer>();
		for (const p of peers) if (p.userId !== myId && !map.has(p.userId)) map.set(p.userId, p);
		return [...map.values()];
	});
</script>

{#if people.length}
	<div
		class="flex -space-x-2"
		role="group"
		aria-label={`Gerade hier: ${people.map((p) => p.name).join(', ')}`}
	>
		{#each people.slice(0, 5) as p (p.userId)}
			<span class="inline-flex rounded-full ring-2 ring-background" title={p.name}>
				<EntityAvatar name={p.name} src={p.image} color={p.color} size={28} />
			</span>
		{/each}
		{#if people.length > 5}
			<span
				class="flex size-7 items-center justify-center rounded-full bg-muted text-xs ring-2 ring-background"
				>+{people.length - 5}</span
			>
		{/if}
	</div>
{/if}
