-- Modul "notes": Notizen als Seitenbaum mit Yjs-Inhalt (live gemeinsam bearbeitet), Freigaben,
-- Änderungs-Log, Versionen und Dateien (Bilder)

CREATE TABLE IF NOT EXISTS notes (
	id text PRIMARY KEY,
	-- Oberseite (NULL = Wurzel); Löschen über den Papierkorb, CASCADE nur beim endgültigen Löschen
	parent_id text REFERENCES notes (id) ON DELETE CASCADE,
	position integer NOT NULL DEFAULT 0,
	title text NOT NULL DEFAULT '',
	icon text CHECK (icon IS NULL OR icon ~ '^[a-z0-9-]{1,64}$'),
	color text CHECK (color IS NULL OR color ~ '^#[0-9a-f]{6}$'),
	-- Eigentümer*in (Unterseiten erben die der Wurzel); NULL nach gelöschtem Konto
	owner_id text,
	-- nur Wurzeln: Notiz einer Aktion (Zugriff über die Aktion)
	action_id text,
	-- verdichteter Yjs-Zustand (encodeStateAsUpdate); Einzel-Updates danach in note_updates
	ydoc bytea,
	-- abgeleitet (verzögert): ProseMirror-JSON, Klartext für Suche/Vorschau
	content_json jsonb,
	content_text text NOT NULL DEFAULT '',
	size_bytes bigint NOT NULL DEFAULT 0,
	-- Stand der letzten automatischen Version (Anzahl angewandter Updates seit Anlage)
	update_count bigint NOT NULL DEFAULT 0,
	version_count bigint NOT NULL DEFAULT 0,
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_by text,
	updated_at timestamptz NOT NULL DEFAULT now(),
	-- Papierkorb: alle Seiten des Teilbaums bekommen deleted_at, nur die oberste trash_root = true
	deleted_at timestamptz,
	deleted_by text,
	trash_root boolean NOT NULL DEFAULT false,
	CONSTRAINT notes_action_root_check CHECK (action_id IS NULL OR parent_id IS NULL)
);

CREATE INDEX IF NOT EXISTS notes_parent_idx ON notes (parent_id, position);
CREATE INDEX IF NOT EXISTS notes_owner_idx ON notes (owner_id) WHERE parent_id IS NULL;
CREATE INDEX IF NOT EXISTS notes_action_idx ON notes (action_id) WHERE action_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS notes_updated_idx ON notes (updated_at DESC);
CREATE INDEX IF NOT EXISTS notes_trash_idx ON notes (deleted_at) WHERE trash_root;
CREATE INDEX IF NOT EXISTS notes_search_idx ON notes
	USING gin (to_tsvector('german', title || ' ' || content_text));

CREATE TABLE IF NOT EXISTS note_shares (
	note_id text NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
	principal_type text NOT NULL CHECK (principal_type IN ('everyone', 'group', 'role', 'user', 'member')),
	principal_id text NOT NULL,
	level text NOT NULL CHECK (level IN ('read', 'edit')),
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (note_id, principal_type, principal_id)
);

CREATE INDEX IF NOT EXISTS note_shares_principal_idx ON note_shares (principal_type, principal_id);

-- Einzel-Updates seit der letzten Verdichtung (in Reihenfolge)
CREATE TABLE IF NOT EXISTS note_updates (
	note_id text NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
	seq bigserial,
	data bytea NOT NULL,
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (note_id, seq)
);

CREATE TABLE IF NOT EXISTS note_versions (
	id text PRIMARY KEY,
	note_id text NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
	label text,
	auto boolean NOT NULL DEFAULT false,
	ydoc bytea NOT NULL,
	size_bytes bigint NOT NULL DEFAULT 0,
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS note_versions_note_idx ON note_versions (note_id, created_at DESC);

CREATE TABLE IF NOT EXISTS note_assets (
	id text PRIMARY KEY,
	note_id text NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
	kind text NOT NULL CHECK (kind IN ('image', 'file')),
	name text NOT NULL,
	content_type text NOT NULL,
	size_bytes bigint NOT NULL DEFAULT 0,
	width integer,
	height integer,
	-- Speicherpfade je Variante, z. B. {"thumb": "...", "web": "..."}
	paths jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS note_assets_note_idx ON note_assets (note_id);
