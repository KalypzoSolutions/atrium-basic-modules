-- Eine Ansicht statt "Meine Dateien"/"Stamm": der Stammesordner wird zu Ordnern der anlegenden Person,
-- die an den ganzen Stamm (everyone:*) freigegeben sind. Dazu Upload-Links und wieder abrufbare Link-URLs.

ALTER TABLE nodes ADD COLUMN IF NOT EXISTS uploaded_by_name text;
ALTER TABLE nodes ADD COLUMN IF NOT EXISTS uploaded_via_link text;

ALTER TABLE share_links ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'view';
ALTER TABLE share_links DROP CONSTRAINT IF EXISTS share_links_mode_check;
ALTER TABLE share_links ADD CONSTRAINT share_links_mode_check CHECK (mode IN ('view', 'upload', 'view-upload'));
-- Token verschluesselt (core.crypto), damit die URL spaeter wieder angezeigt werden kann; token_hash bleibt fuer die Suche
ALTER TABLE share_links ADD COLUMN IF NOT EXISTS token_enc text;

-- 1) Namenskonflikte mit der Wurzel der kuenftigen Eigentuemer*in aufloesen (eindeutiger Index ohne Gross/Klein).
--    Suffix mit ID-Anfang ist eindeutig, auch wenn es "X" und "X (Stamm)" schon gibt.
UPDATE nodes s SET name = s.name || ' (Stamm ' || left(s.id, 8) || ')'
WHERE s.space = 'shared' AND s.parent_id IS NULL AND s.deleted_at IS NULL
	AND EXISTS (
		SELECT 1 FROM nodes p
		WHERE p.space = 'personal' AND p.parent_id IS NULL AND p.deleted_at IS NULL
			AND p.owner_id = s.owner_id AND lower(p.name) = lower(s.name)
	);

-- 2) Ehemalige Stamm-Wurzeln an den ganzen Stamm freigeben (Lesen)
INSERT INTO node_shares (node_id, principal_type, principal_id, level, created_by)
SELECT id, 'everyone', '*', 'read', owner_id FROM nodes
WHERE space = 'shared' AND parent_id IS NULL
ON CONFLICT DO NOTHING;

-- 3) Ganzer Teilbaum gehoert der Person, die die Stamm-Wurzel angelegt hat
WITH RECURSIVE tree AS (
	SELECT id, owner_id AS root_owner FROM nodes WHERE space = 'shared' AND parent_id IS NULL
	UNION ALL
	SELECT n.id, tree.root_owner FROM nodes n JOIN tree ON n.parent_id = tree.id
)
UPDATE nodes SET owner_id = tree.root_owner FROM tree WHERE nodes.id = tree.id;

-- 4) Nur noch ein Bereich
UPDATE nodes SET space = 'personal' WHERE space = 'shared';
