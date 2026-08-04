-- ===========================================================================
--  WeVois Tender Portal - DELETE / REMOVE OPTIONS
--
--  Run this on a database that already has TENDER-SETUP.sql,
--  TENDER-STAGES-UPDATE.sql and TENDER-ACCESS-WORDING-UPDATE.sql in it. It is
--  idempotent: run it as many times as you like.
--
--  Paste the WHOLE file into the Supabase SQL editor and select all of it
--  (Ctrl+A) before pressing Run. The editor executes only the selection, and
--  a partial selection fails with a confusing error on line 1.
--
--  What the user asked
--    "there is no option to delete/Remove any document, tender, requested
--     EMDs"
--
--  What this actually needed, table by table
--    - Tenders already have a delete option (the tender team and admin,
--      blocked outright while an EMD, bank guarantee or fee row is on file -
--      see the "dropping and deleting a tender" work from before). Nothing
--      changes here.
--    - EMD and fee rows already had a database policy letting the tender
--      team and admin delete one (temd_delete, added in
--      TENDER-STAGES-UPDATE.sql) - the screen simply never offered the
--      button. Fixed in the app files, not here.
--    - The company document vault had the same story: tcdocs_write already
--      covers delete for the tender team and admin. Fixed in the app files,
--      not here.
--    - Document requests had NO delete policy at all - the database would
--      have refused it even if a button had been added. That is the one
--      real gap this file closes.
--
--  What it adds
--    wv_can_delete_rfp(request_id) - true for an administrator, the CEO, the
--    VP or the Founder (the same people wv_can_assign_rfp() already trusts
--    to see and hand out every request), OR for whoever raised the request
--    themselves while it is still sitting at "Requested" - before anyone has
--    accepted it, held it, or started work on it. Once somebody has acted on
--    a request, only the four roles above may remove it, so a request
--    already in motion cannot vanish out from under whoever is working on
--    it. Deleting a request also removes its own timeline
--    (tender_rfp_events references it "on delete cascade") - that is
--    existing behaviour, not something this file changes.
--
--    The tender team is deliberately NOT given a blanket right here, even
--    though they prepare these requests. Postgres will only let a DELETE
--    match a row that ALSO passes the table's own SELECT policy (trfp_read),
--    and trfp_read only shows the tender team requests they raised or are
--    already assigned to - never the whole list. A wider promise here would
--    have been a lie: the button would show, the delete would silently
--    match 0 rows, and it would look broken. What the tender team keeps is
--    exactly the same self-service everyone else gets - withdrawing their
--    own request while it is still untouched.
--
--  Nothing is dropped and no data is deleted by running this file itself -
--  it only adds a policy that lets the app offer a working Delete button.
-- ===========================================================================


create or replace function public.wv_can_delete_rfp(p_request_id text)
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1
      from public.tender_rfp_requests r
      join public.user_profiles p on p.id = auth.uid()::text
     where r.id = p_request_id
       and coalesce(p.status,'active') <> 'inactive'
       and ( p.role = 'admin'
             or ( coalesce(p.tender_access, false)
                  and p.tender_role in ('ceo','vp','founder') )
             or ( r.requested_by = auth.uid()::text and r.status = 'Requested' ) )
  );
$$;

drop policy if exists trfp_delete on public.tender_rfp_requests;
create policy trfp_delete on public.tender_rfp_requests for delete to authenticated
  using (public.wv_can_delete_rfp(id));


-- ---------------------------------------------------------------------------
--  Verification
-- ---------------------------------------------------------------------------
select
  (select count(*) > 0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'wv_can_delete_rfp'
  ) as delete_rfp_guard_present,
  (select count(*) > 0 from pg_policy where polname = 'trfp_delete'
  ) as rfp_delete_policy_present,
  (select pg_get_expr(polqual, polrelid) like '%wv_can_delete_rfp%'
     from pg_policy where polname = 'trfp_delete'
  ) as rfp_delete_gated;

-- All three columns above should read true.
