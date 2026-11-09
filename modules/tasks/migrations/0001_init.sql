-- Modul "tasks": Aufgaben-Boards (Kanban) mit Spalten, Aufgaben, Zuständigen, Unteraufgaben und Freigaben

CREATE TABLE IF NOT EXISTS boards (
	id text PRIMARY KEY,
	name text NOT NULL,
	description text,
	color text CHECK (color IS NULL OR color ~ '^#[0-9a-f]{6}$'),
	owner_id text NOT NULL,
	action_id text,
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS boards_owner_idx ON boards (owner_id);
CREATE UNIQUE INDEX IF NOT EXISTS boards_action_uidx ON boards (action_id) WHERE action_id IS NOT NULL;

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

CREATE TABLE IF NOT EXISTS board_columns (
	id text PRIMARY KEY,
	board_id text NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
	name text NOT NULL,
	position integer NOT NULL DEFAULT 0,
	is_done boolean NOT NULL DEFAULT false,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS board_columns_board_idx ON board_columns (board_id, position);

CREATE TABLE IF NOT EXISTS tasks (
	id text PRIMARY KEY,
	board_id text NOT NULL REFERENCES boards (id) ON DELETE CASCADE,
	column_id text NOT NULL REFERENCES board_columns (id) ON DELETE RESTRICT,
	title text NOT NULL,
	description text,
	priority text NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
	due_on date,
	position integer NOT NULL DEFAULT 0,
	completed_at timestamptz,
	reminded_on date,
	created_by text,
	created_at timestamptz NOT NULL DEFAULT now(),
	updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tasks_board_idx ON tasks (board_id);
CREATE INDEX IF NOT EXISTS tasks_column_idx ON tasks (column_id, position);
CREATE INDEX IF NOT EXISTS tasks_due_idx ON tasks (due_on) WHERE due_on IS NOT NULL AND completed_at IS NULL;

CREATE TABLE IF NOT EXISTS task_assignees (
	task_id text NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
	user_id text NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (task_id, user_id)
);

CREATE INDEX IF NOT EXISTS task_assignees_user_idx ON task_assignees (user_id);

CREATE TABLE IF NOT EXISTS task_checklist (
	id text PRIMARY KEY,
	task_id text NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
	title text NOT NULL,
	done boolean NOT NULL DEFAULT false,
	assignee_id text,
	due_on date,
	position integer NOT NULL DEFAULT 0,
	done_at timestamptz,
	done_by text,
	created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS task_checklist_task_idx ON task_checklist (task_id, position);
CREATE INDEX IF NOT EXISTS task_checklist_assignee_idx ON task_checklist (assignee_id) WHERE assignee_id IS NOT NULL;
