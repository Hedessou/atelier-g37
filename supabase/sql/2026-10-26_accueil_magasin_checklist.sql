-- Mise à jour 1.1 (26/10/2026) : magasin intelligent, check-list de maintenance, accusés de lecture.
-- Appliquée sur Supabase (projet yrtoimldmzlnmsoapcij) avant la nouvelle version de l'app. Rien n'est supprimé.

-- Magasin : prix unitaire, délai de réapprovisionnement, sorties liées à une machine ou une panne.
ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS unit_price numeric;
ALTER TABLE stock_items ADD COLUMN IF NOT EXISTS lead_days integer NOT NULL DEFAULT 14;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS machine_no integer;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS failure_id text;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS author_name text;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS unit_cost numeric;
CREATE INDEX IF NOT EXISTS stock_movements_sortie_idx ON stock_movements (movement_type, created_at DESC);

-- Check-list de la maintenance (modèle modifiable + check-lists remplies).
CREATE TABLE IF NOT EXISTS checklist_steps (
  id text PRIMARY KEY,
  position integer NOT NULL DEFAULT 0,
  text text NOT NULL,
  created_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS maint_checklists (
  id text PRIMARY KEY,
  machine_no integer NOT NULL,
  maintenance_id text,
  done_at timestamptz NOT NULL DEFAULT now(),
  author_name text,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  photo_before text,
  photo_after text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS maint_checklists_done_idx ON maint_checklists (done_at DESC);
ALTER TABLE checklist_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE maint_checklists ENABLE ROW LEVEL SECURITY;

-- Étapes de départ (manuel Rieter G 37, chapitre 9.10 « Cleaning »). Modifiables dans l'app.
INSERT INTO checklist_steps (id, position, text, created_by)
SELECT 'cl_' || lpad(n::text, 2, '0'), n * 10, t, 'Modèle G37'
FROM (VALUES
  (1, 'Sécurité : interrupteur principal sur OFF et cadenassé'),
  (2, 'Nettoyer le système d''étirage (drafting system) — 9.10.10'),
  (3, 'Nettoyer les cylindres inférieurs : alimentation, milieu et délivreur — 9.10.52 à 9.10.54'),
  (4, 'Nettoyer les cylindres de pression et le berceau (cradle) — 9.10.32, 9.10.55'),
  (5, 'Nettoyer les manchons (top apron) et le tendeur du manchon inférieur — 9.10.33, 9.10.26'),
  (6, 'Nettoyer les rouleaux nettoyeurs (clearer rollers) — 9.10.24'),
  (7, 'Nettoyer les anneaux et le banc à anneaux (ring rail) — 9.10.12, 9.10.22'),
  (8, 'Nettoyer les broches et les freins de broche — 9.10.14, 9.10.15'),
  (9, 'Nettoyer les poulies de tension des bandes de broches — 9.10.49'),
  (10, 'Nettoyer les tubes d''aspiration et le séparateur — 9.10.16, 9.10.13'),
  (11, 'Nettoyer le filtre fixe (stationary filter) — 9.10.8'),
  (12, 'Nettoyer le ventilateur, son capot et le moteur (refroidissement) — 9.10.19, 9.10.21, 9.10.34'),
  (13, 'Nettoyer le chariot nettoyeur (traveling cleaner) — 9.10.48'),
  (14, 'Nettoyer les barrières lumineuses et les réflecteurs — 9.10.17'),
  (15, 'Nettoyer le sol sous les sections, le bâti de tête et le bâti de pied — 9.10.23, 9.10.29, 9.10.42'),
  (16, 'Contrôle final : outils retirés, capots remis, essai de démarrage')
) AS v(n, t)
WHERE NOT EXISTS (SELECT 1 FROM checklist_steps);

-- Messages privés : reçu (deux traits) et lu (deux traits bleus).
ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS delivered_at timestamptz;
ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS read_at timestamptz;
-- Les anciens messages comptent comme reçus et lus (pas de faux « non lu »).
UPDATE dm_messages SET delivered_at = COALESCE(delivered_at, created_at), read_at = COALESCE(read_at, created_at) WHERE created_at < now();

-- Relance des pannes non réglées vers les autres équipes : toutes les 10 minutes.
SELECT cron.schedule('g37-escalade-pannes', '*/10 * * * *', $cron$
  SELECT net.http_post(
    url := 'https://yrtoimldmzlnmsoapcij.supabase.co/functions/v1/api/cron/escalate',
    headers := jsonb_build_object('content-type', 'application/json', 'x-cron-key', (SELECT value FROM public.app_config WHERE key = 'cron.key')),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
$cron$);
