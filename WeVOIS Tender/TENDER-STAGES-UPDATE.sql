-- ===========================================================================
--  WeVois Tender Portal - STAGES, OUTCOMES, CORRIGENDA, EMD PERMISSION, FIRMS
--
--  Run this on a database that already has TENDER-SETUP.sql in it.
--  It is idempotent: run it as many times as you like. If you already ran an
--  earlier copy of this file, run it again - sections 7 and 9 to 13 are new.
--
--  Paste the WHOLE file into the Supabase SQL editor and select all of it
--  (Ctrl+A) before pressing Run. The editor executes only the selection, and
--  a partial selection fails with a confusing error on line 1.
--
--  What it changes
--    1. Two new columns on tenders: loss_reason, loss_reason_notes.
--    2. submitted_at becomes the single signal for "the bid was filed",
--       instead of the stage being at or past 'Submitted'. Existing rows are
--       backfilled so nothing is lost.
--    3. result 'Lost' is renamed 'Not Awarded' to match the new stage.
--    4. A new table, tender_corrigenda - one dated row per corrigendum, with
--       the revised dates it carried and the dates they replaced.
--    5. A trigger that keeps result in step with the Awarded / Not Awarded
--       stages, so nobody has to remember to set two fields.
--    6. EMD becomes tender-team-only to write. Everyone who can see a tender
--       still READS its payments; only the tender team (and an admin) may add,
--       change or delete them.
--    7. Firms and per-firm bids: tender_firms (the companies WeVois bids
--       through), tender_bids (one row per firm per tender), and firm_id on
--       every EMD payment so refunds can be tracked per firm.
--    8. Who may change what. Tender executives edit the tender; BD creates one
--       and hands it over. RFP requests become private to the VP, the Founder,
--       the person who raised it and the person it was given to.
--   10. The RFP copy: somewhere to attach the delivered document, and a
--       storage rule so an uploaded copy is readable only by the four people
--       who can see the request.
--    9. Eligibility, the Go / No-Go request and the gate. The tender team
--       records an eligibility verdict; eligible tenders go to the VP and
--       Founder for a decision; nothing is submitted and no EMD is recorded
--       until that decision is Go.
--
--  Nothing is dropped and no data is deleted.
-- ===========================================================================


-- ---------------------------------------------------------------------------
--  1. New columns on tenders
--
--  Deliberately plain text with no check constraint, matching how stage,
--  result and go_no_go are already handled in this schema: the vocabulary is
--  enforced in the app, so adding a reason later needs no migration.
-- ---------------------------------------------------------------------------
alter table public.tenders add column if not exists loss_reason       text;
alter table public.tenders add column if not exists loss_reason_notes text;

comment on column public.tenders.loss_reason is
  'Why we did not win: Technical | Financial | Wrong documents uploaded | Other. Only meaningful when result = ''Not Awarded''.';
comment on column public.tenders.loss_reason_notes is
  'Free text detail, used mainly when loss_reason = ''Other''.';


-- ---------------------------------------------------------------------------
--  2. submitted_at becomes the "bid was filed" signal
--
--  The stage list is now free-floating - any stage can be set at any time -
--  so "stage is at or past Submitted" no longer means anything. Backfill any
--  row that reached a post-submission stage under the old ordered model so it
--  keeps its submitted state.
-- ---------------------------------------------------------------------------
update public.tenders
   set submitted_at = coalesce(updated_at, created_at, now())
 where submitted_at is null
   and stage in ('Submitted', 'Bid Opened', 'Closed');


-- ---------------------------------------------------------------------------
--  3. 'Lost' becomes 'Not Awarded'
-- ---------------------------------------------------------------------------
update public.tenders set result = 'Not Awarded' where result = 'Lost';


-- ---------------------------------------------------------------------------
--  4. Corrigenda
--
--  A corrigendum is an amendment the authority issues against a live tender.
--  It is NOT a pipeline stage - it can arrive at any point and the tender
--  carries on from wherever it was. It usually revises dates, and when it does
--  the portal is updated too, so the tender's own dates must move with it.
--
--  new_*  = what this corrigendum changed the date TO (null = untouched)
--  prev_* = what the date was immediately before, so the history survives
-- ---------------------------------------------------------------------------
create table if not exists public.tender_corrigenda (
  id                   text primary key default gen_random_uuid()::text,
  tender_id            text not null references public.tenders(id) on delete cascade,
  corrigendum_no       text,
  issued_date          date,
  summary              text,
  portal_updated       boolean not null default false,
  doc_url              text,
  new_pre_bid_date     date,
  new_query_last_date  date,
  new_submission_date  date,
  new_opening_date     date,
  prev_pre_bid_date    date,
  prev_query_last_date date,
  prev_submission_date date,
  prev_opening_date    date,
  created_by           text,
  created_at           timestamptz not null default now()
);

