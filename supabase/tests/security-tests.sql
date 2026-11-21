-- MBS Travel Diary: security tests for the database rules.
-- Runs on plain Postgres 16 after local-stub.sql and schema.sql (set YOUR_ADMIN_EMAIL to dean@mbs.edu, comment out the pg_cron and
-- pg_net extension lines in schema.sql when running locally). Not for use on the live project:
-- it creates test users and trips.
-- Output: one NOTICE per case, "PASS" or "FAIL". Every line should say PASS.
--   psql -f local-stub.sql -f ../schema.sql -f security-tests.sql 2>&1 | grep -E "PASS|FAIL"

create schema if not exists t;
grant usage on schema t to authenticated, anon;

-- t.attempt: run one statement as the current role. expect_ok = true means it must succeed.
create or replace function t.attempt(label text, stmt text, expect_ok boolean) returns void
language plpgsql as $$
begin
  begin
    execute stmt;
    if expect_ok then raise notice 'PASS  %', label; else raise notice 'FAIL  % (was allowed)', label; end if;
  exception when others then
    if expect_ok then raise notice 'FAIL  % (blocked: %)', label, sqlerrm; else raise notice 'PASS  % (blocked: %)', label, sqlerrm; end if;
  end;
end $$;

-- t.updated: run an update and require exactly n rows to change (0 when the rules hide the row).
create or replace function t.updated(label text, stmt text, n int) returns void
language plpgsql as $$
declare c int;
begin
  begin
    execute stmt; get diagnostics c = row_count;
    if c = n then raise notice 'PASS  % (% rows changed)', label, c; else raise notice 'FAIL  % (% rows changed, expected %)', label, c, n; end if;
  exception when others then
    if n = 0 then raise notice 'PASS  % (blocked: %)', label, sqlerrm; else raise notice 'FAIL  % (blocked: %)', label, sqlerrm; end if;
  end;
end $$;

-- t.count_is: a query must return exactly n rows.
create or replace function t.count_is(label text, q text, n int) returns void
language plpgsql as $$
declare c int;
begin
  execute 'select count(*) from (' || q || ') x' into c;
  if c = n then raise notice 'PASS  % (%)', label, c; else raise notice 'FAIL  % (got %, expected %)', label, c, n; end if;
end $$;

