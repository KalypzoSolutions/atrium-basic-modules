-- Modul "events" v2: Serien (Wiederholungstermine) und Ausnahmen einzelner Vorkommen

ALTER TABLE events ADD COLUMN IF NOT EXISTS recurrence jsonb;
-- Letztes Vorkommen (Startdatum) der Serie; NULL = einmalig oder offene Serie (siehe `recurrence`)
ALTER TABLE events ADD COLUMN IF NOT EXISTS recurrence_until date;

CREATE INDEX IF NOT EXISTS events_recurring_idx ON events (starts_on, recurrence_until)
	WHERE recurrence IS NOT NULL;

-- Ausnahme je Vorkommen (ursprüngliches Datum): abgesagt und/oder abweichende Felder (`override`)
CREATE TABLE IF NOT EXISTS event_exceptions (
	event_id text NOT NULL REFERENCES events (id) ON DELETE CASCADE,
	occurrence_date date NOT NULL,
	cancelled boolean NOT NULL DEFAULT false,
	override jsonb,
	updated_by text,
	updated_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (event_id, occurrence_date)
);
