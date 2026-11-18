# MBS Travel Diary pilot

A travel diary and "where is everyone" dashboard for MBS staff and contractors. Static front end on GitHub Pages, data and sign-in on Supabase. No servers to run.

## What is in this folder

| File | Purpose |
|---|---|
| `index.html`, `styles.css`, `app.js` | The app. Upload these to GitHub. |
| `config.js` | Two values from your Supabase project. Edit, then upload with the app. |
| `supabase/schema.sql` | Creates the tables, access rules, policy checks and the daily job. Run once in Supabase. |
| `supabase/functions/smartraveller-sync/index.ts` | Reads the Smartraveller feed and stores each country's advice level. Deploy once in Supabase. |
| `TEST-PLAN.md` | What to try with the pilot group. |

Setup is about half an hour. Steps 1 to 4 get the app working; step 5 adds the Smartraveller colours.

## 1. Create the Supabase project (5 minutes)

1. Go to supabase.com, sign in (GitHub sign-in is fine) and choose **New project**.
2. Name: `mbs-travel-diary`. Region: **Sydney (ap-southeast-2)** so the data stays in Australia. Set a database password and keep it somewhere safe; you will not need it day to day.
3. When the project has finished setting up, open **Project Settings > API** (the gear icon). Copy the **Project URL** and the **anon public** key. You need both in step 3.

## 2. Create the database (5 minutes)

1. Open `supabase/schema.sql` in a text editor. Near the bottom, replace `YOUR_ADMIN_EMAIL` with your own MBS email address, keeping the quotes. That makes you the first admin.
2. If MBS staff email addresses are not `@mbs.edu`, change `'mbs.edu'` in the `allowed_domains` insert near the top.
3. In Supabase, open **SQL Editor > New query**, paste the whole file and press **Run**. It should finish with "Success".

If it stops with an error about `pg_cron` or `pg_net`, go to **Database > Extensions**, switch on **pg_cron** and **pg_net**, then run the file again.

## 3. Allow sign-in from your app address (5 minutes)

Magic-link sign-in works by emailing a link that returns the person to the app, so Supabase needs to know the app's address.

1. Decide the GitHub Pages address first. It will be `https://YOUR-GITHUB-USERNAME.github.io/YOUR-REPO-NAME/` (see step 4).
2. In Supabase open **Authentication > URL Configuration**. Set **Site URL** to that address and add the same address under **Redirect URLs**.
3. Under **Authentication > Providers**, Email should already be on. Leave "Confirm email" on.

**Email limits.** Supabase's built-in email sender is meant for testing and allows only a few sign-in emails per hour. Each pilot user needs one link per browser (they stay signed in afterwards), so onboarding a group of ten over a day works if they do not all try in the same ten minutes. If that is too tight, add your own sender under **Project Settings > Authentication > SMTP Settings**: a Gmail address with an app password works and needs no domain setup, as does Resend or Brevo if you have a domain.

## 4. Publish the app on GitHub Pages (10 minutes)

1. Open `config.js` and paste in the Project URL and anon key from step 1. The anon key is designed to be public; the database rules protect the data.
2. On github.com create a new repository (for example `mbs-travel-diary`). Public is fine, because the repository holds only the app code, never the data. Private also works if your GitHub plan allows Pages on private repositories.
3. Upload `index.html`, `styles.css`, `app.js` and `config.js` to the repository (Add file > Upload files).
4. Repository **Settings > Pages**: Source "Deploy from a branch", branch `main`, folder `/ (root)`. Save. After a minute the address shows at the top of that page. It should match what you entered in step 3.
5. Open the address, enter your MBS email, click the link in the email. You should land on the dashboard as admin.

To update the app later, upload the changed file again; Pages republishes in about a minute.

## 5. Smartraveller advice levels (10 minutes)

Until this runs, every country shows as "No Smartraveller advice found" and the policy checks cannot fire.

1. In Supabase open **Edge Functions > Deploy a new function > Via Editor** (if your dashboard has no editor, use the CLI instructions at the end of this file).
2. Name it exactly `smartraveller-sync`. Replace the sample code with the contents of `supabase/functions/smartraveller-sync/index.ts`. Deploy.
3. Test it: on the function's page use **Invoke** (or the "Test" button), send an empty `{}` body. The response should say something like `{"updated": 170, ...}`. Reload the app; countries now carry colours.
4. Schedule it daily: in `schema.sql`, the last block is commented out. Copy it, remove the leading `-- ` from each line, replace `YOUR_PROJECT_REF` with the part of your Project URL before `.supabase.co` and `YOUR_ANON_KEY` with the anon key, and run it in the SQL Editor. It runs at 03:30 Melbourne time each day.

The feed's format has changed before. If the test returns "Parsed only 0 countries", the function reports the first item it saw; send me that text and I will adjust the parser.

## 6. Set up the pilot group (10 minutes)

Staff sign in with any MBS address and appear on the **People** page automatically. Before they do, you can add them yourself so their cost centre, line manager and role are ready: People > fill in the top row > Add.

- **Role** decides what someone sees. Traveller: own trips only. Arranger: enters trips for anyone and sees everything (EAs, travel arrangers). Manager: sees everything and approves trips naming them. Admin: everything, including roles and the ability to approve any trip.
- **Line manager email** on a person pre-fills their trip form. Approval requests go to whoever is named on the trip.
- **Contractors** are added on the People page with Type "Contractor". Give them an email if they should sign in themselves (any address works once it is listed here); leave it blank if an EA will always enter their travel.
- **Mobile** shows on the dashboard country cards, which is the emergency contact view.

## How the rules work

- Business activity 50% test: of the Monday-to-Friday days away, excluding Melbourne public holidays, at least half must be working days whose activities could not have been done from Melbourne. Travel days count as necessary business travel. Trips below the test can still be submitted; they are flagged for the manager and on the dashboard. Two other things are flagged on every trip, whatever the test result: working days abroad whose activities did not need the person to be overseas (self-directed work, online meetings), and annual leave days taken while abroad.
- Smartraveller level 4 (do not travel): the trip cannot be submitted. Level 3 (reconsider your need to travel): the trip needs a Dean's permission declaration with a date. Both checks run in the browser and again in the database, so they cannot be skipped.
- Approvals: a submitted trip waits for the line manager named on it. The manager sees it under Approvals, approves or declines with a comment, and the traveller sees the result on the trip. If an approved trip's dates or countries change, it goes back to "Awaiting approval". Admins can approve on any manager's behalf.
- The dashboard hides declined trips and shows awaiting-approval trips as dashed bars.

## Costs and limits

- Supabase free tier covers the pilot: 500 MB database, 50,000 monthly active users, 500,000 function calls. Free projects are paused after about a week with no activity; opening the app wakes it, and the Pro plan (about US$25 a month) removes the pause.
- GitHub Pages is free.
- Nothing here needs a Power Platform or Power BI licence.

## Removing everything

Delete the Supabase project (Project Settings > General > Delete project) and the GitHub repository. No data is held anywhere else.

## CLI alternative for the Smartraveller function

If the Supabase dashboard does not offer an in-browser function editor:

```
npm install -g supabase
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase functions deploy smartraveller-sync --project-ref YOUR_PROJECT_REF
```

Run these from inside this folder (the one containing `supabase/`).
