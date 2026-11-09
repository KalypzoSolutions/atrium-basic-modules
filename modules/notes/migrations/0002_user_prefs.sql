-- Persönliche Ansicht-Einstellungen je Konto (z. B. feste Hintergrundfarbe statt Modus/Theme)
CREATE TABLE IF NOT EXISTS user_prefs (
	user_id text PRIMARY KEY,
	prefs jsonb NOT NULL DEFAULT '{}'::jsonb,
	updated_at timestamptz NOT NULL DEFAULT now()
);
