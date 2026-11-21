-- MBS Travel Diary security update, part 1 of 2: controlled write paths.
-- Safe to run while the current app is live. Run it, deploy the new app, then run part 2.
-- Adds: save_trip with ownership checks (runs with the database's own privileges),
-- delete_trip, people_directory, and a rule against approving your own trip or naming
-- yourself as line manager. Safe to run twice.

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
