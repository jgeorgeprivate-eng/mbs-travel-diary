-- MBS Travel Diary update 3: fixes from the developer review (November 2026).
-- Run AFTER update-2026-11-audit-log.sql, update-2026-11-security-1-functions.sql and
-- update-2026-11-security-2-lockdown.sql. Run it and then deploy the matching front end straight
-- away: the front end sends a version with every save and approval, and the old front end does not.
-- Safe to run twice.
--
-- What it changes
--   1. People: an arranger can add only ordinary travellers with no sign-in link; the email of a
--      person already linked to a sign-in cannot change; arrangers cannot edit managers or admins.
--   2. Inactive people: no sign-in linking, no reads, no writes, no approvals, immediately.
--   3. Approver comes from the staff record (people.manager_email), not from the trip form.
--   4. Approval is tied to a fingerprint of the facts approved; a material change returns the trip to
--      the approval queue. Every decision is kept in trip_decisions.
--   5. Every trip has a version. Saves and decisions must quote the version they were looking at.
--   6. Every day has a recognised destination (listed, domestic, or manually reviewed).
--   7. Approval rechecks current Smartraveller advice.
--   8. Level 3 destinations need a dated reference to written Dean permission, per destination.
--   9. A submitted trip needs exactly one entry for every date, up to 120 days.

-- ---------------------------------------------------------------
-- Migration record
-- ---------------------------------------------------------------
create table if not exists public.schema_migrations (
  name       text primary key,
  applied_at timestamptz not null default now()
);
revoke all on public.schema_migrations from anon, authenticated;
insert into public.schema_migrations (name) values
  ('schema.sql baseline'), ('update-2026-11-audit-log'), ('update-2026-11-security-1-functions'), ('update-2026-11-security-2-lockdown')
  on conflict do nothing;

-- ---------------------------------------------------------------
-- New columns and tables
-- ---------------------------------------------------------------
alter table public.trips add column if not exists version int not null default 1;
alter table public.trips add column if not exists approved_fp text;
alter table public.trips add column if not exists level3 jsonb not null default '[]'::jsonb;

alter table public.trip_days add column if not exists dest_status text not null default 'unresolved'
  check (dest_status in ('listed','domestic','reviewed','unresolved'));
alter table public.trip_days add column if not exists review_note text;

create table if not exists public.trip_decisions (
  id           bigint generated always as identity primary key,
  at           timestamptz not null default now(),
  trip_id      uuid not null,
  event        text not null check (event in ('Approved','Declined','Returned for approval')),
  by_email     text,
  by_name      text,
  comment      text,
  trip_version int,
  level        int
);
create index if not exists trip_decisions_trip_idx on public.trip_decisions (trip_id, at);
alter table public.trip_decisions enable row level security;
revoke all on public.trip_decisions from anon, authenticated;
grant select on public.trip_decisions to authenticated;

-- ---------------------------------------------------------------
-- Helpers: an inactive person has no identity
-- ---------------------------------------------------------------
create or replace function public.my_person_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from public.people where user_id = auth.uid() and active limit 1;
$$;

create or replace function public.my_role() returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select role from public.people where user_id = auth.uid() and active limit 1), 'none');
$$;

-- Fingerprint of the facts an approval covers: traveller, approver, dates, destinations,
-- the number of business, remote and leave days, and the Level 3 evidence.
-- A hotel or flight correction does not change it.
create or replace function public.trip_fp(p_trip uuid) returns text
language sql stable security definer set search_path = public as $$
  select md5(concat_ws('|', t.traveller_id::text, coalesce(lower(t.manager_email), ''), t.start_date::text, t.end_date::text,
    coalesce((select string_agg(x, ',' order by x) from
      (select distinct lower(trim(coalesce(country, ''))) || '/' || lower(trim(coalesce(city, ''))) as x from public.trip_days where trip_id = t.id) q), ''),
    (select count(*) filter (where day_type = 'Leave') from public.trip_days where trip_id = t.id)::text,
    (select count(*) filter (where day_type = 'Working' and qualifies) from public.trip_days where trip_id = t.id)::text,
    (select count(*) filter (where day_type = 'Working' and not qualifies) from public.trip_days where trip_id = t.id)::text,
    coalesce((select string_agg(lower(e ->> 'country') || '/' || coalesce(e ->> 'ref', ''), ',' order by e ->> 'country') from jsonb_array_elements(t.level3) e), '')))
  from public.trips t where t.id = p_trip;
