-- Robot WhatsApp G37 v2 (01/11/2026)
-- • Personnes connues du robot (numéro WhatsApp), leur niveau de droits et leur ordre d'appel le soir.
-- • Modifications de l'app depuis WhatsApp (avec confirmation) et journal de ces modifications.
-- • Appel de 16h30 : maintenance du jour finie ? machine(s) en maintenance demain ? (relance après 15 min).
-- • Rapports PDF de quart : efficience par ring frame et remarques.
-- Seulement des ajouts : rien d'existant n'est modifié ni supprimé.

-- 1) Personnes ------------------------------------------------------------------------------
-- level : owner (tout), supervisor (tout sauf les accès), staff (pignons/count, sorties de matériel,
--         fin de maintenance, graissage), none (questions seulement)
-- call_tier : ordre d'appel du soir (1 = superviseur, 2 = responsables maintenance, 3 = propriétaire), NULL = jamais
CREATE TABLE IF NOT EXISTS wa_people (
  id          bigserial PRIMARY KEY,
  name        text NOT NULL,
  phone       text NOT NULL UNIQUE,            -- chiffres avec l'indicatif : 2290196142534
  user_id     integer REFERENCES users(id) ON DELETE SET NULL,
  level       text NOT NULL DEFAULT 'staff' CHECK (level IN ('owner', 'supervisor', 'staff', 'none')),
  call_tier   integer,
  name_auto   boolean NOT NULL DEFAULT true,   -- nom repris du profil WhatsApp au premier message
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE wa_people ENABLE ROW LEVEL SECURITY;

-- 2) Confirmations en attente : numéro, modifications préparées
ALTER TABLE wa_pending_action
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS kind  text NOT NULL DEFAULT 'command', -- command | edit
  ADD COLUMN IF NOT EXISTS ops   jsonb;
CREATE INDEX IF NOT EXISTS wa_pending_action_phone ON wa_pending_action (phone, status);

-- 3) Messages du robot : destinataire privé (sinon le groupe) et note vocale (WAV en base64)
ALTER TABLE wa_outbox
  ADD COLUMN IF NOT EXISTS to_phone text,
  ADD COLUMN IF NOT EXISTS voice    text;

-- Numéro de l'expéditeur des messages de groupe (pour relier les noms aux numéros)
ALTER TABLE wa_messages ADD COLUMN IF NOT EXISTS phone text;

-- 4) Appel du soir --------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS wa_asks (
  id            bigserial PRIMARY KEY,
  day           date NOT NULL,
  person_id     bigint NOT NULL REFERENCES wa_people(id) ON DELETE CASCADE,
  tier          integer NOT NULL DEFAULT 1,
  machines      integer[] NOT NULL DEFAULT '{}',  -- maintenance prévue aujourd'hui (à confirmer finie)
  ask_tomorrow  boolean NOT NULL DEFAULT true,     -- demander la machine de demain
  planned_tomorrow integer[] NOT NULL DEFAULT '{}', -- machines déjà programmées pour demain (à confirmer)
  question      text NOT NULL,
  audio         text,                               -- voix de la question (WAV en base64), lue dans l'app
  status        text NOT NULL DEFAULT 'pending',    -- pending | answered | closed
  done_answer   integer[],                          -- machines du jour déclarées finies (NULL = pas encore répondu)
  tomorrow      integer[],                          -- machines de demain (NULL = pas encore répondu, {} = aucune)
  answered_by   text,
  answered_via  text,                               -- whatsapp | app
  answered_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (day, person_id)
);
ALTER TABLE wa_asks ENABLE ROW LEVEL SECURITY;

-- 5) Journal des modifications faites depuis WhatsApp
CREATE TABLE IF NOT EXISTS wa_edit_log (
  id       bigserial PRIMARY KEY,
  at       timestamptz NOT NULL DEFAULT now(),
  phone    text,
  person   text,
  level    text,
  summary  text,
  ops      jsonb,
  result   jsonb
);
ALTER TABLE wa_edit_log ENABLE ROW LEVEL SECURITY;

-- 6) Rapports PDF de quart ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS shift_reports (
  id          bigserial PRIMARY KEY,
  day         date NOT NULL,
  shift       text NOT NULL CHECK (shift IN ('m', 's', 'n')),  -- matin 7h-15h, après-midi 15h-23h, nuit 23h-7h
  team        text,
  msg_id      text,
  file_name   text,
  total_eff   numeric,
  data        jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (day, shift)
);
ALTER TABLE shift_reports ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS machine_shift_eff (
  day          date NOT NULL,
  shift        text NOT NULL,
  machine_no   integer NOT NULL CHECK (machine_no BETWEEN 1 AND 28),
  team         text,
  count_label  text,
  prod_kg      numeric,
  eff          numeric CHECK (eff BETWEEN 0 AND 100),
  reason       text,
  report_id    bigint REFERENCES shift_reports(id) ON DELETE CASCADE,
  PRIMARY KEY (day, shift, machine_no)
);
ALTER TABLE machine_shift_eff ENABLE ROW LEVEL SECURITY;

-- Pannes venant d'un rapport : une seule fois par rapport, machine et remarque
ALTER TABLE failures ADD COLUMN IF NOT EXISTS source text;
CREATE UNIQUE INDEX IF NOT EXISTS failures_source_uniq ON failures (source) WHERE source IS NOT NULL;