comment on table public.tender_corrigenda is
  'One row per corrigendum issued against a tender. Append-only in practice: the prev_* columns are the audit trail of what the dates were before.';

create index if not exists tcorr_tender_idx on public.tender_corrigenda (tender_id, issued_date desc);

alter table public.tender_corrigenda enable row level security;

-- Inherits the parent tender's visibility, exactly like tender_emd and
-- tender_checklist: if RLS lets you see the tender, you see its corrigenda.
drop policy if exists tcorr_all on public.tender_corrigenda;
create policy tcorr_all on public.tender_corrigenda for all to authenticated
  using       (exists (select 1 from public.tenders t where t.id = tender_id))
  with check  (exists (select 1 from public.tenders t where t.id = tender_id));


-- ---------------------------------------------------------------------------
--  5. Keep result in step with the outcome stages
--
--  Awarded / Not Awarded are stages in the dropdown, but the dashboard, the
--  win rate and the CSV all read the result column. Syncing here rather than
--  in the browser means it holds however the row was written - the app, a
--  bulk update, or the SQL editor.
--
--  One-way only: stage drives result. Setting result on its own is still
--  allowed, so a tender can be marked Cancelled without a matching stage.
-- ---------------------------------------------------------------------------
create or replace function public.wv_tender_sync_result()
returns trigger
language plpgsql
as $$
begin
  if new.stage = 'Awarded' then
    new.result := 'Awarded';

  elsif new.stage = 'Not Awarded' then
    new.result := 'Not Awarded';

  elsif tg_op = 'UPDATE'
        and old.stage in ('Awarded', 'Not Awarded')
        and new.stage not in ('Awarded', 'Not Awarded') then
    -- Dragged back into the pipeline: the recorded outcome no longer holds.
    new.result      := 'Pending';
    new.result_date := null;
  end if;

  -- Stamp the day the outcome was recorded, if nobody supplied one.
  if new.result in ('Awarded', 'Not Awarded') and new.result_date is null then
    new.result_date := current_date;
  end if;

  -- A loss reason on anything other than a loss is noise. Clear it.
  if new.result is distinct from 'Not Awarded' then
    new.loss_reason       := null;
    new.loss_reason_notes := null;
  end if;

  return new;
end
$$;

drop trigger if exists tenders_sync_result on public.tenders;
create trigger tenders_sync_result
  before insert or update on public.tenders
  for each row execute function public.wv_tender_sync_result();


-- ---------------------------------------------------------------------------
--  7. EMD becomes tender-team-only to write
--
--  EMD, bank guarantees and fees are real cash leaving the company and coming
--  back. A wrong refund date is a real problem, so this is deliberately
--  NARROWER than "can see the tender".
--
--  Reading is unchanged: anyone who can see a tender still sees its payments,
--  and the company-wide totals still add up for everyone. Only writing moves.
--
--  The administrator is included as a safety valve. Without it, deactivating
--  the last tender-team account would leave nobody able to correct a mistake
--  except through this SQL editor.
-- ---------------------------------------------------------------------------
create or replace function public.wv_can_edit_emd()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1
      from public.user_profiles p
     where p.id = auth.uid()::text
       and coalesce(p.status,'active') <> 'inactive'
       and ( p.role = 'admin'
             or ( coalesce(p.tender_access, false) and p.tender_role = 'tender_team' ) )
  );
$$;

-- The old single `for all` policy handed write access to every reader, so it
-- has to go. Four policies replace it: one to read, three to write.
drop policy if exists temd_all    on public.tender_emd;
drop policy if exists temd_read   on public.tender_emd;
drop policy if exists temd_insert on public.tender_emd;
drop policy if exists temd_update on public.tender_emd;
drop policy if exists temd_delete on public.tender_emd;

create policy temd_read on public.tender_emd for select to authenticated
  using (exists (select 1 from public.tenders t where t.id = tender_id));

create policy temd_insert on public.tender_emd for insert to authenticated
  with check (public.wv_can_edit_emd()
              and exists (select 1 from public.tenders t where t.id = tender_id));

create policy temd_update on public.tender_emd for update to authenticated
  using       (public.wv_can_edit_emd()
               and exists (select 1 from public.tenders t where t.id = tender_id))
  with check  (public.wv_can_edit_emd()
               and exists (select 1 from public.tenders t where t.id = tender_id));

