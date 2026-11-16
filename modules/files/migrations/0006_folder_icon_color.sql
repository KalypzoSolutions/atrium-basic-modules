-- Eigene Farbe fuer das Icon auf dem Ordner (NULL = automatisch hell/dunkel passend zur Ordnerfarbe).

ALTER TABLE nodes ADD COLUMN IF NOT EXISTS icon_color text;

ALTER TABLE nodes DROP CONSTRAINT IF EXISTS nodes_icon_color_check;
ALTER TABLE nodes ADD CONSTRAINT nodes_icon_color_check
	CHECK (icon_color IS NULL OR icon_color ~ '^#[0-9a-f]{6}$');
-- Nur Ordner tragen ein Aussehen
ALTER TABLE nodes DROP CONSTRAINT IF EXISTS nodes_style_check;
ALTER TABLE nodes ADD CONSTRAINT nodes_style_check
	CHECK (kind = 'folder' OR (icon IS NULL AND color IS NULL AND icon_color IS NULL));
