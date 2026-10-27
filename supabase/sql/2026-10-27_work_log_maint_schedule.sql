-- 27/10/2026 : date de clôture des travaux (écran « Travaux effectués ») et maintenance programmée par le superviseur.
-- Appliquée le 27/10/2026.
ALTER TABLE works ADD COLUMN IF NOT EXISTS done_at timestamptz;
ALTER TABLE machines ADD COLUMN IF NOT EXISTS maint_planned_by text;
ALTER TABLE machines ADD COLUMN IF NOT EXISTS maint_planned_at timestamptz;
ALTER TABLE machines ADD COLUMN IF NOT EXISTS maint_plan_note text;
