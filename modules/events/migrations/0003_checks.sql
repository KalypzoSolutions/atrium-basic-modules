-- Modul "events" v3: Datenbank-CHECKs als Rückhalt zur Zod-Prüfung (#73, 07-11). Greifen auch bei
-- Backup-„Zusammenführen“ und künftigen Direkt-SQL-Pfaden. Erst Altbestand bereinigen (Werte, die die API nie
-- angenommen hätte), dann anlegen und validieren – ein NOT-VALID-CHECK greift bei jedem UPDATE einer Zeile,
-- eine Bereinigung danach scheitert bei Zeilen mit mehreren ungültigen Werten.

-- Bereinigung (Reihenfolge wie die Zod-Regeln)
UPDATE events SET starts_at = NULL
	WHERE starts_at IS NOT NULL AND starts_at !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$';
UPDATE events SET ends_at = NULL
	WHERE ends_at IS NOT NULL AND ends_at !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$';
UPDATE events SET ends_on = NULL, ends_at = NULL WHERE ends_on IS NOT NULL AND ends_on < starts_on;
UPDATE events SET ends_at = NULL WHERE ends_at IS NOT NULL AND ends_on IS NULL;
UPDATE events SET ends_at = NULL
	WHERE ends_on = starts_on AND starts_at IS NOT NULL AND ends_at IS NOT NULL AND ends_at < starts_at;


ALTER TABLE events DROP CONSTRAINT IF EXISTS events_starts_at_check;
ALTER TABLE events ADD CONSTRAINT events_starts_at_check
	CHECK (starts_at IS NULL OR starts_at ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') NOT VALID;

ALTER TABLE events DROP CONSTRAINT IF EXISTS events_ends_at_check;
ALTER TABLE events ADD CONSTRAINT events_ends_at_check
	CHECK (ends_at IS NULL OR (ends_on IS NOT NULL AND ends_at ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$')) NOT VALID;

ALTER TABLE events DROP CONSTRAINT IF EXISTS events_ends_on_check;
ALTER TABLE events ADD CONSTRAINT events_ends_on_check
	CHECK (ends_on IS NULL OR ends_on >= starts_on) NOT VALID;

ALTER TABLE events DROP CONSTRAINT IF EXISTS events_same_day_time_check;
ALTER TABLE events ADD CONSTRAINT events_same_day_time_check
	CHECK (ends_on IS DISTINCT FROM starts_on OR starts_at IS NULL OR ends_at IS NULL OR ends_at >= starts_at) NOT VALID;

ALTER TABLE events VALIDATE CONSTRAINT events_starts_at_check;
ALTER TABLE events VALIDATE CONSTRAINT events_ends_at_check;
ALTER TABLE events VALIDATE CONSTRAINT events_ends_on_check;
ALTER TABLE events VALIDATE CONSTRAINT events_same_day_time_check;
