<script lang="ts">
	// Kompakte Liste von Notizen (Übersicht): Icon, Titel, Textanfang, Stand
	import Users from '@lucide/svelte/icons/users';
	import type { NoteNode } from '../schemas';
	import NoteIcon from './NoteIcon.svelte';
	import { noteTitle, notePath, relativeTime } from './helpers';

	let {
		notes,
		extra
	}: {
		notes: (NoteNode & { actionName?: string })[];
		/** Zusatz je Zeile (z. B. Aktionsname) */
		extra?: (n: NoteNode & { actionName?: string }) => string | null;
	} = $props();
</script>

<ul class="divide-y rounded-lg border bg-card">
	{#each notes as n (n.id)}
		{@const more = extra?.(n)}
		<li>
			<a
				href={notePath(n.id)}
				class="flex items-start gap-3 px-3 py-2.5 outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
			>
				<NoteIcon icon={n.icon} color={n.color} class="mt-0.5 size-5" />
				<span class="min-w-0 flex-1">
					<span class="flex items-center gap-2">
						<span class="truncate text-sm font-medium">{noteTitle(n.title)}</span>
						{#if n.shared || n.stamm}
							<Users class="size-3.5 shrink-0 text-muted-foreground" aria-label="Geteilt" />
						{/if}
					</span>
					{#if n.excerpt}
						<span class="line-clamp-1 text-xs text-muted-foreground">{n.excerpt}</span>
					{/if}
					<span class="block truncate text-xs text-muted-foreground">
						{relativeTime(n.updatedAt)}{n.updatedBy ? ` · ${n.updatedBy.name}` : ''}{more
							? ` · ${more}`
							: ''}
					</span>
				</span>
			</a>
		</li>
	{/each}
</ul>
