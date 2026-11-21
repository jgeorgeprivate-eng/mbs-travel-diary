-- MBS Travel Diary: database schema, access rules and scheduled jobs.
-- Paste the whole file into the Supabase SQL editor and run it once.
-- Before running, replace the two placeholders near the bottom:
--   j.george.dean@mbs.edu  -> your MBS email address (you become the first admin)
--   (the cron section) -> your project URL and anon key, see README step 5

create extension if not exists pgcrypto;
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ---------------------------------------------------------------
-- Reference data
-- ---------------------------------------------------------------

-- Email domains that may sign in without an invitation.
create table if not exists public.allowed_domains (
  domain text primary key
);
insert into public.allowed_domains (domain) values ('mbs.edu') on conflict do nothing;

-- Smartraveller overall advice levels, refreshed daily by the sync function.
create table if not exists public.advice_levels (
  country     text primary key,
  level       int  not null check (level between 1 and 4),
  label       text not null,
  changed     timestamptz,
  fetched_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------
-- People: everyone who can travel or use the app. Contractors can exist
-- here without a sign-in; a staff member's row is created on first sign-in.
-- ---------------------------------------------------------------
create table if not exists public.people (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid unique references auth.users(id) on delete set null,
  email         text unique,
  full_name     text not null,
  kind          text not null default 'staff' check (kind in ('staff','contractor')),
  role          text not null default 'traveller' check (role in ('traveller','arranger','manager','admin')),
  cost_centre   text,
  manager_email text,
  mobile        text,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------
-- Trips, days and segments
-- ---------------------------------------------------------------
create table if not exists public.trips (
  id                    uuid primary key default gen_random_uuid(),
  traveller_id          uuid not null references public.people(id),
  entered_by            uuid not null references public.people(id),
  purpose               text not null,
  cost_centre           text,
  start_date            date not null,
  end_date              date not null check (end_date >= start_date),
  manager_email         text,
  manager_declared      boolean not null default false,
  manager_declared_date date,
  dean_permission       boolean not null default false,
  dean_permission_date  date,
  status                text not null default 'submitted' check (status in ('draft','submitted','approved','declined')),
  approval_comment      text,
  approved_by           text,
  approved_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create table if not exists public.trip_days (
  id         uuid primary key default gen_random_uuid(),
  trip_id    uuid not null references public.trips(id) on delete cascade,
  day_date   date not null,
  city       text,
  country    text,
  day_type   text not null check (day_type in ('Travel','Working','Not working','Weekend','Public holiday','Leave')),
  activities text,
  qualifies  boolean not null default false,
  allowance  boolean not null default false,
  unique (trip_id, day_date)
);

create table if not exists public.trip_segments (
  id            uuid primary key default gen_random_uuid(),
  trip_id       uuid not null references public.trips(id) on delete cascade,
  kind          text not null check (kind in ('flight','stay')),
  carrier       text,
  flight_number text,
  origin        text,
  destination   text,
  seg_date      date,
  property      text,
  city          text,
  country       text,
  checkin       date,
  checkout      date,
  paid_by_mbs   boolean,
  sort_order    int not null default 0
);

create index if not exists trip_days_date_idx on public.trip_days (day_date);
create index if not exists trips_traveller_idx on public.trips (traveller_id);
create index if not exists trips_manager_idx on public.trips (manager_email);

-- ---------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------
create or replace function public.my_person_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from public.people where user_id = auth.uid() limit 1;
$$;

create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select role from public.people where user_id = auth.uid() limit 1), 'traveller');
$$;

create or replace function public.my_email() returns text
language sql stable security definer set search_path = public as $$
  select lower(coalesce(auth.jwt() ->> 'email', ''));
$$;

-- Everyone except plain travellers sees all trips (CFO, exec, managers, EAs, arrangers).
create or replace function public.sees_all() returns boolean
language sql stable security definer set search_path = public as $$
  select public.my_role() in ('arranger','manager','admin');
$$;

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists trips_touch on public.trips;
create trigger trips_touch before update on public.trips for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------
-- Sign-in gate: only allowed domains or invited emails may create an account.
-- On first sign-in, link or create the person's row.
-- ---------------------------------------------------------------
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  em text := lower(new.email);
  dom text := split_part(lower(new.email), '@', 2);
  existing uuid;
begin
  select id into existing from public.people where lower(email) = em;
  if existing is null and not exists (select 1 from public.allowed_domains where domain = dom) then
    raise exception 'This email address is not allowed to sign in to the MBS Travel Diary';
  end if;
  if existing is not null then
    update public.people set user_id = new.id where id = existing;
  else
    insert into public.people (user_id, email, full_name)
    values (new.id, em, coalesce(new.raw_user_meta_data ->> 'full_name', initcap(replace(split_part(em,'@',1),'.',' '))));
  end if;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------
alter table public.people          enable row level security;
alter table public.trips           enable row level security;
alter table public.trip_days       enable row level security;
alter table public.trip_segments   enable row level security;
alter table public.advice_levels   enable row level security;
alter table public.allowed_domains enable row level security;

-- ---------------------------------------------------------------
-- People: the full table (mobile numbers, line manager emails) is readable only by
-- arrangers, managers and admins, and by each person for their own row.
-- Everyone else uses people_directory().
-- ---------------------------------------------------------------
drop policy if exists people_read on public.people;
create policy people_read on public.people for select to authenticated
  using (public.sees_all() or user_id = auth.uid());

-- People edits: nobody may change a sign-in link or a role without being admin (roles) and
-- an ordinary person may change only their own name and mobile.
drop policy if exists people_update on public.people;
create policy people_update on public.people for update to authenticated
  using (user_id = auth.uid() or public.my_role() in ('arranger','admin'))
  with check (
    (select p.user_id from public.people p where p.id = people.id) is not distinct from user_id
    and (
      public.my_role() = 'admin'
      or (
        (select p.role from public.people p where p.id = people.id) = role
        and (
          public.my_role() = 'arranger'
          or (select row(p.email, p.kind, p.cost_centre, p.manager_email, p.active) from public.people p where p.id = people.id)
             is not distinct from row(email, kind, cost_centre, manager_email, active)
        )
      )
    )
  );

drop policy if exists people_insert on public.people;
create policy people_insert on public.people for insert to authenticated
  with check (public.my_role() in ('arranger','admin'));

-- trips: travellers see their own and ones they entered; others see all.
drop policy if exists trips_read on public.trips;
create policy trips_read on public.trips for select to authenticated
  using (public.sees_all() or traveller_id = public.my_person_id() or entered_by = public.my_person_id()
         or lower(manager_email) = public.my_email());
-- trips: no direct writes. All writes go through save_trip, delete_trip and approve_trip.
drop policy if exists trips_write on public.trips;
drop policy if exists trips_update on public.trips;
drop policy if exists trips_delete on public.trips;
revoke insert, update, delete, truncate on public.trips from authenticated, anon;

drop policy if exists days_all on public.trip_days;
drop policy if exists days_read on public.trip_days;
create policy days_read on public.trip_days for select to authenticated
  using (exists (select 1 from public.trips t where t.id = trip_id));
revoke insert, update, delete, truncate on public.trip_days from authenticated, anon;

drop policy if exists segs_all on public.trip_segments;
drop policy if exists segs_read on public.trip_segments;
create policy segs_read on public.trip_segments for select to authenticated
  using (exists (select 1 from public.trips t where t.id = trip_id));
revoke insert, update, delete, truncate on public.trip_segments from authenticated, anon;

drop policy if exists advice_read on public.advice_levels;
create policy advice_read on public.advice_levels for select to authenticated using (true);
drop policy if exists domains_read on public.allowed_domains;
create policy domains_read on public.allowed_domains for select to authenticated using (true);
drop policy if exists domains_admin on public.allowed_domains;
create policy domains_admin on public.allowed_domains for all to authenticated
  using (public.my_role() = 'admin') with check (public.my_role() = 'admin');

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

-- ---------------------------------------------------------------
-- save_trip: the only way to create or change a trip.
-- Security definer, so it checks who may do what itself. It never reads status or
-- approval fields from the request.
-- ---------------------------------------------------------------
create or replace function public.save_trip(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := public.my_person_id();
  v_priv boolean := public.my_role() in ('arranger','admin');
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_trav uuid := nullif(p ->> 'traveller_id', '')::uuid;
  v_trav_email text;
  v_mgr text := lower(nullif(trim(p ->> 'manager_email'), ''));
  v_old public.trips%rowtype;
  v_max_level int := 0;
  v_old_countries text;
  v_new_countries text;
  v_status text;
  v_reasons text[] := '{}';
  d jsonb; s jsonb; i int := 0;
begin
  if v_me is null then raise exception 'You are not signed in to a person record'; end if;
  if v_trav is null then raise exception 'A traveller is required'; end if;
  select lower(email) into v_trav_email from public.people where id = v_trav;
  if not found then raise exception 'Traveller not found'; end if;

  if v_id is not null then
    select * into v_old from public.trips where id = v_id;
    if v_old.id is null then raise exception 'Trip not found'; end if;
    if not (v_old.traveller_id = v_me or v_old.entered_by = v_me or v_priv) then
      raise exception 'You do not have access to this trip';
    end if;
    if v_trav <> v_old.traveller_id and not v_priv then
      raise exception 'Only an arranger or admin can change who is travelling';
    end if;
  elsif v_trav <> v_me and not v_priv then
    raise exception 'Only an arranger or admin can enter a trip for someone else';
  end if;

  if v_mgr is not null and v_mgr = v_trav_email then
    raise exception 'The line manager cannot be the person travelling';
  end if;

  -- highest Smartraveller level across the countries entered
  select coalesce(max(a.level), 0) into v_max_level
  from jsonb_array_elements(coalesce(p -> 'days', '[]'::jsonb)) dd
  join public.advice_levels a on lower(a.country) = lower(dd ->> 'country');

  if v_max_level = 4 then
    raise exception 'MBS policy does not permit travel to a destination where Smartraveller advises do not travel.';
  end if;
  if v_max_level = 3 and not coalesce((p ->> 'dean_permission')::boolean, false) then
    raise exception 'A level 3 destination needs the Dean''s special permission before the trip can be submitted.';
  end if;

  -- status: new trips are submitted; approved trips go back to submitted if dates or countries change
  v_status := coalesce(v_old.status, 'submitted');
  if v_old.id is not null and v_old.status = 'approved' then
    select string_agg(distinct lower(country), ',' order by lower(country)) into v_old_countries from public.trip_days where trip_id = v_id;
    select string_agg(distinct lower(dd ->> 'country'), ',' order by lower(dd ->> 'country')) into v_new_countries
      from jsonb_array_elements(coalesce(p -> 'days', '[]'::jsonb)) dd;
    if v_old.start_date <> (p ->> 'start_date')::date or v_old.end_date <> (p ->> 'end_date')::date
       or coalesce(v_old_countries,'') <> coalesce(v_new_countries,'') then
      v_status := 'submitted';
    end if;
  end if;
  if v_old.status = 'declined' then v_status := 'submitted'; end if;

  -- audit: edits by someone other than the traveller, and rating changes after approval
  if v_old.id is not null then
    if v_me is distinct from v_old.traveller_id then
      v_reasons := array_append(v_reasons, 'Edited by someone other than the traveller'::text);
    end if;
    if v_old.approved_level is not null and v_old.approved_level <> v_max_level then
      v_reasons := array_append(v_reasons, ('Smartraveller rating changed after approval, from ' || public.level_text(v_old.approved_level) || ' to ' || public.level_text(v_max_level))::text);
    end if;
    if array_length(v_reasons, 1) > 0 then
      perform set_config('app.audit_reason', array_to_string(v_reasons, '; '), true);
    end if;
  end if;

  if v_id is null then
    insert into public.trips (traveller_id, entered_by, purpose, cost_centre, start_date, end_date, manager_email,
      manager_declared, manager_declared_date, dean_permission, dean_permission_date, status)
    values (v_trav, v_me, p ->> 'purpose', p ->> 'cost_centre',
      (p ->> 'start_date')::date, (p ->> 'end_date')::date, v_mgr,
      coalesce((p ->> 'manager_declared')::boolean, false), nullif(p ->> 'manager_declared_date','')::date,
      coalesce((p ->> 'dean_permission')::boolean, false), nullif(p ->> 'dean_permission_date','')::date, 'submitted')
    returning id into v_id;
  else
    update public.trips set
      traveller_id = v_trav,
      purpose = p ->> 'purpose', cost_centre = p ->> 'cost_centre',
      start_date = (p ->> 'start_date')::date, end_date = (p ->> 'end_date')::date,
      manager_email = v_mgr,
      manager_declared = coalesce((p ->> 'manager_declared')::boolean, false),
      manager_declared_date = nullif(p ->> 'manager_declared_date','')::date,
      dean_permission = coalesce((p ->> 'dean_permission')::boolean, false),
      dean_permission_date = nullif(p ->> 'dean_permission_date','')::date,
      status = v_status,
      approved_by = case when v_status = 'submitted' then null else approved_by end,
      approved_at = case when v_status = 'submitted' then null else approved_at end
    where id = v_id;
    delete from public.trip_days where trip_id = v_id;
    delete from public.trip_segments where trip_id = v_id;
  end if;

  for d in select * from jsonb_array_elements(coalesce(p -> 'days', '[]'::jsonb)) loop
    insert into public.trip_days (trip_id, day_date, city, country, day_type, activities, qualifies, allowance)
    values (v_id, (d ->> 'day_date')::date, d ->> 'city', d ->> 'country', coalesce(d ->> 'day_type','Working'),
            d ->> 'activities', coalesce((d ->> 'qualifies')::boolean,false), coalesce((d ->> 'allowance')::boolean,false));
  end loop;
  for s in select * from jsonb_array_elements(coalesce(p -> 'segments', '[]'::jsonb)) loop
    i := i + 1;
    insert into public.trip_segments (trip_id, kind, carrier, flight_number, origin, destination, seg_date,
      property, city, country, checkin, checkout, paid_by_mbs, sort_order)
    values (v_id, s ->> 'kind', s ->> 'carrier', s ->> 'flight_number', s ->> 'origin', s ->> 'destination',
      nullif(s ->> 'seg_date','')::date, s ->> 'property', s ->> 'city', s ->> 'country',
      nullif(s ->> 'checkin','')::date, nullif(s ->> 'checkout','')::date, (s ->> 'paid_by_mbs')::boolean, i);
  end loop;
  return v_id;
end $$;

-- ---------------------------------------------------------------
-- delete_trip: the traveller, whoever entered the trip, or an admin.
-- ---------------------------------------------------------------
create or replace function public.delete_trip(p_trip uuid) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := public.my_person_id();
  t public.trips%rowtype;
begin
  if v_me is null then raise exception 'You are not signed in to a person record'; end if;
  select * into t from public.trips where id = p_trip;
  if t.id is null then raise exception 'Trip not found'; end if;
  if not (t.traveller_id = v_me or t.entered_by = v_me or public.my_role() = 'admin') then
    raise exception 'You do not have access to this trip';
  end if;
  delete from public.trips where id = p_trip;
end $$;

-- ---------------------------------------------------------------
-- approve_trip: the named line manager (or an admin) approves or declines,
-- but never their own trip.
-- ---------------------------------------------------------------
create or replace function public.approve_trip(p_trip uuid, p_decision text, p_comment text default null) returns void
language plpgsql security definer set search_path = public as $$
declare
  t public.trips%rowtype;
  v_trav_email text;
begin
  select * into t from public.trips where id = p_trip;
  if t.id is null then raise exception 'Trip not found'; end if;
  if not (lower(coalesce(t.manager_email,'')) = public.my_email() or public.my_role() = 'admin') then
    raise exception 'Only the named line manager or an admin can approve this trip';
  end if;
  select lower(email) into v_trav_email from public.people where id = t.traveller_id;
  if t.traveller_id = public.my_person_id() or coalesce(v_trav_email, '') = public.my_email() then
    raise exception 'You cannot approve or decline your own trip';
  end if;
  if p_decision not in ('approved','declined') then raise exception 'Decision must be approved or declined'; end if;
  update public.trips set status = p_decision, approval_comment = p_comment,
    approved_by = public.my_email(), approved_at = now(),
    approved_level = case when p_decision = 'approved' then
      (select coalesce(max(a.level), 0) from public.trip_days d join public.advice_levels a on lower(a.country) = lower(d.country) where d.trip_id = p_trip)
      else approved_level end
  where id = p_trip;
end $$;

-- ---------------------------------------------------------------
-- people_directory: names for everyone, without contact details.
-- Email is shown only for managers, admins and people named as someone's line manager.
-- ---------------------------------------------------------------
create or replace function public.people_directory()
returns table (id uuid, full_name text, kind text, cost_centre text, active boolean, email text)
language sql stable security definer set search_path = public as $$
  select p.id, p.full_name, p.kind, p.cost_centre, p.active,
         case when p.role in ('manager','admin')
                or exists (select 1 from public.people m where lower(m.manager_email) = lower(p.email))
              then p.email end
  from public.people p
  where auth.uid() is not null;
$$;

revoke execute on function public.save_trip(jsonb) from public, anon;
revoke execute on function public.delete_trip(uuid) from public, anon;
revoke execute on function public.approve_trip(uuid, text, text) from public, anon;
revoke execute on function public.people_directory() from public, anon;
grant execute on function public.save_trip(jsonb) to authenticated;
grant execute on function public.delete_trip(uuid) to authenticated;
grant execute on function public.approve_trip(uuid, text, text) to authenticated;
grant execute on function public.people_directory() to authenticated;

grant execute on function public.my_person_id() to authenticated;
grant execute on function public.my_role() to authenticated;
grant execute on function public.my_email() to authenticated;
grant execute on function public.sees_all() to authenticated;

-- ---------------------------------------------------------------
-- ---------------------------------------------------------------
-- Further tightening: the anonymous role needs no table access, nobody needs truncate,
-- and advice_levels is written only by the edge function (service role).
-- ---------------------------------------------------------------
revoke all on all tables in schema public from anon;
revoke truncate, references, trigger on public.people, public.trips, public.trip_days, public.trip_segments from authenticated;
revoke truncate on all tables in schema public from authenticated;
revoke insert, update, delete on public.advice_levels from authenticated;

-- First admin. Replace j.george.dean@mbs.edu with your address, keep the quotes.
-- The row is created now (so the role is in place) and linked when you first sign in.
-- ---------------------------------------------------------------
insert into public.people (email, full_name, role, kind)
values ('j.george.dean@mbs.edu', 'Pilot admin', 'admin', 'staff')
on conflict (email) do update set role = 'admin';

-- ---------------------------------------------------------------
-- Daily Smartraveller refresh (03:30 Melbourne, 16:30 UTC the day before).
-- Run this block AFTER deploying the smartraveller-sync function (README step 5),
-- replacing YOUR_PROJECT_REF and YOUR_ANON_KEY.
-- ---------------------------------------------------------------
-- select cron.schedule(
--   'smartraveller-sync-daily', '30 16 * * *',
--   $job$
--   select net.http_post(
--     url := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/smartraveller-sync',
--     headers := '{"Content-Type":"application/json","Authorization":"Bearer YOUR_ANON_KEY"}'::jsonb,
--     body := '{}'::jsonb);
--   $job$);
