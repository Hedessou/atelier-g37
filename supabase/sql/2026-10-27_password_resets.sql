-- Récupération de compte par e-mail (27/10/2026) : code à 6 chiffres, valable 15 min, 5 essais.
-- Appliquée le 27/10/2026.
CREATE TABLE IF NOT EXISTS password_resets (
  id bigserial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email text NOT NULL,
  code_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS password_resets_email_idx ON password_resets (lower(email), created_at DESC);
ALTER TABLE password_resets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON password_resets FROM anon, authenticated;

-- Réglages d'envoi (à remplir une fois, mot de passe de la boîte noreply) :
-- INSERT INTO app_config (key, value) VALUES
--   ('smtp.host', 'mail.africansbiz.com'), ('smtp.port', '465'),
--   ('smtp.user', 'noreply@africansbiz.com'), ('smtp.pass', '••••••')
-- ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
