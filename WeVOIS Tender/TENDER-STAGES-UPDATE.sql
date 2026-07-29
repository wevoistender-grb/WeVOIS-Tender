-- ===========================================================================
--  WeVois Tender Portal - STAGES, OUTCOMES, CORRIGENDA, EMD PERMISSION, FIRMS
--
--  Run this on a database that already has TENDER-SETUP.sql in it.
--  It is idempotent: run it as many times as you like. If you already ran an
--  earlier copy of this file, run it again - sections 7 and 9 are new.
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

-- ===========================================================================
--  10. VERIFICATION
--  Expect:  2  -  1  -  true  -  true  -  0  -  4  -  true  -  2  -  1  -  true
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
  ) as one_bid_per_firm;
