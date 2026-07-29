# WeVois Tender Portal — setup and deployment

A **standalone** system. Its own Supabase project, its own users, its own
hosting. It shares no file, no table and no login with the billing portal, and
neither one can break the other.

---

## 1. Create the Supabase project

1. supabase.com → **New project**. Name it something like `wevois-tender`.
2. Choose a region close to you (Mumbai / Singapore).
3. Save the database password somewhere safe — you will not be shown it again.

## 2. Create the tables

1. Supabase → **SQL Editor** → **New query**.
2. Open `TENDER-SETUP.sql`, select **the whole file** (Ctrl+A) and paste it in.
3. Press **Run**.

You should get exactly one row back:

| tables_found | regions_seeded | org_units_seeded | standard_docs_seeded | rls_enabled | needs_first_run |
|---|---|---|---|---|---|
| 12 | 3 | 7 | 23 | 12 | true |

If any number differs, stop and check the error rather than carrying on.

> **Why "select the whole file" matters.** The Supabase SQL editor runs only the
> *selected* text when a selection exists. A selection that starts a few
> characters into line 1 fails with a confusing syntax error on line 1.

## 3. Two settings in Supabase

Authentication → **Providers** → Email:

- **Confirm email: OFF.** Otherwise a new account has no session and the person
  cannot sign in until they click a link. You can turn it on later.
- **Allow new users to sign up: OFF** — but only *after* step 5. This is the
  single most important setting: with it on, anyone who finds the URL can
  register. (Even then they would land with no access and see nothing, because
  the database gives every account after the first one `tender_access = false`.
  Turn it off anyway.)

## 4. Point the app at your project

Open `supabase-config.js` and paste in the two values from
Supabase → **Settings → API**:

```js
const SUPABASE_URL      = 'https://xxxxxxxx.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOi...';
```

The anon key is public by design and safe in the browser — row level security
is what protects the data. **Never** put the `service_role` key in this file.

## 5. Deploy

Vercel → **Add New → Project** → import the repo (or drag this folder in).

- **Root Directory:** this folder (`WeVOIS Tender`)
- **Framework preset:** Other
- **Build command:** none
- **Output directory:** leave blank

Any static host works — it is plain HTML, CSS and JavaScript with no build step.

## 6. Create the first administrator

Open the deployed URL. Because the database is empty you get a **one-time setup
screen**. Enter your name, email and a password.

The very first account ever created becomes the administrator, with full access
and visibility of every tender. That decision is made by a database trigger, not
by the browser, so nobody can ask for admin rights by tampering with the request.
Every account after it starts with **no access at all** until you switch it on.

Now go back and turn **Allow new users to sign up: OFF**.

## 7. Set up your organisation

**Team & access** (visible to administrators only):

1. **Org units** — rename the seeded units to your real ones and set who reports
   into whom. A unit sees itself and everything beneath it. Two units marked
   *global* (Founder, Tender Team) see everything regardless.
2. **Regions** — add any beyond Rajasthan and Madhya Pradesh.
3. **People** — *Add a user* creates their login. Set their unit, their tender
   role, and tick their regions.

### How visibility works

A person sees a tender only when **both** are true:

- the tender's owning unit is their own unit **or a unit beneath it**, and
- the tender's region is one of theirs (*tick none = every region*).

So the AVP's tenders are invisible to the DGM and the DGM's are invisible to the
AVP, while the VP above both sees everything under them, and the Founder and
Tender Team see the lot. This is enforced by row level security in the database,
not by the interface — hiding a button is not security.

---

## Files

| File | What it is |
|---|---|
| `index.html` | The whole interface: login, first-run, dashboard, every dialog |
| `tender-engine.js` | Plumbing — Supabase client, auth, formatting, charts, CSV, PDF text, uploads, notifications, PWA |
| `tender-data.js` | Tender domain — visibility rules, roll-ups, saves, tender-notice parser |
| `tender-app.js` | Screens and behaviour |
| `tender-theme.css` | Design system (dark) |
| `TENDER-SETUP.sql` | The entire database. Safe to run more than once |
| `sw.js` | Service worker — makes it installable, never serves stale code |
| `manifest.json` | PWA manifest |
| `supabase-config.js` | Your project URL and anon key |

## ⚠ On every deploy that changes a `.js` or `.css` file

Bump `CACHE_VERSION` in `sw.js` (`wevois-tender-1` → `-2` → …).

Static files are served **cache-first** for speed. Without a bump, a returning
phone keeps the old JavaScript: the page shows the new fields but nothing works.
It is a silent failure and very confusing to diagnose.

## Backups

Supabase → Database → Backups. On the free tier, take a manual dump before any
schema change. `tender_rfp_events` is an append-only audit trail — do not prune it.
