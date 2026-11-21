-- MBS Travel Diary update: audit log.
-- Run once in the Supabase SQL editor on a project that already has the earlier schema.
-- Safe to run twice. Adds the admin-only audit log, records the Smartraveller level a trip
-- was approved at, and replaces save_trip and approve_trip to use both.

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

create or replace function public.save_trip(p jsonb) returns uuid
language plpgsql security invoker set search_path = public as $$
declare
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_old public.trips%rowtype;
  v_max_level int := 0;
  v_old_countries text;
  v_new_countries text;
  v_status text;
  v_reasons text[] := '{}';
  d jsonb; s jsonb; i int := 0;
begin
  if v_id is not null then
    select * into v_old from public.trips where id = v_id;
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
    if public.my_person_id() is distinct from v_old.traveller_id then
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
    values ((p ->> 'traveller_id')::uuid, public.my_person_id(), p ->> 'purpose', p ->> 'cost_centre',
      (p ->> 'start_date')::date, (p ->> 'end_date')::date, lower(nullif(p ->> 'manager_email','')),
      coalesce((p ->> 'manager_declared')::boolean, false), nullif(p ->> 'manager_declared_date','')::date,
      coalesce((p ->> 'dean_permission')::boolean, false), nullif(p ->> 'dean_permission_date','')::date, 'submitted')
    returning id into v_id;
  else
    update public.trips set
      traveller_id = (p ->> 'traveller_id')::uuid,
      purpose = p ->> 'purpose', cost_centre = p ->> 'cost_centre',
      start_date = (p ->> 'start_date')::date, end_date = (p ->> 'end_date')::date,
      manager_email = lower(nullif(p ->> 'manager_email','')),
      manager_declared = coalesce((p ->> 'manager_declared')::boolean, false),
      manager_declared_date = nullif(p ->> 'manager_declared_date','')::date,
      dean_permission = coalesce((p ->> 'dean_permission')::boolean, false),
      dean_permission_date = nullif(p ->> 'dean_permission_date','')::date,
      status = v_status,
      approved_by = case when v_status = 'submitted' then null else approved_by end,
      approved_at = case when v_status = 'submitted' then null else approved_at end
    where id = v_id;
    if not found then raise exception 'You do not have access to this trip'; end if;
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
-- approve_trip: the named line manager (or an admin) approves or declines.
-- ---------------------------------------------------------------
create or replace function public.approve_trip(p_trip uuid, p_decision text, p_comment text default null) returns void
language plpgsql security definer set search_path = public as $$
declare t public.trips%rowtype;
begin
  select * into t from public.trips where id = p_trip;
  if t.id is null then raise exception 'Trip not found'; end if;
  if not (lower(coalesce(t.manager_email,'')) = public.my_email() or public.my_role() = 'admin') then
    raise exception 'Only the named line manager or an admin can approve this trip';
  end if;
  if p_decision not in ('approved','declined') then raise exception 'Decision must be approved or declined'; end if;
  update public.trips set status = p_decision, approval_comment = p_comment,
    approved_by = public.my_email(), approved_at = now(),
    approved_level = case when p_decision = 'approved' then
      (select coalesce(max(a.level), 0) from public.trip_days d join public.advice_levels a on lower(a.country) = lower(d.country) where d.trip_id = p_trip)
      else approved_level end
  where id = p_trip;
end $$;

grant execute on function public.save_trip(jsonb) to authenticated;
grant execute on function public.approve_trip(uuid, text, text) to authenticated;
grant execute on function public.save_trip(jsonb) to authenticated;
grant execute on function public.approve_trip(uuid, text, text) to authenticated;
