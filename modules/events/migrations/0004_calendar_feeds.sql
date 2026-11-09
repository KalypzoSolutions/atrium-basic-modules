-- Modul "events": Kalender-Abos (iCal) je Person, mehrere je Person mit Filter
-- Token nur als Hash (core.crypto.forModule('events').hash) + verschluesselt (fuer die Link-Anzeige)

CREATE TABLE IF NOT EXISTS calendar_feeds (
	id text PRIMARY KEY,
	user_id text NOT NULL,
	name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
	token_hash text NOT NULL UNIQUE,
	token_enc text NOT NULL,
	include_events boolean NOT NULL DEFAULT true,
	include_actions boolean NOT NULL DEFAULT true,
	-- Filter auf Termine: leere Liste = alle; Gruppen-IDs ('stamm' oder members-Gruppe), Tags
	group_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
	tags jsonb NOT NULL DEFAULT '[]'::jsonb,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now(),
	last_used_at timestamptz,
	CHECK (include_events OR include_actions)
);

CREATE INDEX IF NOT EXISTS calendar_feeds_user_idx ON calendar_feeds (user_id, created_at);
