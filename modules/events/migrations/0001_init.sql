-- Modul "events" (Termine): Termine, Tags, Gruppen-Zuordnung, Freigaben an Principals

CREATE TABLE IF NOT EXISTS events (
	id text PRIMARY KEY,
	title text NOT NULL,
	description text,
	location text,
	color text CHECK (color IS NULL OR color ~ '^#[0-9a-f]{6}$'),
	starts_on date NOT NULL,
	starts_at text,
	ends_on date,
	ends_at text,
	on_website boolean NOT NULL DEFAULT false,
	owner_id text NOT NULL,
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS events_starts_on_idx ON events (starts_on);
CREATE INDEX IF NOT EXISTS events_owner_idx ON events (owner_id);
CREATE INDEX IF NOT EXISTS events_website_idx ON events (on_website, starts_on);

CREATE TABLE IF NOT EXISTS event_tags (
	event_id text NOT NULL REFERENCES events (id) ON DELETE CASCADE,
	tag text NOT NULL,
	position integer NOT NULL DEFAULT 0,
	PRIMARY KEY (event_id, tag)
);

CREATE INDEX IF NOT EXISTS event_tags_tag_idx ON event_tags (lower(tag));

-- group_id = 'stamm' (ganzer Stamm) oder Gruppen-ID aus `members` (ohne FK, anderes Schema)
CREATE TABLE IF NOT EXISTS event_groups (
	event_id text NOT NULL REFERENCES events (id) ON DELETE CASCADE,
	group_id text NOT NULL,
	PRIMARY KEY (event_id, group_id)
);

CREATE INDEX IF NOT EXISTS event_groups_group_idx ON event_groups (group_id);

CREATE TABLE IF NOT EXISTS event_shares (
	event_id text NOT NULL REFERENCES events (id) ON DELETE CASCADE,
	principal_type text NOT NULL CHECK (principal_type IN ('everyone', 'group', 'role', 'user', 'member')),
	principal_id text NOT NULL,
	level text NOT NULL CHECK (level IN ('read', 'edit')),
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (event_id, principal_type, principal_id)
);

CREATE INDEX IF NOT EXISTS event_shares_principal_idx ON event_shares (principal_type, principal_id);
