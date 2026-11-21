-- MBS Travel Diary update: audit log.
-- Run once in the Supabase SQL editor on a project that already has the earlier schema.
-- Safe to run twice. Adds the admin-only audit log, records the Smartraveller level a trip
-- was approved at. (The save_trip and approve_trip changes it used to carry now live in the later files.)

-- ---------------------------------------------------------------
-- Audit log (admins only). One row when someone other than the traveller edits
-- or deletes a trip, or when an approved trip is edited and its Smartraveller
-- rating is no longer the one it was approved at. Written by triggers only,
-- so nobody can add, change or remove entries from the app.
-- ---------------------------------------------------------------
alter table public.trips add column if not exists approved_level int;

create table if not exists public.trip_audit (
  id             bigint generated always as identity primary key,
  at             timestamptz not null default now(),
  trip_id        uuid not null,
  action         text not null check (action in ('Edited','Deleted')),
  changed_by     uuid,
  changed_by_name text,
  traveller_name text,
  trip_label     text,
  reason         text not null
);
create index if not exists trip_audit_at_idx on public.trip_audit (at desc);

alter table public.trip_audit enable row level security;
drop policy if exists audit_admin_read on public.trip_audit;
create policy audit_admin_read on public.trip_audit for select to authenticated
  using (public.my_role() = 'admin');
revoke insert, update, delete, truncate on public.trip_audit from anon, authenticated;
grant select on public.trip_audit to authenticated;

create or replace function public.level_text(n int) returns text
language sql immutable as $$ select case when coalesce(n,0) = 0 then 'no advice found' else 'Level ' || n end $$;

create or replace function public.audit_trip_change() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  r text;
  actor uuid := public.my_person_id();
  rec public.trips%rowtype;
begin
  if tg_op = 'UPDATE' then
    r := nullif(current_setting('app.audit_reason', true), '');
    if r is null then return new; end if;
    perform set_config('app.audit_reason', '', true);
    rec := new;
  else
    if actor is null then return old; end if;
    if actor is not distinct from old.traveller_id and old.approved_level is null then return old; end if;
    r := case when actor is distinct from old.traveller_id then 'Deleted by someone other than the traveller' else 'Deleted after approval' end;
    rec := old;
  end if;
  insert into public.trip_audit (trip_id, action, changed_by, changed_by_name, traveller_name, trip_label, reason)
  values (rec.id,
          case when tg_op = 'UPDATE' then 'Edited' else 'Deleted' end,
          actor,
          (select full_name from public.people where id = actor),
          (select full_name from public.people where id = rec.traveller_id),
          rec.purpose || ' (' || to_char(rec.start_date, 'DD Mon YYYY') || ' to ' || to_char(rec.end_date, 'DD Mon YYYY') || ')',
          r);
  return null;
end $$;

drop trigger if exists trips_audit on public.trips;
create trigger trips_audit after update or delete on public.trips
  for each row execute function public.audit_trip_change();

-- Trips approved before this update: record the rating as it stands now, as the baseline.
update public.trips t set approved_level = (
  select coalesce(max(a.level), 0) from public.trip_days d
  join public.advice_levels a on lower(a.country) = lower(d.country) where d.trip_id = t.id)
where t.status = 'approved' and t.approved_level is null;

-- save_trip and approve_trip are NOT defined here any more. This file used to replace them, which
-- would overwrite the later, stricter versions if it were run again out of order. The current
-- versions are in update-2026-11-review-fixes.sql (and schema.sql). Apply the files in the order
-- listed in docs/MIGRATIONS.md.
