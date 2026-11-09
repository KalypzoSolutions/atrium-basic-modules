<script lang="ts">
	// VERTRAG (Welle 0) – Props nicht ändern; Implementierung: Welle 4.4.
	import Link from '@lucide/svelte/icons/link';
	import Tent from '@lucide/svelte/icons/tent';
	import Upload from '@lucide/svelte/icons/upload';
	import Users from '@lucide/svelte/icons/users';
	import { Badge } from '$lib/components/ui/badge';
	import { Button } from '$lib/components/ui/button';
	import * as Dialog from '$lib/components/ui/dialog';
	import { SummaryList, type SummaryRow } from '$lib/components/layout';
	import type { FileNode } from '../schemas';
	import { formatBytes, formatDateTime, iconFor, thumbUrl } from './helpers';
	import FileTypeGlyph from './FileTypeGlyph.svelte';

	let {
		open = $bindable(false),
		node
	}: {
		open?: boolean;
		/** Details: Typ, Größe, angelegt von/am, geändert, Freigaben/Links-Hinweis */
		node: FileNode | null;
	} = $props();

	/** Lesbare Dateiarten (MIME-Typ ohne Parameter, klein geschrieben) */
	const TYPE_LABELS: Record<string, string> = {
		'application/pdf': 'PDF-Dokument',
		'image/jpeg': 'JPEG-Bild',
		'image/png': 'PNG-Bild',
		'image/gif': 'GIF-Bild',
		'image/webp': 'WebP-Bild',
		'image/avif': 'AVIF-Bild',
		'image/svg+xml': 'SVG-Grafik',
		'image/heic': 'HEIC-Bild',
		'text/plain': 'Textdatei',
		'text/csv': 'CSV-Tabelle',
		'text/markdown': 'Markdown-Text',
		'application/json': 'JSON-Datei',
		'application/zip': 'ZIP-Archiv',
		'application/msword': 'Word-Dokument',
		'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word-Dokument',
		'application/vnd.ms-excel': 'Excel-Tabelle',
		'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel-Tabelle',
		'application/vnd.ms-powerpoint': 'PowerPoint-Präsentation',
		'application/vnd.openxmlformats-officedocument.presentationml.presentation':
			'PowerPoint-Präsentation',
		'application/vnd.oasis.opendocument.text': 'OpenDocument-Text',
		'application/vnd.oasis.opendocument.spreadsheet': 'OpenDocument-Tabelle',
		'application/vnd.oasis.opendocument.presentation': 'OpenDocument-Präsentation',
		'application/vnd.openxmlformats-officedocument.wordprocessingml.template': 'Word-Vorlage',
		'application/vnd.openxmlformats-officedocument.spreadsheetml.template': 'Excel-Vorlage',
		'application/vnd.openxmlformats-officedocument.presentationml.template': 'PowerPoint-Vorlage',
		'application/vnd.openxmlformats-officedocument.presentationml.slideshow':
			'PowerPoint-Bildschirmpräsentation',
		'application/vnd.oasis.opendocument.text-template': 'OpenDocument-Textvorlage',
		'application/vnd.oasis.opendocument.spreadsheet-template': 'OpenDocument-Tabellenvorlage',
		'application/vnd.oasis.opendocument.presentation-template': 'OpenDocument-Präsentationsvorlage',
		'application/rtf': 'RTF-Dokument',
		'text/rtf': 'RTF-Dokument',
		'audio/mpeg': 'MP3-Audio',
		'video/mp4': 'MP4-Video'
	};

	function typeLabel(n: FileNode): string {
		if (n.kind === 'folder') return 'Ordner';
		const t = (n.contentType ?? '').split(';')[0]!.trim().toLowerCase();
		if (!t) return 'Datei';
		return TYPE_LABELS[t] ?? t;
	}

	function entriesLabel(count: number | null): string {
		const c = count ?? 0;
		return c === 1 ? '1 Eintrag' : `${c.toLocaleString('de-DE')} Einträge`;
	}

	const rows = $derived.by<SummaryRow[]>(() => {
		if (!node) return [];
		const r: SummaryRow[] = [
			{ label: 'Art', value: typeLabel(node) },
			{
				label: node.kind === 'folder' ? 'Inhalt' : 'Größe',
				value: node.kind === 'folder' ? entriesLabel(node.childCount) : formatBytes(node.sizeBytes),
				hint: node.kind === 'folder' ? 'Nur direkte Einträge, ohne Unterordner-Inhalte.' : undefined
			},
			{ label: 'Gehört', value: node.own ? 'dir' : node.owner.name || 'Unbekannt' }
		];
		if (node.stamm) r.push({ label: 'Mit dem Stamm geteilt', value: 'Ja' });
		if (node.viaLink) {
			r.push({
				label: 'Hochgeladen über Link',
				value: node.uploadedByName
					? `von „${node.uploadedByName}“ (eigene Angabe, nicht geprüft)`
					: 'ohne Namensangabe'
			});
		} else {
			r.push({ label: 'Angelegt von', value: node.createdBy?.name ?? 'Unbekannt' });
		}
		r.push(
			{ label: 'Angelegt am', value: formatDateTime(node.createdAt) },
			{ label: 'Geändert am', value: formatDateTime(node.updatedAt) },
			{ label: 'Dein Zugriff', value: node.access === 'edit' ? 'Bearbeiten' : 'Nur ansehen' }
		);
		return r;
	});

	const thumb = $derived(node ? thumbUrl(node) : null);
	const Icon = $derived(node ? iconFor(node.kind, node.contentType) : null);
	/** fehlgeschlagene Vorschaubild-URLs → Icon statt kaputtem Bild */
	let failedThumb = $state<string | null>(null);

	/** Fehler-Listener per Action statt `onerror`-Attribut (Inline-Handler aus dem SSR blockiert die CSP) */
	function watchError(img: HTMLImageElement) {
		const fail = () => (failedThumb = img.getAttribute('src'));
		img.addEventListener('error', fail);
		return { destroy: () => img.removeEventListener('error', fail) };
	}
