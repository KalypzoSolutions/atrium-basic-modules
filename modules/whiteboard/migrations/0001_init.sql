-- Modul "whiteboard": Whiteboards mit Elementen (Formen, Verbinder, Freihand, Bilder, Dateien, Links, Rahmen, Karten),
-- Dateien (Assets), Freigaben und Versionsverlauf

CREATE TABLE IF NOT EXISTS boards (
	id text PRIMARY KEY,
	name text NOT NULL,
	description text,
	color text CHECK (color IS NULL OR color ~ '^#[0-9a-f]{6}$'),
	background text NOT NULL DEFAULT 'dots' CHECK (background IN ('dots', 'grid', 'none')),
	owner_id text NOT NULL,
	action_id text,
	-- fortlaufende Änderungsnummer (jede angewandte Änderung bekommt die nächste)
	seq bigint NOT NULL DEFAULT 0,
	-- bis zu dieser Nummer sind gelöschte Elemente endgültig entfernt (ältere `since` → komplett neu laden)
	purged_seq bigint NOT NULL DEFAULT 0,
	-- Stand der letzten automatischen Version
	snapshot_seq bigint NOT NULL DEFAULT 0,
	element_count integer NOT NULL DEFAULT 0,
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_by text,
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS boards_owner_idx ON boards (owner_id);
CREATE INDEX IF NOT EXISTS boards_action_idx ON boards (action_id) WHERE action_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS boards_updated_idx ON boards (updated_at DESC);

CREATE TABLE IF NOT EXISTS board_shares (
	board_id text NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
	principal_type text NOT NULL CHECK (principal_type IN ('everyone', 'group', 'role', 'user', 'member')),
	principal_id text NOT NULL,
	level text NOT NULL CHECK (level IN ('read', 'edit')),
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (board_id, principal_type, principal_id)
);

CREATE INDEX IF NOT EXISTS board_shares_principal_idx ON board_shares (principal_type, principal_id);

CREATE TABLE IF NOT EXISTS elements (
	board_id text NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
	id text NOT NULL,
	type text NOT NULL CHECK (type IN ('shape', 'connector', 'freehand', 'image', 'file', 'link', 'frame', 'ref')),
	data jsonb NOT NULL DEFAULT '{}'::jsonb,
	z double precision NOT NULL DEFAULT 0,
	version integer NOT NULL DEFAULT 1,
	seq bigint NOT NULL,
	deleted boolean NOT NULL DEFAULT false,
	updated_by text,
	updated_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (board_id, id)
);

CREATE INDEX IF NOT EXISTS elements_seq_idx ON elements (board_id, seq);
CREATE INDEX IF NOT EXISTS elements_deleted_idx ON elements (updated_at) WHERE deleted;

CREATE TABLE IF NOT EXISTS assets (
	id text PRIMARY KEY,
	board_id text NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
	kind text NOT NULL CHECK (kind IN ('image', 'file')),
	name text NOT NULL,
	content_type text NOT NULL,
	size_bytes bigint NOT NULL DEFAULT 0,
	width integer,
	height integer,
	-- Speicherpfade je Variante, z. B. {"thumb": "...", "web": "..."} bzw. {"file": "...", "thumb": "..."}
	paths jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS assets_board_idx ON assets (board_id);

CREATE TABLE IF NOT EXISTS snapshots (
	id text PRIMARY KEY,
	board_id text NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
	label text,
	auto boolean NOT NULL DEFAULT false,
	seq bigint NOT NULL DEFAULT 0,
	elements jsonb NOT NULL DEFAULT '[]'::jsonb,
	element_count integer NOT NULL DEFAULT 0,
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS snapshots_board_idx ON snapshots (board_id, created_at DESC);
