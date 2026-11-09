-- Modul "events": Meilensteine aus dem Modul Aufgaben im Kalender-Abo (Standard aus)

ALTER TABLE calendar_feeds ADD COLUMN IF NOT EXISTS include_tasks boolean NOT NULL DEFAULT false;
ALTER TABLE calendar_feeds DROP CONSTRAINT IF EXISTS calendar_feeds_check;
ALTER TABLE calendar_feeds DROP CONSTRAINT IF EXISTS calendar_feeds_content_check;
ALTER TABLE calendar_feeds ADD CONSTRAINT calendar_feeds_content_check
	CHECK (include_events OR include_actions OR include_tasks);
