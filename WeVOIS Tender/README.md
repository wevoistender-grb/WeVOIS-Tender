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
(published, pre-bid, queries close, submission, opening).

**Stages** — Spotted, Under Review, RFP, NIT, Go/No-Go, Documents, Proposal,
PPT, Ready, Submitted, Bid Opened, Awarded, Not Awarded, Closed.

These **float freely**. There is no fixed order and nothing is enforced: set
whichever stage describes where the tender actually is, go backwards, or skip
half of them. Real tenders do not queue politely, and a system that insists they
do just gets filled with lies.

Because of that, **whether the bid was filed is its own tick box**, not
something read off the stage. Ticking it is what stops the deadline countdown
and opens the EMD, rank and result fields. A tender can sit in PPT long after
it was submitted without confusing anything.

Picking **Awarded** or **Not Awarded** records the result for you — one field,
not two to keep in step. **Not Awarded demands a reason**: Technical, Financial,
Wrong documents uploaded, or Other with a note. That is the only way the pattern
in why you lose ever becomes visible. Move a tender back out of an outcome
stage and the recorded result clears itself, so nothing stale is left behind.

**Firms and per-firm bids** — WeVois enters the same tender through two to five
of its companies. Each firm files its own proposal, quotes its own number, gets
its own rank, pays its own EMD, and one of them may win. Record the firms once
under Team & access, then enter them against a tender on the **Firms & bids**
tab. A firm can only enter a given tender once — the database enforces that.

Once firms are entered, the quote and rank move off the tender onto each firm,
because three firms quote three different numbers and leaving both places
editable would guarantee they drift. A tender bid by a single firm needs no bid
rows at all and works exactly as before.

Why a fixed list and not a typed name: a work order, and later an experience
certificate, is held by **one named firm**, and a municipal tender only lets you
cite experience the *bidding* firm holds. "WeVois Enviro Pvt Ltd" and "Wevois
Enviro Pvt. Ltd." typed on different days would become two firms, and every
eligibility check after that would be quietly wrong.

**EMD and fees** — every payment records **whose money it was**. All the refunds
come back to WeVois, but each has to be chased in the name of the firm that paid
it, so the EMD tab totals still-out, refunded and forfeited **per firm** as well
as overall. Payments recorded before firms existed show as *not attributed*
rather than being guessed at.

Only the **Tender Team** (and an administrator) can add, change or delete a
payment. Everyone who can see a tender still reads its EMD — the Founder and VP
watch the amounts, they just do not change them. That is a database rule, not a
hidden button.

**Corrigenda** — amendments the authority issues against a live tender. Not a
stage: one can arrive at any point and the tender carries on from wherever it
was. Record it with the dates it revised, and those dates are applied to the
tender itself — the portal has been updated, so your copy has to move too. What
the dates were before is kept on the corrigendum, so the history survives.

**Deadlines** — a "closing in the next 15 days" list (switchable to 7 or 30) with
countdown chips that go amber at a week and red at three days. Anything past its
date and still not filed is flagged at the top of the dashboard.

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

**Tender notice auto-read** — upload the PDF and the NIT number, authority,
estimated cost, EMD, fees, all five key dates and the contract period fill
themselves in. It never overwrites anything you have already typed, and tells
you exactly which fields it filled.

## Who may change what

Seeing a tender is not the same as being able to change it.

| | Tender executives | VP · AVP · DGM · Founder | BD |
|---|---|---|---|
| See the tender and everything on it | yes | yes | yes |
| Create a new tender | yes | — | **yes** |
| Edit the tender after it exists | **yes** | no | no |
| Stage, dates, scope, money | **yes** | no | no |
| Checklist, corrigenda, firms & bids | **yes** | no | no |
| EMD and fees | **yes** | no | no |
| **Go / No-Go decision** | yes | **yes** | no |
| Comment | yes | yes | yes |

**Tender executives** are the Tender Team role. They do the work, so they own
the file.

**Leadership decides and then watches.** VP, AVP, DGM and the Founder get one
control on a tender — the **Go / No-Go decision** — and read-only access to
everything else. They see every amount, every date and every document; they
just do not change them.

**BD spots tenders and creates them**, then hands over. Note the consequence:
once a BD person saves a tender they cannot correct a typo in it — they have to
ask an executive. Say the word if you want that softened.

This is enforced in PostgreSQL, not in the browser. Because a policy can only
say yes or no to a whole row, the tender table carries a trigger that rebuilds
the row from what it was and copies across only the Go / No-Go columns. Anything
else a non-executive sends is put back. Written that way round on purpose: a
column added to the table in future is protected automatically rather than
being forgotten.

### RFP requests are private

An RFP request is visible **only** to the VP, the Founder, the person who raised
it, and the person it was given to. Not to everyone who can see the tender, and
not to the whole tender team — an executive sees only the requests assigned to
them.

Anyone with access can raise one. **Only the VP and the Founder decide who works
on it.** Trying to assign one to yourself is stripped by the database, not just
hidden in the interface.

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
| `TENDER-STAGES-UPDATE.sql` | One-off migration for a database created before the stage rework. Not needed for a fresh install |

## A note on `supabase-config.js`

It holds the project URL and the **anon** key. That key is public by design and
safe in the browser — row level security is what protects the data.

**Never** put the `service_role` key in this file or anywhere in this repository.
It bypasses every security policy.

## Before every deploy that changes a `.js` or `.css` file

Bump `CACHE_VERSION` in `sw.js`. Static files are served cache-first for speed;
without a bump a returning phone keeps the old JavaScript and the page silently
stops working.
