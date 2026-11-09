-- Modul "tasks" v1.1: Phasen (Zeitabschnitte je Board), Zeitraum und Meilensteine je Aufgabe, Standardansicht,
-- Meilensteine im Kalender-Abo, Vorlagen (Bezugsdatum) und Abhängigkeiten zwischen Aufgaben

CREATE TABLE IF NOT EXISTS board_phases (
	id text PRIMARY KEY,
	board_id text NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
	name text NOT NULL,
	color text CHECK (color IS NULL OR color ~ '^#[0-9a-f]{6}$'),
	starts_on date,
	ends_on date,
	position integer NOT NULL DEFAULT 0,
	created_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT board_phases_range_check CHECK (starts_on IS NULL OR ends_on IS NULL OR ends_on >= starts_on)
);

CREATE INDEX IF NOT EXISTS board_phases_board_idx ON board_phases (board_id, position);

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS phase_id text REFERENCES board_phases (id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS starts_on date;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS is_milestone boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS tasks_phase_idx ON tasks (phase_id) WHERE phase_id IS NOT NULL;

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_range_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_range_check
	CHECK (starts_on IS NULL OR due_on IS NULL OR starts_on <= due_on);
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_milestone_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_milestone_check CHECK (NOT is_milestone OR starts_on IS NULL);

ALTER TABLE boards ADD COLUMN IF NOT EXISTS default_view text NOT NULL DEFAULT 'board';
ALTER TABLE boards DROP CONSTRAINT IF EXISTS boards_default_view_check;
ALTER TABLE boards ADD CONSTRAINT boards_default_view_check
	CHECK (default_view IN ('board', 'list', 'timeline', 'calendar'));
-- Meilensteine im Kalender-Abo (Modul events), Standard aus
ALTER TABLE boards ADD COLUMN IF NOT EXISTS calendar_milestones boolean NOT NULL DEFAULT false;
-- Bezugsdatum (Aktionsbeginn bzw. Datum der Vorlage); weicht der Aktionsbeginn ab, bietet das Board das Mitverschieben an.
ALTER TABLE boards ADD COLUMN IF NOT EXISTS anchor_on date;

CREATE TABLE IF NOT EXISTS board_templates (
	id text PRIMARY KEY,
	name text NOT NULL,
	description text,
	owner_id text NOT NULL,
	data jsonb NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS board_templates_owner_idx ON board_templates (owner_id);

CREATE TABLE IF NOT EXISTS task_dependencies (
	task_id text NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
	blocked_by_id text NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (task_id, blocked_by_id),
	CONSTRAINT task_dependencies_self_check CHECK (task_id <> blocked_by_id)
);

CREATE INDEX IF NOT EXISTS task_dependencies_blocked_idx ON task_dependencies (blocked_by_id);
