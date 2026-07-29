-- WeVois Tender Portal - complete database setup. Select ALL of this file and Run.
--
-- This is a STANDALONE system. It creates its own users, its own tables and its
-- own storage in a FRESH Supabase project. It does not read, write or depend on
-- the billing project in any way.
--
-- Run this ONCE on a brand-new project, then open the portal: the first screen
-- asks you to create the very first administrator account.
--
-- SECTIONS
--   1  Tables
--   2  Seed rows (regions, org units, standard document types)
--   3  Indexes
--   4  Triggers
--   5  Auth: first account becomes the administrator
--   6  Security helper functions
--   7  Storage
--   8  Row Level Security
--   9  Verification


-- ===========================================================================
--  SECTION 1 - TABLES
-- ===========================================================================

-- 1.1  People. `id` matches the Supabase Auth user id (text).
--      role       - what they may administer (admin | leadership | member)
--      tender_*   - where they sit in the org, and what they may therefore see
create table if not exists public.user_profiles (
  id                text primary key,
  full_name         text not null default '',
  email             text unique not null,
  role              text not null default 'member',
  employee_id       text,
  mobile_no         text,
  designation       text,
  status            text not null default 'active',        -- active | inactive
  tender_team_id    text,
  tender_role       text,
  tender_region_ids text[] not null default '{}',
  tender_access     boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on column public.user_profiles.tender_team_id    is 'tender_teams.id - which org unit this person sits in';
comment on column public.user_profiles.tender_role       is 'founder | vp | avp | dgm | bd | tender_team | member';
comment on column public.user_profiles.tender_region_ids is 'tender_regions.id list. Empty array = every region.';
comment on column public.user_profiles.tender_access     is 'may open the portal at all';

-- 1.2  Regions a tender can belong to (Rajasthan, Madhya Pradesh, ...).
create table if not exists public.tender_regions (
  id         text primary key,               -- lowercase slug, e.g. 'rajasthan'
  name       text not null,
  sort       integer not null default 100,
  created_at timestamptz not null default now()
);

-- 1.3  Org units. A tree: Founder -> VP -> AVP / DGM / BD, plus the Tender Team.
--      scope = 'global'  -> members see EVERY tender (Founder, Tender Team)
--      scope = 'subtree' -> members see their own unit and everything under it
create table if not exists public.tender_teams (
  id         text primary key,               -- lowercase slug, e.g. 'avp'
  name       text not null,
  parent_id  text references public.tender_teams(id) on delete set null,
  scope      text not null default 'subtree',   -- global | subtree
  can_upload boolean not null default true,     -- may add new tenders
  sort       integer not null default 100,
  created_at timestamptz not null default now(),
  constraint tender_teams_scope_ck check (scope in ('global','subtree'))
);

do $$ begin
  alter table public.user_profiles
    add constraint user_profiles_tender_team_fk
    foreign key (tender_team_id) references public.tender_teams(id) on delete set null;
exception when duplicate_object then null;
end $$;

-- 1.4  A tender.
create table if not exists public.tenders (
  id                text primary key default gen_random_uuid()::text,
  nit_no            text,                    -- NIT / tender reference number
  title             text not null,
  authority         text,                    -- ULB / department inviting the bid
  department        text,
  city              text,
  region_id         text references public.tender_regions(id) on delete set null,
  team_id           text references public.tender_teams(id)   on delete set null,
  owner_id          text,                    -- user_profiles.id of the person driving it
  tender_type       text,                    -- Service | Works | Supply | PPP | Other
  scope_summary     text,
  portal_url        text,
  -- money
  estimated_value   numeric not null default 0,
  emd_amount        numeric not null default 0,
  tender_fee        numeric not null default 0,
  processing_fee    numeric not null default 0,
  -- key dates
  published_date    date,
  pre_bid_date      date,
  query_last_date   date,
  submission_date   date,                    -- the deadline that drives every alert
  submission_time   text,
  opening_date      date,
  contract_months   integer,
  -- eligibility
  eligibility_notes text,
  -- workflow
  stage             text not null default 'Spotted',
  go_no_go          text,                    -- Go | No-Go
  go_no_go_reason   text,
  go_no_go_by       text,
  go_no_go_at       timestamptz,
  -- submission and result
  submitted_at      timestamptz,
  submitted_by      text,
  quoted_value      numeric,
  our_rank          text,                    -- L1, L2, ...
  result            text,                    -- Pending | Awarded | Not Awarded | Cancelled
  result_date       date,
  awarded_to        text,
  awarded_value     numeric,
  result_notes      text,
  -- why a bid did not win. Plain text with no check constraint, like stage and
  -- result above: the vocabulary lives in the app, so adding a reason later
  -- needs no migration.
  loss_reason       text,                    -- Technical | Financial | Wrong documents uploaded | Other
  loss_reason_notes text,
  remarks           text,
  created_by        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- 1.5  Money paid as EMD / bank guarantee, and whether it came back.
create table if not exists public.tender_emd (
  id            text primary key default gen_random_uuid()::text,
  tender_id     text not null references public.tenders(id) on delete cascade,
  kind          text not null default 'EMD',   -- EMD | Bank Guarantee | Tender Fee | Processing Fee | Security Deposit
  amount        numeric not null default 0,
  mode          text,                          -- DD | NEFT | RTGS | BG | Online | Exempted
  instrument_no text,
  bank          text,
  paid_on       date,
  valid_till    date,
  status        text not null default 'Paid',  -- Paid | Refund Due | Refunded | Forfeited | Exempted
  refund_due_on date,
  refunded_on   date,
  refund_ref    text,
  file_path     text,
  notes         text,
  created_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- 1.6  The company document vault - one row per master document, with expiry.
create table if not exists public.tender_company_docs (
  id           text primary key default gen_random_uuid()::text,
  name         text not null,
  category     text,                 -- Statutory | Registration | Financial | Experience | Technical | Other
  doc_no       text,
  issuer       text,
  issue_date   date,
  expiry_date  date,                 -- NULL = never expires
  file_path    text,
  version      integer not null default 1,
  owner_id     text,
  notes        text,
  status       text not null default 'active',   -- active | archived
  created_by   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- 1.7  The checklist for one tender: what that tender demands, and where it is.
create table if not exists public.tender_checklist (
  id             text primary key default gen_random_uuid()::text,
  tender_id      text not null references public.tenders(id) on delete cascade,
  name           text not null,
  category       text,
  required       boolean not null default true,
  status         text not null default 'Pending',  -- Pending | Requested | Received | Attached | Not Applicable
  company_doc_id text references public.tender_company_docs(id) on delete set null,
  assigned_to    text,
  due_date       date,
  file_path      text,
  notes          text,
  sort           integer not null default 100,
  created_by     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- 1.8  A request to the tender team to prepare an RFP / document.
--      Every state change is also written to tender_rfp_events (1.9).
create table if not exists public.tender_rfp_requests (
  id                  text primary key default gen_random_uuid()::text,
  tender_id           text references public.tenders(id) on delete set null,
  title               text not null,
  doc_type            text,                  -- RFP | Technical Bid | Financial Bid | Affidavit | Undertaking | Other
  description         text,
  priority            text not null default 'Normal',   -- Low | Normal | High | Urgent
  needed_by           date,
  requested_by        text,                  -- user_profiles.id
  requested_by_team   text references public.tender_teams(id) on delete set null,
  assigned_to         text,                  -- tender team member handling it
  status              text not null default 'Requested',
      -- Requested | Accepted | In Preparation | Delivered | Changes Requested | Revised | Closed | Rejected
  current_version     integer not null default 0,
  file_path           text,                  -- latest delivered file
  -- the timeline, one column per milestone so reporting is a plain query
  requested_at        timestamptz not null default now(),
  accepted_at         timestamptz,
  started_at          timestamptz,
  delivered_at        timestamptz,
  change_requested_at timestamptz,
  revised_at          timestamptz,
  closed_at           timestamptz,
  rejected_at         timestamptz,
  reject_reason       text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- 1.9  Full audit timeline for an RFP request. Never updated, only appended.
create table if not exists public.tender_rfp_events (
  id          bigint generated always as identity primary key,
  request_id  text not null references public.tender_rfp_requests(id) on delete cascade,
  event       text not null,        -- status | comment | file | assign
  from_status text,
  to_status   text,
  note        text,
  file_path   text,
  version     integer,
  actor_id    text,
  actor_name  text,
  actor_email text,
  created_at  timestamptz not null default now()
);

-- 1.10  Comments on a tender. Leadership comment as well as edit.
create table if not exists public.tender_comments (
  id          bigint generated always as identity primary key,
  tender_id   text not null references public.tenders(id) on delete cascade,
  body        text not null,
  author_id   text,
  author_name text,
  author_role text,
  created_at  timestamptz not null default now()
);

-- 1.10b  Corrigenda - amendments the authority issues against a live tender.
--        NOT a pipeline stage: one can arrive at any point and the tender
--        carries on from wherever it was. What it usually does is move dates,
--        and because the portal is updated at the same time the tender's own
--        dates move with it.
--          new_*  = what this corrigendum changed the date TO (null = untouched)
--          prev_* = what it was immediately before, so the history survives
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

-- 1.11  Bell notifications.
create table if not exists public.notifications (
  id               bigint generated always as identity primary key,
  title            text not null,
  message          text not null default '',
  type             text,
  recipient_role   text default 'all',
  site_id          text,
  user_id          text,
  read             boolean not null default false,
  created_by_email text,
  created_at       timestamptz not null default now()
);

-- 1.12  Audit trail.
create table if not exists public.activity_logs (
  id                 text primary key default gen_random_uuid()::text,
  action             text not null,
  details            text not null default '',
  target             text,
  performed_by_name  text,
  performed_by_email text,
  performed_by_role  text,
  created_at         timestamptz not null default now()
);


-- ===========================================================================
--  SECTION 2 - SEED ROWS
-- ===========================================================================

insert into public.tender_regions (id, name, sort) values
  ('rajasthan',      'Rajasthan',      10),
  ('madhya-pradesh', 'Madhya Pradesh', 20),
  ('other',          'Other',          900)
on conflict (id) do nothing;

-- The org tree. Rename or extend these from inside the app - nothing is hardcoded.
-- Foreign keys are checked at the end of the statement, so a child may name a
-- parent inserted by the same statement.
insert into public.tender_teams (id, name, parent_id, scope, can_upload, sort) values
  ('founder',     'Founder',                null,      'global',  true, 10),
  ('tender-team', 'Tender Team',            null,      'global',  true, 20),
  ('vp',          'VP',                     'founder', 'subtree', true, 30),
  ('avp',         'AVP (Rajasthan and MP)', 'vp',      'subtree', true, 40),
  ('dgm',         'DGM',                    'vp',      'subtree', true, 50),
  ('bd',          'BD Team',                'vp',      'subtree', true, 60),
  ('crm',         'CRM Team',               'vp',      'subtree', true, 70)
on conflict (id) do nothing;

-- The documents almost every Indian municipal tender asks for. Used to
-- pre-fill a new tender's checklist; edit the list in the app at any time.
-- Seeded ONLY while the vault is empty, so re-running this file never
-- duplicates rows and never resurrects a document you deleted.
insert into public.tender_company_docs (name, category, notes)
select * from (values
  ('PAN Card',                            'Statutory',    'Company PAN'),
  ('GST Registration Certificate',        'Statutory',    null),
  ('EPF Registration Certificate',        'Statutory',    null),
  ('ESIC Registration Certificate',       'Statutory',    null),
  ('Labour Licence',                      'Statutory',    null),
  ('Certificate of Incorporation',        'Registration', null),
  ('MOA and AOA',                         'Registration', null),
  ('Partnership Deed / LLP Agreement',    'Registration', null),
  ('Board Resolution / Power of Attorney','Registration', null),
  ('Audited Balance Sheet - Year 1',      'Financial',    null),
  ('Audited Balance Sheet - Year 2',      'Financial',    null),
  ('Audited Balance Sheet - Year 3',      'Financial',    null),
  ('Turnover Certificate (CA)',           'Financial',    null),
  ('Solvency Certificate',                'Financial',    null),
  ('Bank Details / Cancelled Cheque',     'Financial',    null),
  ('Income Tax Returns - 3 Years',        'Financial',    null),
  ('Work Experience Certificates',        'Experience',   null),
  ('Work Completion Certificates',        'Experience',   null),
  ('Performance Certificates',            'Experience',   null),
  ('List of Equipment / Machinery',       'Technical',    null),
  ('Key Personnel CVs',                   'Technical',    null),
  ('Affidavit - Not Blacklisted',         'Statutory',    null),
  ('Tender Acceptance Undertaking',       'Statutory',    null)
) as seed(name, category, notes)
where not exists (select 1 from public.tender_company_docs);


-- ===========================================================================
--  SECTION 3 - INDEXES
-- ===========================================================================
create index if not exists profiles_email_idx    on public.user_profiles (lower(email));
create index if not exists profiles_team_idx     on public.user_profiles (tender_team_id);
create index if not exists tenders_team_idx      on public.tenders (team_id);
create index if not exists tenders_region_idx    on public.tenders (region_id);
create index if not exists tenders_stage_idx     on public.tenders (stage);
create index if not exists tenders_sub_date_idx  on public.tenders (submission_date);
create index if not exists tenders_owner_idx     on public.tenders (owner_id);
create index if not exists emd_tender_idx        on public.tender_emd (tender_id);
create index if not exists emd_status_idx        on public.tender_emd (status);
create index if not exists checklist_tender_idx  on public.tender_checklist (tender_id);
create index if not exists rfp_tender_idx        on public.tender_rfp_requests (tender_id);
create index if not exists rfp_status_idx        on public.tender_rfp_requests (status);
create index if not exists rfp_requester_idx     on public.tender_rfp_requests (requested_by);
create index if not exists rfp_events_req_idx    on public.tender_rfp_events (request_id, created_at);
create index if not exists tcomments_tender_idx  on public.tender_comments (tender_id, created_at);
comment on table public.tender_corrigenda is
  'One row per corrigendum issued against a tender. Append-only in practice: the prev_* columns are the audit trail of what the dates were before.';
comment on column public.tenders.loss_reason is
  'Why we did not win: Technical | Financial | Wrong documents uploaded | Other. Only meaningful when result = ''Not Awarded''.';
comment on column public.tenders.loss_reason_notes is
  'Free text detail, used mainly when loss_reason = ''Other''.';

create index if not exists tcorr_tender_idx      on public.tender_corrigenda (tender_id, issued_date desc);
create index if not exists cdocs_expiry_idx      on public.tender_company_docs (expiry_date);
create index if not exists notifications_time_idx on public.notifications (created_at desc);
create index if not exists activity_time_idx     on public.activity_logs (created_at desc);


-- ===========================================================================
--  SECTION 4 - TRIGGERS
-- ===========================================================================

create or replace function public.wv_touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists profiles_touch on public.user_profiles;
create trigger profiles_touch before update on public.user_profiles
  for each row execute function public.wv_touch_updated_at();

drop trigger if exists tenders_touch on public.tenders;
create trigger tenders_touch before update on public.tenders
  for each row execute function public.wv_touch_updated_at();

drop trigger if exists temd_touch on public.tender_emd;
create trigger temd_touch before update on public.tender_emd
  for each row execute function public.wv_touch_updated_at();

drop trigger if exists tcdocs_touch on public.tender_company_docs;
create trigger tcdocs_touch before update on public.tender_company_docs
  for each row execute function public.wv_touch_updated_at();

drop trigger if exists tchk_touch on public.tender_checklist;
create trigger tchk_touch before update on public.tender_checklist
  for each row execute function public.wv_touch_updated_at();

drop trigger if exists trfp_touch on public.tender_rfp_requests;
create trigger trfp_touch before update on public.tender_rfp_requests
  for each row execute function public.wv_touch_updated_at();


-- ===========================================================================
--  SECTION 5 - AUTH
-- ===========================================================================

-- 5.1  Is the system brand new? SECURITY DEFINER so a signed-out visitor gets
--      the TRUE answer even with RLS on. Without this the app would count 0
--      rows (because RLS hides them), show the setup screen on a live system,
--      and let a stranger register themselves as the administrator.
create or replace function public.wv_needs_setup()
returns boolean language sql security definer stable set search_path = public as $$
  select not exists (select 1 from public.user_profiles);
$$;

revoke all on function public.wv_needs_setup() from public;
grant execute on function public.wv_needs_setup() to anon, authenticated;

-- 5.2  When a Supabase Auth user is created, create/relink their profile.
--      SECURITY: the role is decided HERE, never by the sign-up request.
--        * the very first account ever created becomes the administrator,
--          with full tender access and global visibility
--        * every later sign-up becomes a powerless member with tender_access
--          FALSE and no org unit - an admin switches them on inside the app
create or replace function public.handle_new_auth_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_is_first boolean;
begin
  select not exists (select 1 from public.user_profiles) into v_is_first;

  insert into public.user_profiles (
    id, full_name, email, role, employee_id, mobile_no, status,
    tender_team_id, tender_role, tender_region_ids, tender_access)
  values (
    new.id::text,
    coalesce(nullif(new.raw_user_meta_data->>'full_name', ''), split_part(new.email, '@', 1)),
    new.email,
    case when v_is_first then 'admin' else 'member' end,
    new.raw_user_meta_data->>'employee_id',
    new.raw_user_meta_data->>'mobile_no',
    'active',
    case when v_is_first then 'founder' else null end,
    case when v_is_first then 'founder' else null end,
    '{}',
    v_is_first
  )
  on conflict (email) do update set
    id        = excluded.id,          -- relink an existing profile to the real uid
    full_name = coalesce(nullif(excluded.full_name, ''), public.user_profiles.full_name),
    status    = 'active';
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_auth_user();


-- Keep result in step with the Awarded / Not Awarded stages.
--
-- Stages float freely - any stage can be set at any time - so the outcome
-- stages are the natural place to say how a bid ended. But the dashboard, the
-- win rate and the CSV all read the result column. Syncing here rather than in
-- the browser means it holds however the row was written: the app, a bulk
-- update, or a query typed into the SQL editor.
--
-- One way only: stage drives result. Setting result on its own still works, so
-- a tender can be marked Cancelled without a matching stage.
create or replace function public.wv_tender_sync_result()
returns trigger
language plpgsql
as $fn$
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
$fn$;

drop trigger if exists tenders_sync_result on public.tenders;
create trigger tenders_sync_result
  before insert or update on public.tenders
  for each row execute function public.wv_tender_sync_result();


-- ===========================================================================
--  SECTION 6 - SECURITY HELPER FUNCTIONS
-- ===========================================================================

create or replace function public.is_admin() returns boolean
  language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.user_profiles
                  where id = auth.uid()::text
                    and role = 'admin'
                    and coalesce(status,'active') <> 'inactive');
$$;

-- Every team id at or below a given unit. Used by the visibility rules.
create or replace function public.wv_team_subtree(p_team text)
returns table (id text)
language sql stable set search_path = public as $$
  with recursive t as (
    select tt.id from public.tender_teams tt where tt.id = p_team
    union all
    select c.id from public.tender_teams c join t on c.parent_id = t.id
  )
  select id from t;
$$;

-- Does the signed-in user see everything? Yes for an administrator, for anyone
-- whose tender_role is founder or tender_team, and for anyone sitting in a unit
-- whose scope is 'global'.
create or replace function public.wv_tender_is_global()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1
      from public.user_profiles p
      left join public.tender_teams t on t.id = p.tender_team_id
     where p.id = auth.uid()::text
       and coalesce(p.status,'active') <> 'inactive'
       and ( p.role = 'admin'
             or p.tender_role in ('founder','tender_team')
             or t.scope = 'global' )
  );
$$;

-- Who may record money movements.
--
-- EMD, bank guarantees and fees are real cash leaving the company and coming
-- back. A wrong refund date is a real problem, so this is deliberately NARROWER
-- than "can see the tender": only the Tender Team records payments.
--
-- The administrator is included as a safety valve. Without it, deactivating the
-- last tender-team account would leave nobody able to correct a mistake except
-- through the SQL editor.
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

-- The core visibility rule: team AND region must both match.
-- A user with no regions set is treated as covering every region.
create or replace function public.wv_can_see_tender(p_team text, p_region text)
returns boolean language sql security definer stable set search_path = public as $$
  select public.wv_tender_is_global()
      or exists (
        select 1
          from public.user_profiles p
         where p.id = auth.uid()::text
           and coalesce(p.status,'active') <> 'inactive'
           and coalesce(p.tender_access, false)
           and p.tender_team_id is not null
           and ( p_team is null
                 or p_team in (select id from public.wv_team_subtree(p.tender_team_id)) )
           and ( cardinality(p.tender_region_ids) = 0
                 or p_region is null
                 or p_region = any (p.tender_region_ids) )
      );
$$;

-- May this user open the portal at all?
create or replace function public.wv_has_tender_access()
returns boolean language sql security definer stable set search_path = public as $$
  select exists (
    select 1 from public.user_profiles p
     where p.id = auth.uid()::text
       and coalesce(p.status,'active') <> 'inactive'
       and (coalesce(p.tender_access,false) or p.role = 'admin')
  );
$$;

-- Every RFP request change writes one immutable timeline row.
create or replace function public.wv_rfp_log()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_name  text;
  v_email text;
begin
  select full_name, email into v_name, v_email
    from public.user_profiles where id = auth.uid()::text;

  if tg_op = 'INSERT' then
    insert into public.tender_rfp_events
      (request_id, event, to_status, note, actor_id, actor_name, actor_email)
    values (new.id, 'status', new.status, 'Request raised',
            auth.uid()::text, v_name, v_email);
    return new;
  end if;

  if new.status is distinct from old.status then
    insert into public.tender_rfp_events
      (request_id, event, from_status, to_status, file_path, version,
       actor_id, actor_name, actor_email)
    values (new.id, 'status', old.status, new.status, new.file_path,
            new.current_version, auth.uid()::text, v_name, v_email);
  end if;

  if new.assigned_to is distinct from old.assigned_to then
    insert into public.tender_rfp_events
      (request_id, event, note, actor_id, actor_name, actor_email)
    values (new.id, 'assign',
            'Assigned to ' || coalesce(new.assigned_to,'nobody'),
            auth.uid()::text, v_name, v_email);
  end if;

  if new.current_version is distinct from old.current_version then
    insert into public.tender_rfp_events
      (request_id, event, note, file_path, version,
       actor_id, actor_name, actor_email)
    values (new.id, 'file', 'Version ' || new.current_version || ' uploaded',
            new.file_path, new.current_version,
            auth.uid()::text, v_name, v_email);
  end if;

  return new;
end $$;

drop trigger if exists rfp_log_ins on public.tender_rfp_requests;
create trigger rfp_log_ins after insert on public.tender_rfp_requests
  for each row execute function public.wv_rfp_log();

drop trigger if exists rfp_log_upd on public.tender_rfp_requests;
create trigger rfp_log_upd after update on public.tender_rfp_requests
  for each row execute function public.wv_rfp_log();

-- Stamp the milestone columns automatically from the status.
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
  return new;
end $$;

drop trigger if exists rfp_stamp on public.tender_rfp_requests;
create trigger rfp_stamp before insert or update on public.tender_rfp_requests
  for each row execute function public.wv_rfp_stamp();


-- ===========================================================================
--  SECTION 7 - STORAGE
-- ===========================================================================
insert into storage.buckets (id, name, public)
values ('tenders', 'tenders', false)
on conflict (id) do update set public = false;

drop policy if exists tender_files_read   on storage.objects;
drop policy if exists tender_files_upload on storage.objects;
drop policy if exists tender_files_update on storage.objects;
drop policy if exists tender_files_delete on storage.objects;

create policy tender_files_read   on storage.objects for select to authenticated
  using (bucket_id = 'tenders' and public.wv_has_tender_access());
create policy tender_files_upload on storage.objects for insert to authenticated
  with check (bucket_id = 'tenders' and public.wv_has_tender_access());
create policy tender_files_update on storage.objects for update to authenticated
  using (bucket_id = 'tenders' and public.wv_has_tender_access());
create policy tender_files_delete on storage.objects for delete to authenticated
  using (bucket_id = 'tenders' and public.is_admin());


-- ===========================================================================
--  SECTION 8 - ROW LEVEL SECURITY
-- ===========================================================================
alter table public.user_profiles       enable row level security;
alter table public.tender_regions      enable row level security;
alter table public.tender_teams        enable row level security;
alter table public.tenders             enable row level security;
alter table public.tender_emd          enable row level security;
alter table public.tender_company_docs enable row level security;
alter table public.tender_checklist    enable row level security;
alter table public.tender_rfp_requests enable row level security;
alter table public.tender_rfp_events   enable row level security;
alter table public.tender_comments     enable row level security;
alter table public.tender_corrigenda   enable row level security;
alter table public.notifications       enable row level security;
alter table public.activity_logs       enable row level security;

-- People: everyone signed in can see the staff list (needed for the "assigned
-- to" pickers); only an administrator may change it.
drop policy if exists profiles_read  on public.user_profiles;
drop policy if exists profiles_write on public.user_profiles;
create policy profiles_read  on public.user_profiles for select to authenticated using (true);
create policy profiles_write on public.user_profiles for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists tregions_read  on public.tender_regions;
drop policy if exists tregions_write on public.tender_regions;
create policy tregions_read  on public.tender_regions for select to authenticated using (true);
create policy tregions_write on public.tender_regions for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

drop policy if exists tteams_read  on public.tender_teams;
drop policy if exists tteams_write on public.tender_teams;
create policy tteams_read  on public.tender_teams for select to authenticated using (true);
create policy tteams_write on public.tender_teams for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- Tenders: read and write are both gated by the team-AND-region rule.
drop policy if exists tenders_read   on public.tenders;
drop policy if exists tenders_insert on public.tenders;
drop policy if exists tenders_update on public.tenders;
drop policy if exists tenders_delete on public.tenders;
create policy tenders_read   on public.tenders for select to authenticated
  using (public.wv_can_see_tender(team_id, region_id));
create policy tenders_insert on public.tenders for insert to authenticated
  with check (public.wv_can_see_tender(team_id, region_id));
create policy tenders_update on public.tenders for update to authenticated
  using (public.wv_can_see_tender(team_id, region_id))
  with check (public.wv_can_see_tender(team_id, region_id));
create policy tenders_delete on public.tenders for delete to authenticated
  using (public.is_admin() or public.wv_tender_is_global());

-- Child tables inherit the parent tender's visibility.
-- EMD is the one child table that is NOT "see it, edit it". Everyone who can
-- see the tender reads its payments; only the tender team (and an admin) may
-- write them. Split into four policies because a single `for all` would hand
-- write access to every reader.
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

drop policy if exists tchk_all on public.tender_checklist;
create policy tchk_all on public.tender_checklist for all to authenticated
  using (exists (select 1 from public.tenders t where t.id = tender_id))
  with check (exists (select 1 from public.tenders t where t.id = tender_id));

drop policy if exists tcorr_all on public.tender_corrigenda;
create policy tcorr_all on public.tender_corrigenda for all to authenticated
  using      (exists (select 1 from public.tenders t where t.id = tender_id))
  with check (exists (select 1 from public.tenders t where t.id = tender_id));

drop policy if exists tcom_read  on public.tender_comments;
drop policy if exists tcom_write on public.tender_comments;
create policy tcom_read  on public.tender_comments for select to authenticated
  using (exists (select 1 from public.tenders t where t.id = tender_id));
create policy tcom_write on public.tender_comments for insert to authenticated
  with check (exists (select 1 from public.tenders t where t.id = tender_id));

-- The document vault is company-wide: anyone with access reads it, the tender
-- team and administrators maintain it.
drop policy if exists tcdocs_read  on public.tender_company_docs;
drop policy if exists tcdocs_write on public.tender_company_docs;
create policy tcdocs_read  on public.tender_company_docs for select to authenticated
  using (public.wv_has_tender_access());
create policy tcdocs_write on public.tender_company_docs for all to authenticated
  using (public.wv_tender_is_global()) with check (public.wv_tender_is_global());

-- RFP requests: you see your own, anything for a tender you can see, and the
-- tender team / founder see them all.
drop policy if exists trfp_read   on public.tender_rfp_requests;
drop policy if exists trfp_insert on public.tender_rfp_requests;
drop policy if exists trfp_update on public.tender_rfp_requests;
create policy trfp_read on public.tender_rfp_requests for select to authenticated
  using ( public.wv_tender_is_global()
          or requested_by = auth.uid()::text
          or assigned_to  = auth.uid()::text
          or (tender_id is not null
              and exists (select 1 from public.tenders t where t.id = tender_id)) );
create policy trfp_insert on public.tender_rfp_requests for insert to authenticated
  with check (public.wv_has_tender_access());
create policy trfp_update on public.tender_rfp_requests for update to authenticated
  using ( public.wv_tender_is_global()
          or requested_by = auth.uid()::text
          or assigned_to  = auth.uid()::text );

drop policy if exists trfpev_read   on public.tender_rfp_events;
drop policy if exists trfpev_insert on public.tender_rfp_events;
create policy trfpev_read on public.tender_rfp_events for select to authenticated
  using (exists (select 1 from public.tender_rfp_requests r where r.id = request_id));
create policy trfpev_insert on public.tender_rfp_events for insert to authenticated
  with check (public.wv_has_tender_access());

drop policy if exists notif_read   on public.notifications;
drop policy if exists notif_insert on public.notifications;
drop policy if exists notif_update on public.notifications;
create policy notif_read   on public.notifications for select to authenticated using (true);
create policy notif_insert on public.notifications for insert to authenticated with check (true);
create policy notif_update on public.notifications for update to authenticated
  using (true) with check (true);

drop policy if exists audit_read   on public.activity_logs;
drop policy if exists audit_insert on public.activity_logs;
create policy audit_read   on public.activity_logs for select to authenticated using (public.is_admin());
create policy audit_insert on public.activity_logs for insert to authenticated with check (true);


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

-- ===========================================================================
--  SECTION 13 - VERIFICATION
--  Expect:  15  -  3  -  7  -  23  -  15  -  true
--  tables, regions, org units, standard documents, RLS-protected tables,
--  and "the system is brand new, go and create the first administrator".
-- ===========================================================================
select
  (select count(*) from information_schema.tables
    where table_schema = 'public'
      and table_name in ('user_profiles','tender_regions','tender_teams','tenders',
                         'tender_emd','tender_company_docs','tender_checklist',
                         'tender_rfp_requests','tender_rfp_events','tender_comments',
                         'tender_corrigenda','tender_firms','tender_bids',
                         'notifications','activity_logs')
  ) as tables_found,
  (select count(*) from public.tender_regions)      as regions_seeded,
  (select count(*) from public.tender_teams)        as org_units_seeded,
  (select count(*) from public.tender_company_docs) as standard_docs_seeded,
  (select count(*) from pg_tables
    where schemaname = 'public' and rowsecurity = true)      as rls_enabled,
  public.wv_needs_setup()                                    as needs_first_run;