create policy temd_delete on public.tender_emd for delete to authenticated
  using (public.wv_can_edit_emd()
         and exists (select 1 from public.tenders t where t.id = tender_id));


-- ---------------------------------------------------------------------------
--  9. FIRMS AND PER-FIRM BIDS
--
--  WeVois enters the same tender through several of its firms - two to five is
--  normal. Each firm files its own proposal, pays its own EMD, gets its own
--  rank, and one of them may win. The refunds all come back to WeVois, and the
--  tender team updates them.
--
--  Why firms are a master list and not a text box: a work order and, later, an
--  experience certificate are held by ONE named firm, and a municipal tender
--  only lets you cite experience the BIDDING firm holds. "WeVois Enviro Pvt
--  Ltd" and "Wevois Enviro Pvt. Ltd." typed on different days would become two
--  firms, and every eligibility check after that would be quietly wrong.
--
--  Where the outcome lives: the TENDER keeps the overall Awarded / Not Awarded,
--  because that is the question the dashboard asks. The BID keeps the quote,
--  the rank and that firm's own result. The tender's quoted_value and our_rank
--  stay for tenders entered by a single firm with no bid rows.
-- ---------------------------------------------------------------------------

create table if not exists public.tender_firms (
  id          text primary key default gen_random_uuid()::text,
  name        text not null,
  short_name  text,
  gst_no      text,
  pan_no      text,
  notes       text,
  status      text not null default 'active',   -- active | inactive
  sort        integer not null default 100,
  created_by  text,
  created_at  timestamptz not null default now()
);

comment on table public.tender_firms is
  'The companies WeVois bids through. Work orders and experience certificates are held by exactly one of these, which is why it is a controlled list rather than free text.';

-- Case-insensitive, so "WeVois Enviro" cannot be added twice in different case.
create unique index if not exists tfirms_name_uidx on public.tender_firms (lower(name));


create table if not exists public.tender_bids (
  id                text primary key default gen_random_uuid()::text,
  tender_id         text not null references public.tenders(id)      on delete cascade,
  firm_id           text not null references public.tender_firms(id) on delete restrict,
  quoted_value      numeric,
  our_rank          text,                    -- L1, L2, ...
  result            text not null default 'Pending',
  result_date       date,
  loss_reason       text,
  loss_reason_notes text,
  remarks           text,
  created_by        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.tender_bids is
  'One row per firm entered into a tender. A firm can only enter a given tender once.';

-- A firm cannot bid the same tender twice. This is a real-world rule, so the
-- database holds it rather than the interface.
create unique index if not exists tbids_tender_firm_uidx on public.tender_bids (tender_id, firm_id);
create index if not exists tbids_tender_idx on public.tender_bids (tender_id);
create index if not exists tbids_firm_idx   on public.tender_bids (firm_id);

-- on delete restrict above is deliberate: deleting a firm that has bids against
-- it would silently orphan the history of who bid what. Deactivate it instead.


-- Whose money a payment was. Null means "not attributed to a firm" - which is
-- what every existing row becomes, and is correct: they were recorded before
-- firms existed.
alter table public.tender_emd add column if not exists firm_id text
  references public.tender_firms(id) on delete set null;

create index if not exists temd_firm_idx on public.tender_emd (firm_id);


-- ---------------------------------------------------------------------------
--  Who is the tender team
--
--  wv_can_edit_emd() already answers this, but its name is about money. Firms
--  are master data, not money, so the underlying test gets its own honest name
--  and wv_can_edit_emd() is redefined to call it. One rule, two readable names,
--  no chance of them drifting apart.
-- ---------------------------------------------------------------------------
create or replace function public.wv_is_tender_team()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1
      from public.user_profiles p
     where p.id = auth.uid()::text
       and coalesce(p.status,'active') <> 'inactive'
       and ( p.role = 'admin'
             or ( coalesce(p.tender_access, false) and p.tender_role = 'tender_team' ) )
  );
$$;

create or replace function public.wv_can_edit_emd()
returns boolean language sql security definer stable set search_path = public as $$
  select public.wv_is_tender_team();
$$;


alter table public.tender_firms enable row level security;
alter table public.tender_bids  enable row level security;

-- Firms: everyone with tender access reads them - you cannot pick a firm from a
-- dropdown you cannot see. Only the tender team maintains the list.
drop policy if exists tfirms_read  on public.tender_firms;
drop policy if exists tfirms_write on public.tender_firms;

create policy tfirms_read on public.tender_firms for select to authenticated
  using (public.wv_has_tender_access());

create policy tfirms_write on public.tender_firms for all to authenticated
  using (public.wv_is_tender_team()) with check (public.wv_is_tender_team());

