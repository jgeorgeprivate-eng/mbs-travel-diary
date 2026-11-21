-- Minimal stand-ins for Supabase objects so the schema and tests run on plain Postgres 16.
-- Not for use on Supabase. Create roles first if missing: create role authenticated nologin; create role anon nologin;
create extension if not exists pgcrypto;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb default '{}'::jsonb);
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create or replace function auth.jwt() returns jsonb language sql stable as $$ select jsonb_build_object('email', current_setting('request.jwt.claim.email', true)) $$;
grant usage on schema public to authenticated; grant all on all tables in schema public to authenticated;
alter default privileges in schema public grant all on tables to authenticated;