</script>

<Dialog.Root bind:open>
	<Dialog.Content class="sm:max-w-md">
		<Dialog.Header>
			<Dialog.Title>Details</Dialog.Title>
			<Dialog.Description class="sr-only">Informationen zum ausgewählten Eintrag</Dialog.Description
			>
		</Dialog.Header>
		{#if node}
			<div class="flex min-w-0 items-center gap-3">
				<div
					class="bg-muted text-muted-foreground flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-md"
				>
					{#if thumb && failedThumb !== thumb}
						<img src={thumb} alt="" class="size-full object-cover" loading="lazy" use:watchError />
					{:else if node.kind === 'file'}
						<FileTypeGlyph
							contentType={node.contentType}
							name={node.name}
							size="sm"
							class="size-7"
						/>
					{:else if Icon}
						<Icon class="size-7" aria-hidden="true" />
					{/if}
				</div>
				<div class="min-w-0 flex-1">
					<p class="font-semibold break-words">{node.name}</p>
					{#if node.shared || node.linked || node.stamm || node.viaLink}
						<div class="mt-1 flex flex-wrap gap-1.5">
							{#if node.stamm}
								<Badge variant="secondary">
									<Tent aria-hidden="true" />
									Mit dem Stamm geteilt
								</Badge>
							{/if}
							{#if node.viaLink}
								<Badge variant="outline">
									<Upload aria-hidden="true" />
									Über Link hochgeladen
								</Badge>
							{/if}
							{#if node.shared}
								<Badge variant="secondary">
									<Users aria-hidden="true" />
									Freigegeben
								</Badge>
							{/if}
							{#if node.linked}
								<Badge variant="secondary">
									<Link aria-hidden="true" />
									Öffentlicher Link aktiv
								</Badge>
							{/if}
						</div>
					{/if}
				</div>
			</div>
			<SummaryList {rows} />
		{:else}
			<p class="text-muted-foreground text-sm">Kein Eintrag ausgewählt.</p>
		{/if}
		<Dialog.Footer>
			<Button type="button" variant="outline" onclick={() => (open = false)}>Schließen</Button>
		</Dialog.Footer>
	</Dialog.Content>
</Dialog.Root>
