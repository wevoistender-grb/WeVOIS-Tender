-- ===========================================================================
--  WeVois Tender Portal - FIRM/EMD VISIBILITY, WHO MAY REQUEST A DOCUMENT,
--  AND PLAIN-LANGUAGE WORDING
--
--  Run this on a database that already has TENDER-SETUP.sql and
--  TENDER-STAGES-UPDATE.sql in it. It is idempotent: run it as many times as
--  you like.
--
--  Paste the WHOLE file into the Supabase SQL editor and select all of it
--  (Ctrl+A) before pressing Run. The editor executes only the selection, and
--  a partial selection fails with a confusing error on line 1.
--
--  What it changes
--    1. Two new functions:
--         wv_can_see_bid_finance()   - Tender team, Founder, CEO, VP, admin.
--         wv_can_request_document()  - AVP, DGM, VP, Founder, CEO, Tender
--                                       team, admin.
--    2. tender_bids and tender_emd: reading which firm a tender is filed
--       through, its quote/rank and its EMD payment status (paid, pending,
--       refunded) now additionally requires wv_can_see_bid_finance(), on top
--       of already being able to see the tender itself. AVP and DGM keep
--       seeing and working their own tenders - this narrows one thing inside
--       that: firm attribution and money. Nothing about WRITING these
--       changes; that was already tender-team-only.
--    3. tender_rfp_requests: raising a document request now requires
--       wv_can_request_document() instead of "anyone with tender access".
--    4. Wording only, no behaviour change: the tender stage 'RFP' becomes
--       'Document In Hand', the document-request type 'RFP' becomes 'Tender
--       Document', and the loss reasons 'Technical' / 'Financial' become
--       'Did Not Qualify' / 'Lost on Price'. Existing rows are migrated so
--       nothing is left showing a value that no longer appears in any
--       dropdown. 'Corrigendum' is unchanged in the database - only the
--       screen labels changed, in the app files, not here.
--
--  Nothing is dropped and no data is deleted.
-- ===========================================================================


-- ---------------------------------------------------------------------------
--  1. New role checks
-- ---------------------------------------------------------------------------

-- Who may see which firm a tender is filed through, its quote/rank, and its
-- EMD payment trail (what is out, what has come back). Narrower than "can see
-- the tender": AVP and DGM work their own tenders but do not see this - it
-- stays with the tender team and the leadership that watches the whole
-- portfolio.
create or replace function public.wv_can_see_bid_finance()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.user_profiles p
     where p.id = auth.uid()::text
       and coalesce(p.status,'active') <> 'inactive'
       and ( p.role = 'admin'
             or ( coalesce(p.tender_access, false)
                  and p.tender_role in ('founder','ceo','vp','tender_team') ) )
  );
$$;

-- Who may raise a document request. AVP and DGM are the ones closest to the
-- tender and the usual requesters; leadership and the tender team may still
-- raise their own. BD and a plain team member may not.
create or replace function public.wv_can_request_document()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.user_profiles p
     where p.id = auth.uid()::text
       and coalesce(p.status,'active') <> 'inactive'
       and ( p.role = 'admin'
             or ( coalesce(p.tender_access, false)
                  and p.tender_role in ('avp','dgm','vp','founder','ceo','tender_team') ) )
  );
$$;


-- ---------------------------------------------------------------------------
--  2. tender_bids: reading firm attribution and the quote is now also gated
--     on wv_can_see_bid_finance(), in addition to the existing "if you can
--     see the tender you can see this row" rule (the EXISTS subquery is
--     itself subject to the tenders table's own RLS, so that half is
--     unchanged). Writing stays tender-team-only, unchanged.
-- ---------------------------------------------------------------------------
drop policy if exists tbids_read on public.tender_bids;
create policy tbids_read on public.tender_bids for select to authenticated
  using (
    public.wv_can_see_bid_finance()
    and exists (select 1 from public.tenders t where t.id = tender_id)
  );


-- ---------------------------------------------------------------------------
--  3. tender_emd: reading EMD payment status now also requires
--     wv_can_see_bid_finance(). Writing stays tender-team-only (wv_can_edit_emd),
--     unchanged.
-- ---------------------------------------------------------------------------
drop policy if exists temd_read on public.tender_emd;
create policy temd_read on public.tender_emd for select to authenticated
  using (
    public.wv_can_see_bid_finance()
    and exists (select 1 from public.tenders t where t.id = tender_id)
  );


-- ---------------------------------------------------------------------------
--  4. tender_rfp_requests: raising a request now requires
--     wv_can_request_document() instead of merely having tender access.
--     Reading and deciding who prepares one are unchanged.
-- ---------------------------------------------------------------------------
drop policy if exists trfp_insert on public.tender_rfp_requests;
create policy trfp_insert on public.tender_rfp_requests for insert to authenticated
  with check (public.wv_can_request_document());


-- ---------------------------------------------------------------------------
--  5. Wording migration - existing rows only. The app no longer offers these
--     old values in any dropdown; this brings rows already on file into line
--     with what is now shown, so nothing quietly stops matching a filter.
-- ---------------------------------------------------------------------------
update public.tenders
   set stage = 'Document In Hand'
 where stage = 'RFP';

update public.tender_rfp_requests
   set doc_type = 'Tender Document'
 where doc_type = 'RFP';

update public.tenders
   set loss_reason = 'Did Not Qualify'
 where loss_reason = 'Technical';

update public.tenders
   set loss_reason = 'Lost on Price'
 where loss_reason = 'Financial';

update public.tender_bids
   set loss_reason = 'Did Not Qualify'
 where loss_reason = 'Technical';

update public.tender_bids
   set loss_reason = 'Lost on Price'
 where loss_reason = 'Financial';


-- ---------------------------------------------------------------------------
--  Verification
-- ---------------------------------------------------------------------------
select
  (select count(*) > 0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'wv_can_see_bid_finance'
  ) as bid_finance_guard_present,
  (select count(*) > 0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'wv_can_request_document'
  ) as request_document_guard_present,
  (select pg_get_expr(polqual, polrelid) like '%wv_can_see_bid_finance%'
     from pg_policy where polname = 'tbids_read'
  ) as bids_read_gated,
  (select pg_get_expr(polqual, polrelid) like '%wv_can_see_bid_finance%'
     from pg_policy where polname = 'temd_read'
  ) as emd_read_gated,
  (select pg_get_expr(polwithcheck, polrelid) like '%wv_can_request_document%'
     from pg_policy where polname = 'trfp_insert'
  ) as rfp_insert_gated,
  (select count(*) from public.tenders where stage = 'RFP') as stale_rfp_stage_rows,
  (select count(*) from public.tender_rfp_requests where doc_type = 'RFP') as stale_rfp_type_rows,
  (select count(*) from public.tenders where loss_reason in ('Technical','Financial')) as stale_tender_loss_rows,
  (select count(*) from public.tender_bids where loss_reason in ('Technical','Financial')) as stale_bid_loss_rows,
  (select count(*) from public.tenders where stage = 'Document In Hand') as migrated_stage_rows,
  (select count(*) from public.tenders where loss_reason in ('Did Not Qualify','Lost on Price')) as migrated_tender_loss_rows;

-- All six "stale_*" columns above should read 0. "*_gated" columns should
-- read true. The two "migrated_*" columns are just a sanity count - however
-- many rows you actually had using the old wording, not a fixed number.
