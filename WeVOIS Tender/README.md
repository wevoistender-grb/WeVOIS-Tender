# WeVois Tender Portal

Tender pipeline, document requests, company document vault and EMD register
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

**Not pursuing a tender** — most tenders you look at, you do not bid. That is
normal, and *why* you walked away is worth more than the tender itself: too
small, not eligible, deadline already gone, bidding a better one in the same
district. That is the pattern that tells you which credential to go and build.

So there are two different actions, and they are not the same thing:

- **Not pursuing this** asks for a reason, parks the tender out of the working
  list, and keeps everything. It records who dropped it, when, and the stage it
  was standing at. **Pick it back up** puts it exactly there again — not at some
  guessed stage. A drop is a decision, and decisions get reversed.
- **Delete** is for rows that should never have existed: a duplicate, a typo,
  somebody testing the form. Nothing to learn, so nothing to keep.

Dropped tenders leave the tender list, the dashboard counts, the "closing soon"
numbers and the leadership's *waiting for your decision* list — a tender nobody
is bidding should not sit on somebody's work list forever. The **Dropped ones**
filter brings them back when you want them.

**Deleting is the tender executives' and an administrator's.** It used to be
anyone with global visibility, which handed it to the Founder and the CEO —
people who cannot change one field on a tender. Being able to destroy a row you
may not edit makes no sense.

**A tender with money recorded against it cannot be deleted at all** — not by an
executive, not by an administrator. An EMD or a fee means real cash left the
company and a refund is owed back; the tender row is the only thing tying that
payment to an authority. Delete it and the payment rows go with it, and nobody
chases the refund because nobody knows it exists. Remove the payments first if
they really were a mistake. Two deliberate steps beat one that quietly destroys
both.

**Deadlines** — a "closing in the next 15 days" list (switchable to 7 or 30) with
countdown chips that go amber at a week and red at three days. Anything past its
date and still not filed is flagged at the top of the dashboard.

**Document requests** — anyone can ask for a document to be prepared. It used to
be called *RFP requests*, which was wrong twice over: most of what gets asked for
is not an RFP, and the word already means two other things here (a tender stage,
and a document type). Both of those keep the name, because that is what the
authority calls them. The feature is now **Request a Document**.

A request has to be about **something**. Either it hangs off a tender, or the
person raising it names the topic — a project, a scheme, a client, an internal
deck. Never neither: a request attached to nothing is one nobody can act on, and
the list would fill with rows saying only "Not linked". When a tender *is*
picked, the topic stays available but optional, for the phase or client the
tender title does not say.

Two jobs, and they are not the same person:

- The **CEO, VP or Founder** receives the request and does one of three things:
  **Accept**, **Put on hold**, or **Reject**. Nobody else sees those three —
  not the tender team, not the person it will end up with.
- Then they **hand it to a person** — anyone with access, whatever team they sit
  in: BD, their own team, the tender team, the Founder's team. Whoever knows the
  subject. Handing it over **is** the acceptance, so assigning straight from
  Requested accepts it in the same act.
- **Once it is assigned, accept / hold / reject disappear for everyone.** Only
  reassignment stays. Re-answering a request afterwards would leave somebody
  working on something that had since been rejected.
- That person does the work: In Preparation → Delivered → Revised, and attaches
  the copy.

The VP is the vice president of the company; he is not going to sit and write
the document. So he is never offered "start preparing" or the attach-a-copy box, and
the preparer is never offered accept or reject.

Every step is timestamped by the database and the timeline is append-only, so
who asked, who decided, who prepared it, how long it took and what changed is
all on record. A request put on hold records when — a request parked in March
and forgotten is invisible otherwise. Overdue requests and average turnaround
show on the dashboard.

**Document vault** — the master copies every bid draws on, with expiry dates.
Anything expiring within 60 days surfaces on the dashboard; anything already
expired raises an alert.

**It starts empty, and nothing is pre-named.** Guessing at a company's document
list produces names nobody uses and a list people work around rather than with.
The tender team types the name they actually call it and attaches the PDF, or
pastes a link.

**Only the Tender Team, the VP and the Founder see it at all** — AVP, DGM and BD
do not get the tab. It holds registrations, financials and experience
certificates, which is not everybody's business. Maintaining it stays with the
tender team, who know which certificate is current and when it expires.

An **uploaded** document is covered by that rule. A **linked** one is not —
whoever holds the link can open it. The form says so.

**Per-tender checklist** — what that tender demands, who is preparing each item,
and what is still missing, with a progress bar on every row of the tender list.

**Tender notice auto-read** — upload the PDF and the NIT number, authority,
estimated cost, EMD, fees, all five key dates and the contract period fill
themselves in. It never overwrites anything you have already typed, and tells
you exactly which fields it filled.

**Live updates** — the portal used to load once at sign-in and never look again,
so two people on the same tender saw different things until somebody pressed
reload. Now changes arrive on their own, in three layers because any one of them
can fail quietly:

1. **Realtime** — Supabase streams row changes. Instant, but needs a working
   websocket, and corporate networks do block those.