-- Bids follow the tender's own rule: if you can see the tender you can see and
-- edit which firms entered it and what they quoted. Only the MONEY was
-- restricted to the tender team, not the bid detail.
drop policy if exists tbids_all on public.tender_bids;
create policy tbids_all on public.tender_bids for all to authenticated
  using      (exists (select 1 from public.tenders t where t.id = tender_id))
  with check (exists (select 1 from public.tenders t where t.id = tender_id));


-- ---------------------------------------------------------------------------
--  A bid's loss reason, kept honest
--
--  Same rule as the tender-level trigger: a reason for losing, attached to
--  something that was not lost, is noise that skews the why-we-lose reporting.
-- ---------------------------------------------------------------------------
create or replace function public.wv_bid_sync()
returns trigger language plpgsql as $fn$
begin
  if new.result in ('Awarded', 'Not Awarded') and new.result_date is null then
    new.result_date := current_date;
  end if;

  if new.result is distinct from 'Not Awarded' then
    new.loss_reason       := null;
    new.loss_reason_notes := null;
  end if;

  if tg_op = 'UPDATE' then
    new.updated_at := now();
  end if;

  return new;
end
$fn$;

drop trigger if exists tender_bids_sync on public.tender_bids;
create trigger tender_bids_sync
  before insert or update on public.tender_bids
  for each row execute function public.wv_bid_sync();

-- ---------------------------------------------------------------------------
--  10. WHO MAY CHANGE WHAT
--
--  The rule the business asked for:
--
--    Tender executives (the Tender Team) are the ONLY people who edit a
--    tender. They do the work, so they keep the file.
--
--    VP, AVP, DGM and the Founder are decision makers. They see everything
--    they are entitled to see, and the one thing they change is the
--    Go / No-Go decision. Not the stage, not the dates, not the money.
--
--    BD spots tenders and creates them. After that it is handed over.
--
--  Read access is untouched. This is only about writing.
--
--  Column-level rules cannot be expressed in a policy, because a policy can
--  only say yes or no to the whole row. So the tender table gets a BEFORE
--  UPDATE trigger that rebuilds the row from OLD and copies across only the
--  Go / No-Go columns. Anything else a non-executive sends is silently put
--  back. Written that way round on purpose: any column added to this table in
--  future is protected automatically, instead of being forgotten.
-- ---------------------------------------------------------------------------

-- Decision makers. Deliberately does NOT include tender_team - this answers
-- "is this person leadership", not "may this person decide".
create or replace function public.wv_is_leadership()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.user_profiles p
     where p.id = auth.uid()::text
       and coalesce(p.status,'active') <> 'inactive'
       and coalesce(p.tender_access, false)
       and p.tender_role in ('vp','avp','dgm','founder')
  );
$$;

-- Who hands an RFP request to a person. The business put this with the VP and
-- the Founder specifically, not with all of leadership.
create or replace function public.wv_can_assign_rfp()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.user_profiles p
     where p.id = auth.uid()::text
       and coalesce(p.status,'active') <> 'inactive'
       and ( p.role = 'admin'
             or ( coalesce(p.tender_access, false) and p.tender_role in ('vp','founder') ) )
  );
$$;


-- --- the tender itself -------------------------------------------------------

create or replace function public.wv_tenders_guard_update()
returns trigger language plpgsql security definer set search_path = public as $fn$
declare
  kept public.tenders%rowtype;
begin
  -- Executives and administrators may change anything.
  if public.wv_is_tender_team() then
    return new;
  end if;

  -- Everyone else: start from the row as it was, and let through only the
  -- Go / No-Go decision.
  kept := old;
  kept.go_no_go        := new.go_no_go;
  kept.go_no_go_reason := new.go_no_go_reason;
  kept.go_no_go_by     := new.go_no_go_by;
  kept.go_no_go_at     := new.go_no_go_at;
  kept.updated_at      := now();
  return kept;
end
$fn$;

-- Named to sort AFTER tenders_sync_result, so the guard has the last word:
-- sync_result may derive a result from a stage the caller was not allowed to
-- set, and the guard then puts both back.
drop trigger if exists tenders_zz_guard_update on public.tenders;
create trigger tenders_zz_guard_update
  before update on public.tenders
  for each row execute function public.wv_tenders_guard_update();


-- --- the child tables --------------------------------------------------------
-- "Only tender executives edit tender details" applies to everything hanging
-- off the tender, not just the tender row. Reading is unchanged: if you can
-- see the tender you can see its checklist, its bids and its corrigenda.

