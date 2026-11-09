-- Öffentliche Links für Personen ohne Konto: Notiz (mit Unterseiten) ansehen oder live mitbearbeiten.
-- Token nur als Hash (Suche) + verschlüsselt (URL später wieder abrufbar), optional Passwort (scrypt) und Ablaufdatum.

CREATE TABLE IF NOT EXISTS note_links (
	id text PRIMARY KEY,
	note_id text NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
	token_hash text NOT NULL UNIQUE,
	token_enc text,
	level text NOT NULL DEFAULT 'read' CHECK (level IN ('read', 'edit')),
	-- gültig bis einschließlich (Europe/Berlin)
	expires_on date,
	password_hash text,
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	revoked_at timestamptz,
	last_access_at timestamptz,
	access_count bigint NOT NULL DEFAULT 0,
	-- Passwort-Fehlversuche je Stunde
	failed_count integer NOT NULL DEFAULT 0,
	failed_window_start timestamptz
);

CREATE INDEX IF NOT EXISTS note_links_note_idx ON note_links (note_id);
CREATE INDEX IF NOT EXISTS note_links_created_by_idx ON note_links (created_by) WHERE created_by IS NOT NULL;