create or replace function t.as_user(u text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', (select id::text from auth.users where email = u || '@mbs.edu'), false);
  perform set_config('request.jwt.claim.email', u || '@mbs.edu', false);
end $$;

create or replace function t.ver(trip text) returns int language sql security definer as $$ select version from public.trips where id = trip::uuid $$;
-- t.payload_r: a trip payload covering every date from s to e in one country (or the day list given).
create or replace function t.payload_r(trav text, country text, s date, e date, trip text default null, l3 jsonb default '[]'::jsonb)
returns jsonb language sql security definer as $$
  select jsonb_build_object('id', trip, 'version', (select version from public.trips where id = trip::uuid), 'traveller_id', current_setting('test.p_' || trav),
    'purpose', 'Test trip', 'cost_centre', 'Marketing', 'start_date', s, 'end_date', e, 'manager_email', 'ignored@mbs.edu', 'level3', l3,
    'days', (select jsonb_agg(jsonb_build_object('day_date', g::date, 'country', country, 'city', 'X', 'day_type', 'Working', 'qualifies', true, 'activities', 'work') order by g) from generate_series(s, e, '1 day') g))
$$;
create or replace function t.payload(trav text, country text, mgr text, dean boolean default false, trip text default null)
returns jsonb language sql security definer as $$
  select t.payload_r(trav, country, '2026-12-01', '2026-12-03', trip,
    case when dean then jsonb_build_array(jsonb_build_object('country', country, 'date', '2026-11-10', 'ref', 'Email from the Dean, 10 Nov')) else '[]'::jsonb end)
$$;
grant execute on all functions in schema t to authenticated, anon;

-- ---- fixtures (run as the database owner) ----
insert into public.advice_levels (country, level, label) values ('Singapore',1,'x'),('Mexico',2,'x'),('Israel',3,'x'),('Syria',4,'x') on conflict do nothing;
insert into auth.users (id, email) values
  (gen_random_uuid(), 'dean@mbs.edu'), (gen_random_uuid(), 'amy@mbs.edu'), (gen_random_uuid(), 'bob@mbs.edu'),
  (gen_random_uuid(), 'ea@mbs.edu'), (gen_random_uuid(), 'mgr@mbs.edu'), (gen_random_uuid(), 'andrew@mbs.edu');
update public.people set role = 'admin'    where email = 'dean@mbs.edu';
update public.people set role = 'arranger' where email = 'ea@mbs.edu';
update public.people set role = 'manager'  where email = 'mgr@mbs.edu';
update public.people set mobile = '04' || lpad((abs(hashtext(email)) % 100000000)::text, 8, '0');
update public.people set manager_email = 'andrew@mbs.edu' where email = 'dean@mbs.edu';
update public.people set manager_email = 'mgr@mbs.edu' where email in ('amy@mbs.edu','bob@mbs.edu');
select set_config('test.p_' || split_part(email,'@',1), id::text, false) from public.people;
select set_config('test.u_' || split_part(email,'@',1), id::text, false) from auth.users;

-- ================= ordinary traveller (amy) =================
select t.as_user('amy'); set role authenticated;
select t.attempt('amy: direct insert into trips', format($q$insert into trips (traveller_id, entered_by, purpose, start_date, end_date, status, approved_by) values (%L,%L,'x','2026-12-01','2026-12-02','approved','amy@mbs.edu')$q$, current_setting('test.p_amy'), current_setting('test.p_amy')), false);
select t.attempt('amy: save_trip own trip (Singapore)', format($q$select save_trip(t.payload('amy','Singapore','mgr@mbs.edu'))$q$), true);
select set_config('test.trip_amy', (select id::text from trips where traveller_id = current_setting('test.p_amy')::uuid limit 1), false);
select t.attempt('amy: direct update of own trip status', format($q$update trips set status='approved', approved_by='boss@mbs.edu' where id=%L$q$, current_setting('test.trip_amy')), false);
select t.attempt('amy: direct delete of own trip', format($q$delete from trips where id=%L$q$, current_setting('test.trip_amy')), false);
select t.attempt('amy: direct insert into trip_days', format($q$insert into trip_days (trip_id, day_date, country, day_type) values (%L,'2026-12-09','Syria','Travel')$q$, current_setting('test.trip_amy')), false);
select t.attempt('amy: direct insert into trip_segments', format($q$insert into trip_segments (trip_id, kind) values (%L,'flight')$q$, current_setting('test.trip_amy')), false);
select t.attempt('amy: save_trip for someone else', format($q$select save_trip(t.payload('bob','Singapore','mgr@mbs.edu'))$q$), false);
select t.attempt('amy: save_trip to level 4 country', format($q$select save_trip(t.payload('amy','Syria','mgr@mbs.edu'))$q$), false);
select t.attempt('amy: save_trip level 3 without Dean permission', format($q$select save_trip(t.payload('amy','Israel','mgr@mbs.edu'))$q$), false);
select t.attempt('amy: save_trip level 3 with Dean permission', format($q$select save_trip(t.payload('amy','Israel','mgr@mbs.edu', true))$q$), true);
select t.attempt('amy: approve her own trip', format($q$select approve_trip(%L,'approved',null,t.ver(%L))$q$, current_setting('test.trip_amy'), current_setting('test.trip_amy')), false);
select t.count_is('amy: people table shows only her own row', 'select * from people', 1);
select t.count_is('amy: people_directory lists everyone', 'select * from people_directory()', 6);
select t.count_is('amy: directory shows email only for managers, admins, named line managers', 'select * from people_directory() where email is not null', 3);
select t.updated('amy: update own mobile', format($q$update people set mobile='0400000000' where id=%L$q$, current_setting('test.p_amy')), 1);
select t.attempt('amy: change own email', format($q$update people set email='someone.else@mbs.edu' where id=%L$q$, current_setting('test.p_amy')), false);
select t.attempt('amy: change own cost centre', format($q$update people set cost_centre='Other' where id=%L$q$, current_setting('test.p_amy')), false);
select t.attempt('amy: change own line manager', format($q$update people set manager_email='x@mbs.edu' where id=%L$q$, current_setting('test.p_amy')), false);
select t.attempt('amy: change own role', format($q$update people set role='admin' where id=%L$q$, current_setting('test.p_amy')), false);
select t.attempt('amy: change own sign-in link', format($q$update people set user_id=%L where id=%L$q$, current_setting('test.u_bob'), current_setting('test.p_amy')), false);
select t.updated('amy: update bob''s row', format($q$update people set mobile='1' where id=%L$q$, current_setting('test.p_bob')), 0);
select t.count_is('amy: audit log is hidden', 'select * from trip_audit', 0);
select t.attempt('amy: insert into audit log', $q$insert into trip_audit (trip_id, action, reason) values (gen_random_uuid(),'Edited','x')$q$, false);
reset role;

-- ================= second traveller (bob) =================
select t.as_user('bob'); set role authenticated;
select t.attempt('bob: save_trip own trip', format($q$select save_trip(t.payload('bob','Mexico','mgr@mbs.edu'))$q$), true);
select set_config('test.trip_bob', (select id::text from trips where traveller_id = current_setting('test.p_bob')::uuid limit 1), false);
reset role;
select t.as_user('amy'); set role authenticated;
select t.attempt('amy: edit bob''s trip', format($q$select save_trip(t.payload('bob','Singapore','mgr@mbs.edu', false, %L))$q$, current_setting('test.trip_bob')), false);
select t.attempt('amy: delete bob''s trip', format($q$select delete_trip(%L)$q$, current_setting('test.trip_bob')), false);
select t.count_is('amy: cannot see bob''s trips', format($q$select * from trips where id=%L$q$, current_setting('test.trip_bob')), 0);
reset role;

-- ================= arranger (ea) =================
select t.as_user('ea'); set role authenticated;
select t.attempt('ea: save_trip on behalf of amy', format($q$select save_trip(t.payload('amy','Singapore','mgr@mbs.edu', false, %L))$q$, current_setting('test.trip_amy')), true);
select t.attempt('ea: direct update of trips', format($q$update trips set status='approved' where id=%L$q$, current_setting('test.trip_amy')), false);
select t.count_is('ea: sees all people', 'select * from people', 6);
select t.updated('ea: edit bob''s cost centre on People', format($q$update people set cost_centre='Marketing' where id=%L$q$, current_setting('test.p_bob')), 1);
select t.attempt('ea: change a role', format($q$update people set role='admin' where id=%L$q$, current_setting('test.p_bob')), false);
select t.attempt('ea: change a sign-in link', format($q$update people set user_id=%L where id=%L$q$, current_setting('test.u_amy'), current_setting('test.p_bob')), false);
reset role;
select t.count_is('audit: ea edit of amy''s trip is logged', $q$select * from trip_audit where reason like 'Edited by someone other%'$q$, 1);

-- ================= manager (mgr) =================
select t.as_user('mgr'); set role authenticated;
select t.count_is('mgr: sees all people including mobiles', 'select * from people where mobile is not null', 6);
select t.updated('mgr: update someone else''s row', format($q$update people set mobile='2' where id=%L$q$, current_setting('test.p_bob')), 0);
select t.attempt('mgr: approve amy''s trip (named manager)', format($q$select approve_trip(%L,'approved','ok',t.ver(%L))$q$, current_setting('test.trip_amy'), current_setting('test.trip_amy')), true);
select t.attempt('mgr: direct delete of a trip', format($q$delete from trips where id=%L$q$, current_setting('test.trip_amy')), false);
reset role;
select t.count_is('approve: approved_level recorded', format($q$select * from trips where id=%L and status='approved' and approved_level = 1$q$, current_setting('test.trip_amy')), 1);

-- ===== approved trip moves to a different rating: logged =====
select t.as_user('amy'); set role authenticated;
select t.attempt('amy: edits approved trip to a level 2 country', format($q$select save_trip(t.payload('amy','Mexico','mgr@mbs.edu', false, %L))$q$, current_setting('test.trip_amy')), true);
reset role;
select t.count_is('audit: rating change after approval is logged', $q$select * from trip_audit where reason like '%rating changed after approval, from Level 1 to Level 2%'$q$, 1);

-- ================= the Dean (admin) and Andrew =================
select t.as_user('dean'); set role authenticated;
select t.attempt('dean: save_trip own trip, Andrew as manager', format($q$select save_trip(t.payload('dean','Singapore','andrew@mbs.edu'))$q$), true);
select set_config('test.trip_dean', (select id::text from trips where traveller_id = current_setting('test.p_dean')::uuid limit 1), false);
select t.attempt('dean: approve her own trip', format($q$select approve_trip(%L,'approved',null,t.ver(%L))$q$, current_setting('test.trip_dean'), current_setting('test.trip_dean')), false);
select t.count_is('dean: reads the audit log', 'select * from trip_audit', 2);
select t.attempt('dean: delete amy''s trip as admin', format($q$select delete_trip(%L)$q$, current_setting('test.trip_amy')), true);
reset role;
select t.as_user('andrew'); set role authenticated;
select t.count_is('andrew: sees the Dean''s trip as named manager', format($q$select * from trips where id=%L$q$, current_setting('test.trip_dean')), 1);
select t.attempt('andrew: approves the Dean''s trip', format($q$select approve_trip(%L,'approved','ok',t.ver(%L))$q$, current_setting('test.trip_dean'), current_setting('test.trip_dean')), true);
select t.count_is('andrew: cannot see the audit log', 'select * from trip_audit', 0);
reset role;
select t.count_is('audit: admin delete of amy''s trip is logged', $q$select * from trip_audit where action='Deleted'$q$, 1);

-- ================= signed out =================
set role anon;
select t.attempt('anon: save_trip', format($q$select save_trip(t.payload('amy','Singapore','mgr@mbs.edu'))$q$), false);
select t.attempt('anon: read people', 'select * from people', false);
select t.attempt('anon: people_directory', 'select * from people_directory()', false);
reset role;

-- =====================================================================
-- Review fixes (update 3)
-- =====================================================================
reset role;
-- fresh slate for the new scenarios
delete from public.trips;
update public.people set manager_email = 'mgr@mbs.edu' where email in ('amy@mbs.edu','bob@mbs.edu');
insert into public.advice_levels (country, level, label) values ('Egypt',3,'x') on conflict do nothing;
update public.advice_levels set level = 3 where country = 'Israel';
update public.advice_levels set level = 1 where country in ('Singapore');
update public.advice_levels set level = 2 where country = 'Mexico';

-- ---- 1. roles on creation and editing ----
select t.as_user('ea'); set role authenticated;
select t.attempt('ea: adds a contractor as ordinary traveller', $q$insert into people (full_name, kind, role) values ('Carl Contractor','contractor','traveller')$q$, true);
select t.attempt('ea: adds a person with admin role', $q$insert into people (full_name, kind, role) values ('Sneaky','staff','admin')$q$, false);
select t.attempt('ea: adds a person with manager role', $q$insert into people (full_name, kind, role) values ('Sneaky2','staff','manager')$q$, false);
select t.attempt('ea: adds a person already linked to a sign-in', format($q$insert into people (full_name, kind, role, user_id) values ('Linked','staff','traveller',%L)$q$, current_setting('test.u_amy')), false);
select t.attempt('ea: changes the email of a person linked to a sign-in', format($q$update people set email='redirected@mbs.edu' where id=%L$q$, current_setting('test.p_bob')), false);
select t.attempt('ea: changes the email of a contractor with no sign-in', $q$update people set email='carl@example.com' where full_name='Carl Contractor'$q$, true);
select t.updated('ea: cannot edit a manager''s row', format($q$update people set mobile='9' where id=%L$q$, current_setting('test.p_mgr')), 0);
select t.updated('ea: cannot edit the admin''s row', format($q$update people set manager_email='ea@mbs.edu' where id=%L$q$, current_setting('test.p_dean')), 0);
reset role;
select t.as_user('dean'); set role authenticated;
select t.attempt('admin: adds an arranger', $q$insert into people (full_name, kind, role) values ('New Arranger','staff','arranger')$q$, true);
select t.attempt('admin: adds a person with a sign-in link', format($q$insert into people (full_name, kind, role, user_id) values ('Linked2','staff','traveller',%L)$q$, current_setting('test.u_amy')), false);
select t.attempt('admin: deactivates her own account', format($q$update people set active=false where id=%L$q$, current_setting('test.p_dean')), false);
reset role;

-- ---- 6/9. destinations and day range ----
select t.as_user('amy'); set role authenticated;
select t.attempt('amy: one-day trip', format($q$select save_trip(t.payload_r('amy','Singapore','2027-01-05','2027-01-05'))$q$), true);
select t.attempt('amy: 120-day trip', format($q$select save_trip(t.payload_r('amy','Singapore','2027-02-01','2027-05-31'))$q$), true);
select t.attempt('amy: 121-day trip refused', format($q$select save_trip(t.payload_r('amy','Singapore','2027-02-01','2027-06-01'))$q$), false);
select t.attempt('amy: three-day trip with one day entered refused', format($q$select save_trip(jsonb_set(t.payload('amy','Singapore','x'),'{days}', (t.payload('amy','Singapore','x') -> 'days') - 0 - 0))$q$), false);
select t.attempt('amy: duplicate day entry refused', format($q$select save_trip(jsonb_set(t.payload('amy','Singapore','x'),'{days}', jsonb_build_array((t.payload('amy','Singapore','x') -> 'days' -> 0),(t.payload('amy','Singapore','x') -> 'days' -> 0),(t.payload('amy','Singapore','x') -> 'days' -> 2))))$q$), false);
select t.attempt('amy: unfamiliar country spelling refused', format($q$select save_trip(t.payload_r('amy','Singapor','2027-07-01','2027-07-02'))$q$), false);
select t.attempt('amy: two countries, one unfamiliar, refused', format($q$select save_trip(jsonb_set(t.payload('amy','Singapore','x'),'{days,2,country}','"Narnia"'))$q$), false);
select t.attempt('amy: Australia is accepted as domestic', format($q$select save_trip(t.payload_r('amy','australia','2027-07-01','2027-07-02'))$q$), true);
select t.attempt('amy: unlisted place with a review note refused (traveller)', format($q$select save_trip(jsonb_set(t.payload('amy','Singapore','x'),'{days,2}', (t.payload('amy','Singapore','x') -> 'days' -> 2) || '{"country":"Narnia","review_note":"checked"}'))$q$), false);
reset role;
select t.count_is('destinations: domestic day stored as domestic', $q$select * from trip_days where dest_status='domestic'$q$, 2);
select t.as_user('ea'); set role authenticated;
select t.attempt('ea: unlisted place with a review note accepted', format($q$select save_trip(jsonb_set(t.payload('amy','Singapore','x'),'{days,2}', (t.payload('amy','Singapore','x') -> 'days' -> 2) || '{"country":"Narnia","review_note":"Checked with the Dean, no advice"}'))$q$), true);
reset role;
select t.count_is('destinations: reviewed day stored', $q$select * from trip_days where dest_status='reviewed'$q$, 1);
select t.count_is('destinations: listed days are canonical', $q$select * from trip_days where dest_status='listed' and country='Singapore'$q$, 123);
delete from public.trips;

-- ---- 3. approver comes from the staff record ----
select t.as_user('amy'); set role authenticated;
select t.attempt('amy: saves trip naming someone else as approver in the request', format($q$select save_trip(jsonb_set(t.payload('amy','Singapore','x'),'{manager_email}','"bob@mbs.edu"'))$q$), true);
reset role;
select t.count_is('approver: request value ignored, staff record used', $q$select * from trips where traveller_id=(select id from people where email='amy@mbs.edu') and manager_email='mgr@mbs.edu'$q$, 1);
select set_config('test.trip_amy', (select id::text from trips limit 1), false);
select t.as_user('bob'); set role authenticated;
select t.attempt('bob: ordinary user cannot approve amy''s trip', format($q$select approve_trip(%L,'approved',null,t.ver(%L))$q$, current_setting('test.trip_amy'), current_setting('test.trip_amy')), false);
reset role;
update public.people set manager_email = null where email = 'bob@mbs.edu';
select t.as_user('bob'); set role authenticated;
select t.attempt('bob: trip with no approver on the staff record is saved', format($q$select save_trip(t.payload('bob','Singapore','x'))$q$), true);
reset role;
select t.count_is('approver: missing approver leaves manager_email empty for the arranger to see', $q$select * from trips where manager_email is null$q$, 1);
update public.people set manager_email = 'mgr@mbs.edu' where email = 'bob@mbs.edu';
select t.count_is('approver: restoring the staff record updates the waiting trip', $q$select * from trips where manager_email = 'mgr@mbs.edu' and traveller_id=(select id from people where email='bob@mbs.edu')$q$, 1);

-- ---- 5. versions ----
select t.as_user('mgr'); set role authenticated;
select t.attempt('mgr: decision with an old version refused', format($q$select approve_trip(%L,'approved',null,%s)$q$, current_setting('test.trip_amy'), t.ver(current_setting('test.trip_amy')) - 1), false);
select t.attempt('mgr: decision at the current version accepted', format($q$select approve_trip(%L,'approved','fine',t.ver(%L))$q$, current_setting('test.trip_amy'), current_setting('test.trip_amy')), true);
select t.attempt('mgr: second decision on a decided trip refused', format($q$select approve_trip(%L,'declined','late',t.ver(%L))$q$, current_setting('test.trip_amy'), current_setting('test.trip_amy')), false);
reset role;
select t.count_is('decisions: approval recorded', format($q$select * from trip_decisions where trip_id=%L and event='Approved' and by_email='mgr@mbs.edu'$q$, current_setting('test.trip_amy')), 1);
-- two editors: ea opens the trip, amy saves first, then the stale ea save is refused
select set_config('test.stale', (select jsonb_set(t.payload('amy','Singapore','x', false, current_setting('test.trip_amy')), '{purpose}', '"EA change"')::text), false);
select t.as_user('amy'); set role authenticated;
select t.attempt('amy: saves a purpose change (hotel-level change, same facts)', format($q$select save_trip(jsonb_set(t.payload('amy','Singapore','x', false, %L), '{purpose}', '"Amy change"'))$q$, current_setting('test.trip_amy')), true);
reset role;
select t.as_user('ea'); set role authenticated;
select t.attempt('ea: save from a stale screen refused', format($q$select save_trip(%L::jsonb)$q$, current_setting('test.stale')), false);
reset role;

-- ---- 4. material changes ----
select t.count_is('approval kept after a purpose-only change', format($q$select * from trips where id=%L and status='approved'$q$, current_setting('test.trip_amy')), 1);
select t.as_user('amy'); set role authenticated;
select t.attempt('amy: correcting a hotel name keeps the approval', format($q$select save_trip(t.payload('amy','Singapore','x', false, %L) || jsonb_build_object('segments', jsonb_build_array(jsonb_build_object('kind','stay','property','Hotel Splendid'))))$q$, current_setting('test.trip_amy')), true);
reset role;
select t.count_is('approval kept after a hotel change', format($q$select * from trips where id=%L and status='approved'$q$, current_setting('test.trip_amy')), 1);
select t.as_user('amy'); set role authenticated;
select t.attempt('amy: replaces a business day with leave', format($q$select save_trip(jsonb_set(t.payload('amy','Singapore','x', false, %L),'{days,1,day_type}','"Leave"'))$q$, current_setting('test.trip_amy')), true);
reset role;
select t.count_is('trip returned to approval after business day became leave', format($q$select * from trips where id=%L and status='submitted'$q$, current_setting('test.trip_amy')), 1);
select t.count_is('decisions: return to approval recorded', format($q$select * from trip_decisions where trip_id=%L and event='Returned for approval'$q$, current_setting('test.trip_amy')), 1);
select t.as_user('mgr'); set role authenticated;
select t.attempt('mgr: approves again', format($q$select approve_trip(%L,'approved',null,t.ver(%L))$q$, current_setting('test.trip_amy'), current_setting('test.trip_amy')), true);
reset role;
select t.count_is('decisions: earlier approval still attributable', format($q$select * from trip_decisions where trip_id=%L and event='Approved' and by_email='mgr@mbs.edu'$q$, current_setting('test.trip_amy')), 2);
select t.as_user('ea'); set role authenticated;
select t.attempt('ea: changes the traveller on an approved trip', format($q$select save_trip(jsonb_set(t.payload('amy','Singapore','x', false, %L) || jsonb_build_object('days', (select jsonb_agg(case when (x->>'day_date')='2026-12-02' then x || '{"day_type":"Leave"}'::jsonb else x end) from jsonb_array_elements(t.payload('amy','Singapore','x') -> 'days') x)),'{traveller_id}', to_jsonb(%L::text)))$q$, current_setting('test.trip_amy'), current_setting('test.p_bob')), true);
reset role;
select t.count_is('trip returned to approval after the traveller changed', format($q$select * from trips where id=%L and status='submitted' and traveller_id=%L$q$, current_setting('test.trip_amy'), current_setting('test.p_bob')), 1);
-- change of line manager on the staff record returns upcoming approved trips
select t.as_user('mgr'); set role authenticated;
select t.attempt('mgr: approves bob''s trip', format($q$select approve_trip(%L,'approved',null,t.ver(%L))$q$, current_setting('test.trip_amy'), current_setting('test.trip_amy')), true);
reset role;
update public.people set manager_email = 'andrew@mbs.edu' where email = 'bob@mbs.edu';
select t.count_is('staff record manager change returns approved upcoming trips', format($q$select * from trips where id=%L and status='submitted' and manager_email='andrew@mbs.edu'$q$, current_setting('test.trip_amy')), 1);

-- ---- 7. advice recheck at approval ----
update public.people set manager_email = 'mgr@mbs.edu' where email = 'bob@mbs.edu';
delete from public.trips;
select t.as_user('amy'); set role authenticated;
select t.attempt('amy: pending trip to Mexico', format($q$select save_trip(t.payload('amy','Mexico','x'))$q$), true);
reset role;
select set_config('test.trip_mx', (select id::text from trips limit 1), false);
update public.advice_levels set level = 4 where country = 'Mexico';
select t.as_user('mgr'); set role authenticated;
select t.attempt('mgr: approval refused after advice rose to Level 4', format($q$select approve_trip(%L,'approved',null,t.ver(%L))$q$, current_setting('test.trip_mx'), current_setting('test.trip_mx')), false);
select t.attempt('mgr: decline is still allowed', format($q$select approve_trip(%L,'declined','advice',t.ver(%L))$q$, current_setting('test.trip_mx'), current_setting('test.trip_mx')), true);
reset role;
update public.advice_levels set level = 2 where country = 'Mexico';

-- ---- 8. Level 3 evidence ----
delete from public.trips;
select t.as_user('amy'); set role authenticated;
select t.attempt('amy: Level 3 without reference refused', format($q$select save_trip(t.payload('amy','Israel','x'))$q$), false);
select t.attempt('amy: Level 3 with date but empty reference refused', format($q$select save_trip(t.payload_r('amy','Israel','2026-12-01','2026-12-03', null, '[{"country":"Israel","date":"2026-11-10","ref":""}]'))$q$), false);
select t.attempt('amy: Level 3 with date and reference accepted', format($q$select save_trip(t.payload('amy','Israel','x', true))$q$), true);
reset role;
select t.count_is('level 3: entry records who entered it', $q$select * from trips where level3 -> 0 ->> 'entered_by' = 'amy@mbs.edu'$q$, 1);
select set_config('test.trip_l3', (select id::text from trips limit 1), false);
select t.as_user('amy'); set role authenticated;
select t.attempt('amy: adds a second Level 3 country without evidence refused', format($q$select save_trip(jsonb_set(t.payload('amy','Israel','x', true, %L),'{days,2,country}','"Egypt"'))$q$, current_setting('test.trip_l3')), false);
reset role;
select t.as_user('ea'); set role authenticated;
select t.attempt('ea: edit keeps the original declarant', format($q$select save_trip(jsonb_set(t.payload('amy','Israel','x', true, %L),'{purpose}','"EA edit"'))$q$, current_setting('test.trip_l3')), true);
reset role;
select t.count_is('level 3: declarant not overwritten by the editor', $q$select * from trips where level3 -> 0 ->> 'entered_by' = 'amy@mbs.edu'$q$, 1);

-- ---- 2. inactive people ----
insert into public.trips (traveller_id, entered_by, purpose, start_date, end_date, manager_email)
  select id, id, 'Historic', '2026-12-01', '2026-12-02', 'mgr@mbs.edu' from public.people where email = 'amy@mbs.edu';
update public.people set active = false where email = 'mgr@mbs.edu';
select t.as_user('mgr'); set role authenticated;
select t.count_is('inactive manager: reads no trips', 'select * from trips', 0);
select t.count_is('inactive manager: reads no mobiles', 'select * from people', 0);
select t.count_is('inactive manager: directory is empty', 'select * from people_directory()', 0);
select t.attempt('inactive manager: cannot save a trip', format($q$select save_trip(t.payload('amy','Singapore','x'))$q$), false);
select t.attempt('inactive manager: cannot approve', format($q$select approve_trip(%L,'approved',null,1)$q$, current_setting('test.trip_l3')), false);
reset role;
select t.as_user('ea'); set role authenticated;
select t.count_is('arranger still reads the historical trip', $q$select * from trips where purpose='Historic'$q$, 1);
reset role;
select t.attempt('inactive person cannot be linked to a new sign-in', $q$insert into auth.users (id, email) select gen_random_uuid(), email from (values ('carl@example.com')) v(email)$q$, true);
update public.people set active = false where email = 'carl@example.com';
delete from auth.users where email = 'carl@example.com';
select t.attempt('inactive contractor cannot sign in', $q$insert into auth.users (id, email) values (gen_random_uuid(), 'carl@example.com')$q$, false);
update public.people set active = true where email = 'mgr@mbs.edu';
