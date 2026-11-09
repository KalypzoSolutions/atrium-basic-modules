-- Schutz gegen Passwort-Raten bei oeffentlichen Links: Fehlversuche je Link
ALTER TABLE share_links ADD COLUMN IF NOT EXISTS failed_count integer NOT NULL DEFAULT 0;
ALTER TABLE share_links ADD COLUMN IF NOT EXISTS failed_window_start timestamptz;
