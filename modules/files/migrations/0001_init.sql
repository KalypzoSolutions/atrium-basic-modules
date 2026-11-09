-- Modul "files" (Dateien): Ordner/Dateien als Baum, Freigaben an Principals, oeffentliche Links

-- Ordner und Dateien in einer Tabelle. Wurzeln sind virtuell: parent_id NULL + space (+ owner_id bei personal).
-- Datei-Inhalte liegen im Core-Storage (Modul "files"), storage_path/thumb_path verweisen darauf.
CREATE TABLE IF NOT EXISTS nodes (
	id text PRIMARY KEY,
	parent_id text REFERENCES nodes (id) ON DELETE CASCADE,
	kind text NOT NULL CHECK (kind IN ('folder', 'file')),
	space text NOT NULL CHECK (space IN ('personal', 'shared')),
	-- personal: Besitzer*in der Ablage; shared: anlegende Person (nur Info)
	owner_id text NOT NULL,
	name text NOT NULL,
	storage_path text,
	content_type text,
	size_bytes bigint,
	thumb_path text,
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	-- Papierkorb: alle Knoten eines geloeschten Teilbaums haben deleted_at, nur die Wurzel trash_root = true
	deleted_at timestamptz,
	deleted_by text,
	trash_root boolean NOT NULL DEFAULT false,
	CHECK (kind = 'folder' OR storage_path IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS nodes_parent_idx ON nodes (parent_id);
CREATE INDEX IF NOT EXISTS nodes_space_owner_idx ON nodes (space, owner_id) WHERE parent_id IS NULL;
CREATE INDEX IF NOT EXISTS nodes_trash_idx ON nodes (deleted_at) WHERE trash_root;
CREATE INDEX IF NOT EXISTS nodes_owner_idx ON nodes (owner_id);

-- Eindeutige Namen je Ordner (ohne Gross/Klein), nur fuer nicht geloeschte Knoten.
-- Wurzel: parent_id NULL -> Schluessel aus space + owner (personal) bzw. '' (shared).
CREATE UNIQUE INDEX IF NOT EXISTS nodes_unique_name_idx ON nodes (
	COALESCE(parent_id, space || ':' || CASE WHEN space = 'personal' THEN owner_id ELSE '' END),
	lower(name)
) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS node_shares (
	node_id text NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
	principal_type text NOT NULL CHECK (principal_type IN ('everyone', 'group', 'role', 'user', 'member')),
	principal_id text NOT NULL,
	level text NOT NULL CHECK (level IN ('read', 'edit')),
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (node_id, principal_type, principal_id)
);

CREATE INDEX IF NOT EXISTS node_shares_principal_idx ON node_shares (principal_type, principal_id);

-- Oeffentliche Links: nur der SHA-256 des Tokens wird gespeichert
CREATE TABLE IF NOT EXISTS share_links (
	id text PRIMARY KEY,
	node_id text NOT NULL REFERENCES nodes (id) ON DELETE CASCADE,
	token_hash text NOT NULL UNIQUE,
	-- gueltig bis einschliesslich expires_on (NULL = unbegrenzt)
	expires_on date,
	password_hash text,
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	revoked_at timestamptz,
	last_access_at timestamptz,
	access_count integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS share_links_node_idx ON share_links (node_id);