$$;
revoke execute on function public.trip_fp(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------
-- Sign-in gate: inactive people cannot be linked to a new sign-in
-- ---------------------------------------------------------------
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  em text := lower(new.email);
  dom text := split_part(lower(new.email), '@', 2);
  existing public.people%rowtype;
begin
  select * into existing from public.people where lower(email) = em;
  if existing.id is null and not exists (select 1 from public.allowed_domains where domain = dom) then
    raise exception 'This email address is not allowed to sign in to the MBS Travel Diary';
  end if;
  if existing.id is not null then
    if not existing.active then
      raise exception 'This email address is not allowed to sign in to the MBS Travel Diary';
    end if;
    update public.people set user_id = new.id where id = existing.id and user_id is null;
  else
    insert into public.people (user_id, email, full_name)
    values (new.id, em, coalesce(new.raw_user_meta_data ->> 'full_name', initcap(replace(split_part(em, '@', 1), '.', ' '))));
  end if;
  return new;
end $$;

-- ---------------------------------------------------------------
-- Row level security: people
-- ---------------------------------------------------------------
drop policy if exists people_read on public.people;
create policy people_read on public.people for select to authenticated
  using (public.my_person_id() is not null and (public.sees_all() or user_id = auth.uid()));

-- Arrangers add ordinary travellers only, with no sign-in link. Admins add any role, still with no link
-- (a link is made only by the person signing in).
drop policy if exists people_insert on public.people;
create policy people_insert on public.people for insert to authenticated
  with check (
    public.my_person_id() is not null
    and user_id is null
    and (public.my_role() = 'admin' or (public.my_role() = 'arranger' and role = 'traveller'))
  );

-- Edits. Anyone may edit their own row (mobile and name only). Arrangers may edit ordinary travellers.
-- Admins may edit anyone. Nobody changes a sign-in link, nobody changes the email of a linked account,
-- only an admin changes a role, and nobody deactivates their own account.
drop policy if exists people_update on public.people;
create policy people_update on public.people for update to authenticated
  using (
    public.my_person_id() is not null
    and (user_id = auth.uid() or public.my_role() = 'admin' or (public.my_role() = 'arranger' and role = 'traveller'))
  )
  with check (
    (select p.user_id from public.people p where p.id = people.id) is not distinct from user_id
    and ((select p.user_id from public.people p where p.id = people.id) is null
         or (select p.email from public.people p where p.id = people.id) is not distinct from email)
    and not (user_id = auth.uid() and not active)
    and (
      public.my_role() = 'admin'
      or (
        (select p.role from public.people p where p.id = people.id) = role
        and (
          (public.my_role() = 'arranger' and (select p.role from public.people p where p.id = people.id) = 'traveller')
          or (select row(p.email, p.kind, p.cost_centre, p.manager_email, p.active) from public.people p where p.id = people.id)
             is not distinct from row(email, kind, cost_centre, manager_email, active)
        )
      )
    )
  );

-- ---------------------------------------------------------------
-- Row level security: trips and decisions (inactive people read nothing)
-- ---------------------------------------------------------------
drop policy if exists trips_read on public.trips;
create policy trips_read on public.trips for select to authenticated
  using (public.my_person_id() is not null
         and (public.sees_all() or traveller_id = public.my_person_id() or entered_by = public.my_person_id()
              or lower(manager_email) = public.my_email()));

drop policy if exists decisions_read on public.trip_decisions;
create policy decisions_read on public.trip_decisions for select to authenticated
  using (public.my_person_id() is not null
         and (public.sees_all() or exists (select 1 from public.trips t where t.id = trip_id)));

-- ---------------------------------------------------------------
-- people_directory: names for everyone, only to active users
-- ---------------------------------------------------------------
create or replace function public.people_directory()
returns table (id uuid, full_name text, kind text, cost_centre text, active boolean, email text)
language sql stable security definer set search_path = public as $$
  select p.id, p.full_name, p.kind, p.cost_centre, p.active,
         case when p.role in ('manager', 'admin')
                or exists (select 1 from public.people m where lower(m.manager_email) = lower(p.email))
              then p.email end
  from public.people p
  where public.my_person_id() is not null;
$$;

-- ---------------------------------------------------------------
-- A change of line manager on the staff record moves the trips with it:
-- waiting trips go to the new manager, and upcoming approved trips return for approval.
-- ---------------------------------------------------------------
create or replace function public.people_manager_changed() returns trigger
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  if lower(coalesce(new.manager_email, '')) is distinct from lower(coalesce(old.manager_email, '')) then
    update public.trips set manager_email = lower(new.manager_email), version = version + 1
      where traveller_id = new.id and status = 'submitted';
    for r in select id, version from public.trips where traveller_id = new.id and status = 'approved' and end_date >= current_date loop
      update public.trips set manager_email = lower(new.manager_email), status = 'submitted',
        approved_by = null, approved_at = null, version = version + 1 where id = r.id;
      insert into public.trip_decisions (trip_id, event, by_email, by_name, comment, trip_version)
      values (r.id, 'Returned for approval', public.my_email(), (select full_name from public.people where id = public.my_person_id()),
              'Line manager on the staff record changed', r.version + 1);
    end loop;
  end if;
  return new;
end $$;
drop trigger if exists people_manager_changed on public.people;
create trigger people_manager_changed after update of manager_email on public.people
  for each row execute function public.people_manager_changed();

-- ---------------------------------------------------------------
-- save_trip
-- ---------------------------------------------------------------
create or replace function public.save_trip(p jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := public.my_person_id();
  v_me_email text := public.my_email();
  v_me_name text;
  v_priv boolean := public.my_role() in ('arranger', 'admin');
  v_id uuid := nullif(p ->> 'id', '')::uuid;
  v_trav uuid := nullif(p ->> 'traveller_id', '')::uuid;
  v_trav_email text;
  v_mgr text;
  v_old public.trips%rowtype;
  v_start date; v_end date; v_span int;
  v_max_level int := 0;
  v_status text;
  v_reasons text[] := '{}';
  v_days jsonb := '[]'::jsonb;
  v_l3 jsonb := '[]'::jsonb;
  v_l3_countries text[] := '{}';
  v_in jsonb; v_prev jsonb;
  v_country text; v_adv public.advice_levels%rowtype; v_dstatus text; v_note text;
  v_ref text; v_date date; c text;
  v_fp text;
  d jsonb; s jsonb; i int := 0;
begin
  if v_me is null then raise exception 'You are not signed in to an active person record'; end if;
  if v_trav is null then raise exception 'A traveller is required'; end if;
  select lower(email), lower(nullif(trim(manager_email), '')) into v_trav_email, v_mgr from public.people where id = v_trav;
  if not found then raise exception 'Traveller not found'; end if;
  select full_name into v_me_name from public.people where id = v_me;

  if nullif(trim(p ->> 'purpose'), '') is null then raise exception 'A purpose is required'; end if;
  if nullif(trim(p ->> 'cost_centre'), '') is null then raise exception 'A cost centre is required'; end if;
  v_start := (p ->> 'start_date')::date; v_end := (p ->> 'end_date')::date;
  if v_start is null or v_end is null or v_end < v_start then raise exception 'The first and last day away are needed, and the last day cannot be before the first'; end if;
  v_span := v_end - v_start + 1;
  if v_span > 120 then raise exception 'A trip can cover at most 120 days. Enter longer absences as separate trips.'; end if;

  if v_id is not null then
    select * into v_old from public.trips where id = v_id;
    if v_old.id is null then raise exception 'Trip not found'; end if;
    if not (v_old.traveller_id = v_me or v_old.entered_by = v_me or v_priv) then
      raise exception 'You do not have access to this trip';
    end if;
    if v_trav <> v_old.traveller_id and not v_priv then
      raise exception 'Only an arranger or admin can change who is travelling';
    end if;
    if (p ->> 'version') is null or (p ->> 'version')::int <> v_old.version then
      raise exception 'This trip was changed by someone else after you opened it. Reload it and make your changes again.';
    end if;
  elsif v_trav <> v_me and not v_priv then
    raise exception 'Only an arranger or admin can enter a trip for someone else';
  end if;

  if v_mgr is not null and v_mgr = v_trav_email then
    raise exception 'The line manager on the staff record is the traveller. Ask an arranger to correct the line manager on the People page.';
  end if;

  -- one entry for every date, no more
  if jsonb_array_length(coalesce(p -> 'days', '[]'::jsonb)) <> v_span
     or (select count(distinct (dd ->> 'day_date')::date) from jsonb_array_elements(coalesce(p -> 'days', '[]'::jsonb)) dd
         where (dd ->> 'day_date')::date between v_start and v_end) <> v_span then
    raise exception 'Every date from the first day away to the last needs exactly one entry (% days expected).', v_span;
  end if;

  -- resolve each day's destination
  for d in select * from jsonb_array_elements(p -> 'days') loop
    v_country := nullif(trim(d ->> 'country'), '');
    if v_country is null then raise exception 'A country is needed for every day (missing on %)', d ->> 'day_date'; end if;
    v_note := nullif(trim(d ->> 'review_note'), '');
    select * into v_adv from public.advice_levels where lower(country) = lower(v_country);
    if found then
      v_dstatus := 'listed'; v_country := v_adv.country; v_note := null;
      v_max_level := greatest(v_max_level, v_adv.level);
      if v_adv.level = 3 and not (v_adv.country = any (v_l3_countries)) then v_l3_countries := array_append(v_l3_countries, v_adv.country); end if;
    elsif lower(v_country) = 'australia' then
      v_dstatus := 'domestic'; v_country := 'Australia'; v_note := null;
    elsif v_priv and v_note is not null then
      v_dstatus := 'reviewed';
    else
      raise exception 'Destination not recognised: "%" on %. Pick the country from the list. An arranger can mark a place that is not on the list as manually reviewed.', v_country, d ->> 'day_date';
    end if;
    v_days := v_days || jsonb_build_array(d || jsonb_build_object('country', v_country, 'dest_status', v_dstatus, 'review_note', v_note));
  end loop;

  if v_max_level = 4 then
    raise exception 'MBS policy does not permit travel to a destination where Smartraveller advises do not travel.';
  end if;

  -- Level 3: a dated reference to written Dean permission for each Level 3 destination
  foreach c in array v_l3_countries loop
    select e into v_in from jsonb_array_elements(coalesce(p -> 'level3', '[]'::jsonb)) e where lower(e ->> 'country') = lower(c) limit 1;
    v_ref := nullif(trim(v_in ->> 'ref'), '');
    begin v_date := nullif(v_in ->> 'date', '')::date; exception when others then v_date := null; end;
    if v_in is null or v_ref is null or v_date is null then
      raise exception '% is a Level 3 destination. Enter the date and a reference to the Dean''s written permission for it.', c;
    end if;
    select e into v_prev from jsonb_array_elements(coalesce(v_old.level3, '[]'::jsonb)) e
      where lower(e ->> 'country') = lower(c) and e ->> 'ref' = v_ref and (e ->> 'date')::date = v_date limit 1;
    v_l3 := v_l3 || jsonb_build_array(jsonb_build_object('country', c, 'date', v_date, 'ref', v_ref,
      'entered_by', coalesce(v_prev ->> 'entered_by', v_me_email), 'entered_by_name', coalesce(v_prev ->> 'entered_by_name', v_me_name)));
  end loop;

  v_status := coalesce(v_old.status, 'submitted');
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
      manager_declared, manager_declared_date, dean_permission, dean_permission_date, level3, status)
    values (v_trav, v_me, trim(p ->> 'purpose'), p ->> 'cost_centre', v_start, v_end, v_mgr,
      coalesce((p ->> 'manager_declared')::boolean, false), nullif(p ->> 'manager_declared_date', '')::date,
      jsonb_array_length(v_l3) > 0, (select min((e ->> 'date')::date) from jsonb_array_elements(v_l3) e), v_l3, 'submitted')
    returning id into v_id;
  else
    update public.trips set
      traveller_id = v_trav,
      purpose = trim(p ->> 'purpose'), cost_centre = p ->> 'cost_centre',
      start_date = v_start, end_date = v_end,
      manager_email = v_mgr,
      manager_declared = coalesce((p ->> 'manager_declared')::boolean, false),
      manager_declared_date = nullif(p ->> 'manager_declared_date', '')::date,
      dean_permission = jsonb_array_length(v_l3) > 0,
      dean_permission_date = (select min((e ->> 'date')::date) from jsonb_array_elements(v_l3) e),
      level3 = v_l3,
      status = v_status,
      approved_by = case when v_status = 'submitted' then null else approved_by end,
      approved_at = case when v_status = 'submitted' then null else approved_at end,
      version = version + 1
    where id = v_id;
    delete from public.trip_days where trip_id = v_id;
    delete from public.trip_segments where trip_id = v_id;
  end if;

  for d in select * from jsonb_array_elements(v_days) loop
    insert into public.trip_days (trip_id, day_date, city, country, day_type, activities, qualifies, allowance, dest_status, review_note)
    values (v_id, (d ->> 'day_date')::date, d ->> 'city', d ->> 'country', coalesce(d ->> 'day_type', 'Working'),
            d ->> 'activities', coalesce((d ->> 'qualifies')::boolean, false), coalesce((d ->> 'allowance')::boolean, false),
            d ->> 'dest_status', d ->> 'review_note');
  end loop;
  for s in select * from jsonb_array_elements(coalesce(p -> 'segments', '[]'::jsonb)) loop
    i := i + 1;
    insert into public.trip_segments (trip_id, kind, carrier, flight_number, origin, destination, seg_date,
      property, city, country, checkin, checkout, paid_by_mbs, sort_order)
    values (v_id, s ->> 'kind', s ->> 'carrier', s ->> 'flight_number', s ->> 'origin', s ->> 'destination',
      nullif(s ->> 'seg_date', '')::date, s ->> 'property', s ->> 'city', s ->> 'country',
      nullif(s ->> 'checkin', '')::date, nullif(s ->> 'checkout', '')::date, (s ->> 'paid_by_mbs')::boolean, i);
  end loop;

  -- an approved trip returns to the queue only if a fact the approval covered has changed
  if v_old.status = 'approved' then
    v_fp := public.trip_fp(v_id);
    if v_fp is distinct from v_old.approved_fp then
      update public.trips set status = 'submitted', approved_by = null, approved_at = null where id = v_id;
      insert into public.trip_decisions (trip_id, event, by_email, by_name, comment, trip_version)
      values (v_id, 'Returned for approval', v_me_email, v_me_name,
              'A detail covered by the approval changed (traveller, line manager, dates, destinations, business, remote or leave days, or Level 3 evidence)',
              v_old.version + 1);
    end if;
  end if;
  return v_id;
end $$;

-- ---------------------------------------------------------------
-- approve_trip: only a trip waiting for a decision, at the version the decider saw.
-- ---------------------------------------------------------------
drop function if exists public.approve_trip(uuid, text, text);
create or replace function public.approve_trip(p_trip uuid, p_decision text, p_comment text, p_version int) returns void
language plpgsql security definer set search_path = public as $$
declare
  t public.trips%rowtype;
  v_me uuid := public.my_person_id();
  v_trav_email text;
  v_trav_mgr text;
  v_level int;
  v_name text;
  c text;
begin
  if v_me is null then raise exception 'You are not signed in to an active person record'; end if;
  select * into t from public.trips where id = p_trip;
  if t.id is null then raise exception 'Trip not found'; end if;
  select lower(email), lower(nullif(trim(manager_email), '')) into v_trav_email, v_trav_mgr from public.people where id = t.traveller_id;
  if not (v_trav_mgr = public.my_email() or public.my_role() = 'admin') then
    raise exception 'Only the line manager on the traveller''s staff record, or an admin, can decide this trip';
  end if;
  if t.traveller_id = v_me or coalesce(v_trav_email, '') = public.my_email() then
    raise exception 'You cannot approve or decline your own trip';
  end if;
  if p_decision not in ('approved', 'declined') then raise exception 'Decision must be approved or declined'; end if;
  if t.status <> 'submitted' then raise exception 'This trip is not waiting for a decision'; end if;
  if p_version is null or p_version <> t.version then
    raise exception 'This trip changed after you opened it. Review the latest version before deciding.';
  end if;

  select coalesce(max(a.level), 0) into v_level
    from public.trip_days d join public.advice_levels a on lower(a.country) = lower(d.country)
    where d.trip_id = p_trip and d.dest_status = 'listed';

  if p_decision = 'approved' then
    if exists (select 1 from public.trip_days where trip_id = p_trip and dest_status = 'unresolved') then
      raise exception 'This trip has a destination that is not recognised. Ask the traveller or an arranger to correct it before approval.';
    end if;
    if v_level = 4 then
      raise exception 'Smartraveller now advises do not travel for a destination on this trip. It cannot be approved.';
    end if;
    for c in select distinct a.country from public.trip_days d join public.advice_levels a on lower(a.country) = lower(d.country)
             where d.trip_id = p_trip and d.dest_status = 'listed' and a.level = 3 loop
      if not exists (select 1 from jsonb_array_elements(t.level3) e where lower(e ->> 'country') = lower(c)) then
        raise exception '% is now a Level 3 destination and the trip has no reference to the Dean''s written permission for it.', c;
      end if;
    end loop;
  end if;

  select full_name into v_name from public.people where id = v_me;
  update public.trips set status = p_decision, approval_comment = p_comment,
    approved_by = public.my_email(), approved_at = now(),
    approved_level = case when p_decision = 'approved' then v_level else approved_level end,
    approved_fp = case when p_decision = 'approved' then public.trip_fp(p_trip) else approved_fp end,
    version = version + 1
  where id = p_trip;
  insert into public.trip_decisions (trip_id, event, by_email, by_name, comment, trip_version, level)
  values (p_trip, case when p_decision = 'approved' then 'Approved' else 'Declined' end, public.my_email(), v_name, p_comment, t.version + 1, v_level);
end $$;

-- ---------------------------------------------------------------
-- Existing rows
-- ---------------------------------------------------------------
update public.trip_days d set dest_status = 'listed'
  where dest_status = 'unresolved' and exists (select 1 from public.advice_levels a where lower(a.country) = lower(d.country));
update public.trip_days set dest_status = 'domestic' where dest_status = 'unresolved' and lower(trim(country)) = 'australia';

update public.trips t set level3 = coalesce((
    select jsonb_agg(jsonb_build_object('country', x.c, 'date', t.dean_permission_date, 'ref', 'Declared before references were recorded', 'entered_by', 'unknown'))
    from (select distinct a.country as c from public.trip_days d join public.advice_levels a on lower(a.country) = lower(d.country)
          where d.trip_id = t.id and a.level = 3) x), '[]'::jsonb)
  where t.dean_permission and t.level3 = '[]'::jsonb;

update public.trips set approved_fp = public.trip_fp(id) where status = 'approved' and approved_fp is null;

-- ---------------------------------------------------------------
-- Permissions
-- ---------------------------------------------------------------
revoke execute on function public.save_trip(jsonb) from public, anon;
revoke execute on function public.approve_trip(uuid, text, text, int) from public, anon;
revoke execute on function public.people_directory() from public, anon;
grant execute on function public.save_trip(jsonb) to authenticated;
grant execute on function public.approve_trip(uuid, text, text, int) to authenticated;
grant execute on function public.people_directory() to authenticated;

insert into public.schema_migrations (name) values ('update-2026-11-review-fixes') on conflict do nothing;
