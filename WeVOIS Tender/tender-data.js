/* WeVois Tender Portal - data layer.
   Loads AFTER tender-engine.js and uses its Supabase client, auth, formatting,
   escaping, charts and notifications. Standalone: no billing project involved. */
(function (global) {
  'use strict';

  var WV  = global.WV;
  var WVT = global.WVT = {};

  /* ==========================================================================
     1. CONSTANTS
     ========================================================================== */

  /* The stages a tender can be in.
   *
   * FREE FLOATING - the order below is for reading and grouping only. It is
   * NOT a sequence: any stage can be set at any time, a tender can go
   * backwards, and nothing checks that it passed through anything first.
   *
   * So never write "has it got past X" by comparing positions in this array.
   * Whether a bid was actually filed is submitted_at and nothing else - see
   * WVT.isSubmitted below. That is why stageRank() no longer exists. */
  WVT.STAGES = [
    'Spotted',
    'Under Review',
    'RFP',
    'NIT',
    'Go / No-Go',
    'Documents',
    'Proposal',
    'PPT',
    'Ready',
    'Submitted',
    'Bid Opened',
    'Awarded',
    'Not Awarded',
    'Closed'
  ];

  WVT.STAGE_HELP = {
    'Spotted':      'Found on the portal, nothing checked yet',
    'Under Review': 'Reading the document, checking eligibility',
    'RFP':          'Request for proposal in hand, being studied',
    'NIT':          'Notice inviting tender published by the authority',
    'Go / No-Go':   'Decision pending on whether we bid',
    'Documents':    'Preparing the papers this tender demands',
    'Proposal':     'Writing the technical and financial proposal',
    'PPT':          'Presentation to the authority',
    'Ready':        'Everything attached, waiting to upload',
    'Submitted':    'Bid filed with the authority',
    'Bid Opened':   'Technical or financial bid opened',
    'Awarded':      'We won it',
    'Not Awarded':  'We did not win it - record why',
    'Closed':       'Dropped, cancelled or otherwise finished'
  };

  /* Stages that mean the tender is finished, however it ended. This replaces
     the old OPEN_STAGES list, which assumed everything before 'Submitted' was
     still in play - an assumption free-floating stages break. */
  WVT.TERMINAL_STAGES = ['Awarded', 'Not Awarded', 'Closed'];

  /* Picking one of these as the stage writes the matching result. The database
     trigger tenders_sync_result does the same thing server-side, so it holds
     even for a bulk update or a hand-written query. */
  WVT.OUTCOME_STAGE_RESULT = { 'Awarded': 'Awarded', 'Not Awarded': 'Not Awarded' };

  WVT.RESULTS       = ['Pending', 'Awarded', 'Not Awarded', 'Cancelled'];

  /* Why a bid did not win. 'Other' is deliberately there: the day someone loses
     for a reason not on this list you want it written in the notes, not forced
     into the nearest wrong box where it quietly skews the reporting. */
  WVT.LOSS_REASONS = ['Technical', 'Financial', 'Wrong documents uploaded', 'Other'];
  WVT.GO_OPTIONS    = ['Undecided', 'Go', 'No-Go'];
  WVT.TENDER_TYPES  = ['Service', 'Works', 'Supply', 'PPP', 'Other'];

  WVT.EMD_KINDS  = ['EMD', 'Bank Guarantee', 'Tender Fee', 'Processing Fee', 'Security Deposit'];
  WVT.EMD_MODES  = ['DD', 'NEFT', 'RTGS', 'BG', 'Online', 'Exempted'];
  WVT.EMD_STATUS = ['Paid', 'Refund Due', 'Refunded', 'Forfeited', 'Exempted'];

  WVT.DOC_CATEGORIES = ['Statutory', 'Registration', 'Financial', 'Experience', 'Technical', 'Other'];
  WVT.CHECK_STATUS   = ['Pending', 'Requested', 'Received', 'Attached', 'Not Applicable'];

  WVT.RFP_STATUS = [
    'Requested', 'Accepted', 'In Preparation', 'Delivered',
    'Changes Requested', 'Revised', 'Closed', 'Rejected'
  ];
  WVT.RFP_OPEN    = ['Requested', 'Accepted', 'In Preparation', 'Changes Requested'];
  WVT.RFP_TYPES   = ['RFP', 'Technical Bid', 'Financial Bid', 'Affidavit', 'Undertaking', 'Other'];
  WVT.PRIORITIES  = ['Low', 'Normal', 'High', 'Urgent'];

  /* The window the leadership "what is coming up" list watches. */
  WVT.UPCOMING_DAYS = 15;

  WVT.TENDER_ROLES = ['founder', 'vp', 'avp', 'dgm', 'bd', 'tender_team', 'member'];
  WVT.ROLE_LABEL = {
    founder:     'Founder',
    vp:          'VP',
    avp:         'AVP',
    dgm:         'DGM',
    bd:          'BD Team',
    tender_team: 'Tender Team',
    member:      'Team member'
  };
  /* Sees every tender, whatever the team or region. */
  WVT.GLOBAL_ROLES = ['founder', 'tender_team'];

  /* Position in WVT.STAGES, for sorting and drawing only. Named to make misuse
     obvious: it is a display order, not a progression. Anything asking "how far
     has this got" is asking the wrong question now that stages float freely. */
  WVT.stageOrder = function (s) {
    var i = WVT.STAGES.indexOf(s);
    return i < 0 ? WVT.STAGES.length : i;
  };

  /* ==========================================================================
     2. STATE
     ========================================================================== */

  WVT.data = {
    teams: [], regions: [], tenders: [], emd: [], checklist: [],
    companyDocs: [], rfps: [], events: [], comments: [], corrigenda: [],
    firms: [], bids: []
  };

  WVT.me = null;      // the user_profiles row, with the tender columns
  WVT.profiles = [];  // everyone, for the "assigned to" pickers

  /* ==========================================================================
     3. WHO AM I / WHAT MAY I SEE
     ========================================================================== */

  /* Mirrors wv_can_see_tender() in the database. The database is the real
     guard - this only decides what the interface offers, so the user is never
     shown a control that would fail on save. */
  WVT.isGlobal = function () {
    var me = WVT.me;
    if (!me) return false;
    if (me.role === 'admin') return true;
    if (WVT.GLOBAL_ROLES.indexOf(me.tender_role) >= 0) return true;
    var t = WVT.teamById(me.tender_team_id);
    return !!(t && t.scope === 'global');
  };

  WVT.hasAccess = function () {
    var me = WVT.me;
    if (!me) return false;
    return !!(me.tender_access || me.role === 'admin');
  };

  WVT.isAdmin = function () {
    return !!(WVT.me && WVT.me.role === 'admin');
  };

  WVT.teamById = function (id) {
    if (!id) return null;
    for (var i = 0; i < WVT.data.teams.length; i++) {
      if (String(WVT.data.teams[i].id) === String(id)) return WVT.data.teams[i];
    }
    return null;
  };

  WVT.regionById = function (id) {
    if (!id) return null;
    for (var i = 0; i < WVT.data.regions.length; i++) {
      if (String(WVT.data.regions[i].id) === String(id)) return WVT.data.regions[i];
    }
    return null;
  };

  WVT.teamName   = function (id) { var t = WVT.teamById(id);   return t ? t.name : '—'; };
  WVT.regionName = function (id) { var r = WVT.regionById(id); return r ? r.name : '—'; };

  /* Every team id at or below `rootId`, matching wv_team_subtree(). */
  WVT.subtree = function (rootId) {
    var out = [];
    if (!rootId) return out;
    var queue = [String(rootId)];
    var guard = 0;
    while (queue.length && guard++ < 500) {
      var id = queue.shift();
      if (out.indexOf(id) >= 0) continue;
      out.push(id);
      WVT.data.teams.forEach(function (t) {
        if (t.parent_id != null && String(t.parent_id) === id) queue.push(String(t.id));
      });
    }
    return out;
  };

  /* The teams and regions this user may file a tender against. */
  WVT.myTeamIds = function () {
    if (WVT.isGlobal()) return WVT.data.teams.map(function (t) { return String(t.id); });
    return WVT.subtree(WVT.me && WVT.me.tender_team_id);
  };

  WVT.myRegionIds = function () {
    var all = WVT.data.regions.map(function (r) { return String(r.id); });
    if (WVT.isGlobal()) return all;
    var mine = (WVT.me && WVT.me.tender_region_ids) || [];
    if (!mine.length) return all;                  // no regions set = every region
    return all.filter(function (id) { return mine.indexOf(id) >= 0; });
  };

  WVT.canSee = function (teamId, regionId) {
    if (WVT.isGlobal()) return true;
    if (!WVT.hasAccess()) return false;
    var teamOk   = !teamId   || WVT.myTeamIds().indexOf(String(teamId))     >= 0;
    var regionOk = !regionId || WVT.myRegionIds().indexOf(String(regionId)) >= 0;
    return teamOk && regionOk;
  };

  /* Everyone who can see a tender can also comment on it and move it along -
     leadership included. Only deleting is restricted. */
  WVT.canEdit   = function (t) { return t ? WVT.canSee(t.team_id, t.region_id) : false; };
  WVT.canDelete = function ()  { return WVT.isAdmin() || WVT.isGlobal(); };
  WVT.canUpload = function () {
    if (WVT.isGlobal()) return true;
    var t = WVT.teamById(WVT.me && WVT.me.tender_team_id);
    return !!(t && t.can_upload);
  };
  /* Only the tender team (and admins) work on RFP requests. */
  WVT.isPreparer = function () {
    return WVT.isAdmin() || (WVT.me && WVT.me.tender_role === 'tender_team');
  };

  /* Who may record money movements.
   *
   * EMD, bank guarantees and fees are real cash leaving the company and coming
   * back, so this is deliberately NARROWER than "can see the tender": only the
   * tender team writes payments. Everyone who can see a tender still READS its
   * EMD - the founder and VP watch the amounts, they just do not change them.
   *
   * The admin is included as a safety valve: without it, deactivating the last
   * tender-team account would leave nobody able to fix a wrong refund date.
   *
   * Kept separate from isPreparer() even though the test is the same today, so
   * that changing who prepares RFPs cannot silently change who moves money.
   *
   * This mirrors wv_can_edit_emd() in the database, which is the real guard.
   * Hiding a button is courtesy, not security. */
  WVT.canEditEmd = function () { return WVT.isTenderTeam(); };

  /* The same test under an honest name, because it also governs the firm list -
     which is master data, not money. Mirrors wv_is_tender_team() in the
     database. One rule, two readable names, no chance of them drifting. */
  WVT.isTenderTeam = function () {
    if (WVT.isAdmin()) return true;
    var me = WVT.me;
    return !!(me && me.tender_access && me.tender_role === 'tender_team');
  };

  /* ==========================================================================
     4. DATES
     ========================================================================== */

  WVT.today = function () {
    var d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  };

  WVT.parseDate = function (v) {
    if (!v) return null;
    var d = new Date(String(v).length <= 10 ? String(v) + 'T00:00:00' : v);
    return isNaN(d.getTime()) ? null : d;
  };

  /* Days from today until `v`. Negative = already past. null = no date. */
  WVT.daysTo = function (v) {
    var d = WVT.parseDate(v);
    if (!d) return null;
    return Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - WVT.today()) / 86400000);
  };

  WVT.fmtDate = function (v) {
    var d = WVT.parseDate(v);
    if (!d) return '—';
    return String(d.getDate()).padStart(2, '0') + ' ' +
           WV.MONTH_NAMES[d.getMonth()] + ' ' + d.getFullYear();
  };

  WVT.monthKeyOf = function (v) {
    var d = WVT.parseDate(v);
    if (!d) return '';
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  };

  /* A tender still in play - the bid is not filed, it has not finished one way
     or another, and we have not decided against bidding. Stated as three things
     that are true rather than as a list of stages, so adding a stage later does
     not silently change what "live" means. */
  WVT.isLive = function (t) {
    if (!t) return false;
    if (t.go_no_go === 'No-Go') return false;
    if (WVT.isSubmitted(t)) return false;
    return WVT.TERMINAL_STAGES.indexOf(t.stage) < 0;
  };

  /* The bid was filed. This is the ONLY signal for that, and it is a fact
     somebody ticked with a date - never inferred from the stage, because
     stages float freely and a tender can sit in 'PPT' long after it was
     submitted, or be dragged back to 'Documents' by mistake. */
  WVT.isSubmitted = function (t) {
    return !!t && !!t.submitted_at;
  };

  /* Deadline urgency, used for the row colour and the countdown chip. */
  WVT.deadlineState = function (t) {
    if (!t) return { cls: 'ok', label: '—', days: null };
    var d = WVT.daysTo(t.submission_date);
    if (d == null) return { cls: 'ok', label: 'No date', days: null };
    if (WVT.isSubmitted(t)) return { cls: 'done', label: 'Submitted', days: d };
    if (d < 0)   return { cls: 'bad',  label: Math.abs(d) + 'd overdue', days: d };
    if (d === 0) return { cls: 'bad',  label: 'Due today',   days: d };
    if (d <= 3)  return { cls: 'bad',  label: d + 'd left',  days: d };
    if (d <= 7)  return { cls: 'warn', label: d + 'd left',  days: d };
    return { cls: 'ok', label: d + 'd left', days: d };
  };

  /* The leadership "next 15 days" list. */
  WVT.upcoming = function (days) {
    var win = days == null ? WVT.UPCOMING_DAYS : days;
    return WVT.data.tenders.filter(function (t) {
      if (WVT.isSubmitted(t)) return false;
      if (t.go_no_go === 'No-Go') return false;
      var d = WVT.daysTo(t.submission_date);
      return d != null && d <= win;          // includes anything already overdue
    }).sort(function (a, b) {
      return (WVT.daysTo(a.submission_date) || 0) - (WVT.daysTo(b.submission_date) || 0);
    });
  };

  /* ==========================================================================
     5. LOADING
     ========================================================================== */

  WVT.loadMe = async function () {
    if (!WV.currentUser) { WVT.me = null; return null; }
    var r = await WV.sb.from('user_profiles').select('*').eq('id', String(WV.currentUser.id)).maybeSingle();
    WVT.me = r.data || WV.currentUser;
    if (!Array.isArray(WVT.me.tender_region_ids)) WVT.me.tender_region_ids = [];
    return WVT.me;
  };

  function safe(promise, fallback) {
    return promise.then(function (r) {
      if (r && r.error) { console.warn('[tender]', r.error.message); return fallback; }
      return (r && r.data) || fallback;
    }).catch(function (e) { console.warn('[tender]', e); return fallback; });
  }

  WVT.loadAll = async function () {
    var sb = WV.sb;
    var res = await Promise.all([
      safe(sb.from('tender_teams').select('*').order('sort'), []),
      safe(sb.from('tender_regions').select('*').order('sort'), []),
      safe(sb.from('tenders').select('*').order('submission_date', { ascending: true, nullsFirst: false }), []),
      safe(sb.from('tender_emd').select('*').order('created_at', { ascending: false }), []),
      safe(sb.from('tender_checklist').select('*').order('sort'), []),
      safe(sb.from('tender_company_docs').select('*').eq('status', 'active').order('category').order('name'), []),
      safe(sb.from('tender_rfp_requests').select('*').order('requested_at', { ascending: false }), []),
      safe(sb.from('tender_comments').select('*').order('created_at', { ascending: false }), []),
      safe(sb.from('user_profiles').select('id,full_name,email,role,tender_team_id,tender_role,tender_region_ids,tender_access,status').order('full_name'), []),
      safe(sb.from('tender_corrigenda').select('*').order('issued_date', { ascending: false, nullsFirst: false }), []),
      safe(sb.from('tender_firms').select('*').order('sort').order('name'), []),
      safe(sb.from('tender_bids').select('*').order('created_at'), [])
    ]);

    WVT.data.teams       = res[0];
    WVT.data.regions     = res[1];
    WVT.data.tenders     = res[2];
    WVT.data.emd         = res[3];
    WVT.data.checklist   = res[4];
    WVT.data.companyDocs = res[5];
    WVT.data.rfps        = res[6];
    WVT.data.comments    = res[7];
    WVT.profiles         = res[8];
    WVT.data.corrigenda  = res[9];
    WVT.data.firms       = res[10];
    WVT.data.bids        = res[11];
    return WVT.data;
  };

  WVT.loadEvents = async function (requestId) {
    var r = await WV.sb.from('tender_rfp_events').select('*')
      .eq('request_id', String(requestId)).order('created_at', { ascending: true });
    return r.data || [];
  };

  WVT.tenderById = function (id) {
    if (!id) return null;
    for (var i = 0; i < WVT.data.tenders.length; i++) {
      if (String(WVT.data.tenders[i].id) === String(id)) return WVT.data.tenders[i];
    }
    return null;
  };

  WVT.profileById = function (id) {
    if (!id) return null;
    for (var i = 0; i < WVT.profiles.length; i++) {
      if (String(WVT.profiles[i].id) === String(id)) return WVT.profiles[i];
    }
    return null;
  };

  WVT.personName = function (id) {
    var p = WVT.profileById(id);
    return p ? (p.full_name || p.email) : '—';
  };

  WVT.checklistFor = function (tenderId) {
    return WVT.data.checklist.filter(function (c) { return String(c.tender_id) === String(tenderId); });
  };
  WVT.emdFor = function (tenderId) {
    return WVT.data.emd.filter(function (e) { return String(e.tender_id) === String(tenderId); });
  };
  WVT.rfpsFor = function (tenderId) {
    return WVT.data.rfps.filter(function (r) { return String(r.tender_id) === String(tenderId); });
  };
  WVT.commentsFor = function (tenderId) {
    return WVT.data.comments.filter(function (c) { return String(c.tender_id) === String(tenderId); });
  };

  /* ==========================================================================
     6. WRITES
     ========================================================================== */

  /* Columns that a slightly older database may not have yet. If Postgres
     complains about one, drop it and retry rather than losing the whole save. */
  var TENDER_OPTIONAL = [
    { col: 'contract_months',   what: 'the contract period' },
    { col: 'processing_fee',    what: 'the processing fee' },
    { col: 'eligibility_notes', what: 'the eligibility notes' }
  ];

  WVT.saveTender = async function (body, id) {
    var payload = Object.assign({}, body);
    var dropped = [];
    var r;

    for (var attempt = 0; attempt <= TENDER_OPTIONAL.length; attempt++) {
      r = id
        ? await WV.sb.from('tenders').update(payload).eq('id', String(id)).select().maybeSingle()
        : await WV.sb.from('tenders').insert(payload).select().maybeSingle();
      if (!r.error) break;

      var hit = null;
      for (var i = 0; i < TENDER_OPTIONAL.length; i++) {
        var o = TENDER_OPTIONAL[i];
        if (payload[o.col] !== undefined && new RegExp(o.col, 'i').test(r.error.message || '')) { hit = o; break; }
      }
      if (!hit) break;
      delete payload[hit.col];
      dropped.push(hit.what);
    }

    if (r.error) return { ok: false, error: r.error.message };
    return {
      ok: true,
      row: r.data,
      warning: dropped.length
        ? 'Saved, but ' + dropped.join(' and ') + ' was not stored - run WEVOIS-TENDER-01-setup.sql in Supabase first.'
        : null
    };
  };

  WVT.deleteTender = async function (id) {
    var r = await WV.sb.from('tenders').delete().eq('id', String(id));
    return r.error ? { ok: false, error: r.error.message } : { ok: true };
  };

  WVT.addComment = async function (tenderId, body) {
    var text = String(body || '').trim();
    if (!text) return { ok: false, error: 'Write something first.' };
    var r = await WV.sb.from('tender_comments').insert({
      tender_id: String(tenderId),
      body: text,
      author_id: String(WV.currentUser.id),
      author_name: WV.currentUser.full_name || WV.currentUser.email,
      author_role: WVT.ROLE_LABEL[WVT.me && WVT.me.tender_role] || WV.roleLabel(WV.currentUser.role)
    }).select().maybeSingle();
    if (r.error) return { ok: false, error: r.error.message };
    WVT.data.comments.unshift(r.data);
    return { ok: true, row: r.data };
  };

  /* ==========================================================================
     FIRMS AND PER-FIRM BIDS

     WeVois enters the same tender through two to five of its firms. Each files
     its own proposal, pays its own EMD, gets its own rank, and one may win.

     Where the outcome lives: the TENDER keeps the overall Awarded / Not
     Awarded, because that is what the dashboard counts. The BID keeps the
     quote, the rank and that firm's own result. The tender's own quoted_value
     and our_rank are still used when no bids are recorded - a tender entered by
     a single firm needs no bid rows at all.
     ========================================================================== */

  WVT.firmById = function (id) {
    if (!id) return null;
    for (var i = 0; i < WVT.data.firms.length; i++) {
      if (String(WVT.data.firms[i].id) === String(id)) return WVT.data.firms[i];
    }
    return null;
  };

  WVT.firmName = function (id) {
    var f = WVT.firmById(id);
    return f ? (f.short_name || f.name) : '—';
  };

  /* Inactive firms stay selectable on records that already use them, but are
     not offered for anything new. */
  WVT.activeFirms = function () {
    return WVT.data.firms.filter(function (f) { return f.status !== 'inactive'; });
  };

  WVT.bidsFor = function (tenderId) {
    var id = String(tenderId);
    return WVT.data.bids.filter(function (b) { return String(b.tender_id) === id; })
      .sort(function (a, b) {
        return String(a.our_rank || 'zz').localeCompare(String(b.our_rank || 'zz'));
      });
  };

  WVT.hasBids = function (tenderId) { return WVT.bidsFor(tenderId).length > 0; };

  /* Which firms have not entered this tender yet - so the picker cannot offer a
     duplicate the database would refuse anyway. */
  WVT.firmsNotBidding = function (tenderId, exceptFirmId) {
    var taken = {};
    WVT.bidsFor(tenderId).forEach(function (b) {
      if (String(b.firm_id) !== String(exceptFirmId || '')) taken[String(b.firm_id)] = 1;
    });
    return WVT.activeFirms().filter(function (f) { return !taken[String(f.id)]; });
  };

  WVT.saveFirm = async function (body, id) {
    if (!id) body.created_by = String(WV.currentUser.id);
    var r = id
      ? await WV.sb.from('tender_firms').update(body).eq('id', String(id)).select().maybeSingle()
      : await WV.sb.from('tender_firms').insert(body).select().maybeSingle();
    if (r.error) {
      /* The unique index is on lower(name), so a near-duplicate is caught by
         the database rather than by a check the interface could get wrong. */
      if (/tfirms_name_uidx|duplicate key/i.test(r.error.message)) {
        return { ok: false, error: 'A firm with that name already exists.' };
      }
      return { ok: false, error: r.error.message };
    }
    return { ok: true, row: r.data };
  };

  WVT.deleteFirm = async function (id) {
    var r = await WV.sb.from('tender_firms').delete().eq('id', String(id));
    if (r.error) {
      /* on delete restrict: a firm that has bid on something cannot be removed
         without orphaning the record of who bid what. */
      if (/foreign key|violates/i.test(r.error.message)) {
        return { ok: false, error: 'This firm has bids against it. Mark it inactive instead — deleting it would erase the record of what it bid.' };
      }
      return { ok: false, error: r.error.message };
    }
    return { ok: true };
  };

  WVT.saveBid = async function (body, id) {
    if (!id) body.created_by = String(WV.currentUser.id);
    var r = id
      ? await WV.sb.from('tender_bids').update(body).eq('id', String(id)).select().maybeSingle()
      : await WV.sb.from('tender_bids').insert(body).select().maybeSingle();
    if (r.error) {
      if (/tbids_tender_firm_uidx|duplicate key/i.test(r.error.message)) {
        return { ok: false, error: 'That firm is already entered into this tender.' };
      }
      return { ok: false, error: r.error.message };
    }
    return { ok: true, row: r.data };
  };

  WVT.deleteBid = async function (id) {
    var r = await WV.sb.from('tender_bids').delete().eq('id', String(id));
    return r.error ? { ok: false, error: r.error.message } : { ok: true };
  };

  /* EMD split by firm. tenderId omitted = company-wide.
     Rows with no firm are grouped under a null id and labelled honestly rather
     than being guessed at - every payment recorded before firms existed lands
     there, and pretending otherwise would invent data. */
  WVT.emdByFirm = function (tenderId) {
    var rows = WVT.data.emd.filter(function (e) {
      return !tenderId || String(e.tender_id) === String(tenderId);
    });
    var map = {};
    rows.forEach(function (e) {
      var k = e.firm_id ? String(e.firm_id) : '';
      if (!map[k]) {
        map[k] = {
          firmId: e.firm_id || null,
          name: e.firm_id ? WVT.firmName(e.firm_id) : 'Not attributed to a firm',
          out: 0, refunded: 0, forfeited: 0, count: 0
        };
      }
      var a = Number(e.amount || 0);
      map[k].count++;
      if (e.status === 'Paid' || e.status === 'Refund Due') map[k].out += a;
      if (e.status === 'Refunded')  map[k].refunded  += a;
      if (e.status === 'Forfeited') map[k].forfeited += a;
    });
    return Object.keys(map).map(function (k) { return map[k]; })
      .sort(function (a, b) { return b.out - a.out; });
  };

  /* ==========================================================================
     CORRIGENDA

     A corrigendum is an amendment the authority issues against a live tender.
     It is not a stage: it can arrive at any point and the tender carries on
     from wherever it was. What it usually does is move the dates - and because
     the portal is updated at the same time, the tender's own dates have to
     move with it or every countdown on the dashboard goes stale.

     So saving one does two writes: the corrigendum row keeps what the dates
     WERE (prev_*) alongside what they became (new_*), and the tender itself is
     updated to the new ones. The history survives on the corrigendum.
     ========================================================================== */

  var CORR_DATE_FIELDS = [
    { corr: 'pre_bid_date',    tender: 'pre_bid_date' },
    { corr: 'query_last_date', tender: 'query_last_date' },
    { corr: 'submission_date', tender: 'submission_date' },
    { corr: 'opening_date',    tender: 'opening_date' }
  ];

  WVT.corrigendaFor = function (tenderId) {
    var id = String(tenderId);
    return WVT.data.corrigenda.filter(function (c) { return String(c.tender_id) === id; })
      .sort(function (a, b) {
        return String(b.issued_date || '').localeCompare(String(a.issued_date || ''));
      });
  };

  WVT.corrigendumCount = function (tenderId) {
    return WVT.corrigendaFor(tenderId).length;
  };

  /* body carries new_* dates only. prev_* are read off the tender here rather
     than trusted from the caller, so the audit trail cannot be fabricated by a
     stale form. Returns which tender dates actually moved. */
  WVT.saveCorrigendum = async function (tenderId, body) {
    var t = WVT.tenderById(tenderId);
    if (!t) return { ok: false, error: 'That tender is no longer loaded. Refresh and try again.' };

    var row = {
      tender_id: String(tenderId),
      corrigendum_no: body.corrigendum_no || null,
      issued_date: body.issued_date || null,
      summary: body.summary || null,
      portal_updated: !!body.portal_updated,
      doc_url: body.doc_url || null,
      created_by: String(WV.currentUser.id)
    };

    var tenderPatch = {};
    var moved = [];
    CORR_DATE_FIELDS.forEach(function (f) {
      var next = body['new_' + f.corr] || null;
      row['new_' + f.corr]  = next;
      row['prev_' + f.corr] = t[f.tender] || null;
      /* Only touch the tender when the corrigendum actually carries a
         different date. A blank field means "this one did not change". */
      if (next && next !== (t[f.tender] || null)) {
        tenderPatch[f.tender] = next;
        moved.push({ field: f.tender, from: t[f.tender] || null, to: next });
      }
    });

    var r = await WV.sb.from('tender_corrigenda').insert(row).select().maybeSingle();
    if (r.error) return { ok: false, error: r.error.message };
    WVT.data.corrigenda.unshift(r.data);

    /* The tender update is second on purpose: if it fails the corrigendum is
       still on record, which is the half worth keeping. */
    if (Object.keys(tenderPatch).length) {
      var u = await WV.sb.from('tenders').update(tenderPatch)
        .eq('id', String(tenderId)).select().maybeSingle();
      if (u.error) {
        return { ok: true, row: r.data, moved: [], error: u.error.message, datesFailed: true };
      }
      if (u.data) {
        var i = WVT.data.tenders.findIndex(function (x) { return String(x.id) === String(tenderId); });
        if (i >= 0) WVT.data.tenders[i] = u.data;
      }
    }
    return { ok: true, row: r.data, moved: moved };
  };

  WVT.deleteCorrigendum = async function (id) {
    var r = await WV.sb.from('tender_corrigenda').delete().eq('id', String(id));
    if (r.error) return { ok: false, error: r.error.message };
    WVT.data.corrigenda = WVT.data.corrigenda.filter(function (c) { return String(c.id) !== String(id); });
    return { ok: true };
  };

  /* Give a brand-new tender the standard document checklist so nobody has to
     type 23 rows by hand. */
  WVT.seedChecklist = async function (tenderId, docIds) {
    var docs = WVT.data.companyDocs.filter(function (d) {
      return !docIds || docIds.indexOf(String(d.id)) >= 0;
    });
    if (!docs.length) return { ok: true, count: 0 };
    var rows = docs.map(function (d, i) {
      return {
        tender_id: String(tenderId),
        name: d.name,
        category: d.category,
        required: true,
        status: d.file_path ? 'Received' : 'Pending',
        company_doc_id: String(d.id),
        sort: (i + 1) * 10,
        created_by: String(WV.currentUser.id)
      };
    });
    var r = await WV.sb.from('tender_checklist').insert(rows).select();
    if (r.error) return { ok: false, error: r.error.message };
    WVT.data.checklist = WVT.data.checklist.concat(r.data || []);
    return { ok: true, count: (r.data || []).length };
  };

  WVT.saveChecklistItem = async function (body, id) {
    var r = id
      ? await WV.sb.from('tender_checklist').update(body).eq('id', String(id)).select().maybeSingle()
      : await WV.sb.from('tender_checklist').insert(body).select().maybeSingle();
    return r.error ? { ok: false, error: r.error.message } : { ok: true, row: r.data };
  };

  WVT.deleteChecklistItem = async function (id) {
    var r = await WV.sb.from('tender_checklist').delete().eq('id', String(id));
    return r.error ? { ok: false, error: r.error.message } : { ok: true };
  };

  WVT.saveEmd = async function (body, id) {
    var r = id
      ? await WV.sb.from('tender_emd').update(body).eq('id', String(id)).select().maybeSingle()
      : await WV.sb.from('tender_emd').insert(body).select().maybeSingle();
    return r.error ? { ok: false, error: r.error.message } : { ok: true, row: r.data };
  };

  WVT.saveCompanyDoc = async function (body, id) {
    var r = id
      ? await WV.sb.from('tender_company_docs').update(body).eq('id', String(id)).select().maybeSingle()
      : await WV.sb.from('tender_company_docs').insert(body).select().maybeSingle();
    return r.error ? { ok: false, error: r.error.message } : { ok: true, row: r.data };
  };

  WVT.saveRfp = async function (body, id) {
    var r = id
      ? await WV.sb.from('tender_rfp_requests').update(body).eq('id', String(id)).select().maybeSingle()
      : await WV.sb.from('tender_rfp_requests').insert(body).select().maybeSingle();
    return r.error ? { ok: false, error: r.error.message } : { ok: true, row: r.data };
  };

  /* A free-text note on an RFP request. The status trigger writes its own
     rows; this is for "any changes" the requester wants on record. */
  WVT.addRfpNote = async function (requestId, note) {
    var text = String(note || '').trim();
    if (!text) return { ok: false, error: 'Write something first.' };
    var r = await WV.sb.from('tender_rfp_events').insert({
      request_id: String(requestId),
      event: 'comment',
      note: text,
      actor_id: String(WV.currentUser.id),
      actor_name: WV.currentUser.full_name || WV.currentUser.email,
      actor_email: WV.currentUser.email
    }).select().maybeSingle();
    return r.error ? { ok: false, error: r.error.message } : { ok: true, row: r.data };
  };

  /* ==========================================================================
     7. FILES
     ========================================================================== */

  WVT.BUCKET = 'tenders';

  WVT.uploadFile = async function (folder, file) {
    var check = WV.validateUpload(file);
    if (!check.ok) return check;
    var clean = String(file.name).replace(/[^A-Za-z0-9._-]/g, '_');
    var path  = folder + '/' + Date.now() + '-' + clean;
    var r = await WV.sb.storage.from(WVT.BUCKET).upload(path, check.file || file, { upsert: false });
    if (r.error) return { ok: false, error: r.error.message };
    return { ok: true, path: path };
  };

  WVT.fileUrl = async function (path) {
    if (!path) return null;
    if (/^https?:\/\//i.test(path)) return path;
    try {
      var r = await WV.sb.storage.from(WVT.BUCKET).createSignedUrl(path, 3600);
      if (r.error || !r.data) return null;
      return r.data.signedUrl;
    } catch (e) { return null; }
  };

  /* ==========================================================================
     8. READING A TENDER NOTICE PDF
     ========================================================================== */

  function num(s) { return Number(String(s).replace(/[,\s]/g, '')) || 0; }

  /* Turn the many Indian date spellings into YYYY-MM-DD. */
  var MON = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };

  WVT.normDate = function (raw) {
    if (!raw) return null;
    var s = String(raw).trim();
    var m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);      // 12/08/2026
    if (m) {
      var y = m[3].length === 2 ? '20' + m[3] : m[3];
      return y + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[1]).padStart(2, '0');
    }
    m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);                          // 2026-08-12
    if (m) return m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0');
    m = s.match(/^(\d{1,2})[\s\-]*([A-Za-z]{3,9})[\s\-,]*(\d{2,4})$/);     // 12 Aug 2026
    if (m) {
      var mi = MON[m[2].slice(0, 3).toLowerCase()];
      if (mi == null) return null;
      var yy = m[3].length === 2 ? '20' + m[3] : m[3];
      return yy + '-' + String(mi + 1).padStart(2, '0') + '-' + String(m[1]).padStart(2, '0');
    }
    m = s.match(/^([A-Za-z]{3,9})[\s\-]*(\d{1,2})[\s\-,]*(\d{2,4})$/);     // Aug 12, 2026
    if (m) {
      var mi2 = MON[m[1].slice(0, 3).toLowerCase()];
      if (mi2 == null) return null;
      var y2 = m[3].length === 2 ? '20' + m[3] : m[3];
      return y2 + '-' + String(mi2 + 1).padStart(2, '0') + '-' + String(m[2]).padStart(2, '0');
    }
    return null;
  };

  var DATE_RX = '(\\d{1,2}[\\/\\-.]\\d{1,2}[\\/\\-.]\\d{2,4}' +
                '|\\d{4}-\\d{1,2}-\\d{1,2}' +
                '|\\d{1,2}[\\s\\-]*[A-Za-z]{3,9}[\\s\\-,]*\\d{2,4}' +
                '|[A-Za-z]{3,9}[\\s\\-]*\\d{1,2}[\\s\\-,]*\\d{2,4})';

  /* Find the first date that appears after any of `labels`. */
  function dateNear(txt, labels) {
    for (var i = 0; i < labels.length; i++) {
      var rx = new RegExp(labels[i] + '[^\\n]{0,80}?' + DATE_RX, 'i');
      var m  = txt.match(rx);
      if (m) {
        var d = WVT.normDate(m[1]);
        if (d) return d;
      }
    }
    return null;
  }

  /* Find the first rupee figure that appears after any of `labels`. */
  function moneyNear(txt, labels) {
    for (var i = 0; i < labels.length; i++) {
      var rx = new RegExp(labels[i] + '[^\\n]{0,90}?(?:Rs\\.?|INR|\\u20b9)?\\s*([\\d,]{3,20}(?:\\.\\d{1,2})?)', 'i');
      var m  = txt.match(rx);
      if (m) {
        var v = num(m[1]);
        if (v > 0) return v;
      }
    }
    return null;
  }

  WVT.parseTenderText = function (txt) {
    var res = {
      hasText: !!(txt && txt.trim().length > 60),
      nitNo: null, title: null, authority: null,
      estimatedValue: null, emdAmount: null, tenderFee: null, processingFee: null,
      publishedDate: null, preBidDate: null, queryLastDate: null,
      submissionDate: null, openingDate: null,
      contractMonths: null, portalUrl: null, found: []
    };
    if (!res.hasText) return res;

    var clean = String(txt).replace(/[ \t]+/g, ' ');

    var nit = clean.match(/(?:NIT|N\.I\.T\.?|Tender)\s*(?:No\.?|Number|Ref\.?)\s*[:\-]?\s*([A-Za-z0-9\/\-_.]{4,40})/i);
    if (nit) { res.nitNo = nit[1].replace(/[.,]$/, ''); res.found.push('NIT number'); }

    var auth = clean.match(/(?:Municipal Corporation|Nagar Nigam|Nagar Palika|Nagar Parishad|Municipal Council|Development Authority|Municipality)[^\n,.;]{0,45}/i);
    if (auth) { res.authority = auth[0].trim(); res.found.push('authority'); }

    var name = clean.match(/(?:Name of (?:the )?Work|Work\s*Description|Subject|Title of (?:the )?Tender)\s*[:\-]\s*([^\n]{8,180})/i);
    if (name) { res.title = name[1].trim(); res.found.push('title'); }

    res.estimatedValue = moneyNear(clean, ['Estimated\\s*(?:Cost|Value)', 'Tender\\s*Value', 'Contract\\s*Value', 'Approx(?:imate)?\\s*(?:Cost|Value)']);
    if (res.estimatedValue) res.found.push('estimated value');

    res.emdAmount = moneyNear(clean, ['EMD', 'Earnest\\s*Money(?:\\s*Deposit)?', 'Bid\\s*Security']);
    if (res.emdAmount) res.found.push('EMD');

    res.tenderFee = moneyNear(clean, ['Tender\\s*(?:Fee|Document\\s*(?:Fee|Cost)|Cost)', 'Cost\\s*of\\s*(?:Tender|Bid)\\s*Document']);
    if (res.tenderFee) res.found.push('tender fee');

    res.processingFee = moneyNear(clean, ['Processing\\s*Fee', 'e-?Tender\\s*(?:Processing\\s*)?Fee', 'Portal\\s*Fee']);
    if (res.processingFee) res.found.push('processing fee');

    res.publishedDate = dateNear(clean, ['Date\\s*of\\s*(?:Publish|Publication)', 'Published\\s*(?:on|Date)', 'Tender\\s*Publish']);
    if (res.publishedDate) res.found.push('published date');

    res.preBidDate = dateNear(clean, ['Pre[\\s\\-]?Bid\\s*(?:Meeting|Conference)?']);
    if (res.preBidDate) res.found.push('pre-bid date');

    res.queryLastDate = dateNear(clean, ['(?:Last\\s*Date|Due\\s*Date)\\s*(?:for|of)\\s*(?:Query|Queries|Clarification)', 'Seeking\\s*Clarification']);
    if (res.queryLastDate) res.found.push('query last date');

    res.submissionDate = dateNear(clean, [
      '(?:Last\\s*Date|Due\\s*Date|Closing\\s*Date)\\s*(?:and\\s*Time\\s*)?(?:for|of)\\s*(?:Online\\s*)?(?:Bid\\s*)?Submission',
      'Bid\\s*Submission\\s*(?:End|Last|Closing)\\s*Date',
      'Submission\\s*(?:End\\s*)?Date',
      'Last\\s*Date\\s*of\\s*Receipt'
    ]);
    if (res.submissionDate) res.found.push('submission date');

    res.openingDate = dateNear(clean, [
      '(?:Date\\s*of\\s*)?(?:Technical\\s*)?Bid\\s*Opening',
      'Opening\\s*(?:of\\s*)?(?:Technical\\s*)?(?:Bid|Tender)',
      'Tender\\s*Opening\\s*Date'
    ]);
    if (res.openingDate) res.found.push('opening date');

    var mon = clean.match(/(?:Contract\s*Period|Period\s*of\s*Contract|Duration\s*of\s*(?:the\s*)?Contract|Completion\s*Period)\s*[:\-]?\s*(\d{1,3})\s*(month|year)/i);
    if (mon) {
      res.contractMonths = Number(mon[1]) * (/year/i.test(mon[2]) ? 12 : 1);
      res.found.push('contract period');
    }

    var url = clean.match(/https?:\/\/[^\s)"']{6,120}/i);
    if (url) { res.portalUrl = url[0].replace(/[.,;]$/, ''); res.found.push('portal link'); }

    return res;
  };

  WVT.readTenderPdf = async function (file) {
    if (!file) return { ok: false, error: 'No file.' };
    var isPdf = /pdf/i.test(file.type) || /\.pdf$/i.test(file.name || '');
    if (!isPdf) return { ok: false, notPdf: true, error: 'Not a PDF - only the fields you type will be saved.' };
    try {
      var txt = await WV.pdfText(file);
      var parsed = WVT.parseTenderText(txt);
      if (!parsed.hasText) {
        return { ok: false, scanned: true,
                 error: 'This PDF is a scan (no text layer), so nothing could be read automatically. Please type the details.' };
      }
      return { ok: true, parsed: parsed };
    } catch (e) {
      return { ok: false, error: 'Could not read the PDF: ' + (e.message || e) };
    }
  };

  /* ==========================================================================
     9. ROLL-UPS
     ========================================================================== */

  WVT.filterTenders = function (f) {
    f = f || {};
    return WVT.data.tenders.filter(function (t) {
      if (f.region && f.region !== 'all' && String(t.region_id) !== f.region) return false;
      if (f.team   && f.team   !== 'all' && String(t.team_id)   !== f.team)   return false;
      if (f.stage  && f.stage  !== 'all' && t.stage             !== f.stage)  return false;
      if (f.result && f.result !== 'all' && (t.result || 'Pending') !== f.result) return false;
      if (f.month  && f.month  !== 'all' && WVT.monthKeyOf(t.submission_date) !== f.month) return false;
      if (f.owner  && f.owner  !== 'all' && String(t.owner_id)  !== f.owner)  return false;
      if (f.q) {
        var hay = [t.title, t.nit_no, t.authority, t.city, t.department].join(' ').toLowerCase();
        if (hay.indexOf(String(f.q).toLowerCase()) < 0) return false;
      }
      return true;
    });
  };

  /* Every month that has at least one tender, newest first. */
  WVT.monthsPresent = function (list) {
    var seen = {}, out = [];
    (list || WVT.data.tenders).forEach(function (t) {
      var k = WVT.monthKeyOf(t.submission_date);
      if (k && !seen[k]) { seen[k] = 1; out.push(k); }
    });
    return out.sort().reverse();
  };

  WVT.summary = function (list) {
    var t = {
      total: list.length, live: 0, submitted: 0, awarded: 0, lost: 0,
      value: 0, wonValue: 0, emdOut: 0, dueSoon: 0, overdue: 0
    };
    list.forEach(function (x) {
      if (WVT.isLive(x)) t.live++;
      if (WVT.isSubmitted(x)) t.submitted++;
      if (x.result === 'Awarded') { t.awarded++; t.wonValue += Number(x.awarded_value || x.quoted_value || 0); }
      if (x.result === 'Not Awarded') t.lost++;
      t.value += Number(x.estimated_value || 0);
      var d = WVT.deadlineState(x);
      if (d.cls === 'bad' && !WVT.isSubmitted(x)) {
        if (d.days != null && d.days < 0) t.overdue++; else t.dueSoon++;
      } else if (d.cls === 'warn') t.dueSoon++;
    });
    var decided = t.awarded + t.lost;
    t.winRate = decided ? t.awarded / decided : null;
    return t;
  };

  /* Money that has left the company for a tender and has not come back. */
  WVT.emdOutstanding = function (tenderIds) {
    var set = tenderIds ? {} : null;
    if (set) tenderIds.forEach(function (id) { set[String(id)] = 1; });
    var rows = WVT.data.emd.filter(function (e) {
      if (set && !set[String(e.tender_id)]) return false;
      return e.status === 'Paid' || e.status === 'Refund Due';
    });
    var total = 0;
    rows.forEach(function (e) { total += Number(e.amount || 0); });
    return { rows: rows, total: total, count: rows.length };
  };

  WVT.stageCounts = function (list) {
    var out = {};
    WVT.STAGES.forEach(function (s) { out[s] = 0; });
    list.forEach(function (t) { if (out[t.stage] != null) out[t.stage]++; });
    return out;
  };

  WVT.regionCounts = function (list) {
    var out = {};
    WVT.data.regions.forEach(function (r) { out[r.id] = { name: r.name, count: 0, value: 0 }; });
    list.forEach(function (t) {
      var k = String(t.region_id);
      if (!out[k]) out[k] = { name: WVT.regionName(t.region_id), count: 0, value: 0 };
      out[k].count++;
      out[k].value += Number(t.estimated_value || 0);
    });
    return out;
  };

  /* Documents about to expire - the vault's whole reason for existing. */
  WVT.expiringDocs = function (days) {
    var win = days == null ? 60 : days;
    return WVT.data.companyDocs.filter(function (d) {
      var n = WVT.daysTo(d.expiry_date);
      return n != null && n <= win;
    }).sort(function (a, b) {
      return (WVT.daysTo(a.expiry_date) || 0) - (WVT.daysTo(b.expiry_date) || 0);
    });
  };

  WVT.checklistProgress = function (tenderId) {
    var items = WVT.checklistFor(tenderId);
    var req = items.filter(function (i) { return i.required && i.status !== 'Not Applicable'; });
    var done = req.filter(function (i) { return i.status === 'Attached' || i.status === 'Received'; });
    return { total: req.length, done: done.length, pct: req.length ? done.length / req.length : 0, items: items };
  };

  /* How long the tender team is taking. */
  WVT.rfpStats = function (list) {
    var rows = list || WVT.data.rfps;
    var open = 0, late = 0, delivered = 0, hours = 0, n = 0;
    rows.forEach(function (r) {
      if (WVT.RFP_OPEN.indexOf(r.status) >= 0) {
        open++;
        var d = WVT.daysTo(r.needed_by);
        if (d != null && d < 0) late++;
      }
      var end = r.delivered_at || r.revised_at || r.closed_at;
      if (end && r.requested_at) {
        delivered++;
        hours += (Date.parse(end) - Date.parse(r.requested_at)) / 3600000;
        n++;
      }
    });
    return {
      total: rows.length, open: open, late: late, delivered: delivered,
      avgHours: n ? hours / n : null
    };
  };

  WVT.rfpIsLate = function (r) {
    if (WVT.RFP_OPEN.indexOf(r.status) < 0) return false;
    var d = WVT.daysTo(r.needed_by);
    return d != null && d < 0;
  };

  /* ==========================================================================
     10. SMALL RENDER HELPERS
     ========================================================================== */

  WVT.stageBadge = function (stage) {
    var s = stage || 'Spotted';
    var cls = 'b-open';
    if (s === 'Submitted' || s === 'Bid Opened' || s === 'Awarded') cls = 'b-paid';
    if (s === 'Not Awarded') cls = 'b-hold';
    if (s === 'Closed') cls = 'b-none';
    return '<span class="badge ' + cls + '">' + WV.esc(s) + '</span>';
  };

  WVT.resultBadge = function (result) {
    var r = result || 'Pending';
    var cls = r === 'Awarded' ? 'b-paid' : (r === 'Not Awarded' || r === 'Cancelled') ? 'b-hold' : 'b-none';
    return '<span class="badge ' + cls + '">' + WV.esc(r) + '</span>';
  };

  WVT.deadlineChip = function (t) {
    var d = WVT.deadlineState(t);
    return '<span class="age ' + d.cls + '">' + WV.esc(d.label) + '</span>';
  };

  WVT.rfpBadge = function (status) {
    var s = status || 'Requested';
    var cls = 'b-open';
    if (s === 'Delivered' || s === 'Closed' || s === 'Revised') cls = 'b-paid';
    if (s === 'Rejected' || s === 'Changes Requested') cls = 'b-hold';
    return '<span class="badge ' + cls + '">' + WV.esc(s) + '</span>';
  };

  WVT.expiryChip = function (dateStr) {
    var n = WVT.daysTo(dateStr);
    if (n == null) return '<span class="muted">No expiry</span>';
    if (n < 0)   return '<span class="age bad">Expired ' + Math.abs(n) + 'd ago</span>';
    if (n <= 30) return '<span class="age bad">' + n + 'd left</span>';
    if (n <= 60) return '<span class="age warn">' + n + 'd left</span>';
    return '<span class="age ok">' + n + 'd left</span>';
  };

})(typeof window !== 'undefined' ? window : this);
