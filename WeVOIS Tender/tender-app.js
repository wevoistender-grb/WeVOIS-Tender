/* WeVois Tender Portal - interface.
   Depends on tender-engine.js (WV) and tender-data.js (WVT). */
(function () {
  'use strict';

  var $ = WV.$, esc = WV.esc, on = WV.on, show = WV.show;

  var state = {
    view: 'dash',
    upDays: 15,
    group: 'month',
    rfpFilter: 'open',
    emdFilter: 'out',
    detailTab: 'info',
    detailId: null,
    editId: null,
    editEmdId: null,
    corrTenderId: null,
    decideId: null,
    editFirmId: null,
    bidTenderId: null,
    editBidId: null,
    editDocId: null,
    editTeamId: null,
    editPersonId: null,
    pendingDocFile: null
  };

  /* ========================================================================
     SMALL HELPERS
     ======================================================================== */

  function opts(list, sel, blank) {
    var h = blank ? '<option value="">' + esc(blank) + '</option>' : '';
    return h + list.map(function (o) {
      var v = (o && o.value !== undefined) ? o.value : o;
      var l = (o && o.label !== undefined) ? o.label : o;
      return '<option value="' + esc(v) + '"' + (String(v) === String(sel) ? ' selected' : '') + '>' + esc(l) + '</option>';
    }).join('');
  }

  function banner(id, msg, kind) {
    var el = $(id);
    if (!el) return;
    if (!msg) { el.style.display = 'none'; el.textContent = ''; return; }
    el.className = 'banner' + (kind ? ' ' + kind : '');
    el.style.display = 'flex';
    el.textContent = msg;
  }

  function val(id) { var e = $(id); return e ? String(e.value || '').trim() : ''; }
  function numOrNull(id) { var v = val(id); return v === '' ? null : Number(v); }
  function dateOrNull(id) { var v = val(id); return v === '' ? null : v; }
  function setVal(id, v) { var e = $(id); if (e) e.value = (v == null ? '' : v); }
  function setChk(id, v) { var e = $(id); if (e) e.checked = !!v; }

  function empty(msg) { return '<div class="empty">' + esc(msg) + '</div>'; }

  /* --- stacked overlays ---------------------------------------------------
     The EMD, RFP and corrigendum dialogs can open ON TOP of an open tender
     file. WV's global handler closes EVERY overlay, which would drop the user
     back to the dashboard instead of back to the tender they were working on.
     So when one of these is stacked we close only the top one, and swallow the
     event before the global handler sees it. */
  var STACKABLE = ['emdOverlay', 'rfpOverlay', 'corrOverlay', 'bidOverlay', 'decideOverlay'];

  function detailOpen() {
    var el = $('detailOverlay');
    return !!(el && el.classList.contains('open'));
  }

  function closeTop(id) {
    var el = $(id);
    if (el) el.classList.remove('open');
  }

  /* Close whichever stacked dialog is open, if any. Returns true if it did. */
  function closeStackedIfAny() {
    if (!detailOpen()) return false;
    var hit = false;
    STACKABLE.forEach(function (id) {
      var el = $(id);
      if (el && el.classList.contains('open')) { el.classList.remove('open'); hit = true; }
    });
    return hit;
  }

  function wireStacking() {
    STACKABLE.forEach(function (id) {
      var ov = $(id);
      if (!ov) return;
      ov.addEventListener('click', function (e) {
        if (!detailOpen()) return;                       // not stacked - let WV handle it
        if (e.target.closest('[data-close]') || e.target === ov) {
          e.stopPropagation();
          closeTop(id);
        }
      }, true);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (closeStackedIfAny()) e.stopPropagation();
    }, true);
  }

  function money(v) { return WV.rupees(Number(v || 0)); }
  function shortMoney(v) { return WV.short(Number(v || 0)); }

  function whenText(iso) { return iso ? WV.fmtDateTime(iso) : '—'; }

  /* ========================================================================
     TABS
     ======================================================================== */

  var VIEWS = ['dash', 'tenders', 'rfps', 'docs', 'emd', 'team'];

  function setView(v) {
    state.view = v;
    VIEWS.forEach(function (name) { show('view-' + name, name === v); });
    WV.$$('#tabs button').forEach(function (b) {
      b.setAttribute('aria-selected', b.getAttribute('data-view') === v ? 'true' : 'false');
    });
    render();
  }

  /* ========================================================================
     DASHBOARD
     ======================================================================== */

  function renderDash() {
    var all = WVT.data.tenders;
    var s = WVT.summary(all);
    var emd = WVT.emdOutstanding();

    $('dashKpis').innerHTML = [
      kpi('Live tenders', s.live, s.total + ' on file in total', 'var(--brand)'),
      kpi('Closing soon', s.dueSoon + s.overdue,
          s.overdue ? s.overdue + ' already past the date' : 'within 7 days', s.overdue ? 'var(--bad)' : 'var(--warn)'),
      kpi('Submitted', s.submitted, shortMoney(s.value) + ' pipeline value', 'var(--brand-2)'),
      kpi('Won', s.awarded, s.winRate == null ? 'no result yet' : WV.pct(s.winRate, 0) + ' win rate', 'var(--good)'),
      kpi('EMD outstanding', shortMoney(emd.total), emd.count + ' payment' + (emd.count === 1 ? '' : 's') + ' not back', 'var(--warn)')
    ].join('');

    renderUpcoming();
    renderDecisionQueue(all);

    /* Where everything is sitting.
     *
     * This used to be drawn as a funnel. A funnel claims each bar is a subset
     * of the one above it - that things flow downwards and narrow. Stages float
     * freely now, so that claim would be a lie: a tender can be in PPT without
     * ever having been in Documents. It is a plain count per stage, and stages
     * nothing is in are hidden rather than drawn as a row of zeroes. */
    var counts = WVT.stageCounts(all);
    var used = WVT.STAGES.filter(function (st) { return (counts[st] || 0) > 0; });
    var peak = Math.max.apply(null, used.map(function (x) { return counts[x]; }).concat([1]));

    $('funnelRows').innerHTML = used.length
      ? used.map(function (st) {
          var n = counts[st] || 0;
          var col = st === 'Awarded' ? 'var(--good)'
                  : st === 'Not Awarded' ? 'var(--bad)'
                  : st === 'Closed' ? 'var(--muted)'
                  : 'var(--brand)';
          return '<div class="funnel-row">' +
            '<span class="fl" title="' + esc(WVT.STAGE_HELP[st] || '') + '">' + esc(st) + '</span>' +
            '<span class="track"><i class="fill" style="width:' + (peak ? (n / peak) * 100 : 0) + '%;background:' + col + '"></i></span>' +
            '<span class="fv">' + n + '</span></div>';
        }).join('')
      : empty('No tenders yet.');

    /* Region chart */
    var rc = WVT.regionCounts(all);
    var keys = Object.keys(rc).filter(function (k) { return rc[k].count > 0; });
    if (!keys.length) {
      $('regionChart').innerHTML = empty('No tenders yet.');
    } else {
      WV.categoryBars($('regionChart'), {
        labels: keys.map(function (k) { return rc[k].name; }),
        values: keys.map(function (k) { return rc[k].count; }),
        subs:   keys.map(function (k) { return shortMoney(rc[k].value); }),
        fmt: function (v) { return String(Math.round(v)); },
        integer: true,
        name: 'Tenders'
      });
    }

    /* RFP performance */
    var rs = WVT.rfpStats();
    $('rfpStats').innerHTML =
      '<div>Open requests <b>' + rs.open + '</b></div>' +
      '<div>Past needed-by <b' + (rs.late ? ' style="color:var(--bad)"' : '') + '>' + rs.late + '</b></div>' +
      '<div>Delivered <b>' + rs.delivered + '</b></div>' +
      '<div>Average turnaround <b>' +
        (rs.avgHours == null ? '—' : (rs.avgHours < 48
          ? Math.round(rs.avgHours) + ' hrs'
          : Math.round(rs.avgHours / 24) + ' days')) + '</b></div>';

    var lateRows = WVT.data.rfps.filter(WVT.rfpIsLate).slice(0, 6);
    $('rfpLateRows').innerHTML = lateRows.length
      ? lateRows.map(function (r) {
          var d = WVT.daysTo(r.needed_by);
          return '<div class="list-row" data-rfp="' + esc(r.id) + '">' +
            '<div class="g"><div class="t">' + esc(r.title) + '</div>' +
            '<div class="s">' + esc(WVT.personName(r.requested_by)) + ' · ' + esc(r.status) + '</div></div>' +
            '<span class="age bad">' + Math.abs(d) + 'd late</span></div>';
        }).join('')
      : '<div class="none" style="margin-top:10px">Nothing is overdue.</div>';

    /* Expiring documents */
    var exp = WVT.expiringDocs(60);
    $('expiryRows').innerHTML = exp.length
      ? exp.slice(0, 8).map(function (d) {
          return '<div class="list-row"><div class="g">' +
            '<div class="t">' + esc(d.name) + '</div>' +
            '<div class="s">' + esc(d.category || 'Other') + ' · expires ' + esc(WVT.fmtDate(d.expiry_date)) + '</div></div>' +
            WVT.expiryChip(d.expiry_date) + '</div>';
        }).join('')
      : empty('Nothing expires in the next 60 days.');

    /* Top-of-page alert */
    var bits = [];
    if (s.overdue) bits.push(s.overdue + ' tender' + (s.overdue === 1 ? '' : 's') + ' past the submission date and not submitted');
    if (rs.late)   bits.push(rs.late + ' RFP request' + (rs.late === 1 ? '' : 's') + ' past the needed-by date');
    var expired = exp.filter(function (d) { return (WVT.daysTo(d.expiry_date) || 0) < 0; }).length;
    if (expired)   bits.push(expired + ' company document' + (expired === 1 ? '' : 's') + ' already expired');
    if (bits.length) {
      $('alertBanner').style.display = 'flex';
      $('alertBanner').textContent = '⚠ ' + bits.join(' · ');
    } else {
      $('alertBanner').style.display = 'none';
    }
  }

  function kpi(label, value, sub, accent) {
    return '<div class="kpi" style="--accent:' + accent + '">' +
      '<div class="k-l">' + esc(label) + '</div>' +
      '<div class="k-v">' + esc(String(value)) + '</div>' +
      '<div class="k-s">' + esc(sub) + '</div></div>';
  }

  function renderUpcoming() {
    var list = WVT.upcoming(state.upDays);
    $('upDays').textContent = String(state.upDays);
    $('upcomingRows').innerHTML = list.length
      ? list.map(function (t) {
          var p = WVT.checklistProgress(t.id);
          return '<div class="list-row" data-tender="' + esc(t.id) + '">' +
            '<div class="g"><div class="t">' + esc(t.title) + '</div>' +
            '<div class="s">' + esc(t.authority || t.city || '—') + ' · ' + esc(WVT.regionName(t.region_id)) +
              ' · ' + esc(WVT.teamName(t.team_id)) + ' · closes ' + esc(WVT.fmtDate(t.submission_date)) + '</div></div>' +
            '<div class="meta" style="text-align:right">' +
              '<div>' + WVT.stageBadge(t.stage) + '</div>' +
              '<div class="s" style="margin-top:4px">' + p.done + '/' + p.total + ' docs</div>' +
            '</div>' +
            WVT.deadlineChip(t) + '</div>';
        }).join('')
      : empty('Nothing closes in the next ' + state.upDays + ' days.');
  }

  /* ========================================================================
     TENDER LIST
     ======================================================================== */

  function currentFilter() {
    return {
      q:      val('fSearch'),
      region: $('fRegion') ? $('fRegion').value : 'all',
      team:   $('fTeam')   ? $('fTeam').value   : 'all',
      stage:  $('fStage')  ? $('fStage').value  : 'all',
      result: $('fResult') ? $('fResult').value : 'all',
      month:  $('fMonth')  ? $('fMonth').value  : 'all'
    };
  }

  function fillTenderFilters() {
    var keep = currentFilter();
    $('fRegion').innerHTML = '<option value="all">All regions</option>' +
      opts(WVT.data.regions.map(function (r) { return { value: r.id, label: r.name }; }), keep.region);
    $('fTeam').innerHTML = '<option value="all">All teams</option>' +
      opts(WVT.data.teams.map(function (t) { return { value: t.id, label: t.name }; }), keep.team);
    $('fStage').innerHTML = '<option value="all">All stages</option>' + opts(WVT.STAGES, keep.stage);
    $('fResult').innerHTML = '<option value="all">Any result</option>' + opts(WVT.RESULTS, keep.result);
    $('fMonth').innerHTML = '<option value="all">All months</option>' +
      opts(WVT.monthsPresent().map(function (k) { return { value: k, label: WV.monthLabelLong(k) }; }), keep.month);
  }

  function tenderRow(t) {
    var p = WVT.checklistProgress(t.id);
    var pct = Math.round(p.pct * 100);
    return '<tr data-tender="' + esc(t.id) + '" style="cursor:pointer">' +
      '<td><div style="font-weight:650">' + esc(t.title) + '</div>' +
        '<div class="muted" style="font-size:11px">' + esc(t.nit_no || 'No NIT no.') +
        (t.authority ? ' · ' + esc(t.authority) : '') + '</div></td>' +
      '<td>' + esc(WVT.regionName(t.region_id)) + '<div class="muted" style="font-size:11px">' +
        esc(WVT.teamName(t.team_id)) + '</div></td>' +
      '<td class="num">' + esc(shortMoney(t.estimated_value)) +
        '<div class="muted" style="font-size:11px">EMD ' + esc(shortMoney(t.emd_amount)) + '</div></td>' +
      '<td>' + esc(WVT.fmtDate(t.submission_date)) + '<div style="margin-top:3px">' + WVT.deadlineChip(t) + '</div></td>' +
      '<td>' + WVT.stageBadge(t.stage) +
        (t.go_no_go === 'No-Go' ? '<div class="muted" style="font-size:11px;margin-top:3px">No-Go</div>' : '') + '</td>' +
      '<td><div class="prog"><i style="width:' + pct + '%"></i></div>' +
        '<div class="muted" style="font-size:11px;margin-top:3px">' + p.done + '/' + p.total + '</div></td>' +
      '<td>' + WVT.resultBadge(t.result) + '</td></tr>';
  }

  function tableWrap(rows) {
    return '<div class="tbl-wrap"><table><thead><tr>' +
      '<th>Tender</th><th>Region / team</th><th>Value</th><th>Closes</th>' +
      '<th>Stage</th><th>Documents</th><th>Result</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function renderTenders() {
    fillTenderFilters();
    var list = WVT.filterTenders(currentFilter());
    $('cntTenders').textContent = String(WVT.data.tenders.length);
    $('tListTitle').textContent = list.length + ' tender' + (list.length === 1 ? '' : 's');

    if (!list.length) {
      $('tenderList').innerHTML = empty(
        WVT.data.tenders.length ? 'No tender matches these filters.' : 'No tenders yet. Use “New tender” to add the first one.');
      return;
    }

    if (state.group === 'flat') {
      $('tenderList').innerHTML = tableWrap(list.map(tenderRow).join(''));
      return;
    }

    var groups = {}, order = [];
    list.forEach(function (t) {
      var key, label;
      if (state.group === 'month') {
        key = WVT.monthKeyOf(t.submission_date) || 'zz-none';
        label = key === 'zz-none' ? 'No closing date' : WV.monthLabelLong(key);
      } else {
        key = String(t.region_id || 'zz-none');
        label = t.region_id ? WVT.regionName(t.region_id) : 'No region';
      }
      if (!groups[key]) { groups[key] = { label: label, rows: [], value: 0 }; order.push(key); }
      groups[key].rows.push(t);
      groups[key].value += Number(t.estimated_value || 0);
    });

    order.sort(function (a, b) {
      if (state.group === 'month') return a < b ? 1 : a > b ? -1 : 0;   // newest month first
      return groups[a].label.localeCompare(groups[b].label);
    });

    $('tenderList').innerHTML = order.map(function (k) {
      var g = groups[k];
      return '<div class="mgroup"><div class="mgroup-h">' +
        '<span>' + esc(g.label) + '</span>' +
        '<span class="line"></span>' +
        '<span>' + g.rows.length + ' · ' + esc(shortMoney(g.value)) + '</span></div>' +
        tableWrap(g.rows.map(tenderRow).join('')) + '</div>';
    }).join('');
  }

  /* ========================================================================
     TENDER EDITOR
     ======================================================================== */

  function fillTenderForm(t) {
    var myTeams = WVT.myTeamIds();
    var myRegions = WVT.myRegionIds();

    $('teType').innerHTML   = opts(WVT.TENDER_TYPES, t ? t.tender_type : 'Service');
    $('teStage').innerHTML  = opts(WVT.STAGES, t ? t.stage : 'Spotted');
    $('teGo').innerHTML     = opts(WVT.GO_OPTIONS, t ? (t.go_no_go || 'Undecided') : 'Undecided');
    $('teRegion').innerHTML = opts(
      WVT.data.regions.filter(function (r) { return myRegions.indexOf(String(r.id)) >= 0; })
        .map(function (r) { return { value: r.id, label: r.name }; }),
      t ? t.region_id : '', 'Choose a region');
    $('teTeam').innerHTML = opts(
      WVT.data.teams.filter(function (x) { return myTeams.indexOf(String(x.id)) >= 0; })
        .map(function (x) { return { value: x.id, label: x.name }; }),
      t ? t.team_id : (WVT.me && WVT.me.tender_team_id), 'Choose a team');
    $('teOwner').innerHTML = opts(
      WVT.profiles.filter(function (p) { return p.tender_access; })
        .map(function (p) { return { value: p.id, label: p.full_name || p.email }; }),
      t ? t.owner_id : (WV.currentUser && WV.currentUser.id), 'Nobody yet');

    setVal('teTitleIn', t && t.title);
    setVal('teNit', t && t.nit_no);
    setVal('teAuthority', t && t.authority);
    setVal('teDept', t && t.department);
    setVal('teCity', t && t.city);
    setVal('tePortal', t && t.portal_url);
    setVal('teScope', t && t.scope_summary);
    setVal('tePub', t && t.published_date);
    setVal('tePre', t && t.pre_bid_date);
    setVal('teQuery', t && t.query_last_date);
    setVal('teSub', t && t.submission_date);
    setVal('teSubTime', t && t.submission_time);
    setVal('teOpen', t && t.opening_date);
    setVal('teValue', t && t.estimated_value);
    setVal('teEmd', t && t.emd_amount);
    setVal('teFee', t && t.tender_fee);
    setVal('teProc', t && t.processing_fee);
    setVal('teMonths', t && t.contract_months);
    setVal('teGoWhy', t && t.go_no_go_reason);
    setVal('teElig', t && t.eligibility_notes);
    setVal('teRemark', t && t.remarks);

    $('teElig2').innerHTML = opts(WVT.ELIGIBILITY, t ? (t.eligibility_status || 'Not checked') : 'Not checked');
    setVal('teEligWhy', t && t.eligibility_reason);
    $('teEligStamp').querySelector('.hint').textContent =
      (t && t.eligibility_at)
        ? 'Last set ' + whenText(t.eligibility_at) + ' by ' + WVT.personName(t.eligibility_by)
        : '';
    show('teEligStamp', !!(t && t.eligibility_at));

    /* Submission is a fact somebody ticks, not something inferred from stage. */
    setChk('teSubmitted', !!(t && t.submitted_at));
    setVal('teSubmittedOn', t && t.submitted_at ? String(t.submitted_at).slice(0, 10) : '');

    /* Outcome */
    $('teLossReason').innerHTML = opts(WVT.LOSS_REASONS, t ? t.loss_reason : '', 'Choose a reason');
    setVal('teQuoted', t && t.quoted_value);
    setVal('teRank', t && t.our_rank);
    setVal('teResultDate', t && t.result_date);
    setVal('teAwardedTo', t && t.awarded_to);
    setVal('teAwardedValue', t && t.awarded_value);
    setVal('teLossNotes', t && t.loss_reason_notes);
    setVal('teResultNotes', t && t.result_notes);
    syncStatusFields();

    $('teSeedN').textContent = String(WVT.data.companyDocs.length);
    show('teSeedWrap', !t);
    setChk('teSeed', true);
    show('teDelete', !!t && WVT.canDelete());
    $('teTitle').textContent = t ? 'Edit tender' : 'New tender';
    $('teSubtitle').textContent = t
      ? 'Changes are visible to everyone who can see this tender'
      : 'Upload the notice PDF and the details fill themselves in';
    banner('teBanner', '');
  }

  /* Shows only the parts of the form that can mean anything right now.
     Called on open and on every change to the stage or the submitted tick. */
  function syncStatusFields() {
    show('teEligWhyWrap', val('teElig2') === 'Not eligible');

    /* The gate, stated up front rather than as a failure on save. */
    var t0 = state.editId ? WVT.tenderById(state.editId) : null;
    var approved = WVT.isApproved(t0);
    var tick = $('teSubmitted');
    if (tick) tick.disabled = !approved;
    $('teSubHint').textContent = approved
      ? 'Ticking this is what opens the EMD, rank and result fields, and stops the deadline countdown.'
      : 'Locked until the VP or Founder records a Go. Nothing is filed on a tender nobody approved.';

    var stage = val('teStage');
    var filed = $('teSubmitted') && $('teSubmitted').checked;
    var lost  = stage === 'Not Awarded';
    var won   = stage === 'Awarded';

    $('teStageHelp').textContent = WVT.STAGE_HELP[stage] || ' ';

    show('teSubOnWrap', !!filed);
    /* WV.todayInput() gives YYYY-MM-DD for a date input. WVT.today() is a Date
       object for arithmetic - not interchangeable. */
    if (filed && !val('teSubmittedOn')) setVal('teSubmittedOn', WV.todayInput());

    /* There is nothing to record about an outcome until the bid went in or the
       stage already says how it ended. */
    show('teOutcomeWrap', !!filed || won || lost);
    show('teLossWrap', lost);

    /* Once firms are entered, the quote and the rank belong to a FIRM, not to
       the tender - three firms quote three different numbers. Leaving both
       places editable would guarantee they drift, so the tender's copies are
       hidden and the bids tab becomes the single source. */
    var perFirm = !!state.editId && WVT.hasBids(state.editId);
    show('teQuotedWrap', !perFirm);
    show('teRankWrap', !perFirm);
    show('tePerFirmNote', perFirm);

    $('teLossNoteHint').textContent = val('teLossReason') === 'Other'
      ? 'Required, because "Other" on its own tells the next person nothing.'
      : ' ';
  }

  function openTenderEditor(id) {
    state.editId = id || null;
    if (!WVT.canUpload() && !id) {
      WV.toast('Your unit is not set up to add tenders. Ask an admin.');
      return;
    }
    fillTenderForm(id ? WVT.tenderById(id) : null);
    WV.openOverlay('tenderOverlay');
  }

  async function saveTender() {
    var title = val('teTitleIn');
    if (!title)            return banner('teBanner', 'Give the tender a title.', 'bad');
    if (!val('teRegion'))  return banner('teBanner', 'Choose a region.', 'bad');
    if (!val('teTeam'))    return banner('teBanner', 'Choose the owning team.', 'bad');
    if (!val('teSub'))     return banner('teBanner', 'Enter the submission deadline — every alert depends on it.', 'bad');

    var go = val('teGo');
    var body = {
      title: title,
      nit_no: val('teNit') || null,
      tender_type: val('teType') || null,
      authority: val('teAuthority') || null,
      department: val('teDept') || null,
      city: val('teCity') || null,
      region_id: val('teRegion'),
      team_id: val('teTeam'),
      owner_id: val('teOwner') || null,
      portal_url: val('tePortal') || null,
      scope_summary: val('teScope') || null,
      published_date: dateOrNull('tePub'),
      pre_bid_date: dateOrNull('tePre'),
      query_last_date: dateOrNull('teQuery'),
      submission_date: dateOrNull('teSub'),
      submission_time: val('teSubTime') || null,
      opening_date: dateOrNull('teOpen'),
      estimated_value: Number(val('teValue') || 0),
      emd_amount: Number(val('teEmd') || 0),
      tender_fee: Number(val('teFee') || 0),
      processing_fee: Number(val('teProc') || 0),
      contract_months: numOrNull('teMonths'),
      stage: val('teStage') || 'Spotted',
      go_no_go: go === 'Undecided' ? null : go,
      go_no_go_reason: val('teGoWhy') || null,
      eligibility_notes: val('teElig') || null,
      eligibility_status: val('teElig2') || 'Not checked',
      remarks: val('teRemark') || null,
      quoted_value: numOrNull('teQuoted'),
      our_rank: val('teRank') || null,
      result_date: dateOrNull('teResultDate'),
      awarded_to: val('teAwardedTo') || null,
      awarded_value: numOrNull('teAwardedValue'),
      result_notes: val('teResultNotes') || null
    };

    if (body.eligibility_status === 'Not eligible') {
      if (!val('teEligWhy')) {
        return banner('teBanner', 'Say why we are not eligible — that is the field that tells you which credential to go and build.', 'bad');
      }
      body.eligibility_reason = val('teEligWhy');
    } else {
      body.eligibility_reason = null;
    }

    /* A loss with no reason is the whole point of this field, so insist. */
    if (body.stage === 'Not Awarded') {
      if (!val('teLossReason')) {
        return banner('teBanner', 'Choose why this one did not go our way — it is the only way the pattern ever shows up.', 'bad');
      }
      if (val('teLossReason') === 'Other' && !val('teLossNotes')) {
        return banner('teBanner', '"Other" needs a note, otherwise it tells the next person nothing.', 'bad');
      }
      body.loss_reason = val('teLossReason');
      body.loss_reason_notes = val('teLossNotes') || null;
    } else {
      /* The database trigger clears these too; doing it here as well keeps the
         local copy honest without waiting for a reload. */
      body.loss_reason = null;
      body.loss_reason_notes = null;
    }

    /* Submission: the tick is the truth. Untick it and the tender goes back to
       being live, countdown and all. */
    var filed = $('teSubmitted').checked;
    var existing = state.editId ? WVT.tenderById(state.editId) : null;
    if (filed && !(existing && existing.go_no_go === 'Go')) {
      return banner('teBanner',
        'This tender has no Go decision yet. The VP or Founder has to approve it before it can be marked submitted.', 'bad');
    }
    if (filed) {
      var on = dateOrNull('teSubmittedOn');
      var had = existing && existing.submitted_at;
      /* Keep the original timestamp when the date has not been changed, so
         re-saving a tender does not quietly rewrite when it was filed. */
      body.submitted_at = (had && String(had).slice(0, 10) === on)
        ? had
        : new Date((on || WV.todayInput()) + 'T00:00:00').toISOString();
      body.submitted_by = (existing && existing.submitted_by) || String(WV.currentUser.id);
    } else {
      body.submitted_at = null;
      body.submitted_by = null;
    }

    if (body.go_no_go && (!existing || existing.go_no_go !== body.go_no_go)) {
      body.go_no_go_by = String(WV.currentUser.id);
      body.go_no_go_at = new Date().toISOString();
    }
    if (!state.editId) body.created_by = String(WV.currentUser.id);

    var btn = $('teSave');
    btn.disabled = true;
    var r = await WVT.saveTender(body, state.editId);
    btn.disabled = false;

    if (!r.ok) return banner('teBanner', 'Could not save: ' + r.error, 'bad');

    var seeded = 0;
    if (!state.editId && $('teSeed').checked && r.row) {
      var s = await WVT.seedChecklist(r.row.id, null);
      if (s.ok) seeded = s.count;
    }

    await WV.logActivity(state.editId ? 'Tender updated' : 'Tender added', title, r.row && r.row.id);
    if (!state.editId) {
      await WV.addNotification('New tender: ' + title,
        (body.authority || body.city || '') + ' — closes ' + WVT.fmtDate(body.submission_date), 'info', 'all');
    }

    WV.closeOverlays();
    WV.toast(r.warning || ((state.editId ? 'Tender updated' : 'Tender added') +
      (seeded ? ' with ' + seeded + ' checklist items' : '')));
    await refresh();
  }

  async function deleteTender() {
    if (!state.editId) return;
    var t = WVT.tenderById(state.editId);
    if (!t) return;
    if (!window.confirm('Delete "' + t.title + '" and everything filed under it? This cannot be undone.')) return;
    var r = await WVT.deleteTender(state.editId);
    if (!r.ok) return banner('teBanner', 'Could not delete: ' + r.error, 'bad');
    await WV.logActivity('Tender deleted', t.title, t.id);
    WV.closeOverlays();
    WV.toast('Tender deleted');
    await refresh();
  }

  /* --- reading the notice PDF --- */
  async function readTenderPdf(file) {
    if (!file) return;
    banner('teBanner', 'Reading ' + file.name + '…');
    var r = await WVT.readTenderPdf(file);
    if (!r.ok) return banner('teBanner', r.error, 'bad');

    var p = r.parsed, filled = [];
    function put(id, v, label) {
      if (v == null || v === '') return;
      var el = $(id);
      if (!el) return;
      if (String(el.value || '').trim() !== '') return;   // never overwrite what a person typed
      el.value = v;
      filled.push(label);
    }
    put('teTitleIn', p.title, 'title');
    put('teNit', p.nitNo, 'NIT no.');
    put('teAuthority', p.authority, 'authority');
    put('tePortal', p.portalUrl, 'portal link');
    put('tePub', p.publishedDate, 'published date');
    put('tePre', p.preBidDate, 'pre-bid date');
    put('teQuery', p.queryLastDate, 'query date');
    put('teSub', p.submissionDate, 'submission date');
    put('teOpen', p.openingDate, 'opening date');
    put('teValue', p.estimatedValue, 'estimated value');
    put('teEmd', p.emdAmount, 'EMD');
    put('teFee', p.tenderFee, 'tender fee');
    put('teProc', p.processingFee, 'processing fee');
    put('teMonths', p.contractMonths, 'contract period');

    banner('teBanner', filled.length
      ? 'Filled in ' + filled.length + ' field' + (filled.length === 1 ? '' : 's') + ' from the PDF (' +
        filled.join(', ') + '). Check each one before saving.'
      : 'The PDF was read but none of the usual labels were found. Please type the details.',
      filled.length ? 'ok' : 'bad');
  }

  /* ========================================================================
     TENDER DETAIL
     ======================================================================== */

  function openDetail(id) {
    var t = WVT.tenderById(id);
    if (!t) return;
    state.detailId = id;
    state.detailTab = 'info';
    $('dTitle').textContent = t.title;
    $('dSub').textContent = [t.nit_no, t.authority, t.city, WVT.regionName(t.region_id)]
      .filter(Boolean).join(' · ');
    show('dEdit', WVT.canEditTender(t));
    /* Leadership do not edit the file, but they do decide whether we bid. */
    show('dDecide', WVT.canDecide(t) && !WVT.canEditTender(t));
    renderDetail();
    WV.openOverlay('detailOverlay');
  }

  function renderDetail() {
    var t = WVT.tenderById(state.detailId);
    if (!t) return;
    WV.$$('#dTabs button').forEach(function (b) {
      b.setAttribute('aria-selected', b.getAttribute('data-d') === state.detailTab ? 'true' : 'false');
    });
    ['info', 'check', 'bids', 'emd', 'corr', 'rfp', 'talk'].forEach(function (k) {
      show('d' + k.charAt(0).toUpperCase() + k.slice(1), k === state.detailTab);
    });

    if (state.detailTab === 'info')  renderDetailInfo(t);
    if (state.detailTab === 'check') renderDetailCheck(t);
    if (state.detailTab === 'bids')  renderDetailBids(t);
    if (state.detailTab === 'emd')   renderDetailEmd(t);
    if (state.detailTab === 'corr')  renderDetailCorr(t);
    if (state.detailTab === 'rfp')   renderDetailRfp(t);
    if (state.detailTab === 'talk')  renderDetailTalk(t);
  }

  function renderDetailInfo(t) {
    var d = WVT.deadlineState(t);
    var elig = t.eligibility_status || 'Not checked';
    var eligCls = elig === 'Eligible' ? 'b-paid' : elig === 'Not eligible' ? 'b-hold' : 'b-none';
    var rows = [
      ['Stage', WVT.stageBadge(t.stage) + ' ' + WVT.deadlineChip(t)],
      ['Eligibility', '<span class="badge ' + eligCls + '">' + esc(elig) + '</span>' +
        (t.eligibility_reason ? ' <span class="muted">— ' + esc(t.eligibility_reason) + '</span>' : '') +
        (elig === 'Eligible' && !t.go_no_go
          ? ' <span class="age warn">awaiting decision</span>' : '')],
      ['Go / No-Go', esc(t.go_no_go || 'Undecided') +
        (t.go_no_go_reason ? ' <span class="muted">— ' + esc(t.go_no_go_reason) + '</span>' : '')],
      ['Result', WVT.resultBadge(t.result) + (t.our_rank ? ' <span class="muted">' + esc(t.our_rank) + '</span>' : '')],
      ['Authority', esc(t.authority || '—')],
      ['Department', esc(t.department || '—')],
      ['City / region', esc([t.city, WVT.regionName(t.region_id)].filter(Boolean).join(', ') || '—')],
      ['Owning team', esc(WVT.teamName(t.team_id))],
      ['Responsible', esc(WVT.personName(t.owner_id))],
      ['Type', esc(t.tender_type || '—')],
      ['Estimated value', esc(money(t.estimated_value))],
      ['EMD', esc(money(t.emd_amount))],
      ['Tender fee', esc(money(t.tender_fee)) + (Number(t.processing_fee) ? ' + ' + esc(money(t.processing_fee)) + ' processing' : '')],
      ['Contract period', t.contract_months ? esc(t.contract_months + ' months') : '—'],
      ['Published', esc(WVT.fmtDate(t.published_date))],
      ['Pre-bid meeting', esc(WVT.fmtDate(t.pre_bid_date))],
      ['Queries close', esc(WVT.fmtDate(t.query_last_date))],
      ['Submission', esc(WVT.fmtDate(t.submission_date)) + (t.submission_time ? ' at ' + esc(t.submission_time) : '') +
        ' <span class="age ' + d.cls + '">' + esc(d.label) + '</span>'],
      ['Bid opening', esc(WVT.fmtDate(t.opening_date))],
      ['Portal', t.portal_url
        ? '<a href="' + esc(t.portal_url) + '" target="_blank" rel="noopener">Open link</a>' : '—']
    ];
    if (t.scope_summary)     rows.push(['Scope', esc(t.scope_summary)]);
    if (t.eligibility_notes) rows.push(['Eligibility', esc(t.eligibility_notes)]);
    if (t.remarks)           rows.push(['Remarks', esc(t.remarks)]);
    if (t.submitted_at)      rows.push(['Submitted on', esc(whenText(t.submitted_at)) + ' by ' + esc(WVT.personName(t.submitted_by))]);
    if (t.result === 'Awarded' || t.result === 'Not Awarded') {
      rows.push(['Quoted', esc(money(t.quoted_value))]);
      rows.push(['Awarded to', esc(t.awarded_to || '—')]);
      rows.push(['Awarded value', esc(money(t.awarded_value))]);
      rows.push(['Result declared', esc(WVT.fmtDate(t.result_date))]);
    }
    if (t.result === 'Not Awarded') {
      rows.push(['Why we lost', '<b>' + esc(t.loss_reason || 'Not recorded') + '</b>' +
        (t.loss_reason_notes ? ' <span class="muted">— ' + esc(t.loss_reason_notes) + '</span>' : '')]);
    }
    if (t.result_notes) rows.push(['Result notes', esc(t.result_notes)]);

    var nCorr = WVT.corrigendumCount(t.id);
    if (nCorr) {
      var latest = WVT.corrigendaFor(t.id)[0];
      rows.splice(1, 0, ['Corrigenda',
        '<b>' + nCorr + '</b> issued' +
        (latest && latest.issued_date ? ' <span class="muted">— latest ' + esc(WVT.fmtDate(latest.issued_date)) + '</span>' : '')]);
    }

    $('dInfo').innerHTML = '<dl class="kv">' + rows.map(function (r) {
      return '<dt>' + esc(r[0]) + '</dt><dd>' + r[1] + '</dd>';
    }).join('') + '</dl>';
  }

  function renderDetailCheck(t) {
    var items = WVT.checklistFor(t.id);
    var p = WVT.checklistProgress(t.id);
    /* The tender file belongs to the executives. Leadership reads it. */
    var editable = WVT.canEditTender(t);

    var head = '<div class="card-head" style="margin-bottom:12px">' +
      '<div><b>' + p.done + ' of ' + p.total + ' required documents ready</b>' +
      '<div class="prog" style="margin-top:6px;width:200px"><i style="width:' + Math.round(p.pct * 100) + '%"></i></div></div>' +
      (editable
        ? '<div style="display:flex;gap:8px"><button class="btn sm" id="chkSeed">Add standard list</button>' +
          '<button class="btn sm primary" id="chkAdd">＋ Item</button></div>'
        : '') + '</div>';

    var body = items.length
      ? '<div class="tbl-wrap"><table><thead><tr><th>Document</th><th>Category</th><th>Status</th><th>Due</th><th></th></tr></thead><tbody>' +
        items.map(function (c) {
          return '<tr><td>' + esc(c.name) + (c.required ? '' : ' <span class="muted">(optional)</span>') + '</td>' +
            '<td>' + esc(c.category || '—') + '</td>' +
            '<td>' + (editable
              ? '<select data-chk="' + esc(c.id) + '" style="min-width:130px">' + opts(WVT.CHECK_STATUS, c.status) + '</select>'
              : esc(c.status)) + '</td>' +
            '<td>' + esc(WVT.fmtDate(c.due_date)) + '</td>' +
            '<td>' + (editable ? '<button class="btn sm danger" data-chkdel="' + esc(c.id) + '">Remove</button>' : '') + '</td></tr>';
        }).join('') + '</tbody></table></div>'
      : empty('No checklist yet. Use “Add standard list” to load the usual documents.');

    $('dCheck').innerHTML = head + body;
  }

  function renderDetailEmd(t) {
    var rows = WVT.emdFor(t.id);
    /* Money is tender-team-only, unlike everything else on this tender. The
       founder and VP read these amounts; they do not change them. */
    var editable = WVT.canEditEmd();
    var out = rows.filter(function (e) { return e.status === 'Paid' || e.status === 'Refund Due'; })
                  .reduce(function (a, e) { return a + Number(e.amount || 0); }, 0);

    var head = '<div class="card-head" style="margin-bottom:12px">' +
      '<div><b>' + esc(money(out)) + '</b> <span class="muted">still out</span></div>' +
      (editable
        ? '<button class="btn sm primary" id="emdAdd">＋ Record a payment</button>'
        : '<span class="muted">Only the tender team records payments</span>') + '</div>';

    $('dEmd').innerHTML = head + (rows.length
      ? '<div class="tbl-wrap"><table><thead><tr><th>Firm</th><th>What</th><th>Amount</th><th>Mode</th><th>Paid</th><th>Status</th><th>Back on</th><th></th></tr></thead><tbody>' +
        rows.map(function (e) {
          return '<tr><td>' + (e.firm_id ? esc(WVT.firmName(e.firm_id)) : '<span class="muted">—</span>') + '</td>' +
            '<td>' + esc(e.kind) + '<div class="muted" style="font-size:11px">' + esc(e.instrument_no || '') + '</div></td>' +
            '<td class="num">' + esc(money(e.amount)) + '</td><td>' + esc(e.mode || '—') + '</td>' +
            '<td>' + esc(WVT.fmtDate(e.paid_on)) + '</td>' +
            '<td>' + esc(e.status) + '</td>' +
            '<td>' + esc(WVT.fmtDate(e.refunded_on)) + '</td>' +
            '<td>' + (editable ? '<button class="btn sm" data-emdedit="' + esc(e.id) + '">Edit</button>' : '') + '</td></tr>';
        }).join('') + '</tbody></table></div>'
      : empty('Nothing recorded yet.'));
  }

  function renderDetailRfp(t) {
    var rows = WVT.rfpsFor(t.id);
    var head = '<div class="card-head" style="margin-bottom:12px"><div class="muted">' +
      rows.length + ' request' + (rows.length === 1 ? '' : 's') + ' for this tender</div>' +
      '<button class="btn sm primary" id="rfpAddFor">＋ Request a document</button></div>';

    $('dRfp').innerHTML = head + (rows.length
      ? rows.map(function (r) {
          return '<div class="list-row" data-rfp="' + esc(r.id) + '"><div class="g">' +
            '<div class="t">' + esc(r.title) + '</div>' +
            '<div class="s">' + esc(WVT.personName(r.requested_by)) + ' → ' +
              esc(r.assigned_to ? WVT.personName(r.assigned_to) : 'unassigned') +
              ' · needed ' + esc(WVT.fmtDate(r.needed_by)) + '</div></div>' +
            WVT.rfpBadge(r.status) + (WVT.rfpIsLate(r) ? ' <span class="age bad">late</span>' : '') + '</div>';
        }).join('')
      : empty('No document has been requested for this tender yet.'));
  }

  function renderDetailTalk(t) {
    var rows = WVT.commentsFor(t.id);
    $('dTalk').innerHTML =
      '<div class="field"><label for="dCmt">Add a comment</label>' +
      '<textarea id="dCmt" rows="2" placeholder="Anything the team should know"></textarea></div>' +
      '<button class="btn primary sm" id="dCmtSave" style="margin-bottom:16px">Post comment</button>' +
      (rows.length
        ? rows.map(function (c) {
            return '<div class="cmt"><span class="who">' + esc(c.author_name || 'Someone') + '</span>' +
              '<span class="muted" style="font-size:11px"> · ' + esc(c.author_role || '') + '</span>' +
              '<span class="when">' + esc(whenText(c.created_at)) + '</span>' +
              '<div class="body">' + esc(c.body) + '</div></div>';
          }).join('')
        : empty('No comments yet.'));
  }

  /* ========================================================================
     RFP REQUESTS
     ======================================================================== */

  function rfpVisible() {
    var me = WV.currentUser ? String(WV.currentUser.id) : '';
    return WVT.data.rfps.filter(function (r) {
      switch (state.rfpFilter) {
        case 'open': return WVT.RFP_OPEN.indexOf(r.status) >= 0;
        case 'mine': return String(r.requested_by) === me;
        case 'tome': return String(r.assigned_to) === me;
        case 'late': return WVT.rfpIsLate(r);
        default:     return true;
      }
    });
  }

  function renderRfps() {
    var rows = rfpVisible();
    $('cntRfps').textContent = String(WVT.data.rfps.filter(function (r) {
      return WVT.RFP_OPEN.indexOf(r.status) >= 0;
    }).length);
    WV.$$('#rfpFilter button').forEach(function (b) {
      b.setAttribute('aria-selected', b.getAttribute('data-f') === state.rfpFilter ? 'true' : 'false');
    });

    $('rfpList').innerHTML = rows.length
      ? '<div class="tbl-wrap"><table><thead><tr>' +
        '<th>What</th><th>Tender</th><th>Raised by</th><th>With</th><th>Needed</th><th>Status</th><th>Age</th>' +
        '</tr></thead><tbody>' + rows.map(function (r) {
          var age = Math.max(0, Math.round((Date.now() - Date.parse(r.requested_at)) / 86400000));
          var t = r.tender_id ? WVT.tenderById(r.tender_id) : null;
          return '<tr data-rfp="' + esc(r.id) + '" style="cursor:pointer">' +
            '<td><div style="font-weight:650">' + esc(r.title) + '</div>' +
              '<div class="muted" style="font-size:11px">' + esc(r.doc_type || '—') +
              ' · ' + esc(r.priority || 'Normal') + '</div></td>' +
            '<td>' + esc(t ? t.title : 'Not linked') + '</td>' +
            '<td>' + esc(WVT.personName(r.requested_by)) + '</td>' +
            '<td>' + esc(r.assigned_to ? WVT.personName(r.assigned_to) : '—') + '</td>' +
            '<td>' + esc(WVT.fmtDate(r.needed_by)) +
              (WVT.rfpIsLate(r) ? ' <span class="age bad">late</span>' : '') + '</td>' +
            '<td>' + WVT.rfpBadge(r.status) +
              (r.current_version ? ' <span class="muted" style="font-size:11px">v' + r.current_version + '</span>' : '') + '</td>' +
            '<td>' + age + 'd</td></tr>';
        }).join('') + '</tbody></table></div>'
      : empty('Nothing here.');
  }

  function openRfpEditor(tenderId) {
    state.editRfpId = null;
    $('reTender').innerHTML = opts(
      WVT.data.tenders.map(function (t) { return { value: t.id, label: t.title }; }),
      tenderId || '', 'Not linked to a tender');
    $('reType').innerHTML = opts(WVT.RFP_TYPES, 'RFP');
    $('rePri').innerHTML  = opts(WVT.PRIORITIES, 'Normal');
    /* Handing a request to a person is the VP's and the Founder's call. The
       database strips assigned_to from anyone else (trfp_guard_assign), so
       offering the picker would be a lie. */
    show('reAssignWrap', WVT.canAssignRfp());
    $('reAssign').innerHTML = opts(
      WVT.profiles.filter(function (p) { return p.tender_role === 'tender_team' || p.role === 'admin'; })
        .map(function (p) { return { value: p.id, label: p.full_name || p.email }; }),
      '', 'Tender team decides');
    setVal('reTitleIn', ''); setVal('reDesc', ''); setVal('reNeed', '');
    banner('reBanner', '');
    WV.openOverlay('rfpOverlay');
  }

  async function saveRfp() {
    var title = val('reTitleIn');
    if (!title) return banner('reBanner', 'Say what you need.', 'bad');
    var body = {
      tender_id: val('reTender') || null,
      title: title,
      doc_type: val('reType') || null,
      description: val('reDesc') || null,
      priority: val('rePri') || 'Normal',
      needed_by: dateOrNull('reNeed'),
      requested_by: String(WV.currentUser.id),
      requested_by_team: (WVT.me && WVT.me.tender_team_id) || null,
      status: 'Requested'
    };
    /* Set the key at all only when we are allowed to. JSON.stringify would drop
       an undefined, but leaving it out entirely is what the next reader needs
       to see. */
    if (WVT.canAssignRfp()) body.assigned_to = val('reAssign') || null;
    $('reSave').disabled = true;
    var r = await WVT.saveRfp(body, null);
    $('reSave').disabled = false;
    if (!r.ok) return banner('reBanner', 'Could not send: ' + r.error, 'bad');

    await WV.addNotification('RFP requested: ' + title,
      (WV.currentUser.full_name || WV.currentUser.email) + ' needs this by ' + WVT.fmtDate(body.needed_by),
      'info', 'all');
    await WV.logActivity('RFP requested', title, r.row && r.row.id);
    var stacked = detailOpen();
    if (stacked) closeTop('rfpOverlay'); else WV.closeOverlays();
    WV.toast('Request sent to the tender team');
    await refresh();
    if (stacked) { state.detailTab = 'rfp'; renderDetail(); }
  }

  async function openRfpDetail(id) {
    var r = null;
    for (var i = 0; i < WVT.data.rfps.length; i++) {
      if (String(WVT.data.rfps[i].id) === String(id)) { r = WVT.data.rfps[i]; break; }
    }
    if (!r) return;
    state.rfpDetailId = id;

    $('rdTitle').textContent = r.title;
    var t = r.tender_id ? WVT.tenderById(r.tender_id) : null;
    $('rdSub').textContent = (t ? t.title + ' · ' : '') + (r.doc_type || 'Document') + ' · ' + (r.priority || 'Normal');
    $('rdBody').innerHTML = '<div class="muted">Loading the timeline…</div>';
    WV.openOverlay('rfpDetailOverlay');

    var events = await WVT.loadEvents(id);
    var me = String(WV.currentUser.id);
    var isRequester = String(r.requested_by) === me;
    /* The person it was given to, or the people who give it out. Being in the
       tender team is no longer enough - an executive only ever sees the
       requests assigned to them. */
    var canWork = String(r.assigned_to) === me || WVT.canAssignRfp();

    /* Which buttons make sense at this point in the request's life. */
    var actions = [];
    if (canWork) {
      if (r.status === 'Requested')          actions.push(['Accepted', 'Accept'], ['Rejected', 'Reject']);
      if (r.status === 'Accepted')           actions.push(['In Preparation', 'Start preparing']);
      if (r.status === 'In Preparation')     actions.push(['Delivered', 'Mark delivered']);
      if (r.status === 'Changes Requested')  actions.push(['Revised', 'Deliver revision']);
    }
    if (isRequester || WVT.isGlobal()) {
      if (r.status === 'Delivered' || r.status === 'Revised') {
        actions.push(['Changes Requested', 'Ask for changes'], ['Closed', 'Accept and close']);
      }
    }

    var kv = [
      ['Status', WVT.rfpBadge(r.status) + (WVT.rfpIsLate(r) ? ' <span class="age bad">past needed-by</span>' : '')],
      ['Raised by', esc(WVT.personName(r.requested_by)) + ' <span class="muted">' + esc(whenText(r.requested_at)) + '</span>'],
      ['Assigned to', esc(r.assigned_to ? WVT.personName(r.assigned_to) : 'Nobody yet')],
      ['Needed by', esc(WVT.fmtDate(r.needed_by))],
      ['Version', r.current_version ? 'v' + r.current_version : 'none delivered yet']
    ];
    if (r.description) kv.push(['Details', esc(r.description)]);
    if (r.reject_reason) kv.push(['Rejected because', esc(r.reject_reason)]);

    var copyNow = r.file_path
      ? '<button class="btn sm" data-openfile="' + esc(r.file_path) + '">Open v' + (r.current_version || 1) + '</button>' +
        ' <span class="muted">uploaded — only the four of you can open it</span>'
      : (r.file_url
          ? '<a href="' + esc(r.file_url) + '" target="_blank" rel="noopener">Open the link</a>' +
            ' <span class="age warn">linked — anyone with the link can open it</span>'
          : '<span class="muted">Nothing attached yet</span>');
    kv.push(['The copy', copyNow]);

    var attach = canWork
      ? '<div class="sec-title">Attach the copy</div>' +
        '<p class="hint" style="margin:-4px 0 10px">Uploading keeps it private to the Founder, the VP, ' +
        'whoever raised this and you. A link does not — whoever holds it can open the file.</p>' +
        '<div class="form-grid">' +
          '<div class="field"><label for="rdFile">Upload a file</label>' +
            '<input id="rdFile" type="file"></div>' +
          '<div class="field"><label for="rdLink">…or paste a link</label>' +
            '<input id="rdLink" type="url" placeholder="https://drive.google.com/…"></div>' +
        '</div>' +
        '<button class="btn sm primary" id="rdAttach">Attach as v' + ((Number(r.current_version) || 0) + 1) + '</button>' +
        '<div class="banner" id="rdAttachBanner" style="display:none"></div>'
      : '';

    var timeline = events.length ? events.map(function (e) {
      var bad = e.to_status === 'Rejected' || e.to_status === 'Changes Requested';
      var title = e.event === 'status'
        ? (e.from_status ? e.from_status + ' → ' + e.to_status : e.to_status)
        : (e.event === 'file' ? 'File' : e.event === 'assign' ? 'Assignment' : 'Note');
      var attachedHere = e.file_path
        ? ' <button class="btn sm" data-openfile="' + esc(e.file_path) + '">Open v' + (e.version || '') + '</button>'
        : (e.file_url ? ' <a href="' + esc(e.file_url) + '" target="_blank" rel="noopener">Open the link</a>' : '');
      return '<li class="' + (bad ? 'bad' : 'on') + '">' +
        '<div class="tl-t">' + esc(title) + (e.version ? ' <span class="muted">v' + e.version + '</span>' : '') + '</div>' +
        (e.note ? '<div class="tl-m">' + esc(e.note) + attachedHere + '</div>' : (attachedHere ? '<div class="tl-m">' + attachedHere + '</div>' : '')) +
        '<div class="tl-d">' + esc(e.actor_name || 'System') + ' · ' + esc(whenText(e.created_at)) + '</div></li>';
    }).join('') : '<li><div class="tl-m">Nothing recorded yet.</div></li>';

    $('rdBody').innerHTML =
      '<dl class="kv">' + kv.map(function (x) { return '<dt>' + esc(x[0]) + '</dt><dd>' + x[1] + '</dd>'; }).join('') + '</dl>' +
      (actions.length
        ? '<div class="sec-title">Move it along</div><div style="display:flex;gap:8px;flex-wrap:wrap">' +
          actions.map(function (a) {
            return '<button class="btn sm ' + (a[0] === 'Rejected' ? 'danger' : 'primary') +
              '" data-rfpact="' + esc(a[0]) + '">' + esc(a[1]) + '</button>';
          }).join('') + '</div>'
        : '') +
      attach +
      '<div class="sec-title">Add a note</div>' +
      '<div class="field"><textarea id="rdNote" rows="2" placeholder="What changed, what is still needed"></textarea></div>' +
      '<button class="btn sm" id="rdNoteSave">Post note</button>' +
      '<div class="sec-title">Timeline</div><ul class="tl">' + timeline + '</ul>';
  }

  async function rfpAction(toStatus) {
    var id = state.rfpDetailId;
    if (!id) return;
    var body = { status: toStatus };
    if (toStatus === 'Rejected') {
      var why = window.prompt('Why is this being rejected?');
      if (why == null) return;
      body.reject_reason = String(why).trim() || null;
    }
    /* Accepting no longer self-assigns: the VP and Founder decide who works on
       it, and the database would strip a self-assignment anyway. */
    if (toStatus === 'Accepted' && WVT.canAssignRfp()) body.assigned_to = String(WV.currentUser.id);
    if (toStatus === 'Delivered' || toStatus === 'Revised') {
      var cur = 0;
      WVT.data.rfps.forEach(function (r) { if (String(r.id) === String(id)) cur = Number(r.current_version || 0); });
      body.current_version = cur + 1;
    }
    var r = await WVT.saveRfp(body, id);
    if (!r.ok) return WV.toast('Could not update: ' + r.error);
    WV.toast('Marked ' + toStatus.toLowerCase());
    await refresh();
    await openRfpDetail(id);
  }

  /* ========================================================================
     DOCUMENT VAULT
     ======================================================================== */

  function renderDocs() {
    var cat = $('fDocCat') ? $('fDocCat').value : 'all';
    var q = val('fDocSearch').toLowerCase();
    if ($('fDocCat') && !$('fDocCat').options.length) {
      $('fDocCat').innerHTML = '<option value="all">All categories</option>' + opts(WVT.DOC_CATEGORIES, cat);
    }
    var list = WVT.data.companyDocs.filter(function (d) {
      if (cat && cat !== 'all' && d.category !== cat) return false;
      if (q && String(d.name).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
    $('cntDocs').textContent = String(WVT.data.companyDocs.length);
    var editable = WVT.isGlobal();
    show('newDocBtn', editable);

    $('docList').innerHTML = list.length
      ? '<div class="tbl-wrap"><table><thead><tr>' +
        '<th>Document</th><th>Category</th><th>Number</th><th>Issued</th><th>Expiry</th><th>File</th><th></th>' +
        '</tr></thead><tbody>' + list.map(function (d) {
          return '<tr><td style="font-weight:650">' + esc(d.name) + '</td>' +
            '<td>' + esc(d.category || '—') + '</td>' +
            '<td>' + esc(d.doc_no || '—') + '</td>' +
            '<td>' + esc(WVT.fmtDate(d.issue_date)) + '</td>' +
            '<td>' + esc(WVT.fmtDate(d.expiry_date)) + '<div style="margin-top:3px">' + WVT.expiryChip(d.expiry_date) + '</div></td>' +
            '<td>' + (d.file_path
              ? '<button class="btn sm" data-openfile="' + esc(d.file_path) + '">Open</button>'
              : '<span class="muted">none</span>') + '</td>' +
            '<td>' + (editable ? '<button class="btn sm" data-docedit="' + esc(d.id) + '">Edit</button>' : '') + '</td></tr>';
        }).join('') + '</tbody></table></div>'
      : empty('No document matches.');
  }

  function openDocEditor(id) {
    state.editDocId = id || null;
    state.pendingDocFile = null;
    var d = null;
    if (id) {
      for (var i = 0; i < WVT.data.companyDocs.length; i++) {
        if (String(WVT.data.companyDocs[i].id) === String(id)) { d = WVT.data.companyDocs[i]; break; }
      }
    }
    $('cdTitle').textContent = d ? 'Edit document' : 'Add document';
    $('cdCat').innerHTML = opts(WVT.DOC_CATEGORIES, d ? d.category : 'Statutory');
    setVal('cdName', d && d.name);
    setVal('cdNo', d && d.doc_no);
    setVal('cdIssuer', d && d.issuer);
    setVal('cdIssue', d && d.issue_date);
    setVal('cdExpiry', d && d.expiry_date);
    setVal('cdNotes', d && d.notes);
    $('cdFileName').textContent = d && d.file_path ? 'Replace the attached file' : 'Click to attach the document';
    banner('cdBanner', '');
    WV.openOverlay('docOverlay');
  }

  async function saveDoc() {
    var name = val('cdName');
    if (!name) return banner('cdBanner', 'Give the document a name.', 'bad');
    var body = {
      name: name,
      category: val('cdCat') || null,
      doc_no: val('cdNo') || null,
      issuer: val('cdIssuer') || null,
      issue_date: dateOrNull('cdIssue'),
      expiry_date: dateOrNull('cdExpiry'),
      notes: val('cdNotes') || null
    };
    if (!state.editDocId) body.created_by = String(WV.currentUser.id);

    $('cdSave').disabled = true;
    if (state.pendingDocFile) {
      banner('cdBanner', 'Uploading the file…');
      var up = await WVT.uploadFile('company', state.pendingDocFile);
      if (!up.ok) { $('cdSave').disabled = false; return banner('cdBanner', 'Upload failed: ' + up.error, 'bad'); }
      body.file_path = up.path;
    }
    var r = await WVT.saveCompanyDoc(body, state.editDocId);
    $('cdSave').disabled = false;
    if (!r.ok) return banner('cdBanner', 'Could not save: ' + r.error, 'bad');
    await WV.logActivity(state.editDocId ? 'Company document updated' : 'Company document added', name, r.row && r.row.id);
    WV.closeOverlays();
    WV.toast('Saved');
    await refresh();
  }

  /* ========================================================================
     EMD
     ======================================================================== */

  function renderEmd() {
    var rows = WVT.data.emd.filter(function (e) {
      return state.emdFilter === 'all' || e.status === 'Paid' || e.status === 'Refund Due';
    });
    $('cntEmd').textContent = String(WVT.data.emd.length);

    var paid = 0, back = 0, forfeited = 0, dueSoon = 0;
    WVT.data.emd.forEach(function (e) {
      var a = Number(e.amount || 0);
      if (e.status === 'Paid' || e.status === 'Refund Due') paid += a;
      if (e.status === 'Refunded') back += a;
      if (e.status === 'Forfeited') forfeited += a;
      var d = WVT.daysTo(e.refund_due_on);
      if (e.status !== 'Refunded' && d != null && d <= 30) dueSoon++;
    });

    $('emdKpis').innerHTML = [
      kpi('Still out', shortMoney(paid), 'not yet refunded', 'var(--warn)'),
      kpi('Refunded', shortMoney(back), 'money returned', 'var(--good)'),
      kpi('Forfeited', shortMoney(forfeited), 'not coming back', 'var(--bad)'),
      kpi('Refund due soon', dueSoon, 'within 30 days', 'var(--brand)')
    ].join('');

    /* Per firm. They enter the same tender through several firms and every
       refund comes back to WeVois, so "whose money is still out" is the
       question that actually gets asked. Hidden entirely until firms are in
       use, so it is not an empty box on day one. */
    var byFirm = WVT.emdByFirm(null);
    var showByFirm = byFirm.some(function (g) { return !!g.firmId; });
    $('emdByFirm').innerHTML = showByFirm
      ? '<div class="tbl-wrap"><table><thead><tr>' +
        '<th>Firm</th><th>Payments</th><th>Still out</th><th>Refunded</th><th>Forfeited</th>' +
        '</tr></thead><tbody>' + byFirm.map(function (g) {
          return '<tr><td>' + (g.firmId ? esc(g.name) : '<span class="muted">' + esc(g.name) + '</span>') + '</td>' +
            '<td>' + g.count + '</td>' +
            '<td class="num">' + esc(money(g.out)) + '</td>' +
            '<td class="num">' + esc(money(g.refunded)) + '</td>' +
            '<td class="num">' + esc(money(g.forfeited)) + '</td></tr>';
        }).join('') + '</tbody></table></div>'
      : '';
    show('emdByFirmCard', showByFirm);

    $('emdList').innerHTML = rows.length
      ? '<div class="tbl-wrap"><table><thead><tr>' +
        '<th>Tender</th><th>Firm</th><th>What</th><th>Amount</th><th>Mode</th><th>Paid on</th><th>Refund due</th><th>Status</th><th></th>' +
        '</tr></thead><tbody>' + rows.map(function (e) {
          var t = WVT.tenderById(e.tender_id);
          var dd = WVT.daysTo(e.refund_due_on);
          return '<tr><td>' + esc(t ? t.title : 'Unknown tender') + '</td>' +
            '<td>' + (e.firm_id ? esc(WVT.firmName(e.firm_id)) : '<span class="muted">—</span>') + '</td>' +
            '<td>' + esc(e.kind) + '</td>' +
            '<td class="num">' + esc(money(e.amount)) + '</td>' +
            '<td>' + esc(e.mode || '—') + '</td>' +
            '<td>' + esc(WVT.fmtDate(e.paid_on)) + '</td>' +
            '<td>' + esc(WVT.fmtDate(e.refund_due_on)) +
              (dd != null && dd < 0 && e.status !== 'Refunded'
                ? ' <span class="age bad">' + Math.abs(dd) + 'd over</span>' : '') + '</td>' +
            '<td>' + esc(e.status) + '</td>' +
            '<td>' + (WVT.canEditEmd()
              ? '<button class="btn sm" data-emdedit="' + esc(e.id) + '">Edit</button>' : '') + '</td></tr>';
        }).join('') + '</tbody></table></div>'
      : empty(state.emdFilter === 'out' ? 'Nothing is outstanding.' : 'Nothing recorded yet.');
  }

  /* The VP's and Founder's work list. Shown only to them: for anyone else it
     would be a list of things they cannot act on, which is just noise. */
  function renderDecisionQueue(all) {
    if (!WVT.canApprove()) { show('decisionQueueCard', false); return; }
    var rows = WVT.awaitingDecision(all);
    show('decisionQueueCard', rows.length > 0);
    if (!rows.length) return;

    $('decisionQueue').innerHTML = '<div class="tbl-wrap"><table><thead><tr>' +
      '<th>Tender</th><th>Authority</th><th>Value</th><th>Closes</th><th>Waiting</th><th></th>' +
      '</tr></thead><tbody>' + rows.map(function (t) {
        var waited = t.decision_requested_at
          ? Math.max(0, Math.round((Date.now() - new Date(t.decision_requested_at)) / 86400000))
          : null;
        var d = WVT.deadlineState(t);
        return '<tr>' +
          '<td><a href="#" data-tender="' + esc(t.id) + '">' + esc(t.title) + '</a></td>' +
          '<td>' + esc(t.authority || '—') + '</td>' +
          '<td class="num">' + esc(shortMoney(t.estimated_value)) + '</td>' +
          '<td>' + esc(WVT.fmtDate(t.submission_date)) +
            ' <span class="age ' + d.cls + '">' + esc(d.label) + '</span></td>' +
          '<td>' + (waited == null ? '—' : waited + 'd') + '</td>' +
          '<td><button class="btn sm primary" data-decide="' + esc(t.id) + '">Decide</button></td>' +
          '</tr>';
      }).join('') + '</tbody></table></div>';
  }

  /* ========================================================================
     GO / NO-GO — the one thing leadership changes
     ======================================================================== */

  function openDecideEditor(tenderId) {
    var t = WVT.tenderById(tenderId);
    if (!t) return;
    if (!WVT.canDecide(t)) return WV.toast('You cannot make this decision.');
    state.decideId = tenderId;

    $('gdSub').textContent = t.title;
    $('gdGo').innerHTML = opts(WVT.GO_OPTIONS, t.go_no_go || 'Undecided');
    setVal('gdWhy', t.go_no_go_reason);
    $('gdPrev').textContent = t.go_no_go_at
      ? 'Last decided ' + whenText(t.go_no_go_at) + ' by ' + WVT.personName(t.go_no_go_by)
      : '';
    banner('gdBanner', '');
    WV.openOverlay('decideOverlay');
  }

  async function saveDecision() {
    var t = WVT.tenderById(state.decideId);
    if (!t) return;
    var go = val('gdGo');

    /* Only these four columns are sent. The database would put anything else
       back anyway (tenders_zz_guard_update), but sending a whole tender body
       here would make the next reader think leadership can edit it. */
    var body = {
      go_no_go: go === 'Undecided' ? null : go,
      go_no_go_reason: val('gdWhy') || null
    };
    if (body.go_no_go && body.go_no_go !== t.go_no_go) {
      body.go_no_go_by = String(WV.currentUser.id);
      body.go_no_go_at = new Date().toISOString();
    }

    var btn = $('gdSave');
    btn.disabled = true;
    var r = await WVT.saveTender(body, state.decideId);
    btn.disabled = false;
    if (!r.ok) return banner('gdBanner', 'Could not save: ' + r.error, 'bad');

    await WV.logActivity('Go / No-Go recorded', (body.go_no_go || 'Undecided') + ' — ' + t.title, t.id);
    closeTop('decideOverlay');
    WV.toast('Decision saved');
    await refresh();
    if (state.detailId) renderDetail();
  }

  /* ========================================================================
     FIRMS AND BIDS
     ======================================================================== */

  function renderFirms() {
    var editable = WVT.isTenderTeam();
    show('newFirmBtn', editable);
    var rows = WVT.data.firms;

    $('firmList').innerHTML = rows.length
      ? '<div class="tbl-wrap"><table><thead><tr>' +
        '<th>Firm</th><th>Short</th><th>GST</th><th>PAN</th><th>Bids</th><th>Status</th><th></th>' +
        '</tr></thead><tbody>' + rows.map(function (f) {
          var used = WVT.data.bids.filter(function (b) { return String(b.firm_id) === String(f.id); }).length;
          return '<tr><td>' + esc(f.name) + '</td>' +
            '<td>' + esc(f.short_name || '—') + '</td>' +
            '<td>' + esc(f.gst_no || '—') + '</td>' +
            '<td>' + esc(f.pan_no || '—') + '</td>' +
            '<td>' + used + '</td>' +
            '<td>' + (f.status === 'inactive'
              ? '<span class="badge b-none">Inactive</span>'
              : '<span class="badge b-paid">Active</span>') + '</td>' +
            '<td>' + (editable ? '<button class="btn sm" data-firmedit="' + esc(f.id) + '">Edit</button>' : '') + '</td></tr>';
        }).join('') + '</tbody></table></div>'
      : empty(editable
          ? 'No firms yet. Add the companies you bid through — a work order and an experience certificate are held by one named firm, and you can only cite experience the bidding firm holds.'
          : 'No firms yet. The tender team maintains this list.');
  }

  function openFirmEditor(id) {
    if (!WVT.isTenderTeam()) return WV.toast('Only the tender team maintains the firm list.');
    state.editFirmId = id || null;
    var f = id ? WVT.firmById(id) : null;
    $('fmTitle').textContent = f ? 'Edit firm' : 'Add a firm';
    $('fmStatus').innerHTML = opts(['active', 'inactive'].map(function (v) {
      return { value: v, label: v === 'active' ? 'Active' : 'Inactive — do not offer for new bids' };
    }), f ? f.status : 'active');
    setVal('fmName', f && f.name);
    setVal('fmShort', f && f.short_name);
    setVal('fmGst', f && f.gst_no);
    setVal('fmPan', f && f.pan_no);
    setVal('fmNotes', f && f.notes);
    show('fmDelete', !!f);
    banner('fmBanner', '');
    WV.openOverlay('firmOverlay');
  }

  async function saveFirm() {
    var name = val('fmName');
    if (!name) return banner('fmBanner', 'Enter the firm’s name.', 'bad');
    var btn = $('fmSave');
    btn.disabled = true;
    var r = await WVT.saveFirm({
      name: name,
      short_name: val('fmShort') || null,
      gst_no: val('fmGst') || null,
      pan_no: val('fmPan') || null,
      notes: val('fmNotes') || null,
      status: val('fmStatus') || 'active'
    }, state.editFirmId);
    btn.disabled = false;
    if (!r.ok) return banner('fmBanner', r.error, 'bad');
    await WV.logActivity(state.editFirmId ? 'Firm updated' : 'Firm added', name);
    WV.closeOverlays();
    WV.toast('Saved');
    await refresh();
  }

  async function deleteFirm() {
    if (!state.editFirmId) return;
    var f = WVT.firmById(state.editFirmId);
    if (!window.confirm('Delete ' + (f ? f.name : 'this firm') + '?')) return;
    var r = await WVT.deleteFirm(state.editFirmId);
    if (!r.ok) return banner('fmBanner', r.error, 'bad');
    WV.closeOverlays();
    WV.toast('Firm deleted');
    await refresh();
  }

  /* --- per-tender bids --- */

  function renderDetailBids(t) {
    var rows = WVT.bidsFor(t.id);
    var editable = WVT.canEditTender(t);
    var anyFirms = WVT.data.firms.length > 0;

    var head = '<div class="card-head" style="margin-bottom:12px">' +
      '<div><b>' + rows.length + ' firm' + (rows.length === 1 ? '' : 's') + ' entered</b>' +
      '<div class="muted" style="margin-top:4px">Each firm files its own proposal and pays its own EMD. ' +
      'Record them here and the quote and rank move off the tender onto each firm.</div></div>' +
      (editable && anyFirms ? '<button class="btn sm primary" id="bidAdd">＋ Add a firm</button>' : '') +
      '</div>';

    if (!anyFirms) {
      $('dBids').innerHTML = head + empty(WVT.isTenderTeam()
        ? 'No firms set up yet. Add them under Team & access first.'
        : 'No firms set up yet. Ask the tender team to add them under Team & access.');
      return;
    }

    var emdByFirm = {};
    WVT.emdByFirm(t.id).forEach(function (g) { if (g.firmId) emdByFirm[String(g.firmId)] = g; });

    var body = rows.length
      ? '<div class="tbl-wrap"><table><thead><tr>' +
        '<th>Firm</th><th>Quote</th><th>Rank</th><th>Result</th><th>Why not</th><th>EMD still out</th><th></th>' +
        '</tr></thead><tbody>' + rows.map(function (b) {
          var g = emdByFirm[String(b.firm_id)];
          return '<tr>' +
            '<td>' + esc(WVT.firmName(b.firm_id)) + '</td>' +
            '<td class="num">' + esc(money(b.quoted_value)) + '</td>' +
            '<td>' + esc(b.our_rank || '—') + '</td>' +
            '<td>' + WVT.resultBadge(b.result) + '</td>' +
            '<td>' + (b.result === 'Not Awarded'
              ? esc(b.loss_reason || 'Not recorded') +
                (b.loss_reason_notes ? ' <span class="muted">— ' + esc(b.loss_reason_notes) + '</span>' : '')
              : '<span class="muted">—</span>') + '</td>' +
            '<td class="num">' + (g && g.out ? esc(money(g.out)) : '<span class="muted">—</span>') + '</td>' +
            '<td>' + (editable ? '<button class="btn sm" data-bidedit="' + esc(b.id) + '">Edit</button>' : '') + '</td>' +
            '</tr>';
        }).join('') + '</tbody></table></div>'
      : empty('No firms entered yet. If only one firm bid, you can leave this empty and use the quote and rank on the tender itself.');

    $('dBids').innerHTML = head + body;
  }

  function syncBidFields() {
    var lost = val('bdResult') === 'Not Awarded';
    show('bdLossWrap', lost);
    $('bdLossHint').textContent = val('bdLossReason') === 'Other'
      ? 'Required, because "Other" on its own tells the next person nothing.'
      : ' ';
  }

  function openBidEditor(tenderId, bidId) {
    var t = WVT.tenderById(tenderId);
    if (!t) return;
    if (!WVT.canEditTender(t)) {
      return WV.toast('Only tender executives update a tender. You can record the Go / No-Go decision.');
    }

    state.bidTenderId = tenderId;
    state.editBidId = bidId || null;
    var b = null;
    if (bidId) {
      for (var i = 0; i < WVT.data.bids.length; i++) {
        if (String(WVT.data.bids[i].id) === String(bidId)) { b = WVT.data.bids[i]; break; }
      }
    }

    $('bdTitle').textContent = b ? 'Edit this firm’s bid' : 'Add a firm to this tender';
    $('bdSub').textContent = t.title;

    /* Only firms not already entered, so the picker cannot offer something the
       database would refuse. */
    var choices = WVT.firmsNotBidding(tenderId, b && b.firm_id);
    $('bdFirm').innerHTML = opts(
      choices.map(function (f) { return { value: f.id, label: f.name }; }),
      b ? b.firm_id : '', 'Choose a firm');
    $('bdFirmHint').textContent = choices.length
      ? ''
      : 'Every active firm is already entered into this tender.';

    $('bdResult').innerHTML     = opts(WVT.RESULTS, b ? b.result : 'Pending');
    $('bdLossReason').innerHTML = opts(WVT.LOSS_REASONS, b ? b.loss_reason : '', 'Choose a reason');
    setVal('bdQuote', b && b.quoted_value);
    setVal('bdRank', b && b.our_rank);
    setVal('bdResultDate', b && b.result_date);
    setVal('bdLossNotes', b && b.loss_reason_notes);
    setVal('bdRemarks', b && b.remarks);
    show('bdDelete', !!b);
    syncBidFields();
    banner('bdBanner', '');
    WV.openOverlay('bidOverlay');
  }

  async function saveBid() {
    if (!val('bdFirm')) return banner('bdBanner', 'Choose which firm this is.', 'bad');
    var result = val('bdResult') || 'Pending';
    var body = {
      tender_id: String(state.bidTenderId),
      firm_id: val('bdFirm'),
      quoted_value: numOrNull('bdQuote'),
      our_rank: val('bdRank') || null,
      result: result,
      result_date: dateOrNull('bdResultDate'),
      remarks: val('bdRemarks') || null
    };
    if (result === 'Not Awarded') {
      if (!val('bdLossReason')) {
        return banner('bdBanner', 'Choose why this firm did not win.', 'bad');
      }
      if (val('bdLossReason') === 'Other' && !val('bdLossNotes')) {
        return banner('bdBanner', '"Other" needs a note, otherwise it tells the next person nothing.', 'bad');
      }
      body.loss_reason = val('bdLossReason');
      body.loss_reason_notes = val('bdLossNotes') || null;
    } else {
      body.loss_reason = null;
      body.loss_reason_notes = null;
    }

    var btn = $('bdSave');
    btn.disabled = true;
    var r = await WVT.saveBid(body, state.editBidId);
    btn.disabled = false;
    if (!r.ok) return banner('bdBanner', r.error, 'bad');

    await WV.logActivity(state.editBidId ? 'Bid updated' : 'Firm entered into tender',
      WVT.firmName(body.firm_id), state.bidTenderId);
    closeTop('bidOverlay');
    WV.toast('Saved');
    await refresh();
    if (state.detailId) { state.detailTab = 'bids'; renderDetail(); }
  }

  async function deleteBid() {
    if (!state.editBidId) return;
    if (!window.confirm('Remove this firm from the tender? Its EMD records stay, but will no longer sit against a bid.')) return;
    var r = await WVT.deleteBid(state.editBidId);
    if (!r.ok) return banner('bdBanner', r.error, 'bad');
    closeTop('bidOverlay');
    WV.toast('Removed');
    await refresh();
    if (state.detailId) { state.detailTab = 'bids'; renderDetail(); }
  }

  /* ========================================================================
     CORRIGENDA
     ======================================================================== */

  function corrDateCell(prev, next) {
    if (!next) return '<span class="muted">—</span>';
    if (!prev) return esc(WVT.fmtDate(next)) + ' <span class="muted">(was blank)</span>';
    return '<span class="muted" style="text-decoration:line-through">' + esc(WVT.fmtDate(prev)) +
           '</span> → <b>' + esc(WVT.fmtDate(next)) + '</b>';
  }

  function renderDetailCorr(t) {
    var rows = WVT.corrigendaFor(t.id);
    var editable = WVT.canEditTender(t);

    var head = '<div class="card-head" style="margin-bottom:12px">' +
      '<div><b>' + rows.length + ' corrigend' + (rows.length === 1 ? 'um' : 'a') + '</b>' +
      '<div class="muted" style="margin-top:4px">Amendments the authority issued against this tender. ' +
      'Revised dates here have already been applied above.</div></div>' +
      (editable ? '<button class="btn sm primary" id="corrAdd">＋ Corrigendum</button>' : '') +
      '</div>';

    var body = rows.length
      ? '<div class="tbl-wrap"><table><thead><tr>' +
        '<th>No.</th><th>Issued</th><th>What changed</th>' +
        '<th>Submission</th><th>Opening</th><th>Portal</th><th></th>' +
        '</tr></thead><tbody>' +
        rows.map(function (c) {
          return '<tr>' +
            '<td>' + esc(c.corrigendum_no || '—') + '</td>' +
            '<td>' + esc(WVT.fmtDate(c.issued_date)) + '</td>' +
            '<td>' + esc(c.summary || '—') +
              (c.doc_url ? ' <a href="' + esc(c.doc_url) + '" target="_blank" rel="noopener">link</a>' : '') + '</td>' +
            '<td>' + corrDateCell(c.prev_submission_date, c.new_submission_date) + '</td>' +
            '<td>' + corrDateCell(c.prev_opening_date, c.new_opening_date) + '</td>' +
            '<td>' + (c.portal_updated
              ? '<span class="badge b-paid">Updated</span>'
              : '<span class="badge b-hold">Not yet</span>') + '</td>' +
            '<td>' + (editable
              ? '<button class="btn sm danger" data-corrdel="' + esc(c.id) + '">Remove</button>' : '') + '</td>' +
            '</tr>';
        }).join('') + '</tbody></table></div>'
      : empty('No corrigendum yet. Record one when the authority amends this tender.');

    $('dCorr').innerHTML = head + body;
  }

  function openCorrEditor(tenderId) {
    var t = WVT.tenderById(tenderId);
    if (!t) return;
    state.corrTenderId = tenderId;

    $('coSub').textContent = t.title;
    setVal('coNo', String(WVT.corrigendumCount(tenderId) + 1));
    setVal('coIssued', WV.todayInput());
    ['coSummary', 'coUrl', 'coPre', 'coQuery', 'coSubDate', 'coOpen'].forEach(function (id) { setVal(id, ''); });
    setChk('coPortal', true);

    /* Show what each date is right now, so nobody has to go and look. */
    function now(id, v) {
      $(id).textContent = v ? 'Currently ' + WVT.fmtDate(v) : 'Not set';
    }
    now('coPreNow', t.pre_bid_date);
    now('coQueryNow', t.query_last_date);
    now('coSubNow', t.submission_date);
    now('coOpenNow', t.opening_date);

    banner('coBanner', '');
    WV.openOverlay('corrOverlay');
  }

  async function saveCorrigendum() {
    var summary = val('coSummary');
    if (!summary) return banner('coBanner', 'Say what the corrigendum changed.', 'bad');

    var btn = $('coSave');
    btn.disabled = true;
    var r = await WVT.saveCorrigendum(state.corrTenderId, {
      corrigendum_no: val('coNo'),
      issued_date: dateOrNull('coIssued'),
      summary: summary,
      doc_url: val('coUrl') || null,
      portal_updated: $('coPortal').checked,
      new_pre_bid_date: dateOrNull('coPre'),
      new_query_last_date: dateOrNull('coQuery'),
      new_submission_date: dateOrNull('coSubDate'),
      new_opening_date: dateOrNull('coOpen')
    });
    btn.disabled = false;

    if (!r.ok) return banner('coBanner', 'Could not save: ' + r.error, 'bad');
    if (r.datesFailed) {
      return banner('coBanner',
        'The corrigendum was saved, but the tender dates could not be updated: ' + r.error +
        ' — change them on the tender by hand.', 'bad');
    }

    await WV.logActivity('Corrigendum recorded', summary, state.corrTenderId);
    closeTop('corrOverlay');
    WV.toast(r.moved.length
      ? 'Corrigendum saved — ' + r.moved.length + ' date' + (r.moved.length === 1 ? '' : 's') + ' updated'
      : 'Corrigendum saved');
    render();
    if (state.detailId) { state.detailTab = 'corr'; renderDetail(); }
  }

  function openEmdEditor(tenderId, emdId) {
    /* Belt to the database's braces. A page left open while someone's access
       is changed would otherwise reach a save and get a raw RLS error, which
       reads like a bug rather than a rule. */
    if (!WVT.canEditEmd()) {
      return WV.toast('Only the tender team can record EMD and fees.');
    }
    var gate = WVT.tenderById(tenderId || state.emdTenderId);
    if (!emdId && gate && !WVT.isApproved(gate)) {
      return WV.toast('No money goes out before a Go. Ask the VP or Founder to approve this tender first.');
    }
    state.editEmdId = emdId || null;
    state.emdTenderId = tenderId || null;
    var e = null;
    if (emdId) {
      for (var i = 0; i < WVT.data.emd.length; i++) {
        if (String(WVT.data.emd[i].id) === String(emdId)) { e = WVT.data.emd[i]; break; }
      }
      if (e) state.emdTenderId = e.tender_id;
    }
    var t = WVT.tenderById(state.emdTenderId);
    $('eeTitle').textContent = e ? 'Edit payment' : 'Record a payment';
    $('eeSub').textContent = t ? t.title : '';
    /* Only firms that entered this tender, plus whoever is already on the row.
       Offering every firm would invite attributing a payment to a firm that
       never bid. */
    var bidFirms = WVT.bidsFor(state.emdTenderId).map(function (b) { return b.firm_id; });
    if (e && e.firm_id && bidFirms.indexOf(e.firm_id) < 0) bidFirms.push(e.firm_id);
    var firmChoices = (bidFirms.length
      ? bidFirms.map(function (id) { return WVT.firmById(id); }).filter(Boolean)
      : WVT.activeFirms());
    $('eeFirm').innerHTML = opts(
      firmChoices.map(function (f) { return { value: f.id, label: f.name }; }),
      e ? e.firm_id : '', 'Not attributed to a firm');
    $('eeKind').innerHTML   = opts(WVT.EMD_KINDS, e ? e.kind : 'EMD');
    $('eeMode').innerHTML   = opts(WVT.EMD_MODES, e ? e.mode : 'NEFT', 'Not stated');
    $('eeStatus').innerHTML = opts(WVT.EMD_STATUS, e ? e.status : 'Paid');
    setVal('eeAmount', e ? e.amount : (t ? t.emd_amount : ''));
    setVal('eeRef', e && e.instrument_no);
    setVal('eeBank', e && e.bank);
    setVal('eePaid', e ? e.paid_on : WV.todayInput());
    setVal('eeValid', e && e.valid_till);
    setVal('eeDue', e && e.refund_due_on);
    setVal('eeBack', e && e.refunded_on);
    setVal('eeNotes', e && e.notes);
    show('eeDelete', false);
    banner('eeBanner', '');
    WV.openOverlay('emdOverlay');
  }

  async function saveEmd() {
    if (!WVT.canEditEmd()) {
      return banner('eeBanner', 'Only the tender team can record EMD and fees.', 'bad');
    }
    if (!state.emdTenderId) return banner('eeBanner', 'No tender selected.', 'bad');
    var amt = val('eeAmount');
    if (amt === '') return banner('eeBanner', 'Enter the amount.', 'bad');
    var body = {
      tender_id: String(state.emdTenderId),
      firm_id: val('eeFirm') || null,
      kind: val('eeKind'),
      amount: Number(amt),
      mode: val('eeMode') || null,
      instrument_no: val('eeRef') || null,
      bank: val('eeBank') || null,
      paid_on: dateOrNull('eePaid'),
      valid_till: dateOrNull('eeValid'),
      status: val('eeStatus'),
      refund_due_on: dateOrNull('eeDue'),
      refunded_on: dateOrNull('eeBack'),
      notes: val('eeNotes') || null
    };
    if (!state.editEmdId) body.created_by = String(WV.currentUser.id);
    $('eeSave').disabled = true;
    var r = await WVT.saveEmd(body, state.editEmdId);
    $('eeSave').disabled = false;
    if (!r.ok) return banner('eeBanner', 'Could not save: ' + r.error, 'bad');
    var stacked = detailOpen();
    if (stacked) closeTop('emdOverlay'); else WV.closeOverlays();
    WV.toast('Saved');
    await refresh();
    if (stacked) { state.detailTab = 'emd'; renderDetail(); }
  }

  /* ========================================================================
     TEAM & ACCESS
     ======================================================================== */

  function renderTeam() {
    show('teamTab', WVT.isAdmin());
    if (!WVT.isAdmin()) return;

    /* Org tree, drawn by walking parents so the indent is real. */
    var byParent = {};
    WVT.data.teams.forEach(function (t) {
      var k = t.parent_id == null ? '' : String(t.parent_id);
      (byParent[k] = byParent[k] || []).push(t);
    });
    var html = '';
    (function walk(parent, depth) {
      (byParent[parent] || []).forEach(function (t) {
        var n = WVT.profiles.filter(function (p) { return String(p.tender_team_id) === String(t.id); }).length;
        html += '<div class="list-row" style="margin-left:' + (depth * 20) + 'px">' +
          '<div class="g"><div class="t">' + esc(t.name) + '</div>' +
          '<div class="s">' + (t.scope === 'global' ? 'Sees every tender' : 'Sees its own subtree') +
          ' · ' + n + ' member' + (n === 1 ? '' : 's') +
          (t.can_upload ? '' : ' · cannot add tenders') + '</div></div>' +
          '<button class="btn sm" data-teamedit="' + esc(t.id) + '">Edit</button></div>';
        walk(String(t.id), depth + 1);
      });
    })('', 0);
    $('teamTree').innerHTML = html || empty('No org units yet.');

    $('regionList').innerHTML = WVT.data.regions.length
      ? WVT.data.regions.map(function (r) {
          var n = WVT.data.tenders.filter(function (t) { return String(t.region_id) === String(r.id); }).length;
          return '<div class="list-row"><div class="g"><div class="t">' + esc(r.name) + '</div>' +
            '<div class="s">' + n + ' tender' + (n === 1 ? '' : 's') + '</div></div></div>';
        }).join('')
      : empty('No regions yet.');

    renderFirms();

    $('peopleList').innerHTML = '<div class="tbl-wrap"><table><thead><tr>' +
      '<th>Person</th><th>Billing role</th><th>Unit</th><th>Tender role</th><th>Regions</th><th>Access</th><th></th>' +
      '</tr></thead><tbody>' + WVT.profiles.map(function (p) {
        var regions = (p.tender_region_ids || []).map(WVT.regionName).join(', ') || 'All';
        var off = String(p.status || 'active').toLowerCase() === 'inactive';
        return '<tr' + (off ? ' style="opacity:.55"' : '') + '><td><div style="font-weight:650">' +
          esc(p.full_name || '—') + (off ? ' <span class="badge b-hold">Deactivated</span>' : '') + '</div>' +
          '<div class="muted" style="font-size:11px">' + esc(p.email) + '</div></td>' +
          '<td>' + esc(WV.roleLabel(p.role)) + '</td>' +
          '<td>' + esc(p.tender_team_id ? WVT.teamName(p.tender_team_id) : '—') + '</td>' +
          '<td>' + esc(WVT.ROLE_LABEL[p.tender_role] || '—') + '</td>' +
          '<td>' + esc(regions) + '</td>' +
          '<td>' + (p.tender_access
            ? '<span class="badge b-paid">Yes</span>' : '<span class="badge b-none">No</span>') + '</td>' +
          '<td><button class="btn sm" data-personedit="' + esc(p.id) + '">Edit</button></td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  /* Creating a login. Uses a THROWAWAY Supabase client (persistSession:false)
     so signing the new person up does not sign the administrator out of their
     own session - the trap the billing console hit. */
  function openUserEditor() {
    $('nuAccount').innerHTML = opts(
      WV.ROLES.map(function (r) { return { value: r, label: WV.roleLabel(r) }; }), 'member');
    $('nuTeam').innerHTML = opts(
      WVT.data.teams.map(function (t) { return { value: t.id, label: t.name }; }), '', 'No unit');
    $('nuRole').innerHTML = opts(
      WVT.TENDER_ROLES.map(function (r) { return { value: r, label: WVT.ROLE_LABEL[r] }; }), 'member', 'Not set');
    $('nuRegions').innerHTML = WVT.data.regions.map(function (r) {
      return '<label><input type="checkbox" value="' + esc(r.id) + '"><span>' + esc(r.name) + '</span></label>';
    }).join('');
    ['nuName', 'nuEmail', 'nuPass', 'nuMobile', 'nuDesig'].forEach(function (id) { setVal(id, ''); });
    setChk('nuAccess', true);
    banner('nuBanner', '');
    WV.openOverlay('userOverlay');
  }

  async function createUser() {
    var name = val('nuName'), email = val('nuEmail'), pass = $('nuPass').value;
    if (!name)           return banner('nuBanner', 'Enter their name.', 'bad');
    if (!email)          return banner('nuBanner', 'Enter their email address.', 'bad');
    if (pass.length < 8) return banner('nuBanner', 'Password must be at least 8 characters.', 'bad');

    var btn = $('nuSave');
    btn.disabled = true;
    banner('nuBanner', 'Creating the account…');

    var tmp = WV.tempClient();
    var up = await tmp.auth.signUp({
      email: email, password: pass,
      options: { data: { full_name: name, mobile_no: val('nuMobile') } }
    });
    if (up.error) {
      btn.disabled = false;
      return banner('nuBanner', 'Could not create the login: ' + up.error.message, 'bad');
    }
    try { await tmp.auth.signOut(); } catch (e) { /* throwaway client, nothing to lose */ }

    var newId = up.data && up.data.user && up.data.user.id;
    if (!newId) {
      btn.disabled = false;
      return banner('nuBanner',
        'The login was created but Supabase returned no user id - this happens when "Confirm email" is on. ' +
        'Ask them to confirm, then set their access from this list.', 'bad');
    }

    var regions = WV.$$('#nuRegions input:checked').map(function (i) { return i.value; });
    var body = {
      full_name: name,
      role: val('nuAccount') || 'member',
      mobile_no: val('nuMobile') || null,
      designation: val('nuDesig') || null,
      tender_team_id: val('nuTeam') || null,
      tender_role: val('nuRole') || null,
      tender_region_ids: regions,
      tender_access: $('nuAccess').checked,
      status: 'active'
    };
    var r = await WV.sb.from('user_profiles').update(body).eq('id', String(newId));
    btn.disabled = false;
    if (r.error) {
      return banner('nuBanner',
        'The login works, but their access could not be saved: ' + r.error.message +
        ' - set it from the people list.', 'bad');
    }

    await WV.logActivity('User created', name + ' (' + email + ')', newId);
    WV.closeOverlays();
    WV.toast(name + ' can now sign in');
    await refresh();
  }

  function openPersonEditor(id) {
    state.editPersonId = id;
    var p = WVT.profileById(id);
    if (!p) return;
    $('peTitle').textContent = p.full_name || p.email;
    $('peSub').textContent = p.email;
    setChk('peAccess', p.tender_access);
    $('peTeam').innerHTML = opts(
      WVT.data.teams.map(function (t) { return { value: t.id, label: t.name }; }),
      p.tender_team_id, 'No unit');
    $('peRole').innerHTML = opts(
      WVT.TENDER_ROLES.map(function (r) { return { value: r, label: WVT.ROLE_LABEL[r] }; }),
      p.tender_role, 'Not set');
    var mine = p.tender_region_ids || [];
    $('peRegions').innerHTML = WVT.data.regions.map(function (r) {
      return '<label><input type="checkbox" value="' + esc(r.id) + '"' +
        (mine.indexOf(String(r.id)) >= 0 ? ' checked' : '') + '><span>' + esc(r.name) + '</span></label>';
    }).join('');
    var inactive = String(p.status || 'active').toLowerCase() === 'inactive';
    $('peToggle').textContent = inactive ? 'Activate' : 'Deactivate';
    /* An admin must not be able to lock themselves out. */
    var self = String(p.id) === String(WV.currentUser.id);
    show('peToggle', !self);
    show('peRemove', !self);
    banner('peBanner', inactive ? 'This account is deactivated and cannot sign in.' : '',
      inactive ? 'bad' : null);
    WV.openOverlay('personOverlay');
  }

  async function togglePerson() {
    var p = WVT.profileById(state.editPersonId);
    if (!p) return;
    var inactive = String(p.status || 'active').toLowerCase() === 'inactive';
    var next = inactive ? 'active' : 'inactive';
    var r = await WV.sb.from('user_profiles').update({ status: next }).eq('id', String(p.id));
    if (r.error) return banner('peBanner', 'Could not change the status: ' + r.error.message, 'bad');
    await WV.logActivity('User ' + next, p.full_name || p.email, p.id);
    WV.closeOverlays();
    WV.toast(next === 'inactive' ? 'Account deactivated' : 'Account reactivated');
    await refresh();
  }

  async function removePerson() {
    var p = WVT.profileById(state.editPersonId);
    if (!p) return;
    if (!window.confirm('Remove ' + (p.full_name || p.email) + ' from the portal?\n\n' +
        'Their tenders and requests stay on record. Their LOGIN is not deleted here - ' +
        'you must also remove them in Supabase under Authentication > Users, ' +
        'otherwise they can still sign in.')) return;
    var r = await WV.sb.from('user_profiles').delete().eq('id', String(p.id));
    if (r.error) return banner('peBanner', 'Could not remove: ' + r.error.message, 'bad');
    await WV.logActivity('User removed', p.full_name || p.email, p.id);
    WV.closeOverlays();
    WV.toast('Removed. Delete their login in Supabase > Authentication > Users too.');
    await refresh();
  }

  async function savePerson() {
    var regions = WV.$$('#peRegions input:checked').map(function (i) { return i.value; });
    var body = {
      tender_access: $('peAccess').checked,
      tender_team_id: val('peTeam') || null,
      tender_role: val('peRole') || null,
      tender_region_ids: regions
    };
    $('peSave').disabled = true;
    var r = await WV.sb.from('user_profiles').update(body).eq('id', String(state.editPersonId));
    $('peSave').disabled = false;
    if (r.error) return banner('peBanner', 'Could not save: ' + r.error.message, 'bad');
    await WV.logActivity('Tender access changed', WVT.personName(state.editPersonId), state.editPersonId);
    WV.closeOverlays();
    WV.toast('Access updated');
    await refresh();
  }

  function openTeamEditor(id) {
    state.editTeamId = id || null;
    var t = id ? WVT.teamById(id) : null;
    $('tuTitle').textContent = t ? 'Edit org unit' : 'Add org unit';
    setVal('tuName', t && t.name);
    $('tuParent').innerHTML = opts(
      WVT.data.teams.filter(function (x) { return !t || String(x.id) !== String(t.id); })
        .map(function (x) { return { value: x.id, label: x.name }; }),
      t && t.parent_id, 'Top level');
    setVal('tuScope', t ? t.scope : 'subtree');
    setChk('tuUpload', t ? t.can_upload : true);
    show('tuDelete', !!t);
    banner('tuBanner', '');
    WV.openOverlay('teamOverlay');
  }

  function slug(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  }

  async function saveTeam() {
    var name = val('tuName');
    if (!name) return banner('tuBanner', 'Give the unit a name.', 'bad');
    var body = {
      name: name,
      parent_id: val('tuParent') || null,
      scope: val('tuScope'),
      can_upload: $('tuUpload').checked
    };
    var r;
    if (state.editTeamId) {
      r = await WV.sb.from('tender_teams').update(body).eq('id', String(state.editTeamId));
    } else {
      var id = slug(name) || ('unit-' + Date.now());
      if (WVT.teamById(id)) return banner('tuBanner', 'A unit with that name already exists.', 'bad');
      body.id = id;
      body.sort = (WVT.data.teams.length + 1) * 10;
      r = await WV.sb.from('tender_teams').insert(body);
    }
    if (r.error) return banner('tuBanner', 'Could not save: ' + r.error.message, 'bad');
    WV.closeOverlays();
    WV.toast('Saved');
    await refresh();
  }

  async function deleteTeam() {
    if (!state.editTeamId) return;
    var kids = WVT.data.teams.filter(function (t) { return String(t.parent_id) === String(state.editTeamId); });
    if (kids.length) return banner('tuBanner', 'Move the ' + kids.length + ' unit(s) under it somewhere else first.', 'bad');
    var people = WVT.profiles.filter(function (p) { return String(p.tender_team_id) === String(state.editTeamId); });
    if (people.length) return banner('tuBanner', people.length + ' person/people are still in this unit.', 'bad');
    if (!window.confirm('Delete this org unit?')) return;
    var r = await WV.sb.from('tender_teams').delete().eq('id', String(state.editTeamId));
    if (r.error) return banner('tuBanner', 'Could not delete: ' + r.error.message, 'bad');
    WV.closeOverlays();
    WV.toast('Unit deleted');
    await refresh();
  }

  async function saveRegion() {
    var name = val('rgName');
    if (!name) return banner('rgBanner', 'Give the region a name.', 'bad');
    var id = slug(name);
    if (WVT.regionById(id)) return banner('rgBanner', 'That region already exists.', 'bad');
    var r = await WV.sb.from('tender_regions').insert({
      id: id, name: name, sort: (WVT.data.regions.length + 1) * 10
    });
    if (r.error) return banner('rgBanner', 'Could not save: ' + r.error.message, 'bad');
    WV.closeOverlays();
    WV.toast('Region added');
    await refresh();
  }

  /* ========================================================================
     EXPORT
     ======================================================================== */

  function exportCsv() {
    var list = WVT.filterTenders(currentFilter());
    if (!list.length) return WV.toast('Nothing to export with these filters.');
    var header = ['NIT no.', 'Title', 'Authority', 'City', 'Region', 'Team', 'Responsible',
      'Type', 'Estimated value', 'EMD', 'Tender fee', 'Published', 'Pre-bid', 'Submission',
      'Opening', 'Stage', 'Go/No-Go', 'Submitted on', 'Result', 'Result date',
      'Why not awarded', 'Loss notes', 'Our rank', 'Quoted', 'Awarded to', 'Awarded value',
      'Corrigenda', 'Docs ready', 'Docs required', 'Remarks'];
    var rows = list.map(function (t) {
      var p = WVT.checklistProgress(t.id);
      return [t.nit_no || '', t.title, t.authority || '', t.city || '',
        WVT.regionName(t.region_id), WVT.teamName(t.team_id), WVT.personName(t.owner_id),
        t.tender_type || '', t.estimated_value || 0, t.emd_amount || 0, t.tender_fee || 0,
        t.published_date || '', t.pre_bid_date || '', t.submission_date || '', t.opening_date || '',
        t.stage, t.go_no_go || '', t.submitted_at ? String(t.submitted_at).slice(0, 10) : '',
        t.result || 'Pending', t.result_date || '',
        t.loss_reason || '', t.loss_reason_notes || '', t.our_rank || '',
        t.quoted_value || '', t.awarded_to || '', t.awarded_value || '',
        WVT.corrigendumCount(t.id), p.done, p.total, t.remarks || ''];
    });
    WV.downloadCsv('wevois-tenders-' + WV.todayInput() + '.csv', header, rows);
    WV.toast('Exported ' + rows.length + ' tenders');
  }

  /* ========================================================================
     RENDER / REFRESH
     ======================================================================== */

  function render() {
    if (state.view === 'dash')    renderDash();
    if (state.view === 'tenders') renderTenders();
    if (state.view === 'rfps')    renderRfps();
    if (state.view === 'docs')    renderDocs();
    if (state.view === 'emd')     renderEmd();
    if (state.view === 'team')    renderTeam();

    $('cntTenders').textContent = String(WVT.data.tenders.length);
    $('cntRfps').textContent = String(WVT.data.rfps.filter(function (r) {
      return WVT.RFP_OPEN.indexOf(r.status) >= 0;
    }).length);
    $('cntDocs').textContent = String(WVT.data.companyDocs.length);
    $('cntEmd').textContent  = String(WVT.data.emd.length);
    show('teamTab', WVT.isAdmin());
    show('newTenderBtn', WVT.canUpload());
  }

  async function refresh() {
    await WVT.loadAll();
    render();
  }

  /* ========================================================================
     BOOT
     ======================================================================== */

  function gateErr(id, msg, ok) {
    var el = $(id);
    if (!el) return;
    el.textContent = msg || '';
    el.className = 'gate-err' + (ok ? ' ok' : '');
    el.style.display = msg ? 'block' : 'none';
  }

  async function afterLogin() {
    await WVT.loadMe();
    if (!WVT.hasAccess()) {
      show('loadingScreen', false);
      show('app', false);
      $('denyWho').textContent = 'Signed in as ' + (WV.currentUser.email || '');
      $('denyGate').style.display = 'flex';
      return;
    }
    $('denyGate').style.display = 'none';
    $('loginGate').style.display = 'none';
    show('app', true);

    var me = WVT.me;
    $('subline').textContent = (me.full_name || me.email) + ' · ' +
      (WVT.ROLE_LABEL[me.tender_role] || WV.roleLabel(me.role)) +
      (me.tender_team_id ? ' · ' + WVT.teamName(me.tender_team_id) : '') +
      (WVT.isGlobal() ? ' · sees every tender' : '');

    await WVT.loadAll();
    /* the subline needs the team names, which only exist after loadAll */
    $('subline').textContent = (me.full_name || me.email) + ' · ' +
      (WVT.ROLE_LABEL[me.tender_role] || WV.roleLabel(me.role)) +
      (me.tender_team_id ? ' · ' + WVT.teamName(me.tender_team_id) : '') +
      (WVT.isGlobal() ? ' · sees every tender' : '');

    await WV.loadNotifications();
    WV.renderNotifications('notifList', 'notifBadge');
    show('loadingScreen', false);
    render();
  }

  async function boot() {
    WV.initOverlays();
    WV.initTheme();
    WV.initPWA({ buttonId: 'installBtn', helpId: 'installOverlay', androidId: 'instAndroid', iosId: 'instIos' });

    if (WV.configError) {
      show('loadingScreen', false);
      $('loginGate').style.display = 'flex';
      return gateErr('loginErr', WV.configError);
    }

    var u = await WV.resumeSession();
    if (u) return afterLogin();

    /* A brand-new database has no users at all, so nobody could ever sign in.
       Offer the one-time setup screen instead. isFirstRun() asks the database
       through a SECURITY DEFINER function, so RLS cannot make a live system
       look empty and let a stranger register themselves as the admin. */
    var fresh = false;
    try { fresh = await WV.isFirstRun(); } catch (e) { fresh = false; }

    show('loadingScreen', false);
    if (fresh) { $('setupGate').style.display = 'flex'; return; }
    $('loginGate').style.display = 'flex';
  }

  /* Create the very first administrator. The database trigger decides the role
     - the sign-up request cannot ask for it - and it grants admin only while
     user_profiles is genuinely empty. */
  async function createFirstAdmin() {
    gateErr('setupErr', '');
    var name = val('suName'), email = val('suEmail');
    var pass = $('suPass').value, confirm = $('suConfirm').value;

    if (!name)               return gateErr('setupErr', 'Enter your name.');
    if (!email)              return gateErr('setupErr', 'Enter your email address.');
    if (pass.length < 8)     return gateErr('setupErr', 'Password must be at least 8 characters.');
    if (pass !== confirm)    return gateErr('setupErr', 'The two passwords do not match.');

    var btn = $('suCreate');
    btn.disabled = true;

    /* Re-check immediately before writing, in case someone else just did it. */
    var stillFresh = true;
    try { stillFresh = await WV.isFirstRun(); } catch (e) { stillFresh = true; }
    if (!stillFresh) {
      btn.disabled = false;
      $('setupGate').style.display = 'none';
      $('loginGate').style.display = 'flex';
      return gateErr('loginErr', 'An account already exists. Please sign in.');
    }

    var r = await WV.sb.auth.signUp({
      email: email, password: pass, options: { data: { full_name: name } }
    });
    if (r.error) {
      btn.disabled = false;
      return gateErr('setupErr', r.error.message);
    }

    /* If "Confirm email" is on in Supabase there is no session yet. Say so
       plainly instead of hanging on a blank screen. */
    var signed = await WV.signIn(email, pass);
    btn.disabled = false;
    if (!signed.ok) {
      $('setupGate').style.display = 'none';
      $('loginGate').style.display = 'flex';
      return gateErr('loginErr',
        'Account created. If you were asked to confirm your email, do that first, then sign in. (' + signed.error + ')');
    }
    $('setupGate').style.display = 'none';
    show('loadingScreen', true);
    await afterLogin();
  }

  /* ========================================================================
     WIRING
     ======================================================================== */

  function wire() {
    /* --- login --- */
    on('loginBtn', 'click', async function () {
      gateErr('loginErr', '');
      var btn = $('loginBtn');
      btn.disabled = true;
      var r = await WV.signIn(val('loginEmail'), $('loginPass').value);
      btn.disabled = false;
      if (!r.ok) return gateErr('loginErr', r.error);
      show('loadingScreen', true);
      await afterLogin();
    });
    on('loginPass', 'keydown', function (e) { if (e.key === 'Enter') $('loginBtn').click(); });
    on('loginEmail', 'keydown', function (e) { if (e.key === 'Enter') $('loginBtn').click(); });
    on('eyeBtn', 'click', function () {
      var p = $('loginPass');
      p.type = p.type === 'password' ? 'text' : 'password';
    });
    on('forgotBtn', 'click', async function () {
      var r = await WV.sendPasswordReset(val('loginEmail'));
      gateErr('loginErr', r.ok ? 'Check your email for the reset link.' : r.error, r.ok);
    });
    on('logoutBtn', 'click', async function () { await WV.signOut(); location.reload(); });
    on('denyOut', 'click', async function () { await WV.signOut(); location.reload(); });

    /* --- tabs --- */
    on('tabs', 'click', function (e) {
      var b = e.target.closest('button[data-view]');
      if (b) setView(b.getAttribute('data-view'));
    });

    /* --- dashboard --- */
    on('upSeg', 'click', function (e) {
      var b = e.target.closest('button[data-days]');
      if (!b) return;
      state.upDays = Number(b.getAttribute('data-days'));
      WV.$$('#upSeg button').forEach(function (x) {
        x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
      });
      renderUpcoming();
    renderDecisionQueue(all);
    });

    /* --- tender list --- */
    ['fSearch', 'fRegion', 'fTeam', 'fStage', 'fResult', 'fMonth'].forEach(function (id) {
      on(id, 'input', renderTenders);
      on(id, 'change', renderTenders);
    });
    on('groupSeg', 'click', function (e) {
      var b = e.target.closest('button[data-g]');
      if (!b) return;
      state.group = b.getAttribute('data-g');
      WV.$$('#groupSeg button').forEach(function (x) {
        x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
      });
      renderTenders();
    });

    /* One delegated click handler for every row and inline button. */
    document.addEventListener('click', async function (e) {
      var el;

      if ((el = e.target.closest('[data-tender]')) && !e.target.closest('button')) {
        return openDetail(el.getAttribute('data-tender'));
      }
      if ((el = e.target.closest('[data-rfp]')) && !e.target.closest('button')) {
        return openRfpDetail(el.getAttribute('data-rfp'));
      }
      if ((el = e.target.closest('[data-emdedit]'))) {
        return openEmdEditor(null, el.getAttribute('data-emdedit'));
      }
      if ((el = e.target.closest('[data-docedit]'))) {
        return openDocEditor(el.getAttribute('data-docedit'));
      }
      if ((el = e.target.closest('[data-personedit]'))) {
        return openPersonEditor(el.getAttribute('data-personedit'));
      }
      if ((el = e.target.closest('[data-teamedit]'))) {
        return openTeamEditor(el.getAttribute('data-teamedit'));
      }
      if ((el = e.target.closest('[data-rfpact]'))) {
        return rfpAction(el.getAttribute('data-rfpact'));
      }
      if ((el = e.target.closest('[data-chkdel]'))) {
        var cid = el.getAttribute('data-chkdel');
        var dr = await WVT.deleteChecklistItem(cid);
        if (!dr.ok) return WV.toast('Could not remove: ' + dr.error);
        await refresh();
        if (state.detailId) { state.detailTab = 'check'; renderDetail(); }
        return;
      }
      if ((el = e.target.closest('[data-firmedit]'))) {
        return openFirmEditor(el.getAttribute('data-firmedit'));
      }
      if ((el = e.target.closest('[data-bidedit]'))) {
        return openBidEditor(state.detailId, el.getAttribute('data-bidedit'));
      }
      if (e.target.id === 'bidAdd') {
        if (state.detailId) openBidEditor(state.detailId, null);
        return;
      }
      if ((el = e.target.closest('[data-decide]'))) {
        return openDecideEditor(el.getAttribute('data-decide'));
      }
      if (e.target.id === 'corrAdd') {
        if (state.detailId) openCorrEditor(state.detailId);
        return;
      }
      if ((el = e.target.closest('[data-corrdel]'))) {
        /* Removing a corrigendum does NOT roll the tender's dates back. The
           dates on the portal are whatever the authority last said, and undoing
           our record of the amendment does not undo the amendment. */
        var dr2 = await WVT.deleteCorrigendum(el.getAttribute('data-corrdel'));
        if (!dr2.ok) return WV.toast('Could not remove: ' + dr2.error);
        WV.toast('Corrigendum removed — the tender dates were left as they are');
        if (state.detailId) { state.detailTab = 'corr'; renderDetail(); }
        return;
      }
      if ((el = e.target.closest('[data-openfile]'))) {
        var url = await WVT.fileUrl(el.getAttribute('data-openfile'));
        if (!url) return WV.toast('Could not open that file.');
        window.open(url, '_blank', 'noopener');
        return;
      }
      if (e.target.id === 'chkAdd') {
        var nm = window.prompt('What document does this tender ask for?');
        if (!nm) return;
        var ar = await WVT.saveChecklistItem({
          tender_id: String(state.detailId), name: String(nm).trim(),
          required: true, status: 'Pending', sort: 999, created_by: String(WV.currentUser.id)
        }, null);
        if (!ar.ok) return WV.toast('Could not add: ' + ar.error);
        await refresh(); state.detailTab = 'check'; renderDetail();
        return;
      }
      if (e.target.id === 'chkSeed') {
        var sr = await WVT.seedChecklist(state.detailId, null);
        if (!sr.ok) return WV.toast('Could not add: ' + sr.error);
        WV.toast('Added ' + sr.count + ' items');
        await refresh(); state.detailTab = 'check'; renderDetail();
        return;
      }
      if (e.target.id === 'emdAdd')    return openEmdEditor(state.detailId, null);
      if (e.target.id === 'rfpAddFor') return openRfpEditor(state.detailId);
      if (e.target.id === 'dCmtSave') {
        var cr = await WVT.addComment(state.detailId, $('dCmt') ? $('dCmt').value : '');
        if (!cr.ok) return WV.toast(cr.error);
        WV.toast('Comment posted');
        state.detailTab = 'talk'; renderDetail();
        return;
      }
      if (e.target.id === 'rdAttach') {
        var fEl = $('rdFile');
        var file = fEl && fEl.files && fEl.files[0];
        var link = $('rdLink') ? $('rdLink').value.trim() : '';
        e.target.disabled = true;
        var ar = await WVT.attachRfpCopy(state.rfpDetailId, file, link);
        e.target.disabled = false;
        if (!ar.ok) return banner('rdAttachBanner', ar.error, 'bad');
        WV.toast('Attached as v' + ar.version);
        await refresh();
        await openRfpDetail(state.rfpDetailId);
        return;
      }
      if (e.target.id === 'rdNoteSave') {
        var nr = await WVT.addRfpNote(state.rfpDetailId, $('rdNote') ? $('rdNote').value : '');
        if (!nr.ok) return WV.toast(nr.error);
        WV.toast('Note added');
        await openRfpDetail(state.rfpDetailId);
        return;
      }
    });

    /* checklist status dropdowns */
    document.addEventListener('change', async function (e) {
      var sel = e.target.closest('select[data-chk]');
      if (!sel) return;
      var r = await WVT.saveChecklistItem({ status: sel.value }, sel.getAttribute('data-chk'));
      if (!r.ok) return WV.toast('Could not update: ' + r.error);
      await WVT.loadAll();
      if (state.detailId) { state.detailTab = 'check'; renderDetail(); }
    });

    /* --- detail sub-tabs --- */
    on('dTabs', 'click', function (e) {
      var b = e.target.closest('button[data-d]');
      if (!b) return;
      state.detailTab = b.getAttribute('data-d');
      renderDetail();
    });
    on('dEdit', 'click', function () {
      var id = state.detailId;
      WV.closeOverlays();
      openTenderEditor(id);
    });

    /* --- tender editor --- */
    on('newTenderBtn', 'click', function () { openTenderEditor(null); });
    on('teSave', 'click', saveTender);
    on('teDelete', 'click', deleteTender);
    on('tePdfDrop', 'click', function () { $('tePdf').click(); });
    on('tePdf', 'change', function (e) {
      if (e.target.files && e.target.files[0]) readTenderPdf(e.target.files[0]);
    });

    /* --- RFP --- */
    on('newRfpBtn', 'click', function () { openRfpEditor(null); });
    on('reSave', 'click', saveRfp);
    on('rfpFilter', 'click', function (e) {
      var b = e.target.closest('button[data-f]');
      if (!b) return;
      state.rfpFilter = b.getAttribute('data-f');
      renderRfps();
    });

    /* --- documents --- */
    on('newDocBtn', 'click', function () { openDocEditor(null); });
    on('cdSave', 'click', saveDoc);
    on('cdDrop', 'click', function () { $('cdFile').click(); });
    on('cdFile', 'change', function (e) {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      state.pendingDocFile = f;
      $('cdFileName').textContent = f.name;
    });
    on('fDocCat', 'change', renderDocs);
    on('fDocSearch', 'input', renderDocs);

    /* --- EMD --- */
    on('eeSave', 'click', saveEmd);
    on('emdSeg', 'click', function (e) {
      var b = e.target.closest('button[data-f]');
      if (!b) return;
      state.emdFilter = b.getAttribute('data-f');
      WV.$$('#emdSeg button').forEach(function (x) {
        x.setAttribute('aria-pressed', x === b ? 'true' : 'false');
      });
      renderEmd();
    });

    /* --- team & access --- */
    on('suCreate', 'click', createFirstAdmin);
    on('suConfirm', 'keydown', function (e) { if (e.key === 'Enter') $('suCreate').click(); });
    on('newUserBtn', 'click', openUserEditor);
    on('nuSave', 'click', createUser);
    on('peSave', 'click', savePerson);
    on('peToggle', 'click', togglePerson);
    on('peRemove', 'click', removePerson);
    on('newTeamBtn', 'click', function () { openTeamEditor(null); });
    on('tuSave', 'click', saveTeam);
    on('tuDelete', 'click', deleteTeam);
    on('newRegionBtn', 'click', function () {
      setVal('rgName', ''); banner('rgBanner', ''); WV.openOverlay('regionOverlay');
    });
    on('rgSave', 'click', saveRegion);

    on('dDecide', 'click', function () { if (state.detailId) openDecideEditor(state.detailId); });
    on('gdSave', 'click', saveDecision);

    /* --- firms and bids --- */
    on('newFirmBtn', 'click', function () { openFirmEditor(null); });
    on('fmSave', 'click', saveFirm);
    on('fmDelete', 'click', deleteFirm);
    on('bdSave', 'click', saveBid);
    on('bdDelete', 'click', deleteBid);
    on('bdResult', 'change', syncBidFields);
    on('bdLossReason', 'change', syncBidFields);

    /* --- corrigenda --- */
    on('coSave', 'click', saveCorrigendum);

    /* The tender form shows only what can mean something right now, so it has
       to react as the stage and the submitted tick change. */
    on('teStage', 'change', syncStatusFields);
    on('teSubmitted', 'change', syncStatusFields);
    on('teLossReason', 'change', syncStatusFields);
    on('teElig2', 'change', syncStatusFields);

    /* --- misc --- */
    on('exportBtn', 'click', exportCsv);
    on('passBtn', 'click', function () {
      setVal('cpNew', ''); setVal('cpConfirm', ''); gateErr('cpErr', '');
      WV.openOverlay('passOverlay');
    });
    on('cpSave', 'click', async function () {
      var a = $('cpNew').value, b = $('cpConfirm').value;
      if (a.length < 8) return gateErr('cpErr', 'Password must be at least 8 characters.');
      if (a !== b) return gateErr('cpErr', 'The two passwords do not match.');
      var r = await WV.changePassword(a);
      if (!r.ok) return gateErr('cpErr', r.error);
      gateErr('cpErr', '✓ Password updated.', true);
      WV.toast('Password updated');
      setTimeout(WV.closeOverlays, 1200);
    });

    on('notifBell', 'click', function (e) {
      e.stopPropagation();
      $('notifPop').classList.toggle('open');
    });
    document.addEventListener('click', function (e) {
      if (!e.target.closest('.bell-wrap')) $('notifPop').classList.remove('open');
    });
    on('markReadBtn', 'click', async function () {
      await WV.markNotificationsRead();
      WV.renderNotifications('notifList', 'notifBadge');
    });
  }

  wire();
  wireStacking();
  boot();
})();
