-- Count toujours cohérent avec les pignons (08/11/2026).
-- count = draft × hank, draft = 16,068 × H ÷ G. On garde le hank de chaque machine et l'historique de chaque changement.
alter table machines add column if not exists run_hank numeric;

create table if not exists machine_history (
  id bigserial primary key,
  machine_no int not null,
  at timestamptz not null default now(),
  prev_g int, prev_h int, prev_count numeric, prev_hank numeric,
  new_g int, new_h int, new_count numeric, new_hank numeric,
  note text
);
alter table machine_history enable row level security;
create index if not exists machine_history_no_at on machine_history (machine_no, at desc);

create or replace function g37_draft(g int, h int) returns numeric language sql immutable as
$$ select case when g > 0 and h > 0 then 16.068 * h / g end $$;

create or replace function machines_count_guard() returns trigger language plpgsql as $$
declare
  d numeric := g37_draft(new.run_g, new.run_h);
  prev record;
  slip record;
begin
  if (new.run_g, new.run_h) is distinct from (old.run_g, old.run_h) and new.run_count is not distinct from old.run_count then
    -- Seuls les pignons changent.
    -- 1) Fiche « count change » validée il y a moins de 2 h pour ces pignons : on prend son count.
    select count_label into slip from gear_change_requests
      where machine_no = new.machine_no and new_g = new.run_g and new_h = new.run_h and status = 'done' and done_at > now() - interval '2 hours'
      order by done_at desc limit 1;
    if found and substring(slip.count_label from '(\d+(?:[.,]\d+)?)') is not null then
      new.run_count := replace(substring(slip.count_label from '(\d+(?:[.,]\d+)?)'), ',', '.')::numeric;
      new.run_hank := case when d is not null then round(new.run_count / d, 4) end;
      return new;
    end if;
    -- 2) Retour à des pignons déjà utilisés ces 15 derniers jours (annulation) : on reprend le count et le hank d'alors.
    select prev_count, prev_hank into prev from machine_history
      where machine_no = new.machine_no and prev_g = new.run_g and prev_h = new.run_h and at > now() - interval '15 days'
      order by at desc limit 1;
    if found then
      new.run_count := prev.prev_count; new.run_hank := prev.prev_hank;
      return new;
    end if;
    -- 3) Même mèche (hank connu) : le count suit le nouveau draft.
    if old.run_hank is not null and d is not null then
      new.run_count := round(d * old.run_hank, 1); new.run_hank := old.run_hank;
    else
      new.run_count := null; new.run_hank := null;   -- inconnu : mieux vaut « ? » qu'un count faux
    end if;
  elsif new.run_count is distinct from old.run_count or (new.run_g, new.run_h) is distinct from (old.run_g, old.run_h) then
    -- Count donné (avec ou sans nouveaux pignons) : on en déduit le hank.
    new.run_hank := case when new.run_count is not null and d is not null then round(new.run_count / d, 4) end;
  end if;
  return new;
end $$;

create or replace function machines_count_log() returns trigger language plpgsql as $$
begin
  if (new.run_g, new.run_h, new.run_count) is distinct from (old.run_g, old.run_h, old.run_count) then
    insert into machine_history (machine_no, prev_g, prev_h, prev_count, prev_hank, new_g, new_h, new_count, new_hank, note)
    values (new.machine_no, old.run_g, old.run_h, old.run_count, old.run_hank, new.run_g, new.run_h, new.run_count, new.run_hank,
            nullif(current_setting('g37.note', true), ''));
  end if;
  return new;
end $$;

drop trigger if exists machines_count_guard on machines;
create trigger machines_count_guard before update on machines for each row execute function machines_count_guard();
drop trigger if exists machines_count_log on machines;
create trigger machines_count_log after update on machines for each row execute function machines_count_log();

-- Fiche « count change » validée après le changement de pignons : le count de la fiche est appliqué.
create or replace function gear_slip_done() returns trigger language plpgsql as $$
declare c text := substring(new.count_label from '(\d+(?:[.,]\d+)?)');
begin
  if new.status = 'done' and old.status is distinct from 'done' and c is not null then
    update machines set run_count = replace(c, ',', '.')::numeric
      where machine_no = new.machine_no and run_g = new.new_g and run_h = new.new_h
        and run_count is distinct from replace(c, ',', '.')::numeric;
  end if;
  return new;
end $$;
drop trigger if exists gear_slip_done on gear_change_requests;
create trigger gear_slip_done after update on gear_change_requests for each row execute function gear_slip_done();

-- Hank des machines dont le count est connu.
update machines set run_hank = round(run_count / g37_draft(run_g, run_h), 4)
  where run_count is not null and g37_draft(run_g, run_h) is not null;

-- Mc 22 : le count 30 venait d'un changement annulé (G37/H103) ; avec G61/H98 le vrai count est inconnu.
select set_config('g37.note', 'Correction 08/11 : count 30 laissé par le changement annulé du 04/11', true);
update machines set run_count = null, run_hank = null where machine_no = 22 and run_g = 61 and run_h = 98 and run_count = 30;

-- Pignons H75 à H88 (08/11/2026) : 12 pièces chacun en magasin.
-- Le robot ne les PROPOSE pas tant que l'admin n'a pas écrit « autoriser H75 » (réglage gears.h_low_allowed).
insert into gears (id, gear_type, teeth, stock, updated_at, updated_by)
select 'H-' || t, 'H', t, 12, now(), 'Habib Edessou'
from generate_series(75, 88) t
on conflict (id) do nothing;

insert into app_config (key, value, updated_at) values ('gears.h_low_allowed', 'non', now())
on conflict (key) do nothing;
