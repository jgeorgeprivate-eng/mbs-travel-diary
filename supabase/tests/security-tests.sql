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

create or replace function t.payload(trav text, country text, mgr text, dean boolean default false, trip text default null)
returns jsonb language sql as $$
  select jsonb_build_object('id', trip, 'traveller_id', current_setting('test.p_' || trav), 'purpose', 'Test trip', 'cost_centre', 'Marketing',
    'start_date', '2026-12-01', 'end_date', '2026-12-03', 'manager_email', mgr, 'dean_permission', dean,
    'days', jsonb_build_array(jsonb_build_object('day_date', '2026-12-01', 'country', country, 'day_type', 'Travel')))
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
select t.attempt('amy: names herself as line manager', format($q$select save_trip(t.payload('amy','Singapore','amy@mbs.edu'))$q$), false);
select t.attempt('amy: approve her own trip', format($q$select approve_trip(%L,'approved',null)$q$, current_setting('test.trip_amy')), false);
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
select t.attempt('mgr: approve amy''s trip (named manager)', format($q$select approve_trip(%L,'approved','ok')$q$, current_setting('test.trip_amy')), true);
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
select t.attempt('dean: approve her own trip', format($q$select approve_trip(%L,'approved',null)$q$, current_setting('test.trip_dean')), false);
select t.attempt('dean: names herself as line manager', format($q$select save_trip(t.payload('dean','Singapore','dean@mbs.edu', false, %L))$q$, current_setting('test.trip_dean')), false);
select t.count_is('dean: reads the audit log', 'select * from trip_audit', 2);
select t.attempt('dean: delete amy''s trip as admin', format($q$select delete_trip(%L)$q$, current_setting('test.trip_amy')), true);
reset role;
select t.as_user('andrew'); set role authenticated;
select t.count_is('andrew: sees the Dean''s trip as named manager', format($q$select * from trips where id=%L$q$, current_setting('test.trip_dean')), 1);
select t.attempt('andrew: approves the Dean''s trip', format($q$select approve_trip(%L,'approved','ok')$q$, current_setting('test.trip_dean')), true);
select t.count_is('andrew: cannot see the audit log', 'select * from trip_audit', 0);
reset role;
select t.count_is('audit: admin delete of amy''s trip is logged', $q$select * from trip_audit where action='Deleted'$q$, 1);

-- ================= signed out =================
set role anon;
select t.attempt('anon: save_trip', format($q$select save_trip(t.payload('amy','Singapore','mgr@mbs.edu'))$q$), false);
select t.attempt('anon: read people', 'select * from people', false);
select t.attempt('anon: people_directory', 'select * from people_directory()', false);
reset role;
