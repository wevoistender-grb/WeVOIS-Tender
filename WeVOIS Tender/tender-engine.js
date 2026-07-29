/* ============================================================================
 * WeVois Tender Portal - ENGINE  (tender-engine.js)
 * ----------------------------------------------------------------------------
 * The shared plumbing for the standalone Tender Portal: Supabase client, real
 * auth, formatting, escaping, toasts, overlays, charts, CSV, PDF text, uploads,
 * notifications, activity log and the PWA install flow.
 *
 * This started life as the WeVois billing core with every billing-specific
 * function removed - no bills, no sites, no stages, no notesheets. The Tender
 * Portal shares NO file with the billing project and does not need it.
 *
 * Requires (in this order, before this file):
 *   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
 *   <script src="supabase-config.js"></script>
 *
 * Everything is exposed on the global  WV  object.
 * ========================================================================== */
(function (global) {
  'use strict';

  var WV = {};
  global.WV = WV;

  /* ==========================================================================
   * 1. CLIENT
   * ======================================================================== */

  WV.configError = null;
  WV.url = null;
  WV.anonKey = null;

  (function initClient() {
    if (typeof global.supabase === 'undefined' || !global.supabase.createClient) {
      WV.configError = 'Supabase library failed to load. Check your internet connection.';
      return;
    }
    /* supabase-config.js declares these with `const`, which puts them in the
     * global LEXICAL scope, not on `window` — so they must be read as bare
     * identifiers (guarded by typeof), not as global.SUPABASE_URL. */
    try { WV.url = (typeof SUPABASE_URL !== 'undefined') ? SUPABASE_URL : global.SUPABASE_URL; } catch (e) {}
    try { WV.anonKey = (typeof SUPABASE_ANON_KEY !== 'undefined') ? SUPABASE_ANON_KEY : global.SUPABASE_ANON_KEY; } catch (e) {}

    if (!WV.url || !WV.anonKey) {
      WV.configError = 'supabase-config.js is missing or did not load.';
      return;
    }
    WV.sb = global.supabase.createClient(WV.url, WV.anonKey, {
      auth: { persistSession: true, autoRefreshToken: true }
    });
  })();

  /* A throwaway client that does NOT touch the stored session — used when an
   * admin creates a login, so the admin is not signed out of their own. */
  WV.tempClient = function () {
    return global.supabase.createClient(WV.url, WV.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, storageKey: 'wv-tmp-' + Math.floor(Math.random() * 1e9) }
    });
  };


  /* ==========================================================================
   * 2. CONSTANTS
   * ======================================================================== */

  WV.MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /* Account level. What a person can DO inside the portal is decided by their
     org unit and tender role (see tender-data.js); this is only about who may
     administer the system and who counts as leadership for notifications. */
  WV.ROLES = ['admin', 'leadership', 'member'];
  WV.ROLE_META = {
    admin:      'Administrator',
    leadership: 'Leadership',
    member:     'Team member'
  };
  WV.roleLabel = function (r) { return WV.ROLE_META[r] || r || 'Team member'; };
  WV.PRIMARY_ADMIN_ROLE = 'admin';

  /* ==========================================================================
   * 3. MONTHS
   * ======================================================================== */

  /* 24 months, oldest first, ending at the LAST COMPLETED month.
   * (July's bill is entered on 1 August, so the current month is excluded.)
   * Rebuilt on demand so a long-open tab does not go stale. */
  WV.buildMonths = function (count) {
    count = count || 24;
    var now = new Date(), out = [];
    for (var i = count - 1; i >= 0; i--) {
      var d = new Date(now.getFullYear(), now.getMonth() - 1 - i, 1);
      var y = d.getFullYear(), m = d.getMonth();
      out.push({
        key:   y + '-' + String(m + 1).padStart(2, '0'),
        label: WV.MONTH_NAMES[m] + ' ' + y,
        short: WV.MONTH_NAMES[m] + " '" + String(y).slice(2),
        year: y, month: m
      });
    }
    return out;
  };

  WV.MONTHS = WV.buildMonths(24);
  WV.currentMonthKey = function () { return WV.MONTHS[WV.MONTHS.length - 1].key; };

  /* --- reporting periods ---------------------------------------------------
   * The Indian financial year runs April to March. Change FY_START_MONTH to 0
   * if you ever want to report on the calendar year instead. */
  WV.FY_START_MONTH = 3;   // 0 = Jan, so 3 = April

  WV.fyStartYear = function () {
    var cur = WV.MONTHS[WV.MONTHS.length - 1];
    return (cur.month >= WV.FY_START_MONTH) ? cur.year : cur.year - 1;
  };

  /* fyStart defaults to the financial year we are currently in. */
  WV.fyLabel = function (fyStart) {
    var y = fyStart == null ? WV.fyStartYear() : Number(fyStart);
    return 'FY ' + y + '-' + String((y + 1) % 100).padStart(2, '0');
  };

  /* Every month key from the start of the given financial year up to and
   * including the latest month of that year that we actually hold data for.
   * For a past FY that is March; for the current FY it is this month. */
  WV.ytdMonthKeys = function (fyStart) {
    var cur = WV.MONTHS[WV.MONTHS.length - 1];
    var start = fyStart == null ? WV.fyStartYear() : Number(fyStart);
    var last = new Date(start + 1, WV.FY_START_MONTH - 1, 1);   // March of FY end
    var curD = new Date(cur.year, cur.month, 1);
    if (curD < last) last = curD;                               // don't run past today

    var keys = [], d = new Date(start, WV.FY_START_MONTH, 1);
    for (var guard = 0; guard < 13 && d <= last; guard++) {
      keys.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'));
      d.setMonth(d.getMonth() + 1);
    }
    return keys;
  };

  /* Financial years we hold any month data for, newest first. */
  WV.fyOptions = function () {
    var years = {};
    WV.MONTHS.forEach(function (m) {
      years[(m.month >= WV.FY_START_MONTH) ? m.year : m.year - 1] = 1;
    });
    return Object.keys(years).map(Number).sort(function (a, b) { return b - a; });
  };

  /* "Apr 2026 – Jun 2026" */
  WV.ytdRangeLabel = function (fyStart) {
    var keys = WV.ytdMonthKeys(fyStart);
    if (!keys.length) return '';
    var a = WV.monthLabelLong(keys[0]), b = WV.monthLabelLong(keys[keys.length - 1]);
    return a === b ? a : a + ' – ' + b;
  };

  WV.monthLabel = function (key) {
    if (!key) return '—';
    var p = String(key).split('-');
    var m = parseInt(p[1], 10) - 1;
    if (isNaN(m) || !WV.MONTH_NAMES[m]) return key;
    return WV.MONTH_NAMES[m] + " '" + String(p[0]).slice(2);
  };

  WV.monthLabelLong = function (key) {
    if (!key) return '—';
    var p = String(key).split('-');
    var m = parseInt(p[1], 10) - 1;
    if (isNaN(m) || !WV.MONTH_NAMES[m]) return key;
    return WV.MONTH_NAMES[m] + ' ' + p[0];
  };

  /* ==========================================================================
   * 4. FORMATTING
   * ======================================================================== */

  var inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

  WV.num = function (v) { return inr.format(Math.round(Number(v) || 0)); };

  /* Full rupee value: ₹24,50,000 */
  WV.rupees = function (v) { return '₹' + WV.num(v); };

  /* Compact: ₹2.45 Cr / ₹4.50 L / ₹85,000.  ALREADY INCLUDES ₹ —
   * never prefix another one (the old build printed '₹₹12.50 L'). */
  WV.short = function (v) {
    v = Number(v) || 0;
    var a = Math.abs(v);
    if (a >= 1e7) return '₹' + (v / 1e7).toFixed(2) + ' Cr';
    if (a >= 1e5) return '₹' + (v / 1e5).toFixed(2) + ' L';
    return '₹' + WV.num(v);
  };

  WV.pct = function (v, dp) { return ((Number(v) || 0) * 100).toFixed(dp == null ? 1 : dp) + '%'; };

  WV.fmtD = function (ms) {
    if (!ms) return '—';
    var d = new Date(ms);
    if (isNaN(d.getTime())) return '—';
    return d.getDate() + ' ' + WV.MONTH_NAMES[d.getMonth()] + " '" + String(d.getFullYear()).slice(2);
  };

  WV.fmtDateTime = function (iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) +
      ' · ' + d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  };

  WV.todayInput = function () {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };

  /* Date input -> ISO at local noon, so a timezone shift can't roll the day. */
  WV.dateInputToISO = function (v) {
    if (!v) return null;
    var d = new Date(v + 'T12:00:00');
    return isNaN(d.getTime()) ? null : d.toISOString();
  };

  /* ==========================================================================
   * 5. ESCAPING  (every dynamic string goes through this — no exceptions)
   * ======================================================================== */

  WV.esc = function (s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };

  WV.$  = function (id) { return document.getElementById(id); };
  WV.$$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  WV.on = function (id, evt, fn) {
    var el = typeof id === 'string' ? WV.$(id) : id;
    if (el) el.addEventListener(evt, fn);
    return el;
  };

  WV.show = function (id, yes) {
    var el = typeof id === 'string' ? WV.$(id) : id;
    if (el) el.style.display = yes ? '' : 'none';
  };

  WV.text = function (id, v) {
    var el = typeof id === 'string' ? WV.$(id) : id;
    if (el) el.textContent = v == null ? '' : String(v);
  };

  /* ==========================================================================
   * 6. TOAST / OVERLAYS / THEME
   * ======================================================================== */

  var toastTimer = null;
  WV.toast = function (msg, ms) {
    var t = WV.$('toast');
    if (!t) { console.log('[toast]', msg); return; }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, ms || 2800);
  };

  WV.openOverlay = function (id) {
    var el = WV.$(id);
    if (el) el.classList.add('open');
  };

  WV.closeOverlays = function () {
    WV.$$('.overlay.open').forEach(function (o) { o.classList.remove('open'); });
  };

  /* Wire close buttons/backdrop/Escape. Safe to call after every render because
   * it delegates from document instead of binding per-element (the old build
   * bound before some modals existed, leaving dead ✕ buttons). */
  WV.initOverlays = function () {
    document.addEventListener('click', function (e) {
      var c = e.target.closest ? e.target.closest('[data-close]') : null;
      if (c) { WV.closeOverlays(); return; }
      if (e.target.classList && e.target.classList.contains('overlay')) WV.closeOverlays();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') WV.closeOverlays();
    });
  };

  /* The product is dark-only. Kept as a function so every page can call it
     without caring, and so any stray light-mode preference is cleared. */
  WV.initTheme = function (btnId) {
    document.documentElement.setAttribute('data-theme', 'dark');
    try { localStorage.removeItem('wv_theme'); } catch (e) {}
    var btn = btnId && WV.$(btnId);
    if (btn) btn.style.display = 'none';
  };

  /* ==========================================================================
   * 7. AUTH   (real Supabase Auth only — no password bypass)
   * ======================================================================== */

  WV.currentUser = null;   // { id, email, role, full_name, ... }

  /* Look up the profile. Called ONLY after Supabase has verified the password,
   * so matching on email here is a linking convenience, not an auth bypass. */
  WV.fetchProfile = async function (userId, email) {
    try {
      if (userId) {
        var r1 = await WV.sb.from('user_profiles').select('*').eq('id', String(userId)).maybeSingle();
        if (r1.data) return r1.data;
      }
      if (email) {
        var r2 = await WV.sb.from('user_profiles').select('*').ilike('email', String(email).trim()).maybeSingle();
        if (r2.data) return r2.data;
      }
    } catch (e) { console.warn('fetchProfile', e); }
    return null;
  };

  /* Returns { ok, user, error, code } */
  WV.signIn = async function (email, password) {
    email = String(email || '').trim().toLowerCase();
    if (!email || !password) return { ok: false, error: 'Enter your email and password.' };

    var res;
    try {
      res = await WV.sb.auth.signInWithPassword({ email: email, password: password });
    } catch (e) {
      return { ok: false, error: 'Network error — could not reach the server.' };
    }
    if (res.error || !res.data || !res.data.user) {
      var m = (res.error && res.error.message) || 'Invalid email or password.';
      if (/email not confirmed/i.test(m)) {
        return { ok: false, code: 'unconfirmed', error: 'This account has not been confirmed yet. Ask the admin to confirm it in Supabase → Authentication → Users.' };
      }
      return { ok: false, code: 'bad_credentials', error: 'Invalid email or password.' };
    }

    var authUser = res.data.user;
    var profile = await WV.fetchProfile(authUser.id, email);

    if (!profile) {
      await WV.sb.auth.signOut();
      return { ok: false, code: 'no_profile', error: 'Your login works, but you have no profile yet. Please ask the Admin to add you.' };
    }
    if (String(profile.status || 'active').toLowerCase() === 'inactive') {
      await WV.sb.auth.signOut();
      return { ok: false, code: 'inactive', error: '⛔ Your account is INACTIVE. Please contact the System Administrator.' };
    }

    WV.currentUser = Object.assign({}, profile, { id: profile.id, authId: authUser.id, email: profile.email || email });
    return { ok: true, user: WV.currentUser };
  };

  /* Restore an existing session on page load. Returns the user or null. */
  WV.resumeSession = async function () {
    try {
      var s = await WV.sb.auth.getSession();
      var sess = s && s.data && s.data.session;
      if (!sess || !sess.user) return null;
      var profile = await WV.fetchProfile(sess.user.id, sess.user.email);
      if (!profile) return null;
      if (String(profile.status || 'active').toLowerCase() === 'inactive') {
        await WV.sb.auth.signOut();
        return null;
      }
      WV.currentUser = Object.assign({}, profile, { id: profile.id, authId: sess.user.id, email: profile.email || sess.user.email });
      return WV.currentUser;
    } catch (e) { return null; }
  };

  WV.signOut = async function () {
    try { await WV.sb.auth.signOut(); } catch (e) {}
    WV.currentUser = null;
    location.reload();
  };

  WV.sendPasswordReset = async function (email) {
    email = String(email || '').trim();
    if (!email) return { ok: false, error: 'Enter your email address first.' };
    try {
      var r = await WV.sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
      if (r.error) return { ok: false, error: r.error.message };
      return { ok: true };
    } catch (e) { return { ok: false, error: 'Could not send the reset link.' }; }
  };

  WV.changePassword = async function (newPass) {
    if (!newPass || newPass.length < 8) return { ok: false, error: 'Password must be at least 8 characters.' };
    try {
      var r = await WV.sb.auth.updateUser({ password: newPass });
      if (r.error) return { ok: false, error: r.error.message };
      return { ok: true };
    } catch (e) { return { ok: false, error: 'Could not update the password.' }; }
  };

  WV.hasRole = function (list) {
    return !!(WV.currentUser && list.indexOf(WV.currentUser.role) !== -1);
  };
  WV.isAdmin = function () { return WV.hasRole(['admin']); };


  /* ==========================================================================
   * 8. DATA HELPERS
   * ======================================================================== */


  /* Page through results so we never silently hit Supabase's 1000-row cap. */
  WV.fetchAll = async function (table, build) {
    var out = [], page = 0, size = 1000;
    for (;;) {
      var q = WV.sb.from(table).select('*');
      if (build) q = build(q);
      var r = await q.range(page * size, page * size + size - 1);
      if (r.error) throw r.error;
      var rows = r.data || [];
      out = out.concat(rows);
      if (rows.length < size) break;
      page++;
      if (page > 50) break; // hard stop
    }
    return out;
  };

  WV.num0 = function (v) { var n = Number(v); return isNaN(n) ? 0 : n; };


  /* ==========================================================================
   * 9. READING A PDF'S TEXT LAYER
   * ======================================================================== */

  WV.PDFJS_SRC    = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
  WV.PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  var pdfjsPromise = null;

  WV.loadPdfJs = function () {
    if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
    if (pdfjsPromise) return pdfjsPromise;
    pdfjsPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = WV.PDFJS_SRC;
      s.onload = function () {
        try { window.pdfjsLib.GlobalWorkerOptions.workerSrc = WV.PDFJS_WORKER; } catch (e) {}
        resolve(window.pdfjsLib);
      };
      s.onerror = function () { pdfjsPromise = null; reject(new Error('the PDF reader could not be loaded (check the internet connection)')); };
      document.head.appendChild(s);
    });
    return pdfjsPromise;
  };

  /* Text, with the visual rows kept intact — pdf.js hands back loose fragments,
     so they are regrouped by baseline and sorted left-to-right. */
  WV.pdfText = async function (file) {
    var pdfjsLib = await WV.loadPdfJs();
    var buf = await file.arrayBuffer();
    var pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    var out = '', pages = Math.min(pdf.numPages, 5);
    for (var i = 1; i <= pages; i++) {
      var page = await pdf.getPage(i);
      var tc = await page.getTextContent();
      var rows = {};
      tc.items.forEach(function (it) {
        if (!it.str || !it.str.trim()) return;
        var y = Math.round(it.transform[5]);
        (rows[y] = rows[y] || []).push({ x: it.transform[4], s: it.str });
      });
      Object.keys(rows).map(Number).sort(function (a, b) { return b - a; }).forEach(function (y) {
        out += rows[y].sort(function (a, b) { return a.x - b.x; })
                      .map(function (o) { return o.s; }).join(' ')
                      .replace(/\s+/g, ' ').trim() + '\n';
      });
    }
    return out;
  };

  /* ==========================================================================
   * 10. UPLOADS
   * ======================================================================== */

  WV.MAX_UPLOAD_MB = 10;

  WV.compressImage = function (file) {
    return new Promise(function (resolve) {
      if (!/^image\//.test(file.type)) return resolve(file);
      var img = new Image(), url = URL.createObjectURL(file);
      img.onload = function () {
        try {
          var max = 1600, w = img.width, h = img.height;
          if (w > max || h > max) { var s = Math.min(max / w, max / h); w = Math.round(w * s); h = Math.round(h * s); }
          var c = document.createElement('canvas');
          c.width = w; c.height = h;
          c.getContext('2d').drawImage(img, 0, 0, w, h);
          c.toBlob(function (blob) {
            URL.revokeObjectURL(url);
            if (blob && blob.size < file.size) {
              resolve(new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' }));
            } else resolve(file);
          }, 'image/jpeg', 0.7);
        } catch (e) { URL.revokeObjectURL(url); resolve(file); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  };

  WV.validateUpload = function (file) {
    if (!file) return { ok: false, error: 'No file selected.' };
    var okType = /^image\//.test(file.type) || file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
    if (!okType) return { ok: false, error: 'Please choose an image or a PDF file.' };
    if (file.size > WV.MAX_UPLOAD_MB * 1024 * 1024) {
      return { ok: false, error: 'File is too large (max ' + WV.MAX_UPLOAD_MB + ' MB).' };
    }
    return { ok: true };
  };
  /* ==========================================================================
   * 12. NOTIFICATIONS  (scoped to the signed-in user — the old build's
   *     "mark all read" updated every row for every user in the system)
   * ======================================================================== */

  WV.notifications = [];

  WV.audienceForRole = function (role) {
    switch (role) {
      case 'admin':      return ['all', 'admin', 'leadership'];
      case 'leadership': return ['all', 'leadership'];
      default:           return ['all', 'member'];
    }
  };

  WV.loadNotifications = async function () {
    if (!WV.currentUser) return [];
    try {
      var aud = WV.audienceForRole(WV.currentUser.role);
      var r = await WV.sb.from('notifications').select('*')
        .order('created_at', { ascending: false }).limit(40);
      if (r.error) { WV.notifications = []; return []; }
      WV.notifications = (r.data || []).filter(function (n) {
        var rr = String(n.recipient_role || 'all');
        return aud.indexOf(rr) !== -1;
      });
      return WV.notifications;
    } catch (e) { WV.notifications = []; return []; }
  };

  WV.addNotification = async function (title, message, type, recipientRole, siteId) {
    try {
      var row = {
        title: title, message: message, type: type || 'info',
        recipient_role: recipientRole || 'all',
        site_id: siteId ? String(siteId) : null,
        created_by_email: (WV.currentUser && WV.currentUser.email) || null,
        read: false
      };
      var r = await WV.sb.from('notifications').insert(row).select().single();
      if (!r.error && r.data) WV.notifications.unshift(r.data);
      return !r.error;
    } catch (e) { return false; }
  };

  WV.markNotificationsRead = async function () {
    var ids = WV.notifications.filter(function (n) { return !n.read; }).map(function (n) { return n.id; });
    if (!ids.length) return true;
    try {
      var r = await WV.sb.from('notifications').update({ read: true }).in('id', ids);
      if (r.error) return false;
      WV.notifications.forEach(function (n) { n.read = true; });
      return true;
    } catch (e) { return false; }
  };

  WV.renderNotifications = function (listId, badgeId) {
    var list = WV.$(listId), badge = WV.$(badgeId);
    if (!list) return;
    var unread = WV.notifications.filter(function (n) { return !n.read; }).length;
    if (badge) {
      badge.textContent = unread > 99 ? '99+' : String(unread);
      badge.style.display = unread ? '' : 'none';
    }
    if (!WV.notifications.length) {
      list.innerHTML = '<div class="notif-empty">No notifications.</div>';
      return;
    }
    list.innerHTML = WV.notifications.map(function (n) {
      var t = n.created_at ? new Date(n.created_at) : null;
      var time = t && !isNaN(t.getTime())
        ? t.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) + ' · ' +
          t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : '';
      return '<div class="notif' + (n.read ? '' : ' unread') + '">' +
        '<div class="notif-t">' + WV.esc(n.title) + '</div>' +
        '<div class="notif-m">' + WV.esc(n.message) + '</div>' +
        '<div class="notif-d">' + WV.esc(time) + '</div>' +
      '</div>';
    }).join('');
  };

  /* ==========================================================================
   * 13. ACTIVITY LOG
   * ======================================================================== */

  WV.logActivity = async function (action, details, target) {
    try {
      await WV.sb.from('activity_logs').insert({
        action: action,
        details: details,
        target: target || null,
        performed_by_name:  (WV.currentUser && WV.currentUser.full_name) || null,
        performed_by_email: (WV.currentUser && WV.currentUser.email) || null,
        performed_by_role:  (WV.currentUser && WV.currentUser.role) || null
      });
    } catch (e) { /* audit is best-effort, never block the user action */ }
  };

  /* ==========================================================================
   * 16. CSV
   * ======================================================================== */

  WV.downloadCsv = function (filename, header, rows) {
    var q = function (v) { return '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; };
    var lines = [header.map(q).join(',')];
    rows.forEach(function (r) { lines.push(r.map(q).join(',')); });
    var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  };

  /* ==========================================================================
   * 17. CHARTS  (dependency-free SVG; tooltips use real <title> children so
   *     they actually appear — the old build set title="" as an attribute on
   *     <rect>, which SVG ignores)
   * ======================================================================== */

  var svgNS = 'http://www.w3.org/2000/svg';
  function mk(tag, attrs, parent) {
    var e = document.createElementNS(svgNS, tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (parent) parent.appendChild(e);
    return e;
  }
  function tip(el, text) {
    var t = document.createElementNS(svgNS, 'title');
    t.textContent = text;
    el.appendChild(t);
  }
  function niceMax(v) {
    if (!v || v <= 0) return 1;
    var mag = Math.pow(10, Math.floor(Math.log10(v)));
    return Math.ceil(v / mag) * mag;
  }
  WV.niceMax = niceMax;

  function cssVar(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name);
    return (v && v.trim()) || fallback;
  }

  /* opts: { labels:[], series:[{name, values:[], color, fill}] } */
  /* Vertical category bars, one colour per bar, with the value written above
     and a sub-label underneath. Used for debtor ageing.
     opts: { labels:[], values:[], colors:[], subs:[], name } */
  WV.categoryBars = function (host, opts) {
    if (!host) return;
    host.innerHTML = '';
    var W = 760, H = 270, pl = 68, pr = 16, pt = 34, pb = 52;
    var svg = mk('svg', { viewBox: '0 0 ' + W + ' ' + H, width: '100%', height: H, preserveAspectRatio: 'none' }, host);

    var labels = opts.labels || [], values = opts.values || [];
    var colors = opts.colors || [], subs = opts.subs || [];
    var fmt = opts.fmt || WV.short;                 /* how a value reads */
    var n = labels.length || 1;
    var peak = Math.max.apply(null, values.concat([0]));
    /* Counts need whole-number gridlines: with max=2 the four ticks land on
     * 2/1.5/1/0.5 and render as "2 2 1 1 0". Snap to a multiple of 4 instead. */
    var max = opts.integer
      ? Math.max(4, Math.ceil(Math.max(peak, 1) / 4) * 4)
      : (niceMax(peak * 1.18) || 1);
    var iw = W - pl - pr, ih = H - pt - pb;
    var slot = iw / n, bw = Math.min(96, slot * 0.52);
    var axis = cssVar('--axis', '#3a3f45'), muted = cssVar('--muted', '#8b949e'), text = cssVar('--text', '#e6edf3');

    for (var g = 0; g <= 4; g++) {
      var gy = pt + (ih * g) / 4;
      mk('line', { x1: pl, y1: gy, x2: W - pr, y2: gy, stroke: axis, 'stroke-width': 1, opacity: 0.32 }, svg);
      var yl = mk('text', { x: pl - 9, y: gy + 4, 'text-anchor': 'end', 'font-size': 10, fill: muted }, svg);
      yl.textContent = fmt(max - (max * g) / 4).replace('₹', '');
    }

    for (var i = 0; i < n; i++) {
      var v = values[i] || 0;
      var h = (Math.max(0, v) / max) * ih;
      var cx = pl + i * slot + slot / 2;
      var bx = cx - bw / 2;
      var col = colors[i] || cssVar('--brand', '#0f7a4f');

      /* faint track so an empty bucket still reads as a bar */
      mk('rect', { x: bx, y: pt, width: bw, height: ih, rx: 6, fill: col, opacity: 0.07 }, svg);

      var r = mk('rect', {
        'data-bar': String(i),
        x: bx, y: pt + ih - Math.max(h, v > 0 ? 3 : 0), width: bw,
        height: Math.max(h, v > 0 ? 3 : 0), rx: 6, fill: col
      }, svg);
      tip(r, labels[i] + '\n' + (opts.name || 'Outstanding') + ': ' + fmt(v) + (subs[i] ? '\n' + subs[i] : ''));

      var vl = mk('text', {
        x: cx, y: pt + ih - Math.max(h, 0) - 10, 'text-anchor': 'middle',
        'font-size': 12.5, 'font-weight': 700, fill: v > 0 ? col : muted
      }, svg);
      vl.textContent = fmt(v);

      var xl = mk('text', { x: cx, y: H - 30, 'text-anchor': 'middle', 'font-size': 11.5, 'font-weight': 650, fill: text }, svg);
      xl.textContent = labels[i];

      if (subs[i]) {
        var sl = mk('text', { x: cx, y: H - 14, 'text-anchor': 'middle', 'font-size': 10.5, fill: muted }, svg);
        sl.textContent = subs[i];
      }

      /* Whole column is one hit target: easier to hit than a 3px-tall bar, and
       * it keeps an empty bucket clickable so "0 sites" is still explorable. */
      if (opts.onClick) {
        var hit = mk('rect', {
          'data-cbhit': String(i), x: pl + i * slot, y: pt, width: slot, height: H - pt - 8,
          fill: 'transparent', style: 'cursor:pointer'
        }, svg);
        tip(hit, labels[i] + '\n' + (opts.name || 'Outstanding') + ': ' + fmt(v) +
          (subs[i] ? '\n' + subs[i] : '') + '\nClick to see the sites');
        (function (idx) {
          hit.addEventListener('click', function () { opts.onClick(idx); });
        })(i);
      }
    }
  };
  /* ==========================================================================
   * 19. BOOT HELPERS
   * ======================================================================== */

  /* Is the system brand new (no users at all)?  Used to offer first-run setup.
   *
   * Asks the database via the SECURITY DEFINER function wv_needs_setup(), which
   * returns the TRUTH even to a signed-out visitor. A plain row count would be
   * blocked by RLS and read back as 0 — which would show the setup screen on a
   * live system and let a stranger register themselves. Falls back to the count
   * only when the function is absent (i.e. before the setup SQL has been run,
   * when RLS is still off and the count is honest anyway). */
  WV.isFirstRun = async function () {
    try {
      var rpc = await WV.sb.rpc('wv_needs_setup');
      if (!rpc.error && typeof rpc.data === 'boolean') return rpc.data;
    } catch (e) { /* function not installed yet */ }
    try {
      var r = await WV.sb.from('user_profiles').select('id', { count: 'exact', head: true });
      if (r.error) return false;
      return (r.count || 0) === 0;
    } catch (e) { return false; }
  };

  WV.countRows = async function (table) {
    try {
      var r = await WV.sb.from(table).select('id', { count: 'exact', head: true });
      if (r.error) return null;
      return r.count || 0;
    } catch (e) { return null; }
  };

  /* ==========================================================================
   * 20. INSTALL TO HOME SCREEN (PWA)
   * ======================================================================== */

  WV.isIOS = function () {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
           (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  };

  WV.isInstalled = function () {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
           navigator.standalone === true;
  };

  /* opts: { buttonId, helpId, androidId, iosId }
   * Registers the service worker, then wires the install button:
   *   • Android / desktop Chrome — fires the real install prompt
   *   • iPhone / iPad — Safari has no prompt, so we show the manual steps
   *   • already installed — the button hides itself                        */
  WV.initPWA = function (opts) {
    opts = opts || {};

    if ('serviceWorker' in navigator &&
        (location.protocol === 'https:' || location.hostname === 'localhost')) {
      navigator.serviceWorker.register('sw.js').catch(function (e) {
        console.warn('service worker not registered', e);
      });
    }

    var btn = opts.buttonId && WV.$(opts.buttonId);
    if (!btn) return;

    if (WV.isInstalled()) { btn.style.display = 'none'; return; }

    var deferred = null;

    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      deferred = e;
      btn.style.display = '';
      btn.title = 'Add WeVois to your home screen';
    });

    window.addEventListener('appinstalled', function () {
      deferred = null;
      btn.style.display = 'none';
      WV.toast('✅ Installed — look for the WV icon on your home screen');
    });

    /* Show the right set of manual steps for the device in front of us. */
    if (opts.androidId) WV.show(opts.androidId, !WV.isIOS());
    if (opts.iosId)     WV.show(opts.iosId, WV.isIOS());

    btn.addEventListener('click', function () {
      if (deferred) {
        deferred.prompt();
        deferred.userChoice.then(function (choice) {
          deferred = null;
          if (choice && choice.outcome !== 'accepted' && opts.helpId) WV.openOverlay(opts.helpId);
        });
      } else if (opts.helpId) {
        WV.openOverlay(opts.helpId);   // iOS, or the prompt isn't available yet
      }
    });
  };

  WV.fatal = function (msg) {
    var d = document.createElement('div');
    d.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#0d1117;color:#e6edf3;display:flex;align-items:center;justify-content:center;padding:24px;font:15px/1.6 system-ui,sans-serif;text-align:center';
    d.innerHTML = '<div style="max-width:520px"><div style="font-size:34px;margin-bottom:12px">⚠️</div>' +
      '<div style="font-weight:700;font-size:18px;margin-bottom:8px">The app could not start</div>' +
      '<div style="opacity:.8">' + WV.esc(msg) + '</div></div>';
    document.body.appendChild(d);
  };

})(window);
