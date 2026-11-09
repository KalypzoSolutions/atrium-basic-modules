<script lang="ts">
	import CalendarSync from '@lucide/svelte/icons/calendar-sync';
	import * as Card from '$lib/components/ui/card';
	import CalendarFeedsPanel from './CalendarFeedsPanel.svelte';

	/** Profil: eigene Kalender-Abos (iCal) */
	// Profil-Abschnitte bekommen `userId`; die Karte zeigt immer die eigenen Abos
	let { userId: _userId }: { userId: string } = $props();
</script>

<Card.Root>
	<Card.Header>
		<Card.Title class="flex items-center gap-2">
			<CalendarSync class="size-4" /> Kalender-Abo
		</Card.Title>
		<Card.Description>
			Termine und Aktionen automatisch in deinem Kalender – auf dem Handy, in Outlook, Google oder
			Apple Kalender.
		</Card.Description>
	</Card.Header>
	<Card.Content>
		<CalendarFeedsPanel />
	</Card.Content>
</Card.Root>