drop policy if exists tchk_all    on public.tender_checklist;
drop policy if exists tchk_read   on public.tender_checklist;
drop policy if exists tchk_write  on public.tender_checklist;
create policy tchk_read on public.tender_checklist for select to authenticated
  using (exists (select 1 from public.tenders t where t.id = tender_id));
create policy tchk_write on public.tender_checklist for all to authenticated
  using       (public.wv_is_tender_team()
               and exists (select 1 from public.tenders t where t.id = tender_id))
  with check  (public.wv_is_tender_team()
               and exists (select 1 from public.tenders t where t.id = tender_id));

drop policy if exists tcorr_all   on public.tender_corrigenda;
drop policy if exists tcorr_read  on public.tender_corrigenda;
drop policy if exists tcorr_write on public.tender_corrigenda;
create policy tcorr_read on public.tender_corrigenda for select to authenticated
  using (exists (select 1 from public.tenders t where t.id = tender_id));
create policy tcorr_write on public.tender_corrigenda for all to authenticated
  using       (public.wv_is_tender_team()
               and exists (select 1 from public.tenders t where t.id = tender_id))
  with check  (public.wv_is_tender_team()
               and exists (select 1 from public.tenders t where t.id = tender_id));

drop policy if exists tbids_all   on public.tender_bids;
drop policy if exists tbids_read  on public.tender_bids;
drop policy if exists tbids_write on public.tender_bids;
create policy tbids_read on public.tender_bids for select to authenticated
  using (exists (select 1 from public.tenders t where t.id = tender_id));
create policy tbids_write on public.tender_bids for all to authenticated
  using       (public.wv_is_tender_team()
               and exists (select 1 from public.tenders t where t.id = tender_id))
  with check  (public.wv_is_tender_team()
               and exists (select 1 from public.tenders t where t.id = tender_id));


-- --- RFP requests ------------------------------------------------------------
--
--  New rule: an RFP request is visible ONLY to the VP and the Founder, the
--  person who raised it, and the person it was handed to. It is no longer
--  visible to everyone who can see the tender, and the tender team no longer
--  sees all of them - only the ones assigned to them.
--
--  Anyone with access may raise one. Only the VP and Founder decide who works
--  on it.
-- ---------------------------------------------------------------------------
drop policy if exists trfp_read   on public.tender_rfp_requests;
drop policy if exists trfp_insert on public.tender_rfp_requests;
drop policy if exists trfp_update on public.tender_rfp_requests;

create policy trfp_read on public.tender_rfp_requests for select to authenticated
  using ( public.wv_can_assign_rfp()
          or requested_by = auth.uid()::text
          or assigned_to  = auth.uid()::text );

create policy trfp_insert on public.tender_rfp_requests for insert to authenticated
  with check (public.wv_has_tender_access());

create policy trfp_update on public.tender_rfp_requests for update to authenticated
  using ( public.wv_can_assign_rfp()
          or requested_by = auth.uid()::text
          or assigned_to  = auth.uid()::text );

-- Only the VP and Founder hand a request to someone. Without this, the
-- requester could assign it to themselves and the update policy above would
-- allow it, because they pass the requested_by test.
create or replace function public.wv_rfp_guard_assign()
returns trigger language plpgsql security definer set search_path = public as $fn$
begin
  if tg_op = 'INSERT' then
    if new.assigned_to is not null and not public.wv_can_assign_rfp() then
      new.assigned_to := null;    -- raise it unassigned; the VP will hand it out
    end if;
    return new;
  end if;

  if new.assigned_to is distinct from old.assigned_to
     and not public.wv_can_assign_rfp() then
    new.assigned_to := old.assigned_to;
  end if;
  return new;
end
$fn$;

drop trigger if exists trfp_guard_assign on public.tender_rfp_requests;
create trigger trfp_guard_assign
  before insert or update on public.tender_rfp_requests
  for each row execute function public.wv_rfp_guard_assign();

-- ---------------------------------------------------------------------------
--  11. ELIGIBILITY, THE GO / NO-GO REQUEST, AND THE GATE
--
--  The flow the business runs:
--
--    1. BD or the tender team adds or updates a tender.
--    2. The tender team reads it and records an ELIGIBILITY verdict -
--       are we eligible to bid, or not.
--    3. If eligible, it goes to the VP and the Founder as a request for a
--       Go / No-Go decision.
--    4. VP or Founder records Go or No-Go. They are the approving authority.
--    5. Only after a Go does work start: nothing may be marked submitted and
--       no EMD may be recorded until then.
--
--  Two consequences for who may change what, tightening section 10:
--
--    * The Go / No-Go is now the VP's and the Founder's alone. AVP and DGM see
--      everything and decide nothing. Tender executives cannot set it either -
--      they raise the request, they do not answer it.
--    * Eligibility is the tender team's call, not leadership's.
--
--  So the tender guard becomes three-way rather than two-way.
-- ---------------------------------------------------------------------------

