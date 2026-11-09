<!--
  Nummerierungsarten geordneter Listen (Attribut `listStyle`, siehe doc/list-style.ts) – global für Editor und
  Versionsvorschau. Keine Ausgabe, nur Stil.
-->
<style>
	:global {
		.note-content ol {
			--ol-start: 0;
		}
		.note-content ol[data-list-style],
		.note-content ol[data-list-style] ol {
			list-style: none !important;
			counter-reset: note-ol var(--ol-start);
			padding-left: 2rem !important;
		}
		.note-content ol[data-list-style='outline'],
		.note-content ol[data-list-style='outline'] ol:not([data-list-style]) {
			padding-left: 2.5rem !important;
		}
		.note-content ol[data-list-style] > li,
		.note-content ol[data-list-style] ol > li {
			counter-increment: note-ol;
			position: relative;
		}
		.note-content ol[data-list-style] > li::before,
		.note-content ol[data-list-style] ol > li::before {
			content: var(--ol-marker);
			position: absolute;
			right: 100%;
			margin-right: 0.45em;
			white-space: nowrap;
			font-variant-numeric: tabular-nums;
			line-height: inherit;
			/* gleiche Höhe wie die erste Zeile des Punkts (li > p hat einen kleinen Rand) */
			top: 0.15em;
		}

		.note-content ol[data-list-style='decimal'] {
			--ol-marker: counter(note-ol) '.';
		}
		.note-content ol[data-list-style='outline'] {
			--ol-marker: counters(note-ol, '.') '.';
		}
		.note-content ol[data-list-style='lower-alpha'] {
			--ol-marker: counter(note-ol, lower-alpha) ')';
		}
		.note-content ol[data-list-style='upper-alpha'] {
			--ol-marker: counter(note-ol, upper-alpha) '.';
		}
		.note-content ol[data-list-style='lower-roman'] {
			--ol-marker: counter(note-ol, lower-roman) '.';
		}
		.note-content ol[data-list-style='upper-roman'] {
			--ol-marker: counter(note-ol, upper-roman) '.';
		}

		/* Klassisch: 1. → a. → i. → 1. … je Ebene (längere Selektoren gewinnen über die Spezifität) */
		.note-content ol[data-list-style='classic'] {
			--ol-marker: counter(note-ol) '.';
		}
		.note-content ol[data-list-style='classic'] ol:not([data-list-style]) {
			--ol-marker: counter(note-ol, lower-alpha) '.';
		}
		.note-content
			ol[data-list-style='classic']
			ol:not([data-list-style])
			ol:not([data-list-style]) {
			--ol-marker: counter(note-ol, lower-roman) '.';
		}
		.note-content
			ol[data-list-style='classic']
			ol:not([data-list-style])
			ol:not([data-list-style])
			ol:not([data-list-style]) {
			--ol-marker: counter(note-ol) '.';
		}
		.note-content
			ol[data-list-style='classic']
			ol:not([data-list-style])
			ol:not([data-list-style])
			ol:not([data-list-style])
			ol:not([data-list-style]) {
			--ol-marker: counter(note-ol, lower-alpha) '.';
		}
		.note-content
			ol[data-list-style='classic']
			ol:not([data-list-style])
			ol:not([data-list-style])
			ol:not([data-list-style])
			ol:not([data-list-style])
			ol:not([data-list-style]) {
			--ol-marker: counter(note-ol, lower-roman) '.';
		}
	}
</style>
