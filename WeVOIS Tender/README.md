# WeVois Tender Portal

Tender pipeline, RFP request tracking, company document vault and EMD register
for WeVois.

A standalone system — its own Supabase project, its own users, its own hosting.
It shares no file, no table and no login with the WeVois billing portal, and
neither can break the other.

**Setup and deployment: see [DEPLOY.md](DEPLOY.md).**

---

## What it does

**Tenders** — the full file on every bid: NIT number, authority, city, region,
owning team, scope, estimated value, EMD, fees, and every date that matters
(published, pre-bid, queries close, submission, opening). Moves through a
pipeline of Spotted → Under Review → Go/No-Go → Documents → Ready → Submitted →
Bid Opened → Closed, then records the result, our rank and what it was awarded at.

**Deadlines** — a "closing in the next 15 days" list (switchable to 7 or 30) with
countdown chips that go amber at a week and red at three days. Anything past its
date and still not submitted is flagged at the top of the dashboard.

**RFP requests** — anyone can ask the tender team to prepare a document. Every
step is timestamped by the database: Requested → Accepted → In Preparation →
Delivered → Changes Requested → Revised → Closed. The timeline is append-only,
so who asked, who prepared it, how long it took and what changed is all on
record. Overdue requests and average turnaround show on the dashboard.

**Document vault** — the master copies every bid draws on, with expiry dates.
Anything expiring within 60 days surfaces on the dashboard; anything already
expired raises an alert. A new tender starts with the standard checklist
pre-loaded from the vault.

**Per-tender checklist** — what that tender demands, who is preparing each item,
and what is still missing, with a progress bar on every row of the tender list.

**EMD and fees** — what was paid, how, when, when the refund is due and whether
it came back. Money still out, refunded, forfeited and refunds due soon are
totalled on their own tab.

**Tender notice auto-read** — upload the PDF and the NIT number, authority,
estimated cost, EMD, fees, all five key dates and the contract period fill
themselves in. It never overwrites anything you have already typed, and tells
you exactly which fields it filled.

## Who sees what

A person sees a tender only when **both** are true:

- the tender's owning unit is their own unit **or a unit beneath it**, and
- the tender's region is one of theirs (tick none = every region).

So the AVP's tenders are invisible to the DGM and the DGM's are invisible to the
AVP, while the VP above them sees everything underneath, and the Founder and
Tender Team see everything.

The org tree is configurable in the app — units, who reports into whom, regions
and people. Nothing is hardcoded.

This is enforced by PostgreSQL row level security, not by the interface. Hiding
a button is not security; every one of these rules is a database policy.

## Stack

Plain HTML, CSS and JavaScript — no build step, no framework, no bundler.
Supabase for the database, auth and file storage. Installable as a PWA.

| File | What it is |
|---|---|
| `index.html` | The whole interface |
| `tender-engine.js` | Supabase client, auth, formatting, escaping, charts, CSV, PDF text, uploads, notifications, PWA |
| `tender-data.js` | Visibility rules, roll-ups, saves, tender-notice parser |
| `tender-app.js` | Screens and behaviour |
| `tender-theme.css` | Design system |
| `TENDER-SETUP.sql` | The entire database. Safe to run more than once |

## A note on `supabase-config.js`

It holds the project URL and the **anon** key. That key is public by design and
safe in the browser — row level security is what protects the data.

**Never** put the `service_role` key in this file or anywhere in this repository.
It bypasses every security policy.

## Before every deploy that changes a `.js` or `.css` file

Bump `CACHE_VERSION` in `sw.js`. Static files are served cache-first for speed;
without a bump a returning phone keeps the old JavaScript and the page silently
stops working.
