-- Vorschaubilder: Zeitpunkt des letzten Erzeugungsversuchs. NULL = noch nie versucht → der Job
-- files.thumbs-backfill erzeugt fehlende Vorschauen (Bilder, PDFs) fuer den Bestand genau einmal.
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS thumb_attempted_at timestamptz;

CREATE INDEX IF NOT EXISTS nodes_thumb_pending_idx ON nodes (created_at)
	WHERE kind = 'file' AND thumb_path IS NULL AND thumb_attempted_at IS NULL AND deleted_at IS NULL;
