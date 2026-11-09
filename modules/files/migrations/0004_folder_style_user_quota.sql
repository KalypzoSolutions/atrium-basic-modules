-- Ordner-Aussehen (Icon aus der Icon-Bibliothek + Farbe, fuer alle mit Zugriff gleich) und
-- Speicherkontingent je Person (ohne Zeile gilt die Modul-Einstellung files.quota.mb).

ALTER TABLE nodes ADD COLUMN IF NOT EXISTS icon text;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS color text;

ALTER TABLE nodes DROP CONSTRAINT IF EXISTS nodes_icon_check;
ALTER TABLE nodes ADD CONSTRAINT nodes_icon_check
	CHECK (icon IS NULL OR (char_length(icon) <= 64 AND icon ~ '^[a-z0-9]+(-[a-z0-9]+)*$'));
ALTER TABLE nodes DROP CONSTRAINT IF EXISTS nodes_color_check;
ALTER TABLE nodes ADD CONSTRAINT nodes_color_check CHECK (color IS NULL OR color ~ '^#[0-9a-f]{6}$');
-- Nur Ordner tragen ein Aussehen
ALTER TABLE nodes DROP CONSTRAINT IF EXISTS nodes_style_check;
ALTER TABLE nodes ADD CONSTRAINT nodes_style_check
	CHECK (kind = 'folder' OR (icon IS NULL AND color IS NULL));

-- quota_mb NULL = unbegrenzt; keine Zeile = Standard aus den Einstellungen
CREATE TABLE IF NOT EXISTS user_quotas (
	user_id text PRIMARY KEY,
	quota_mb integer CHECK (quota_mb IS NULL OR (quota_mb >= 1 AND quota_mb <= 10000000)),
	updated_by text,
	updated_at timestamptz NOT NULL DEFAULT now()
);