alter table public.tenders add column if not exists eligibility_status text not null default 'Not checked';
alter table public.tenders add column if not exists eligibility_reason text;
alter table public.tenders add column if not exists eligibility_by     text;
alter table public.tenders add column if not exists eligibility_at     timestamptz;
alter table public.tenders add column if not exists decision_requested_at timestamptz;

comment on column public.tenders.eligibility_status is
  'Not checked | Eligible | Not eligible. Set by the tender team after reading the notice.';
comment on column public.tenders.eligibility_reason is
  'Why we are not eligible - turnover, experience, registration. Required when Not eligible; this is the data that says which credential to go and build.';
comment on column public.tenders.decision_requested_at is
  'When it was handed to the VP and Founder for a decision. Stamped automatically the moment eligibility becomes Eligible, so turnaround is a plain subtraction.';

-- Anything already carrying free-text eligibility notes has clearly been read.
-- Left as 'Not checked' regardless: guessing a verdict from a note would put
-- words in somebody's mouth, and the whole point of the field is that a person
-- decided it.


-- The approving authority. Same people who assign RFP requests, which is what
-- the business asked for - one approving authority for both.
create or replace function public.wv_can_approve_tender()
returns boolean language sql security definer stable set search_path = public as $$
  select public.wv_can_assign_rfp();
$$;


-- --- the three-way guard -----------------------------------------------------
create or replace function public.wv_tenders_guard_update()
returns trigger language plpgsql security definer set search_path = public as $fn$
declare
  kept public.tenders%rowtype;
  is_admin_user boolean;
begin
  select exists (select 1 from public.user_profiles p
                  where p.id = auth.uid()::text and p.role = 'admin'
                    and coalesce(p.status,'active') <> 'inactive')
    into is_admin_user;

  -- The administrator is the safety valve and may change anything.
  if is_admin_user then
    return new;
  end if;

  -- The approving authority answers the request and nothing else.
  if public.wv_can_approve_tender() then
    kept := old;
    kept.go_no_go        := new.go_no_go;
    kept.go_no_go_reason := new.go_no_go_reason;
    kept.go_no_go_by     := new.go_no_go_by;
    kept.go_no_go_at     := new.go_no_go_at;
    kept.updated_at      := now();
    return kept;
  end if;

  -- Tender executives own the file, but they raise the request rather than
  -- answering it, so the decision columns are put back.
  if public.wv_is_tender_team() then
    new.go_no_go        := old.go_no_go;
    new.go_no_go_reason := old.go_no_go_reason;
    new.go_no_go_by     := old.go_no_go_by;
    new.go_no_go_at     := old.go_no_go_at;

    -- The gate: nothing is filed until the decision is Go.
    if new.submitted_at is not null and old.submitted_at is null
       and coalesce(new.go_no_go, '') <> 'Go' then
      raise exception 'This tender has no Go decision yet. The VP or Founder must approve it before it can be marked submitted.'
        using errcode = 'check_violation';
    end if;

    -- Stamp the moment it becomes a pending decision, so the wait is measurable.
    if new.eligibility_status = 'Eligible'
       and old.eligibility_status is distinct from 'Eligible' then
      new.decision_requested_at := now();
    end if;
    if new.eligibility_status is distinct from old.eligibility_status then
      new.eligibility_by := auth.uid()::text;
      new.eligibility_at := now();
    end if;
    -- A reason for being ineligible, on something that is eligible, is noise.
    if new.eligibility_status <> 'Not eligible' then
      new.eligibility_reason := null;
    end if;

    return new;
  end if;

  -- Everyone else changes nothing at all.
  kept := old;
  kept.updated_at := now();
  return kept;
end
$fn$;

drop trigger if exists tenders_zz_guard_update on public.tenders;
create trigger tenders_zz_guard_update
  before update on public.tenders
  for each row execute function public.wv_tenders_guard_update();


-- --- the gate on money -------------------------------------------------------
-- No EMD, bank guarantee or fee is recorded against a tender nobody approved.
-- Reading is untouched.
drop policy if exists temd_insert on public.tender_emd;
drop policy if exists temd_update on public.tender_emd;

create policy temd_insert on public.tender_emd for insert to authenticated
  with check (public.wv_can_edit_emd()
              and exists (select 1 from public.tenders t
                           where t.id = tender_id and t.go_no_go = 'Go'));

