-- ===========================================================================
--  WeVois Tender Portal - STAGE, RESULT AND CORRIGENDUM UPDATE
--
--  Run this ONCE on a database that already has TENDER-SETUP.sql in it.
--  It is idempotent: running it twice changes nothing the second time.
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


-- ===========================================================================
--  6. VERIFICATION
--  Expect:  2  -  1  -  true  -  true  -  0
--  new tender columns, the corrigenda table, RLS on it, the trigger, and
--  "no tender is still carrying the old 'Lost' result".
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
  ) as stale_lost_rows;
