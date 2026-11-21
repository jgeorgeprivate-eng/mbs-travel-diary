-- MBS Travel Diary security update, part 2 of 2: lock down direct access.
-- Run this only AFTER part 1 has been run and the new app version is live, because the
-- previous app version deletes trips and reads the whole people table directly.
-- Safe to run twice.

-- ---------------------------------------------------------------
-- Trips, days and segments can no longer be written directly through the API.
-- All writes go through save_trip, delete_trip and approve_trip.
-- ---------------------------------------------------------------
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
