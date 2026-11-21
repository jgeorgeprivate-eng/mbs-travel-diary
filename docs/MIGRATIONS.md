# Database changes and deployment order

Every change to the database is a file in `supabase/`. Each file records itself in the `schema_migrations` table when it finishes, so you can see what a given database has had applied:

```sql
select name, applied_at from schema_migrations order by applied_at;
```

## New installation

1. Run `supabase/schema.sql` once. It already contains every change below. Replace `YOUR_ADMIN_EMAIL` first.
2. Fill in `config.js` (project URL and publishable key).
3. Publish the folder to GitHub Pages. The `vendor/` folder must be published with it, because the app loads supabase-js from there and not from a CDN.
4. Deploy the `smartraveller-sync` function (README, section 5) and run it once.
5. Run the tests (see below).

## Existing installation, in this order

| Order | File | Run when | Safe with the old app live? |
|---|---|---|---|
| 1 | `update-2026-11-audit-log.sql` | Once. Audit log and approval-level tracking | Yes |
| 2 | `update-2026-11-security-1-functions.sql` | Once. Controlled write functions, people directory | Yes |
| 3 | `update-2026-11-security-2-lockdown.sql` | After the app from step 2 is published | No. The old app writes to tables directly and stops working |
| 4 | `update-2026-11-review-fixes.sql` | Once. Roles, approver from staff record, versions, decision history, destinations, Level 3 evidence, day coverage | No. `approve_trip` takes a version number and `save_trip` requires one, so publish the new `app.js` and `rules.js` straight after |

Run step 4 and publish the new app within the same few minutes. People with the old page open need a hard refresh (Cmd+Shift+R).

Each file is safe to run twice. After running one, check `schema_migrations` shows its name.

## Confirm the final permissions

After step 4 and the new app are both live, confirm the lockdown held. In the SQL editor:

```sql
select grantee, table_name, privilege_type from information_schema.role_table_grants
where table_schema = 'public' and grantee in ('anon', 'authenticated')
  and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
order by table_name, grantee;
```

Expected: `authenticated` has INSERT or UPDATE only on `people`, where row level security limits it further. Nothing for `anon`. Nothing on `trips`, `trip_days`, `trip_segments`, `trip_decisions`, `advice_levels`.

## Smartraveller feed function

`supabase/functions/smartraveller-sync/index.ts` is the deployed code. It reads the secret key from `SUPABASE_SECRET_KEY` and falls back to `SUPABASE_SERVICE_ROLE_KEY`. After editing, redeploy from the dashboard (Edge Functions, smartraveller-sync, paste, Deploy). The response lists any country not refreshed.

## Tests

- Database rules: `supabase/tests/security-tests.sql` on a local Postgres (instructions in its header). 118 checks.
- Page rules: `node supabase/tests/rules-tests.js` from the repo root. 11 checks.
- Acceptance scenarios by hand: `TEST-PLAN.md`.