2. **On return** — refreshes when you come back to the tab.
3. **Every 90 seconds** — only while the tab is visible. The backstop for when
   realtime never connected at all.

A small **Live** dot in the top bar says which is happening: green when the
stream is connected, amber when it has fallen back to the timer.

Row level security applies to the stream too — you are only told about rows you
could have read anyway.

**An update that arrives while a dialog is open is held back** and applied the
moment it closes. Reloading under somebody's hands is worse than being slightly
stale: half a typed comment disappears, or a dropdown they were about to save
resets underneath them.

## The flow

1. **BD or the tender team** spots a tender and adds it.
2. **A tender executive reads it** and records an **eligibility verdict** —
   are we eligible to bid, or not. *Not eligible* demands a reason, because
   that reason is what tells you which credential to go and build.
3. Marking it **Eligible** hands it to the **CEO, the VP and the Founder**: it appears
   in a *Waiting for your decision* list on their dashboard, with how long it
   has been sitting there, and raises a notification.
4. **The CEO, VP or Founder** records **Go** or **No-Go**. They are the
   approving authority — for tenders and for document requests both.
5. **Only after a Go** does work start. Until then nothing can be marked
   submitted and no EMD can be recorded.

That last one is a hard gate, not a warning. Money and effort do not go into a
bid nobody approved.

## Who may change what

Seeing a tender is not the same as being able to change it.

| | Tender executives | CEO · VP · Founder | AVP · DGM | BD |
|---|---|---|---|---|
| See the tender and everything on it | yes | yes | yes | yes |
| Create a new tender | yes | — | — | **yes** |
| Edit it after it exists | **yes** | no | no | no |
| Stage, dates, scope, money | **yes** | no | no | no |
| Checklist, corrigenda, firms & bids | **yes** | no | no | no |
| **Mark it "not pursuing"** | **yes** | no | no | no |
| **Delete a tender** | **yes** | no | no | no |
| EMD and fees *(after a Go)* | **yes** | no | no | no |
| **Eligibility verdict** | **yes** | no | no | no |
| **Go / No-Go decision** | no | **yes** | no | no |
| Assign a document request | no | **yes** | no | no |
| **See the document vault** | **yes** | **yes** | no | no |
| Maintain the vault | **yes** | no | no | no |
| Comment | yes | yes | yes | yes |

**Tender executives** are the Tender Team role. They do the work, so they own
the file — but they raise the Go/No-Go request rather than answering it. Nobody
approves their own tender.

**The CEO, the VP and the Founder are the approving authority.** One control on
a tender, the Go/No-Go, plus assigning document requests. Everything else is
read-only to them.

**The CEO sees more than the VP**, and that is deliberate. The VP sees their own
unit and everything under it, so a tender parked in the Founder's unit is
invisible to them. The CEO is a *global* role, like the Founder and the Tender
Team: every tender, whatever unit or region owns it. Nothing can be hidden from
the CEO by filing it in the wrong place.

What the CEO still cannot do is edit a tender or record a payment. Those stay
with the tender executives and the tender team, exactly as they do for the VP.

**AVP and DGM see everything and decide nothing.**

**BD spots tenders and creates them**, then hands over. Note the consequence:
once a BD person saves a tender they cannot correct a typo — they have to ask an
executive. Say the word if you want that softened.

The administrator can do anything, as a safety valve.

This is enforced in PostgreSQL, not in the browser. Because a policy can only
say yes or no to a whole row, the tender table carries a trigger that decides
three ways: the approving authority gets the Go/No-Go columns and nothing else,
executives get everything *except* those columns, and everyone else gets
nothing. It is written as "keep the old row, allow these" rather than "block
these", so a column added to the table in future is protected automatically
instead of being forgotten.

### Document requests are private

A document request is visible **only** to the CEO, the VP, the Founder, the
person who raised it, and the person it was given to. Not to everyone who can see the
tender, and not to the whole tender team — an executive sees only the
requests assigned to them.

Anyone with access can raise one. It is raised **unassigned** — trying to assign
one to yourself is stripped by the database, not just hidden in the interface.
**Only the CEO, the VP and the Founder decide who works on it.**

**The copy itself follows the same rule.** The person preparing it attaches the
document when it is ready — uploaded, or as a link. Every version is kept on the
timeline rather than overwritten, so what changed between v1 and v2 survives.

An **uploaded** copy is stored under `rfp/<request-id>/…` and reading it requires
being able to read that request: Founder, CEO, VP, requester, preparer, and
nobody else.
Reassign the request and file access moves with it — the previous preparer loses
it immediately.

A **linked** copy cannot be protected that way, because whoever holds the link
can open it whatever their role. The interface says so at the point of
attaching. Use upload for anything confidential.

## Who sees what

A person sees a tender only when **both** are true:

- the tender's owning unit is their own unit **or a unit beneath it**, and
- the tender's region is one of theirs (tick none = every region).

So the AVP's tenders are invisible to the DGM and the DGM's are invisible to the
AVP, while the VP above them sees everything underneath, and the Founder, the
CEO and the Tender Team see everything.

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