create policy temd_update on public.tender_emd for update to authenticated
  using       (public.wv_can_edit_emd()
               and exists (select 1 from public.tenders t where t.id = tender_id))
  with check  (public.wv_can_edit_emd()
               and exists (select 1 from public.tenders t where t.id = tender_id));
-- update deliberately does NOT require a Go: a tender approved, paid for and
-- later dropped still needs its refund chasing to completion.


-- --- tell the approvers ------------------------------------------------------
-- A pending decision that nobody notices is the same as no process at all.
create or replace function public.wv_notify_decision_due()
returns trigger language plpgsql security definer set search_path = public as $fn$
begin
  if new.eligibility_status = 'Eligible'
     and old.eligibility_status is distinct from 'Eligible'
     and new.go_no_go is null then
    insert into public.notifications (title, message, type, recipient_role)
    values ('Go / No-Go needed: ' || new.title,
            coalesce(new.authority, 'Tender') ||
              ' - closes ' || coalesce(to_char(new.submission_date, 'DD Mon YYYY'), 'no date') ||
              '. Marked eligible and waiting for a decision.',
            'warn', 'all');
    -- recipient_role 'all' on purpose: the bell is the nudge, the pending
    -- queue on the VP's and Founder's dashboard is the actual work list.
  end if;
  return new;
end
$fn$;

drop trigger if exists tenders_notify_decision on public.tenders;
create trigger tenders_notify_decision
  after update on public.tenders
  for each row execute function public.wv_notify_decision_due();

-- ---------------------------------------------------------------------------
--  12. THE RFP COPY
--
--  An RFP request already carried file_path columns - on the request and on
--  every timeline event - but nothing ever wrote them. The preparer finished a
--  document and had nowhere to put it, so it went out by email and the trail
--  ended there.
--
--  Two halves to this:
--
--    a) somewhere to put the copy, versioned, on the timeline
--    b) an access rule that matches the request's own
--
--  (b) is the important one. The old storage rule was:
--
--      using (bucket_id = 'tenders' and wv_has_tender_access())
--
--  - anyone with tender access could read ANY file in the bucket. An RFP copy
--  stored under that rule would be readable by people who cannot see the
--  request it belongs to, which is exactly what the confidentiality is for.
--
--  So RFP copies go under  rfp/<request_id>/...  and reading one requires being
--  able to read that request. The subquery runs as the caller, so the request's
--  own row level security answers the question - Founder, VP, the person who
--  raised it, the person preparing it. Nobody else, and no second rule to keep
--  in step with the first.
-- ---------------------------------------------------------------------------

-- An external link, for copies kept in Drive rather than uploaded. Deliberately
-- separate from file_path so the two are never confused: an uploaded copy is
-- covered by the rule below, a linked one is not, and the interface says so.
alter table public.tender_rfp_requests add column if not exists file_url text;
alter table public.tender_rfp_events   add column if not exists file_url text;

comment on column public.tender_rfp_requests.file_url is
  'Link to a copy held elsewhere (Drive). NOT access-controlled - whoever has the link can open it. Prefer file_path for anything confidential.';


drop policy if exists tender_files_read   on storage.objects;
drop policy if exists tender_files_upload on storage.objects;
drop policy if exists tender_files_update on storage.objects;

-- Reading: ordinary tender and company files as before; an RFP copy only if you
-- can see its request.
create policy tender_files_read on storage.objects for select to authenticated
  using (
    bucket_id = 'tenders'
    and public.wv_has_tender_access()
    and (
      name not like 'rfp/%'
      or exists (select 1 from public.tender_rfp_requests r
                  where r.id = split_part(name, '/', 2))
    )
  );

-- Uploading an RFP copy: the same four people. In practice it is the assignee
-- who does it, but the VP or Founder replacing a copy should not be blocked.
create policy tender_files_upload on storage.objects for insert to authenticated
  with check (
    bucket_id = 'tenders'
    and public.wv_has_tender_access()
    and (
      name not like 'rfp/%'
      or exists (select 1 from public.tender_rfp_requests r
                  where r.id = split_part(name, '/', 2))
    )
  );

create policy tender_files_update on storage.objects for update to authenticated
  using (
    bucket_id = 'tenders'
    and public.wv_has_tender_access()
    and (
      name not like 'rfp/%'
      or exists (select 1 from public.tender_rfp_requests r
                  where r.id = split_part(name, '/', 2))
    )
  );

-- ---------------------------------------------------------------------------
--  13. PUT ON HOLD
--
--  The VP is the vice president of the company. He is not going to sit and
--  write the RFP. A request reaches him and he does one of three things:
--  accept it, park it, or reject it. Then he hands the work to somebody.
--
--  'On Hold' was missing entirely - the only choices were accept or reject,
--  which forces a decision that is not ready to be made.
--
--  It needs its own timestamp for the same reason every other wait here has
--  one: a request parked in March and forgotten is invisible unless you can
--  ask how long it has been parked.
-- ---------------------------------------------------------------------------
alter table public.tender_rfp_requests add column if not exists held_at timestamptz;

comment on column public.tender_rfp_requests.held_at is
  'When it was last put on hold. Cleared when it moves on, so "is it parked, and since when" is one column.';

create or replace function public.wv_rfp_stamp()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.status = 'Accepted'          and new.accepted_at         is null then new.accepted_at         := now(); end if;
  if new.status = 'In Preparation'    and new.started_at          is null then new.started_at          := now(); end if;
  if new.status = 'Delivered'         and new.delivered_at        is null then new.delivered_at        := now(); end if;
  if new.status = 'Changes Requested'                                     then new.change_requested_at := now(); end if;
  if new.status = 'Revised'                                               then new.revised_at          := now(); end if;
  if new.status = 'Closed'            and new.closed_at           is null then new.closed_at           := now(); end if;
  if new.status = 'Rejected'          and new.rejected_at         is null then new.rejected_at         := now(); end if;

  -- Held is the one status you can come back OUT of and go into again, so it
  -- is stamped on every entry and cleared on the way out, rather than being
  -- written once like the milestones above.
  if new.status = 'On Hold' then
    if tg_op = 'INSERT' or old.status is distinct from 'On Hold' then
      new.held_at := now();
    end if;
  else
    new.held_at := null;
  end if;

  return new;
end $$;

drop trigger if exists rfp_stamp on public.tender_rfp_requests;
create trigger rfp_stamp before insert or update on public.tender_rfp_requests
  for each row execute function public.wv_rfp_stamp();

-- ===========================================================================
--  14. VERIFICATION
--  Expect:  2 - 1 - true - true - 0 - 4 - true - 2 - 1 - true - true - true - 5 - true - 2 - 1
--  new tender columns, the corrigenda table, RLS on it, the result trigger,
--  "no tender still carries the old 'Lost' result", the four EMD policies,
--  the EMD permission function, the two new tables, the firm_id on EMD, and
--  the one-bid-per-firm rule.
-- ===========================================================================
select
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'tenders'
      and column_name in ('loss_reason', 'loss_reason_notes')
  ) as new_tender_columns,
  (select count(*) from information_schema.tables
    where table_schema = 'public' and table_name = 'tender_corrigenda'
  ) as corrigenda_table,
  (select rowsecurity from pg_tables
    where schemaname = 'public' and tablename = 'tender_corrigenda'
  ) as corrigenda_rls,
  (select count(*) > 0 from pg_trigger
    where tgname = 'tenders_sync_result' and not tgisinternal
  ) as result_trigger,
  (select count(*) from public.tenders where result = 'Lost'
  ) as stale_lost_rows,
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'tender_emd'
  ) as emd_policies,
  (select count(*) > 0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'wv_can_edit_emd'
  ) as emd_guard_present,
  (select count(*) from information_schema.tables
    where table_schema = 'public' and table_name in ('tender_firms','tender_bids')
  ) as firm_tables,
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'tender_emd' and column_name = 'firm_id'
  ) as emd_firm_column,
  (select count(*) > 0 from pg_indexes
    where schemaname = 'public' and indexname = 'tbids_tender_firm_uidx'
  ) as one_bid_per_firm,
  (select count(*) > 0 from pg_trigger
    where tgname = 'tenders_zz_guard_update' and not tgisinternal
  ) as tender_edit_guard,
  (select count(*) > 0 from pg_trigger
    where tgname = 'trfp_guard_assign' and not tgisinternal
  ) as rfp_assign_guard,
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='tenders'
      and column_name in ('eligibility_status','eligibility_reason','eligibility_by',
                          'eligibility_at','decision_requested_at')
  ) as eligibility_columns,
  (select count(*) > 0 from pg_trigger
    where tgname = 'tenders_notify_decision' and not tgisinternal
  ) as decision_notifier,
  (select count(*) from information_schema.columns
    where table_schema='public' and column_name='file_url'
      and table_name in ('tender_rfp_requests','tender_rfp_events')
  ) as rfp_link_columns,
  (select count(*) from information_schema.columns
    where table_schema='public' and table_name='tender_rfp_requests' and column_name='held_at'
  ) as hold_column;
