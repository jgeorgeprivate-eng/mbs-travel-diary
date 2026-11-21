/* MBS Travel Diary pilot: front end. Plain JavaScript, no build step. Policy calculations are in rules.js. */
(function () {
  'use strict';

  /* ---------- Config and client ---------- */
  var cfg = window.MBS_CONFIG || {};
  if (!cfg.SUPABASE_URL || cfg.SUPABASE_URL.indexOf('YOUR_') >= 0) {
    document.getElementById('app').innerHTML = '<div class="panel err">config.js has not been filled in. See README step 3.</div>';
    return;
  }
  var sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  var R = window.MBSRules;

  var DAY_TYPES = ['Travel', 'Working', 'Not working', 'Weekend', 'Public holiday', 'Leave'];
  var ADVICE_LABEL = { 1: 'Exercise normal safety precautions', 2: 'Exercise a high degree of caution', 3: 'Reconsider your need to travel', 4: 'Do not travel', 0: 'No Smartraveller advice found' };
  var COST_CENTRES = ['Exec Ed - MBS Asia', 'Exec Ed - Custom ANZ', 'Exec Ed - Open', 'Award - Academic allowance', 'Award - Teaching', 'Award - Other', 'Marketing', 'External relations', 'Dean’s Office', 'Other'];
  var ADVICE_SHORT = { 1: 'Normal', 2: 'Caution', 3: 'Reconsider', 4: 'Do not travel', 0: 'No advice found' };
  var PAGE = 25;            // trips per page in lists
  var FETCH_CAP = 1000;     // the API returns at most this many rows per request
  var state = { session: null, me: null, people: [], advice: {}, adviceFetched: null, loaded: false, pending: 0, noApprover: 0 };
  var TODAY = R.iso(new Date());

  /* ---------- Small helpers ---------- */
  var iso = R.iso, parse = R.parse, addDays = R.addDays, daysBetween = R.daysBetween, isWeekend = R.isWeekend;
  function fmt(s, o) { return parse(s).toLocaleDateString('en-AU', o || { weekday: 'short', day: 'numeric', month: 'short' }); }
  function fmtShort(s) { return parse(s).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }); }
  function fmtStamp(ts) { return new Date(ts).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }); }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function q(id) { return document.getElementById(id); }
  function toast(msg, long) { var t = q('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(function () { t.classList.remove('show'); }, long ? 5000 : 2400); }
  function keepScroll(fn) { var y = window.scrollY; fn(); window.scrollTo(0, y); }
  function person(id) { return state.people.find(function (p) { return p.id === id; }) || { full_name: 'Unknown', kind: 'staff', role: 'traveller' }; }
  function personByEmail(e) { e = (e || '').toLowerCase(); return state.people.find(function (p) { return (p.email || '').toLowerCase() === e; }); }
  function myEmail() { return ((state.session && state.session.user && state.session.user.email) || '').toLowerCase(); }
  function seesAll() { return state.me && ['arranger', 'manager', 'admin'].indexOf(state.me.role) >= 0; }
  function isAdmin() { return state.me && state.me.role === 'admin'; }
  function canManagePeople() { return state.me && ['arranger', 'admin'].indexOf(state.me.role) >= 0; }
  function canEditTrip(t) { return !!state.me && (t.traveller_id === state.me.id || t.entered_by === state.me.id || canManagePeople()); }

  /* ---------- Rules (wrappers over rules.js using the loaded advice) ---------- */
  function classify(country) { return R.classify(country, state.advice); }
  function adviceFor(country) { return classify(country).level; }
  var tripCountries = R.tripCountries, assess = R.assess, dayFor = R.dayFor;
  function tripAdvice(t) { return R.tripLevel(t, state.advice); }
  function advTag(level) { return '<span class="tag adv' + level + '">' + (level ? 'Level ' + level + ': ' : '') + ADVICE_LABEL[level] + '</span>'; }
  /* Tag for one destination: advice level (dated if old), domestic, or not recognised. */
  function countryTag(c) {
    var k = classify(c);
    if (k.status === 'domestic') return '<span class="tag info">Domestic travel, no advice check</span>';
    if (k.status === 'unresolved') return '<span class="tag bad">Not recognised</span>';
    return advTag(k.level) + (R.isStale(k.fetched_at) ? ' <span class="tag warn" title="This country was not refreshed in the latest Smartraveller update">advice dated ' + (k.fetched_at ? fmtStamp(k.fetched_at) : 'unknown') + '</span>' : '');
  }
  function buildDays(start, end, keep) { return R.buildDays(start, end, keep); }
  function flagTags(a) {
    return (a.selfDirected ? ' <span class="tag warn">' + a.selfDirected + ' remote working day' + (a.selfDirected === 1 ? '' : 's') + '</span>' : '') + (a.leave ? ' <span class="tag warn">' + a.leave + ' leave day' + (a.leave === 1 ? '' : 's') + ' abroad</span>' : '');
  }
  function testTag(a) { return a.noWeekdays ? '<span class="tag">No eligible weekdays</span>' : (a.ok ? '<span class="tag ok">Meets</span>' : '<span class="tag warn">Below 50%</span>'); }
  function statusTag(t) {
    var names = { submitted: 'Awaiting approval', approved: 'Approved', declined: 'Declined', draft: 'Draft' };
    return '<span class="status ' + t.status + '">' + names[t.status] + '</span>';
  }
  /* Review flags that apply to a trip: advice raised since approval, unrecognised destination, missing Level 3 reference, no approver. */
  function reviewTags(t) {
    var out = '';
    if (R.adviceRaised(t, state.advice)) out += ' <span class="tag bad">Advice raised since approval: review</span>';
    if (R.unresolvedCountries(t, state.advice).length) out += ' <span class="tag bad">Destination not recognised</span>';
    if (tripAdvice(t) >= 3 && !R.level3Covered(t, state.advice)) out += ' <span class="tag bad">Dean permission reference missing</span>';
    if (t.status === 'submitted' && !t.manager_email) out += ' <span class="tag bad">No approver set</span>';
    return out;
  }
  function ccOptions(current) {
    var list = COST_CENTRES.slice();
    if (current && list.indexOf(current) < 0) list.push(current); // keep an older free-text value visible until someone changes it
    return '<option value="">Select cost centre</option>' + list.map(function (c) { return '<option ' + (c === current ? 'selected' : '') + '>' + esc(c) + '</option>'; }).join('');
  }
  function ccOrder(set) { // cost centres in the agreed order, then any older values
    var keys = Object.keys(set), known = COST_CENTRES.filter(function (c) { return set[c]; });
    return known.concat(keys.filter(function (c) { return COST_CENTRES.indexOf(c) < 0; }).sort());
  }
  function advShort(level) { return '<span class="tag adv' + level + '" title="' + esc((level ? 'Level ' + level + ': ' : '') + ADVICE_LABEL[level]) + '">' + ADVICE_SHORT[level] + '</span>'; }
  function countryList() { return '<datalist id="countries">' + Object.keys(state.advice).map(function (k) { return '<option value="' + esc(state.advice[k].country) + '">'; }).join('') + '<option value="Australia"></datalist>'; }

  /* ---------- Data ---------- */
  // People and advice change rarely and are loaded once per sign-in (and after a People edit).
  function loadStatic() {
    return Promise.all([
      sb.from('people').select('*').order('full_name'),
      sb.rpc('people_directory'),
      sb.from('advice_levels').select('*')
    ]).then(function (r) {
      var errs = r.filter(function (x) { return x.error; });
      if (errs.length) throw new Error(errs.map(function (x) { return x.error.message; }).join('; '));
      // The directory lists everyone without contact details; the people table adds full rows where the rules allow.
      var full = {}; (r[0].data || []).forEach(function (p) { full[p.id] = p; });
      state.people = (r[1].data || []).map(function (d) { return full[d.id] || d; });
      (r[0].data || []).forEach(function (p) { if (!state.people.some(function (x) { return x.id === p.id; })) state.people.push(p); });
      state.people.sort(function (a, b) { return a.full_name < b.full_name ? -1 : 1; });
      state.advice = {}; state.adviceFetched = null;
      (r[2].data || []).forEach(function (a) { state.advice[a.country.toLowerCase()] = a; if (!state.adviceFetched || a.fetched_at > state.adviceFetched) state.adviceFetched = a.fetched_at; });
      state.me = state.people.find(function (p) { return p.user_id === state.session.user.id; }) || null;
      state.loaded = true;
    });
  }
  // Trips are fetched by the screen that needs them: a date window, a queue or a page of a list.
  function prepTrip(t) {
    t.days = (t.trip_days || []).sort(function (a, b) { return a.day_date < b.day_date ? -1 : 1; });
    t.segments = (t.trip_segments || []).sort(function (a, b) { return a.sort_order - b.sort_order; });
    delete t.trip_days; delete t.trip_segments; return t;
  }
  function fetchTrips(shape, sel, from, count) {
    var qry = sb.from('trips').select(sel || '*, trip_days(*)');
    qry = shape(qry).range(from || 0, (from || 0) + (count || FETCH_CAP) - 1);
    return qry.then(function (r) {
      if (r.error) throw new Error(r.error.message);
      var rows = (r.data || []).map(prepTrip);
      return { trips: rows, full: rows.length >= (count || FETCH_CAP) };
    });
  }
  function countTrips(shape) {
    return shape(sb.from('trips').select('id', { count: 'exact', head: true })).then(function (r) { return r.error ? 0 : (r.count || 0); });
  }

  /* ---------- Auth ---------- */
  var pendingEmail = '';
  function renderSignIn(msg) {
    q('nav').innerHTML = ''; q('who').innerHTML = '';
    if (pendingEmail) {
      q('app').innerHTML = '<div class="signin"><div class="panel"><h1>Enter your code</h1>' +
        '<p class="lead">We emailed a sign-in code to ' + esc(pendingEmail) + '. Type it here. It is valid for one hour.</p>' +
        (msg ? '<div class="err">' + esc(msg) + '</div>' : '') +
        '<label class="f"><span>Code</span><input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="8" placeholder="12345678" style="font-size:22px;letter-spacing:4px"></label>' +
        '<div class="actions"><button type="button" class="btn primary" id="verify">Sign in</button><button type="button" class="btn quiet" id="back">Use a different email</button></div></div></div>';
      q('verify').addEventListener('click', function () {
        var code = q('code').value.replace(/\D/g, '');
        if (code.length < 6) { toast('Enter the code from the email'); return; }
        q('verify').disabled = true;
        sb.auth.verifyOtp({ email: pendingEmail, token: code, type: 'email' }).then(function (r) {
          q('verify').disabled = false;
          if (r.error) { renderSignIn(/expired|invalid/i.test(r.error.message) ? 'That code is wrong or has expired. Check the latest email, or request a new code.' : r.error.message); return; }
          pendingEmail = '';
        });
      });
      q('code').addEventListener('keydown', function (e) { if (e.key === 'Enter') q('verify').click(); });
      q('back').addEventListener('click', function () { pendingEmail = ''; renderSignIn(); });
      q('code').focus();
      return;
    }
    q('app').innerHTML = '<div class="signin"><div class="panel"><h1>Sign in</h1>' +
      '<p class="lead">Enter your ' + esc(cfg.ALLOWED_DOMAIN_HINT || 'work') + ' email address and we will email you a code. No password needed.</p>' +
      (msg ? '<div class="err">' + esc(msg) + '</div>' : '') +
      '<label class="f"><span>Email</span><input type="email" id="email" autocomplete="email" placeholder="you@' + esc(cfg.ALLOWED_DOMAIN_HINT || 'example.com') + '"></label>' +
      '<div class="actions"><button type="button" class="btn primary" id="sendLink">Send me a code</button></div></div></div>';
    q('sendLink').addEventListener('click', function () {
      var email = q('email').value.trim().toLowerCase();
      if (!email) { toast('Enter your email address'); return; }
      q('sendLink').disabled = true;
      sb.auth.signInWithOtp({ email: email, options: { shouldCreateUser: true } }).then(function (r) {
        q('sendLink').disabled = false;
        if (r.error) { renderSignIn(r.error.message.indexOf('not allowed') >= 0 ? 'That email address is not allowed to use the pilot. Ask an admin to add you.' : r.error.message); return; }
        pendingEmail = email; renderSignIn();
      });
    });
    q('email').addEventListener('keydown', function (e) { if (e.key === 'Enter') q('sendLink').click(); });
  }

  var DRAFT_KEY = 'mbs-draft:';
  function boot() {
    sb.auth.getSession().then(function (r) { handleSession(r.data.session); });
    sb.auth.onAuthStateChange(function (_ev, session) { if ((session && session.user.id) !== (state.session && state.session.user.id)) handleSession(session); });
  }
  // Everything held in memory or in the browser for one person is cleared when the account changes or signs out.
  function clearStoredDrafts() { try { Object.keys(localStorage).filter(function (k) { return k.indexOf(DRAFT_KEY) === 0; }).forEach(function (k) { localStorage.removeItem(k); }); } catch (e) { /* storage unavailable */ } }
  function resetPrivate() { draft = null; editingId = null; draftNotice = ''; dash = { win: [], on: [], full: false }; state.people = []; state.me = null; state.pending = 0; state.noApprover = 0; newPerson = null; }
  function handleSession(session) {
    var prev = state.session && state.session.user && state.session.user.id, next = session && session.user && session.user.id;
    if (prev !== next) { resetPrivate(); if (prev) clearStoredDrafts(); }
    state.session = session; state.loaded = false;
    if (!session) { renderSignIn(); return; }
    q('app').innerHTML = '<div class="loading">Loading</div>';
    loadStatic().then(function () {
      if (!state.me) { renderSignIn('Your account is not active, or has no person record. Ask an admin to check your entry on the People page, then sign in again.'); return; }
      return refreshHeader().then(route);
    }).catch(function (e) { q('app').innerHTML = '<div class="panel err">Could not load data: ' + esc(e.message) + '</div>'; });
  }
  // Re-fetch what the current screen shows, plus the approval counts in the header.
  function reload() { return refreshHeader().then(function () { keepScroll(route); }); }
  function reloadPeople() { return loadStatic().then(function () { return refreshHeader(); }).then(function () { keepScroll(route); }); }

  /* ---------- Header and routing ---------- */
  function refreshHeader() {
    var mine = function (qy) { qy = qy.eq('status', 'submitted'); return isAdmin() ? qy : qy.eq('manager_email', myEmail()); };
    return Promise.all([
      countTrips(mine),
      canManagePeople() ? countTrips(function (qy) { return qy.eq('status', 'submitted').is('manager_email', null); }) : Promise.resolve(0)
    ]).then(function (r) { state.pending = r[0]; state.noApprover = r[1]; renderHeader(); }, function () { renderHeader(); });
  }
  function renderHeader() {
    var views = [['dashboard', 'Dashboard'], ['log', 'Log a trip'], ['trips', 'Trips']];
    var badge = state.pending + (canManagePeople() && !isAdmin() ? state.noApprover : 0);
    if (badge || ['manager', 'admin', 'arranger'].indexOf(state.me.role) >= 0) views.push(['approvals', 'Approvals' + (badge ? '<span class="badge-count">' + badge + '</span>' : '')]);
    if (canManagePeople()) views.push(['people', 'People']);
    if (isAdmin()) views.push(['audit', 'Audit log']);
    q('nav').innerHTML = views.map(function (v) { return '<a href="#' + v[0] + '" data-view="' + v[0] + '">' + v[1] + '</a>'; }).join('');
    q('who').innerHTML = '<span>' + esc(state.me.full_name) + '</span><button type="button" id="signout">Sign out</button>';
    q('signout').addEventListener('click', function () { clearStoredDrafts(); resetPrivate(); sb.auth.signOut().then(function () { state.session = null; renderSignIn(); }); });
    var v = currentView(); document.querySelectorAll('#nav a').forEach(function (a) { a.classList.toggle('active', a.dataset.view === v); });
  }
  var editingId = null, draft = null, draftNotice = '', draftDecisions = [], viewToken = 0;
  function currentView() {
    var h = (location.hash || '#dashboard').replace('#', '').split('/')[0];
    if (['dashboard', 'log', 'trips', 'approvals', 'people', 'audit'].indexOf(h) < 0) h = 'dashboard';
    if (h === 'people' && !canManagePeople()) h = 'dashboard';
    if (h === 'audit' && !isAdmin()) h = 'dashboard';
    return h;
  }
  function route() {
    if (!state.session || !state.loaded) return;
    var v = currentView();
    document.querySelectorAll('#nav a').forEach(function (a) { a.classList.toggle('active', a.dataset.view === v); });
    var app = q('app'); viewToken++;
    if (v === 'dashboard') renderDashboard(app);
    else if (v === 'log') renderLog(app);
    else if (v === 'trips') renderTrips(app);
    else if (v === 'approvals') renderApprovals(app);
    else if (v === 'audit') renderAudit(app);
    else renderPeople(app);
  }
  window.addEventListener('hashchange', function () { route(); window.scrollTo(0, 0); });
  function openTrip(id) { editingId = id; draft = null; if (location.hash === '#log') route(); else location.hash = '#log'; }
  function bindOpenLinks(root) { root.querySelectorAll('[data-edit]').forEach(function (a) { a.addEventListener('click', function (e) { e.preventDefault(); openTrip(a.dataset.edit); }); }); }
  function failView(app, e) { app.innerHTML = '<div class="panel err">Could not load this screen: ' + esc(e.message) + '</div>'; }

  /* ---------- Dashboard ---------- */
  var dashDate = TODAY, dashCountry = '', dashCC = '';
  var dash = { win: [], on: [], full: false };   // win: trips in the next eight weeks; on: trips away on the chosen date
  function dashWindow() { var start = addDays(TODAY, -((parse(TODAY).getDay() + 6) % 7)); return { lo: start, hi: addDays(TODAY, 56) }; }
  function loadWin() { var w = dashWindow(); return fetchTrips(function (qy) { return qy.lte('start_date', w.hi).gte('end_date', w.lo).neq('status', 'draft').order('start_date'); }).then(function (r) { dash.win = r.trips; dash.full = r.full; }); }
  function loadOn() { return fetchTrips(function (qy) { return qy.lte('start_date', dashDate).gte('end_date', dashDate).neq('status', 'draft').order('start_date'); }).then(function (r) { dash.on = r.trips; }); }
  function keep(list) { return list.filter(function (t) { return t.status !== 'declined' && (!dashCC || t.cost_centre === dashCC); }); }
  function renderDashboard(app) {
    var tok = viewToken;
    app.innerHTML = '<div class="loading">Loading</div>';
    Promise.all([loadWin(), loadOn()]).then(function () {
      if (tok !== viewToken) return;
      var countries = {}, ccs = {};
      dash.win.concat(dash.on).forEach(function (t) { tripCountries(t).forEach(function (c) { countries[c] = 1; }); if (t.cost_centre) ccs[t.cost_centre] = 1; });
      var snap = state.adviceFetched ? fmtStamp(state.adviceFetched) : 'not yet loaded';
      var stale = R.isStale(state.adviceFetched);
      app.innerHTML = '<h1>Where everyone is</h1>' +
        (stale ? '<div class="banner warn">Smartraveller advice levels were last refreshed on ' + snap + ' (more than 3 days ago). Levels shown may be out of date. Ask the administrator to check the daily refresh.</div>' : '') +
        (dash.full ? '<div class="banner warn">There are more than ' + FETCH_CAP + ' trips in this period, so the lists below are incomplete. Filter by cost centre or country.</div>' : '') +
        '<p class="lead">Pick a date to see who is away, in which city and whether it is a working day for them. Colours are Smartraveller advice levels (last refreshed ' + snap + '). The timeline shows the next eight weeks. Declined trips are not shown.</p>' +
        '<div class="toolbar">' +
        '<label><span>On this date</span><input type="date" id="dashDate" value="' + dashDate + '"></label>' +
        '<button type="button" class="btn" id="dashToday">Today</button>' +
        '<label><span>Country</span><select id="dashCountry"><option value="">All countries</option>' + Object.keys(countries).sort().map(function (c) { return '<option ' + (c === dashCountry ? 'selected' : '') + '>' + esc(c) + '</option>'; }).join('') + '</select></label>' +
        '<label><span>Cost centre</span><select id="dashCC"><option value="">All cost centres</option>' + ccOrder(ccs).map(function (c) { return '<option ' + (c === dashCC ? 'selected' : '') + '>' + esc(c) + '</option>'; }).join('') + '</select></label>' +
        '</div><div id="where"></div>' +
        (seesAll() ? '<h2>By cost centre</h2><div class="panel scroll" id="byCC"></div>' : '') +
        '<h2>Next eight weeks</h2><div id="timeline"></div>' +
        '<div class="legend"><span><i style="background:var(--adv1)"></i>Level 1 normal precautions</span><span><i style="background:var(--adv2)"></i>Level 2 high degree of caution</span><span><i style="background:var(--adv3)"></i>Level 3 reconsider need to travel</span><span><i style="background:var(--adv4)"></i>Level 4 do not travel</span><span><i style="background:var(--adv0)"></i>No advice found or domestic</span></div>' +
        '<h2>Checks</h2><div class="panel scroll" id="checks"></div>';
      var all = function () { renderWhere(); if (seesAll()) renderByCC(); renderTimeline(); renderChecks(); };
      q('dashDate').addEventListener('change', function (e) { dashDate = e.target.value || TODAY; loadOn().then(function () { if (tok === viewToken) keepScroll(all); }).catch(function (er) { toast(er.message, true); }); });
      q('dashToday').addEventListener('click', function () { dashDate = TODAY; q('dashDate').value = TODAY; loadOn().then(function () { if (tok === viewToken) keepScroll(all); }); });
      q('dashCountry').addEventListener('change', function (e) { dashCountry = e.target.value; keepScroll(all); });
      q('dashCC').addEventListener('change', function (e) { dashCC = e.target.value; keepScroll(all); });
      all();
    }).catch(function (e) { if (tok === viewToken) failView(app, e); });
  }
  function renderWhere() {
    var el = q('where'), rows = [];
    keep(dash.on).forEach(function (t) { var d = dayFor(t, dashDate); if (d && (!dashCountry || d.country === dashCountry)) rows.push({ t: t, d: d }); });
    if (!rows.length) { el.innerHTML = '<div class="empty">No recorded trips for ' + fmt(dashDate, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) + (dashCountry ? ' in ' + esc(dashCountry) : '') + '.</div>'; return; }
    var by = {};
    rows.forEach(function (r) { var k = r.d.country || 'Location not entered'; (by[k] = by[k] || []).push(r); });
    el.innerHTML = '<p class="muted" style="margin:0 0 10px">' + rows.length + (rows.length === 1 ? ' person' : ' people') + ' away on ' + fmt(dashDate, { weekday: 'long', day: 'numeric', month: 'long' }) + '.</p><div class="where">' +
      Object.keys(by).sort().map(function (c) {
        var k = classify(c), lv = k.level;
        return '<div class="country adv' + lv + '"><h3>' + esc(c) + '<span class="tag info">' + by[c].length + '</span></h3><div class="advline">' + (k.status === 'domestic' ? 'Domestic travel' : (k.status === 'unresolved' ? 'Destination not recognised' : (lv ? 'Level ' + lv + ': ' : '') + ADVICE_LABEL[lv])) + (k.status === 'listed' && R.isStale(k.fetched_at) ? ' (advice dated ' + (k.fetched_at ? fmtStamp(k.fetched_at) : 'unknown') + ')' : '') + '</div>' +
          by[c].map(function (r) {
            var p = person(r.t.traveller_id);
            return '<div class="person"><b>' + esc(p.full_name) + (p.kind === 'contractor' ? ' <span class="tag">Contractor</span>' : '') + '</b>' +
              '<div class="sub">' + esc(r.d.city || 'City not entered') + ' · ' + esc(r.d.day_type) + (r.d.allowance ? ' · allowance claimed' : '') + ' · ' + statusTag(r.t) + '</div>' +
              '<div class="sub">' + esc(p.mobile || 'No mobile recorded') + ' · <a href="#log" data-edit="' + r.t.id + '">open trip</a></div></div>';
          }).join('') + '</div>';
      }).join('') + '</div>';
    bindOpenLinks(el);
  }
  function renderByCC() {
    var el = q('byCC'), horizon = addDays(TODAY, 56), ccs = {};
    dash.win.concat(dash.on).forEach(function (t) { if (t.cost_centre) ccs[t.cost_centre] = 1; });
    el.innerHTML = '<table><thead><tr><th>Cost centre</th><th>Away on ' + fmtShort(dashDate) + '</th><th>Trips in next 8 weeks</th><th>Travellers</th><th>Allowance days</th><th>Below 50%</th><th>Remote working</th><th>Leave days abroad</th><th>Level 3 or 4</th><th>Awaiting approval</th><th>Dean permission missing</th></tr></thead><tbody>' +
      ccOrder(ccs).map(function (cc) {
        var s = R.ccSummary(dash.win, dash.on, cc, TODAY, horizon, state.advice);
        var cell = function (n, cls) { return n ? '<span class="tag ' + cls + '">' + n + '</span>' : '0'; };
        return '<tr style="' + (cc === dashCC ? 'background:var(--blue-soft)' : '') + '"><td><a href="#dashboard" data-cc="' + esc(cc) + '">' + esc(cc) + '</a></td><td>' + s.away + '</td><td>' + s.soon + '</td><td>' + s.travellers + '</td><td>' + s.allowance + '</td>' +
          '<td>' + cell(s.below, 'warn') + '</td><td>' + cell(s.remote, 'warn') + '</td><td>' + cell(s.leave, 'warn') + '</td><td>' + cell(s.high, 'adv3') + '</td><td>' + cell(s.waiting, 'warn') + '</td><td>' + cell(s.deanMissing, 'bad') + '</td></tr>';
      }).join('') + '</tbody></table><p class="muted" style="margin:10px 0 0;font-size:13.5px">Select a cost centre to filter the rest of the dashboard to it. Counts cover trips that overlap the next eight weeks.</p>';
    el.querySelectorAll('[data-cc]').forEach(function (a) { a.addEventListener('click', function (e) { e.preventDefault(); dashCC = dashCC === a.dataset.cc ? '' : a.dataset.cc; q('dashCC').value = dashCC; keepScroll(function () { renderWhere(); renderByCC(); renderTimeline(); renderChecks(); }); }); });
  }
  function renderTimeline() {
    var el = q('timeline'), start = addDays(TODAY, -((parse(TODAY).getDay() + 6) % 7)), total = 56, weeks = [];
    for (var i = 0; i < 8; i++) weeks.push(addDays(start, i * 7));
    var trips = keep(dash.win).filter(function (t) { return !dashCountry || tripCountries(t).indexOf(dashCountry) >= 0; });
    var people = state.people.filter(function (p) { return trips.some(function (t) { return t.traveller_id === p.id && daysBetween(start, t.end_date) >= 0 && daysBetween(start, t.start_date) < total; }); });
    var todayPct = daysBetween(start, TODAY) / total * 100;
    el.innerHTML = '<div class="timeline"><div class="tl"><div class="head cell-name">Traveller</div><div class="head weeks" style="grid-template-columns:repeat(8,1fr)">' + weeks.map(function (w) { return '<div>Week of ' + fmtShort(w) + '</div>'; }).join('') + '</div>' +
      (people.length ? people.map(function (p) {
        return '<div class="name">' + esc(p.full_name) + '<small>' + esc(p.cost_centre || '') + '</small></div><div class="lane"><div class="today" style="left:' + todayPct + '%"></div>' +
          trips.filter(function (t) { return t.traveller_id === p.id; }).map(function (t) {
            var s = Math.max(0, daysBetween(start, t.start_date)), e = Math.min(total, daysBetween(start, t.end_date) + 1);
            if (e <= 0 || s >= total) return '';
            return '<div class="bar adv' + tripAdvice(t) + '" style="left:' + (s / total * 100) + '%;width:' + ((e - s) / total * 100) + '%;' + (t.status === 'submitted' ? 'opacity:.6;border:2px dashed rgba(0,0,0,.35)' : '') + '" title="' + esc(t.purpose) + (t.status === 'submitted' ? ' (awaiting approval)' : '') + '" data-edit="' + t.id + '">' + esc(tripCountries(t).join(', ') || t.purpose) + '</div>';
          }).join('') + '</div>';
      }).join('') : '<div class="name">No trips</div><div class="lane"></div>') + '</div></div><p class="muted" style="font-size:13px;margin:6px 0 0">Dashed bars are awaiting approval.</p>';
    bindOpenLinks(el);
  }
  function renderChecks() {
    var el = q('checks'), trips = keep(dash.win).filter(function (t) { return !dashCountry || tripCountries(t).indexOf(dashCountry) >= 0; });
    el.innerHTML = '<table><thead><tr><th>Traveller</th><th class="c-dates">Dates</th><th>Countries</th><th class="c-adv">Smartraveller</th><th>Weekdays away</th><th>Qualifying days</th><th>Business activity 50% test</th><th>Remote working</th><th>Leave days abroad</th><th>Allowance days</th><th>Approvals</th><th>Entered by</th></tr></thead><tbody>' +
      (trips.map(function (t) {
        var p = person(t.traveller_id), a = assess(t), e = person(t.entered_by), lv = tripAdvice(t), old = R.oldestAdvice(t, state.advice);
        return '<tr><td><a href="#log" data-edit="' + t.id + '">' + esc(p.full_name) + '</a>' + (p.kind === 'contractor' ? ' <span class="tag">Contractor</span>' : '') + '</td><td class="c-dates">' + fmtShort(t.start_date) + ' to ' + fmtShort(t.end_date) + '</td><td>' + esc(tripCountries(t).join(', ')) + '</td><td class="c-adv">' + advShort(lv) + (old && R.isStale(old) ? '<div class="sub" title="Oldest advice date for the countries on this trip">as at ' + fmtStamp(old) + '</div>' : '') + '</td><td>' + a.weekdays + '</td><td>' + a.qualifying + '</td>' +
          '<td>' + testTag(a) + '</td><td>' + (a.selfDirected ? '<span class="tag warn">' + a.selfDirected + '</span>' : '0') + '</td><td>' + (a.leave ? '<span class="tag warn">' + a.leave + '</span>' : '0') + '</td><td>' + a.allowance + '</td>' +
          '<td>' + statusTag(t) + (t.manager_declared ? '' : ' <span class="tag bad">Not declared</span>') + (lv >= 3 && R.level3Covered(t, state.advice) ? ' <span class="tag ok">Dean</span>' : '') + reviewTags(t) + '</td>' +
          '<td>' + (e.id === p.id ? 'Self' : esc(e.full_name)) + '</td></tr>';
      }).join('') || '<tr><td colspan="12" class="muted">No recorded trips in the next eight weeks.</td></tr>') + '</tbody></table>';
    bindOpenLinks(el);
  }

  /* ---------- Log a trip ---------- */
  function blankTrip() {
    var me = state.me;
    return { id: null, version: null, traveller_id: me.id, entered_by: me.id, purpose: '', cost_centre: me.cost_centre || '', start_date: '', end_date: '', manager_declared: false, manager_declared_date: '', level3: [], review: {}, status: 'submitted', days: [], segments: [] };
  }
  function toDraft(t) {
    var d = JSON.parse(JSON.stringify(t)); d.level3 = d.level3 || []; d.review = {};
    (d.days || []).forEach(function (x) { if (x.dest_status === 'reviewed' && x.review_note) d.review[x.country] = x.review_note; });
    return d;
  }
  // A private draft of a new trip is kept in this browser, under this person's id, until it is submitted or they sign out.
  function draftKey() { return DRAFT_KEY + (state.session && state.session.user && state.session.user.id); }
  var saveTimer;
  function touch() {
    if (!draft || draft.id) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { try { localStorage.setItem(draftKey(), JSON.stringify({ at: Date.now(), draft: draft })); } catch (e) { /* storage unavailable */ } }, 400);
  }
  function clearLocalDraft() { clearTimeout(saveTimer); try { localStorage.removeItem(draftKey()); } catch (e) { /* storage unavailable */ } }
  function loadLocalDraft() {
    try {
      var v = JSON.parse(localStorage.getItem(draftKey()) || 'null');
      if (v && v.draft && !v.draft.id && Date.now() - v.at < 30 * 86400000) {
        var d = v.draft; if (!state.people.some(function (p) { return p.id === d.traveller_id; })) d.traveller_id = state.me.id;
        d.entered_by = state.me.id; d.level3 = d.level3 || []; d.review = d.review || {};
        draftNotice = 'Restored your unsaved draft from ' + new Date(v.at).toLocaleString('en-AU', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) + '.';
        return d;
      }
    } catch (e) { /* ignore a damaged draft */ }
    return null;
  }
  function decisionsHtml(list) {
    if (!list || !list.length) return '';
    return '<div class="panel scroll"><h3 style="margin-top:0">Decision history</h3><table class="audit"><thead><tr><th>When</th><th>What happened</th><th>By</th><th>Comment</th></tr></thead><tbody>' + list.map(function (d) {
      return '<tr><td class="nowrap">' + new Date(d.at).toLocaleString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) + '</td><td>' + esc(d.event) + (d.level != null && d.event === 'Approved' ? ' <span class="muted">(' + (d.level ? 'Level ' + d.level : 'no advice') + ')</span>' : '') + '</td><td>' + esc(d.by_name || d.by_email || '') + '</td><td>' + esc(d.comment || '') + '</td></tr>';
    }).join('') + '</tbody></table></div>';
  }
  function renderLog(app) {
    var tok = viewToken;
    if (editingId) {
      var id = editingId; editingId = null; draft = null; draftNotice = '';
      app.innerHTML = '<div class="loading">Loading trip</div>';
      Promise.all([
        sb.from('trips').select('*, trip_days(*), trip_segments(*)').eq('id', id).maybeSingle(),
        sb.from('trip_decisions').select('*').eq('trip_id', id).order('at')
      ]).then(function (r) {
        if (tok !== viewToken) return;
        if (r[0].error) throw new Error(r[0].error.message);
        if (!r[0].data) { app.innerHTML = '<div class="panel err">This trip was not found, or you do not have access to it. <a href="#trips">Back to trips</a></div>'; return; }
        var t = prepTrip(r[0].data); draftDecisions = r[1].data || [];
        if (!canEditTrip(t)) { renderTripView(app, t); return; }
        draft = toDraft(t); showLogForm(app);
      }).catch(function (e) { if (tok === viewToken) failView(app, e); });
      return;
    }
    if (!draft) { draft = loadLocalDraft() || blankTrip(); draftDecisions = []; }
    showLogForm(app);
  }
  function showLogForm(app) {
    var isEdit = !!draft.id, onBehalf = draft.traveller_id !== state.me.id;
    var canPick = canManagePeople() || isAdmin();
    var travellers = state.people.filter(function (p) { return p.active || p.id === draft.traveller_id; });
    var trav = person(draft.traveller_id), mgrEmail = (trav.manager_email || '').toLowerCase(), mgr = personByEmail(mgrEmail);
    app.innerHTML = countryList() + '<h1>' + (isEdit ? 'Edit trip' : 'Log a trip') + '</h1>' +
      '<p class="lead">Record where you are going, where you are staying and what each day is for. You can come back and change it until the trip ends.' + (isEdit ? ' This trip is ' + statusTag(draft) + '.' : '') + '</p>' +
      (draftNotice && !isEdit ? '<p class="note">' + esc(draftNotice) + ' <button type="button" class="btn quiet" id="discardDraft">Discard draft</button></p>' : '') +
      (isEdit && draft.status === 'approved' ? '<p class="note">This trip is approved. Changing the traveller, line manager, dates, destinations, or the number of business, remote working or leave days sends it back for approval. Correcting a hotel or flight does not.</p>' : '') +
      (isEdit && draft.approval_comment ? '<p class="note">Comment from approver: ' + esc(draft.approval_comment) + '</p>' : '') +
      '<div class="panel"><h3 style="margin-top:0">Who is travelling</h3><div class="row">' +
      '<label class="f"><span>Traveller</span><select id="travellerId"' + (canPick ? '' : ' disabled') + '>' + travellers.map(function (p) { return '<option value="' + p.id + '" ' + (p.id === draft.traveller_id ? 'selected' : '') + '>' + esc(p.full_name) + ' (' + (p.kind === 'contractor' ? 'contractor' : esc(p.cost_centre || 'staff')) + ')</option>'; }).join('') + '</select></label>' +
      '<label class="f"><span>Entered by</span><input value="' + esc(person(draft.entered_by).full_name) + '" disabled></label></div>' +
      (onBehalf ? '<p class="note">You are entering this on behalf of ' + esc(person(draft.traveller_id).full_name) + '. They can see and edit it when they sign in.</p>' : '') +
      '<div class="row"><label class="f" style="flex:2 1 320px"><span>Purpose of travel</span><input id="purpose" value="' + esc(draft.purpose) + '" placeholder="e.g. Deliver in-company program, Singapore"></label>' +
      '<label class="f"><span>Cost centre</span><select id="cc">' + ccOptions(draft.cost_centre) + '</select></label></div>' +
      '<div class="row"><label class="f"><span>First day away</span><input type="date" id="start" value="' + esc(draft.start_date) + '"></label>' +
      '<label class="f"><span>Last day away</span><input type="date" id="end" value="' + esc(draft.end_date) + '"></label>' +
      '<div class="f approver"><span>Approver (from the staff record)</span>' + (mgrEmail ? '<div class="approver-name">' + esc(mgr ? mgr.full_name : mgrEmail) + ' <small>' + esc(mgrEmail) + '</small></div>' : '<div class="approver-name"><span class="tag bad">No approver set</span> <small>An arranger must set the line manager for ' + esc(trav.full_name) + ' on the People page before this trip can be approved.</small></div>') + '</div></div>' +
      '<p class="muted" id="rangeNote" style="margin:0 0 10px">A trip can cover up to ' + R.MAX_DAYS + ' days. Every date needs an entry.</p>' +
      '<label class="check"><input type="checkbox" id="approved" ' + (draft.manager_declared ? 'checked' : '') + '><span>I confirm that approval for this travel was sought from and given by the line manager shown above' + (onBehalf ? ' (or the traveller has confirmed this to me)' : '') + '. The manager will also be asked to approve it in this app.</span></label>' +
      '<div class="row" id="approvedRow" style="' + (draft.manager_declared ? '' : 'display:none') + '"><label class="f" style="flex:0 1 220px"><span>Date approval was given</span><input type="date" id="approvedDate" value="' + esc(draft.manager_declared_date || '') + '"></label></div></div>' +
      '<div class="panel seg"><h3 style="margin-top:0">Flights</h3><div class="scroll"><table id="flights"></table></div><button type="button" class="btn quiet" id="addFlight">Add a flight</button>' +
      '<h3>Accommodation</h3><div class="scroll"><table id="stays"></table></div><button type="button" class="btn quiet" id="addStay">Add accommodation</button></div>' +
      '<div class="panel"><h3 style="margin-top:0">Day by day</h3><p class="muted" style="margin:0 0 12px;max-width:72ch">For each working day, say what is happening in that location. A working day counts towards the business activity 50% test only if the work could not equally have been done from Melbourne. Online meetings and self-directed work do not count, though you do not need to take leave for them. Travel days count as necessary business travel. Mark a Melbourne public holiday as such and it is left out of the test, like a weekend. Use Australia for domestic days.</p><div class="days" id="days"></div></div>' +
      '<div class="panel" id="summary"></div>' +
      decisionsHtml(isEdit ? draftDecisions : []) +
      '<div class="actions"><button type="button" class="btn primary" id="saveTrip">' + (isEdit ? 'Save changes' : 'Submit trip') + '</button><button type="button" class="btn" id="discard">' + (isEdit ? 'Cancel' : 'Clear form') + '</button>' + (isEdit ? '<button type="button" class="btn danger quiet" id="deleteTrip">Delete trip</button>' : '') + '</div>';

    q('travellerId').addEventListener('change', function (e) { draft.traveller_id = e.target.value; var p = person(draft.traveller_id); draft.cost_centre = p.cost_centre || draft.cost_centre; touch(); keepScroll(function () { showLogForm(app); }); });
    q('purpose').addEventListener('input', function (e) { draft.purpose = e.target.value; touch(); });
    q('cc').addEventListener('change', function (e) { draft.cost_centre = e.target.value; touch(); });
    q('approvedDate').addEventListener('input', function (e) { draft.manager_declared_date = e.target.value; touch(); });
    q('approved').addEventListener('change', function (e) { draft.manager_declared = e.target.checked; q('approvedRow').style.display = draft.manager_declared ? '' : 'none'; if (draft.manager_declared && !draft.manager_declared_date) { draft.manager_declared_date = TODAY; q('approvedDate').value = TODAY; } touch(); });
    q('start').addEventListener('change', function (e) { draft.start_date = e.target.value; if (draft.start_date && (!draft.end_date || draft.end_date < draft.start_date)) { draft.end_date = draft.start_date; q('end').value = draft.end_date; } regenDays(); });
    q('end').addEventListener('change', function (e) { draft.end_date = e.target.value; regenDays(); });
    q('addFlight').addEventListener('click', function () { draft.segments.push({ kind: 'flight', carrier: '', flight_number: '', origin: 'MEL', destination: '', seg_date: draft.start_date || '' }); touch(); keepScroll(renderSegs); });
    q('addStay').addEventListener('click', function () { draft.segments.push({ kind: 'stay', property: '', city: '', country: '', checkin: draft.start_date || '', checkout: draft.end_date || '', paid_by_mbs: true }); touch(); keepScroll(renderSegs); });
    q('saveTrip').addEventListener('click', saveDraft);
    q('discard').addEventListener('click', function () { clearLocalDraft(); draft = null; draftNotice = ''; if (isEdit) location.hash = '#trips'; else showLogForm(app); });
    var dd = q('discardDraft'); if (dd) dd.addEventListener('click', function () { clearLocalDraft(); draft = blankTrip(); draftNotice = ''; showLogForm(app); });
    if (isEdit) q('deleteTrip').addEventListener('click', function () {
      if (!confirm('Delete this trip?')) return;
      sb.rpc('delete_trip', { p_trip: draft.id }).then(function (r) { if (r.error) { toast(r.error.message, true); return; } draft = null; toast('Trip deleted'); refreshHeader().then(function () { location.hash = '#trips'; }); });
    });
    renderSegs(); renderDays(); renderSummary();
  }
  function regenDays() {
    var note = q('rangeNote');
    if (!draft.start_date || !draft.end_date) return;
    var days = buildDays(draft.start_date, draft.end_date, draft.days);
    if (!days) {
      if (note) note.innerHTML = '<span class="tag bad">' + (daysBetween(draft.start_date, draft.end_date) < 0 ? 'The last day is before the first day.' : 'A trip can cover at most ' + R.MAX_DAYS + ' days. Your day entries have been left as they were. Enter a shorter range or split the trip.') + '</span>';
      return;
    }
    if (note) note.textContent = 'A trip can cover up to ' + R.MAX_DAYS + ' days. Every date needs an entry.';
    draft.days = days;
    draft.days.forEach(function (d, i) { if (!d.country && i > 0) { d.country = draft.days[i - 1].country; d.city = d.city || draft.days[i - 1].city; } });
    touch();
    keepScroll(function () { renderDays(); renderSummary(); });
  }
  function renderSegs() {
    var f = q('flights'), s = q('stays');
    var flights = draft.segments.map(function (x, i) { return { x: x, i: i }; }).filter(function (o) { return o.x.kind === 'flight'; });
    var stays = draft.segments.map(function (x, i) { return { x: x, i: i }; }).filter(function (o) { return o.x.kind === 'stay'; });
    f.innerHTML = '<thead><tr><th>Airline</th><th>Flight</th><th>From</th><th>To</th><th>Date</th><th></th></tr></thead><tbody>' + (flights.map(function (o) {
      return '<tr><td class="cell"><input data-i="' + o.i + '" data-k="carrier" value="' + esc(o.x.carrier) + '" placeholder="Qantas"></td><td class="cell"><input data-i="' + o.i + '" data-k="flight_number" value="' + esc(o.x.flight_number) + '" placeholder="QF35" style="min-width:80px"></td><td class="cell"><input data-i="' + o.i + '" data-k="origin" value="' + esc(o.x.origin) + '" style="min-width:70px"></td><td class="cell"><input data-i="' + o.i + '" data-k="destination" value="' + esc(o.x.destination) + '" style="min-width:70px"></td><td class="cell"><input type="date" data-i="' + o.i + '" data-k="seg_date" value="' + esc(o.x.seg_date || '') + '"></td><td><button type="button" class="btn quiet" data-del="' + o.i + '" title="Remove">✕</button></td></tr>';
    }).join('') || '<tr><td colspan="6" class="muted">No flights yet.</td></tr>') + '</tbody>';
    s.innerHTML = '<thead><tr><th>Property</th><th>City</th><th>Country</th><th>Check in</th><th>Check out</th><th>Paid by MBS</th><th></th></tr></thead><tbody>' + (stays.map(function (o) {
      return '<tr><td class="cell"><input data-i="' + o.i + '" data-k="property" value="' + esc(o.x.property) + '" style="min-width:160px"></td><td class="cell"><input data-i="' + o.i + '" data-k="city" value="' + esc(o.x.city) + '"></td><td class="cell"><input data-i="' + o.i + '" data-k="country" list="countries" value="' + esc(o.x.country) + '"></td><td class="cell"><input type="date" data-i="' + o.i + '" data-k="checkin" value="' + esc(o.x.checkin || '') + '"></td><td class="cell"><input type="date" data-i="' + o.i + '" data-k="checkout" value="' + esc(o.x.checkout || '') + '"></td><td class="cell"><select data-i="' + o.i + '" data-k="paid_by_mbs" style="min-width:70px"><option value="1" ' + (o.x.paid_by_mbs ? 'selected' : '') + '>Yes</option><option value="0" ' + (!o.x.paid_by_mbs ? 'selected' : '') + '>No</option></select></td><td><button type="button" class="btn quiet" data-del="' + o.i + '" title="Remove">✕</button></td></tr>';
    }).join('') || '<tr><td colspan="7" class="muted">No accommodation entered. Leave this empty if MBS is not paying for it and you would rather not record it.</td></tr>') + '</tbody>';
    [f, s].forEach(function (tbl) {
      tbl.querySelectorAll('[data-i]').forEach(function (el) { el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', function (e) { var k = e.target.dataset.k; draft.segments[+e.target.dataset.i][k] = k === 'paid_by_mbs' ? e.target.value === '1' : e.target.value; touch(); }); });
      tbl.querySelectorAll('[data-del]').forEach(function (b) { b.addEventListener('click', function () { draft.segments.splice(+b.dataset.del, 1); touch(); keepScroll(renderSegs); }); });
    });
  }
  function dayHtml(d, i) {
    var wk = isWeekend(d.day_date) || d.day_type === 'Public holiday';
    return '<div class="day ' + (wk ? 'weekend' : '') + '" data-i="' + i + '"><div class="when">' + fmt(d.day_date, { weekday: 'long' }) + '<small>' + fmt(d.day_date, { day: 'numeric', month: 'long' }) + '</small></div><div class="fields">' +
      '<label><span>City</span><input data-k="city" value="' + esc(d.city) + '" placeholder="e.g. Singapore"></label>' +
      '<label><span>Country</span><input data-k="country" list="countries" value="' + esc(d.country) + '"></label>' +
      '<label><span>Day type</span><select data-k="day_type">' + DAY_TYPES.map(function (t) { return '<option ' + (t === d.day_type ? 'selected' : '') + '>' + t + '</option>'; }).join('') + '</select></label>' +
      (d.day_type === 'Working' ?
        '<label class="wide"><span>What is happening in ' + esc(d.city || 'this location') + ' on this day?</span><textarea data-k="activities" placeholder="e.g. Teaching the morning session, client meetings in the afternoon">' + esc(d.activities) + '</textarea></label>' +
        '<div class="checks"><label><input type="checkbox" data-k="qualifies" ' + (d.qualifies ? 'checked' : '') + '>This work could not have been done from Melbourne</label><label><input type="checkbox" data-k="allowance" ' + (d.allowance ? 'checked' : '') + '>Claiming travel allowance</label></div>' +
        '<div class="testnote">' + (d.qualifies ? 'Counts towards the business activity 50% test.' : 'Does not count towards the business activity 50% test (self-directed work or online meetings). No leave is needed.') + '</div>'
        : '<div class="checks"><label><input type="checkbox" data-k="allowance" ' + (d.allowance ? 'checked' : '') + '>Claiming travel allowance</label></div>') +
      '</div></div>';
  }
  function bindDay(card) {
    var i = +card.dataset.i;
    card.querySelectorAll('[data-k]').forEach(function (inp) {
      var k = inp.dataset.k, isBox = inp.type === 'checkbox', isSel = inp.tagName === 'SELECT';
      // Typing in a text field only records the text; it never rebuilds the summary.
      if (!isBox && !isSel) inp.addEventListener('input', function () { draft.days[i][k] = inp.value; touch(); });
      if (k === 'city' || k === 'country') inp.addEventListener('focus', function () { inp._prev = inp.value; });
      inp.addEventListener('change', function () {
        draft.days[i][k] = isBox ? inp.checked : inp.value; touch();
        var rerenderedAll = false;
        if (k === 'city' || k === 'country') {
          var v = inp.value, changed = false;
          for (var j = i + 1; j < draft.days.length; j++) { var cur = draft.days[j][k]; if (!cur || cur === inp._prev) { if (cur !== v) { draft.days[j][k] = v; changed = true; } } else break; }
          if (changed) { rerenderedAll = true; keepScroll(function () { renderDays(); renderSummary(); }); }
        }
        if (k === 'day_type' || k === 'qualifies') { var fresh = document.createElement('div'); fresh.innerHTML = dayHtml(draft.days[i], i); var n = fresh.firstChild; card.replaceWith(n); bindDay(n); card = n; }
        // Destination, day type, allowance and qualifying work change the summary. City and activity text do not.
        if (!rerenderedAll && k !== 'city' && k !== 'activities') renderSummary();
      });
    });
  }
  function renderDays() {
    var el = q('days');
    if (!draft.days.length) { el.innerHTML = '<div class="empty">Enter the first and last day away and the days will appear here.</div>'; return; }
    el.innerHTML = draft.days.map(dayHtml).join('');
    el.querySelectorAll('.day').forEach(bindDay);
  }
  function l3Entry(country, create) {
    var e = (draft.level3 || []).find(function (x) { return String(x.country).toLowerCase() === country.toLowerCase(); });
    if (!e && create) { e = { country: country, date: '', ref: '' }; draft.level3.push(e); }
    return e;
  }
  function renderSummary() {
    var el = q('summary'); if (!el) return;
    if (!draft.days.length) { el.innerHTML = '<h3 style="margin-top:0">Summary</h3><p class="muted" style="margin:0">Enter the dates to see the running check.</p>'; return; }
    var a = assess(draft), countries = tripCountries(draft), lv = tripAdvice(draft), l3 = R.level3Countries(draft, state.advice), canReview = canManagePeople();
    el.innerHTML = '<h3 style="margin-top:0">Destinations and Smartraveller advice</h3><div class="advice">' +
      (countries.length ? countries.map(function (c) {
        var k = classify(c);
        return '<div class="adv-row"><b>' + esc(c) + '</b>' + countryTag(c) +
          (k.status === 'unresolved' ? '<span class="muted">Pick the country from the list so it matches Smartraveller.</span>' + (canReview ? '<label class="review"><span>Not on the list? Manual review note (who checked, and what they found)</span><input data-review="' + esc(c) + '" value="' + esc(draft.review[c] || '') + '"></label>' : '') : '') + '</div>';
      }).join('') : '<p class="muted" style="margin:0">Enter a country for each day and the advice level will appear here.</p>') +
      (lv === 4 ? '<div class="policy block">MBS policy does not permit travel to a destination where Smartraveller advises do not travel. This trip cannot be submitted. Talk to your line manager about alternatives.</div>' : '') +
      (l3.length ? '<div class="policy dean">Level 3, reconsider your need to travel. MBS policy requires the Dean’s special written permission for each Level 3 destination, in addition to your line manager’s approval. Enter the date of the permission and a reference to it (for example, “Email from the Dean, 12 Nov”) for each destination.' +
        l3.map(function (c) { var e = l3Entry(c, false) || {}; return '<div class="l3row"><b>' + esc(c) + '</b><label class="f"><span>Date of permission</span><input type="date" data-l3="' + esc(c) + '" data-f="date" value="' + esc(e.date || '') + '"></label><label class="f" style="flex:2 1 260px"><span>Reference</span><input data-l3="' + esc(c) + '" data-f="ref" value="' + esc(e.ref || '') + '" placeholder="Where the written permission can be found"></label>' + (e.entered_by_name ? '<small class="muted">Entered by ' + esc(e.entered_by_name) + '</small>' : '') + '</div>'; }).join('') + '</div>' : '') +
      '</div><h3>Business activity 50% test</h3><div class="summary">' +
      '<div><div class="n">' + draft.days.length + '</div><div class="l">days away</div></div><div><div class="n">' + a.weekdays + '</div><div class="l">weekdays, less Melbourne public holidays</div></div><div><div class="n">' + a.qualifying + '</div><div class="l">qualifying working days</div></div><div><div class="n">' + a.selfDirected + '</div><div class="l">remote working days</div></div><div><div class="n">' + a.leave + '</div><div class="l">leave days abroad</div></div><div><div class="n">' + a.allowance + '</div><div class="l">allowance days claimed</div></div></div>' +
      (a.noWeekdays ? '<div class="verdict">No eligible weekdays: every day away is a weekend or a public holiday, so the 50% test does not apply.</div>' :
        '<div class="verdict ' + (a.ok ? 'ok' : 'bad') + '">' + (a.ok ? 'Meets the business activity 50% test: ' + a.qualifying + ' of ' + a.weekdays + ' weekdays are necessary business travel.' : 'Below the business activity 50% test: ' + a.qualifying + ' of ' + a.weekdays + ' weekdays are necessary business travel. At least ' + Math.ceil(a.weekdays / 2) + ' are needed. You can still submit, and your line manager and Finance will see this flag.') + '</div>');
    el.querySelectorAll('[data-l3]').forEach(function (inp) { inp.addEventListener('input', function () { l3Entry(inp.dataset.l3, true)[inp.dataset.f] = inp.value; touch(); }); });
    el.querySelectorAll('[data-review]').forEach(function (inp) { inp.addEventListener('input', function () { draft.review[inp.dataset.review] = inp.value; touch(); }); });
    var sbtn = q('saveTrip'); if (sbtn) { sbtn.disabled = lv === 4; }
  }
  function saveDraft() {
    var missing = [], lv = tripAdvice(draft);
    if (!draft.purpose.trim()) missing.push('purpose');
    if (!(draft.cost_centre || '').trim()) missing.push('cost centre');
    R.coverageProblems(draft.start_date, draft.end_date, draft.days).forEach(function (p) { missing.push(p); });
    if (draft.days.some(function (d) { return !(d.country || '').trim(); })) missing.push('a country for every day');
    if (draft.days.some(function (d) { return d.day_type === 'Working' && d.qualifies && !(d.activities || '').trim(); })) missing.push('activities for each qualifying working day');
    R.unresolvedCountries(draft, state.advice).forEach(function (c) {
      if (!canManagePeople()) missing.push('a recognised country instead of “' + c + '” (pick it from the list)');
      else if (!(draft.review[c] || '').trim()) missing.push('a pick from the list or a manual review note for “' + c + '”');
    });
    var l3 = R.level3Countries(draft, state.advice);
    l3.forEach(function (c) { var e = l3Entry(c, false); if (!e || !e.date || !(e.ref || '').trim()) missing.push('the date and reference of the Dean’s permission for ' + c); });
    missing = missing.filter(function (m, i) { return missing.indexOf(m) === i; });
    if (missing.length) { toast('Still needed: ' + missing.join(', '), true); return; }
    if (lv === 4) { toast('This trip includes a do not travel destination and cannot be submitted', true); return; }
    var trav = person(draft.traveller_id);
    if (!trav.manager_email && !confirm('No approver is set for ' + trav.full_name + '. You can submit, but it cannot be approved until an arranger sets the line manager on the People page. Submit anyway?')) return;
    if (!draft.manager_declared && !confirm('You have not declared manager approval. Submit anyway? The trip will show as not declared.')) return;
    var btn = q('saveTrip'); btn.disabled = true;
    var payload = { id: draft.id, version: draft.version, traveller_id: draft.traveller_id, purpose: draft.purpose, cost_centre: draft.cost_centre, start_date: draft.start_date, end_date: draft.end_date, manager_declared: draft.manager_declared, manager_declared_date: draft.manager_declared_date || null,
      level3: l3.map(function (c) { var e = l3Entry(c, false); return { country: c, date: e.date, ref: e.ref.trim() }; }),
      days: draft.days.map(function (d) { var unresolved = classify(d.country).status === 'unresolved'; return { day_date: d.day_date, city: d.city, country: d.country, day_type: d.day_type, activities: d.activities, qualifies: !!d.qualifies, allowance: !!d.allowance, review_note: unresolved ? (draft.review[d.country] || null) : null }; }),
      segments: draft.segments.map(function (s) { return { kind: s.kind, carrier: s.carrier, flight_number: s.flight_number, origin: s.origin, destination: s.destination, seg_date: s.seg_date || null, property: s.property, city: s.city, country: s.country, checkin: s.checkin || null, checkout: s.checkout || null, paid_by_mbs: s.paid_by_mbs == null ? null : !!s.paid_by_mbs }; }) };
    sb.rpc('save_trip', { p: payload }).then(function (r) {
      btn.disabled = false;
      if (r.error) {
        if (/changed by someone else/.test(r.error.message) && confirm(r.error.message + '\n\nReload the latest version now? What you have typed on this screen will be replaced.')) { var id = draft.id; draft = null; openTrip(id); return; }
        toast(r.error.message, true); return;
      }
      var wasEdit = !!draft.id; clearLocalDraft(); draft = null; draftNotice = '';
      toast(wasEdit ? 'Changes saved' : 'Trip submitted. Your line manager can now approve it.');
      refreshHeader().then(function () { location.hash = '#trips'; });
    });
  }

  /* ---------- Read-only trip view (for a manager or anyone who may read a trip but not change it) ---------- */
  function canDecide(t) { return t.status === 'submitted' && !!state.me && t.traveller_id !== state.me.id && ((t.manager_email || '').toLowerCase() === myEmail() || isAdmin()); }
  function decideButtons(t, open) {
    return open ? '<div><textarea id="c-' + t.id + '" placeholder="Comment for the traveller (optional)"></textarea><div class="actions"><button type="button" class="btn primary" data-dec="approved" data-t="' + t.id + '" data-v="' + t.version + '">Approve</button><button type="button" class="btn danger" data-dec="declined" data-t="' + t.id + '" data-v="' + t.version + '">Decline</button></div></div>' : '';
  }
  function bindDecisions(root, after) {
    root.querySelectorAll('[data-dec]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.dataset.t, dec = b.dataset.dec, c = (q('c-' + id).value || '').trim();
        if (dec === 'declined' && !c && !confirm('Decline without a comment?')) return;
        b.disabled = true;
        sb.rpc('approve_trip', { p_trip: id, p_decision: dec, p_comment: c || null, p_version: +b.dataset.v }).then(function (r) {
          if (r.error) { b.disabled = false; toast(r.error.message, true); if (/changed after you opened|not waiting/.test(r.error.message)) after(true); return; }
          toast(dec === 'approved' ? 'Trip approved' : 'Trip declined'); after(false);
        });
      });
    });
  }
  function renderTripView(app, t) {
    var p = person(t.traveller_id), a = assess(t), e = person(t.entered_by), lv = tripAdvice(t), appr = personByEmail(t.manager_email);
    var flights = t.segments.filter(function (s) { return s.kind === 'flight'; }), stays = t.segments.filter(function (s) { return s.kind === 'stay'; });
    app.innerHTML = '<h1>' + esc(p.full_name) + ': ' + esc(t.purpose) + '</h1><p class="lead">You can read this trip but not change it.' + (canDecide(t) ? ' You can approve or decline it at the foot of the page.' : '') + '</p>' +
      '<div class="panel"><div class="t"><div>' + statusTag(t) + ' ' + advTag(lv) + ' ' + testTag(a) + flagTags(a) + reviewTags(t) +
      '<div class="sub">' + esc(tripCountries(t).join(', ')) + ' · ' + fmtShort(t.start_date) + ' to ' + fmtShort(t.end_date) + ' · ' + t.days.length + ' days · cost centre ' + esc(t.cost_centre || 'not set') + '</div>' +
      '<div class="sub">Approver: ' + (t.manager_email ? esc(appr ? appr.full_name : t.manager_email) : 'none set') + (e.id !== p.id ? ' · entered by ' + esc(e.full_name) : '') + ' · ' + (t.manager_declared ? 'traveller declares approval was given' + (t.manager_declared_date ? ' on ' + fmtShort(t.manager_declared_date) : '') : 'traveller has not declared prior approval') + '</div>' +
      (t.approval_comment ? '<div class="sub">Comment from approver: ' + esc(t.approval_comment) + '</div>' : '') + '</div></div>' +
      ((t.level3 || []).length ? '<h3>Dean permission (Level 3)</h3>' + t.level3.map(function (l) { return '<div class="sub">' + esc(l.country) + ': ' + esc(l.ref) + ', dated ' + (l.date ? fmtShort(l.date) : '') + (l.entered_by_name ? ', entered by ' + esc(l.entered_by_name) : '') + '</div>'; }).join('') : '') + '</div>' +
      '<div class="panel scroll"><h3 style="margin-top:0">Days</h3><table><thead><tr><th>Date</th><th>City</th><th>Country</th><th>Day type</th><th>Activities</th><th>Allowance</th></tr></thead><tbody>' + t.days.map(function (d) {
        return '<tr><td>' + fmt(d.day_date) + '</td><td>' + esc(d.city) + '</td><td>' + esc(d.country) + '</td><td>' + esc(d.day_type) + (d.day_type === 'Working' ? (d.qualifies ? ' <span class="tag ok">qualifies</span>' : ' <span class="tag warn">remote</span>') : '') + '</td><td>' + esc(d.activities || '') + '</td><td>' + (d.allowance ? 'Yes' : '') + '</td></tr>';
      }).join('') + '</tbody></table></div>' +
      ((flights.length || stays.length) ? '<div class="panel"><h3 style="margin-top:0">Flights and accommodation</h3>' + flights.map(function (s) { return '<div class="sub">' + esc([s.carrier, s.flight_number].join(' ').trim()) + ' ' + esc(s.origin || '') + ' to ' + esc(s.destination || '') + (s.seg_date ? ', ' + fmtShort(s.seg_date) : '') + '</div>'; }).join('') + stays.map(function (s) { return '<div class="sub">' + esc(s.property || 'Accommodation') + ', ' + esc([s.city, s.country].filter(Boolean).join(', ')) + (s.checkin ? ', ' + fmtShort(s.checkin) + ' to ' + (s.checkout ? fmtShort(s.checkout) : '') : '') + '</div>'; }).join('') + '</div>' : '') +
      decisionsHtml(draftDecisions) +
      (canDecide(t) ? '<div class="panel queue"><h3 style="margin-top:0">Your decision</h3>' + decideButtons(t, true) + '</div>' : '') +
      '<div class="actions"><a class="btn" href="#approvals">Back</a></div>';
    bindDecisions(app, function () { refreshHeader().then(function () { location.hash = '#approvals'; route(); }); });
  }

  /* ---------- Trips list ---------- */
  function tripCard(t) {
    var p = person(t.traveller_id), a = assess(t), e = person(t.entered_by), lv = tripAdvice(t);
    return '<div class="t"><div><b>' + esc(p.full_name) + '</b> ' + (p.kind === 'contractor' ? '<span class="tag">Contractor</span> ' : '') + statusTag(t) + ' ' + advTag(lv) + (a.ok ? '' : ' <span class="tag warn">Below 50%</span>') + flagTags(a) + (t.manager_declared ? '' : ' <span class="tag bad">Approval not declared</span>') + reviewTags(t) + '</div>' +
      '<div class="sub">' + esc(t.purpose) + '</div><div class="sub">' + esc(tripCountries(t).join(', ')) + ' · ' + fmtShort(t.start_date) + ' to ' + fmtShort(t.end_date) + ' · ' + t.days.length + ' days' + (e.id !== p.id ? ' · entered by ' + esc(e.full_name) : '') + '</div></div>' +
      '<div><a href="#log" class="btn" data-edit="' + t.id + '">Open</a></div></div>';
  }
  function renderTrips(app) {
    var tok = viewToken, me = state.me.id, lists = { mine: { rows: [], full: true }, others: { rows: [], full: true } };
    var shapes = {
      mine: function (qy) { return qy.or('traveller_id.eq.' + me + ',entered_by.eq.' + me).neq('status', 'draft').order('start_date', { ascending: false }); },
      others: function (qy) { return qy.neq('traveller_id', me).neq('entered_by', me).neq('status', 'draft').order('start_date', { ascending: false }); }
    };
    function page(kind) {
      return fetchTrips(shapes[kind], null, lists[kind].rows.length, PAGE).then(function (r) { lists[kind].rows = lists[kind].rows.concat(r.trips); lists[kind].full = r.full; });
    }
    function paint() {
      var box = function (kind, title, empty) {
        return '<div class="panel trips-list"><h3 style="margin-top:0">' + title + '</h3>' + (lists[kind].rows.map(tripCard).join('') || '<p class="muted">' + empty + '</p>') +
          (lists[kind].full ? '<div class="actions"><button type="button" class="btn" data-more="' + kind + '">Show more</button></div>' : '') + '</div>';
      };
      app.innerHTML = '<h1>Trips</h1><p class="lead">Trips you are travelling on or have entered for someone else come first. Newest travel dates first.</p>' +
        box('mine', 'Yours', 'None yet. <a href="#log">Log a trip</a>.') + (seesAll() ? box('others', 'Everyone else', 'None.') : '');
      bindOpenLinks(app);
      app.querySelectorAll('[data-more]').forEach(function (b) { b.addEventListener('click', function () { b.disabled = true; page(b.dataset.more).then(function () { if (tok === viewToken) keepScroll(paint); }).catch(function (e) { toast(e.message, true); }); }); });
    }
    app.innerHTML = '<div class="loading">Loading</div>';
    Promise.all([page('mine'), seesAll() ? page('others') : Promise.resolve()]).then(function () { if (tok === viewToken) paint(); }).catch(function (e) { if (tok === viewToken) failView(app, e); });
  }

  /* ---------- Approvals ---------- */
  function renderApprovals(app) {
    var tok = viewToken, admin = isAdmin();
    var mineOnly = function (qy) { return admin ? qy : qy.eq('manager_email', myEmail()); };
    Promise.all([
      fetchTrips(function (qy) { return mineOnly(qy.eq('status', 'submitted')).order('start_date'); }, null, 0, 100),
      fetchTrips(function (qy) { return mineOnly(qy.in('status', ['approved', 'declined'])).order('approved_at', { ascending: false }); }, null, 0, 30),
      canManagePeople() ? fetchTrips(function (qy) { return qy.eq('status', 'submitted').is('manager_email', null).order('start_date'); }, null, 0, 100) : Promise.resolve({ trips: [] })
    ]).then(function (r) {
      if (tok !== viewToken) return;
      var waiting = r[0].trips, done = r[1].trips, orphan = r[2].trips.filter(function (t) { return !waiting.some(function (w) { return w.id === t.id; }); });
      var item = function (t, open) {
        var p = person(t.traveller_id), a = assess(t), lv = tripAdvice(t), e = person(t.entered_by);
        return '<div class="t"><div><b>' + esc(p.full_name) + '</b> ' + (p.kind === 'contractor' ? '<span class="tag">Contractor</span> ' : '') + statusTag(t) + ' ' + advTag(lv) + (a.noWeekdays ? ' <span class="tag">No eligible weekdays</span>' : (a.ok ? ' <span class="tag ok">Meets 50% test</span>' : ' <span class="tag warn">Below 50%: ' + a.qualifying + ' of ' + a.weekdays + ' weekdays</span>')) + flagTags(a) + (lv >= 3 ? (R.level3Covered(t, state.advice) ? ' <span class="tag ok">Dean permission referenced</span>' : ' <span class="tag bad">Dean permission reference missing</span>') : '') + reviewTags(t) + '</div>' +
          '<div class="sub">' + esc(t.purpose) + '</div><div class="sub">' + esc(tripCountries(t).join(', ')) + ' · ' + fmtShort(t.start_date) + ' to ' + fmtShort(t.end_date) + ' · ' + a.allowance + ' allowance days · cost centre ' + esc(t.cost_centre || 'not set') + (e.id !== p.id ? ' · entered by ' + esc(e.full_name) : '') + '</div>' +
          '<div class="sub">' + (t.manager_declared ? 'Traveller declares approval was given' + (t.manager_declared_date ? ' on ' + fmtShort(t.manager_declared_date) : '') : 'Traveller has not declared prior approval') + (t.approved_at ? ' · ' + (t.status === 'approved' ? 'Approved' : 'Declined') + ' by ' + esc(t.approved_by) + ' on ' + new Date(t.approved_at).toLocaleDateString('en-AU') : '') + (t.approval_comment ? ' · "' + esc(t.approval_comment) + '"' : '') + '</div>' +
          '<div class="sub"><a href="#log" data-edit="' + t.id + '">Open the full trip</a></div></div>' + decideButtons(t, open) + '</div>';
      };
      app.innerHTML = '<h1>Approvals</h1><p class="lead">Trips for which you are the line manager on the traveller’s staff record. Approve or decline here; the traveller sees your comment on the trip.' + (admin ? ' As an admin you also see trips waiting on other managers.' : '') + '</p>' +
        (orphan.length ? '<div class="panel queue"><h3 style="margin-top:0">No approver set (' + orphan.length + ')</h3><p class="muted">These trips are waiting but nobody can approve them. Set the line manager for the traveller on the <a href="#people">People page</a>.</p>' + orphan.map(function (t) { return item(t, false); }).join('') + '</div>' : '') +
        '<div class="panel queue"><h3 style="margin-top:0">Waiting for you (' + waiting.length + ')</h3>' + (waiting.map(function (t) { return item(t, t.traveller_id !== state.me.id); }).join('') || '<p class="muted">Nothing waiting.</p>') + '</div>' +
        '<div class="panel queue"><h3 style="margin-top:0">Decided</h3>' + (done.map(function (t) { return item(t, false); }).join('') || '<p class="muted">None yet.</p>') + '</div>';
      bindOpenLinks(app);
      bindDecisions(app, function () { reload(); });
    }).catch(function (e) { if (tok === viewToken) failView(app, e); });
  }

  /* ---------- Audit log (admins only) ---------- */
  function renderAudit(app) {
    var tok = viewToken;
    app.innerHTML = '<h1>Audit log</h1><p class="lead">A record of trips edited or deleted by someone other than the traveller, and of approved trips whose Smartraveller rating changed after approval. It shows who, when and which trip, not what was changed. Visible to admins only. Newest first, up to 500 entries.</p><div class="panel scroll" id="auditBody"><div class="loading">Loading</div></div>';
    sb.from('trip_audit').select('*').order('at', { ascending: false }).limit(500).then(function (r) {
      var el = q('auditBody'); if (!el || tok !== viewToken) return;
      if (r.error) { el.innerHTML = '<div class="err">Could not load the audit log: ' + esc(r.error.message) + (/trip_audit/.test(r.error.message) ? ' The database update for the audit log may not have been run yet.' : '') + '</div>'; return; }
      var rows = r.data || [];
      if (!rows.length) { el.innerHTML = '<div class="empty">No entries yet.</div>'; return; }
      var ids = rows.map(function (a) { return a.trip_id; }).filter(function (x, i, arr) { return x && arr.indexOf(x) === i; });
      (ids.length ? sb.from('trips').select('id').in('id', ids) : Promise.resolve({ data: [] })).then(function (ex) {
        if (tok !== viewToken) return;
        var have = {}; (ex.data || []).forEach(function (t) { have[t.id] = true; });
        el.innerHTML = '<table class="audit"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Traveller</th><th>Trip</th><th>Why it was logged</th></tr></thead><tbody>' + rows.map(function (a) {
          var exists = !!have[a.trip_id];
          return '<tr><td class="nowrap">' + new Date(a.at).toLocaleString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) + '</td><td>' + esc(a.changed_by_name || 'Unknown') + '</td><td>' + esc(a.action) + '</td><td>' + esc(a.traveller_name || '') + '</td><td>' + (exists ? '<a href="#log" data-edit="' + a.trip_id + '">' + esc(a.trip_label || 'Open trip') + '</a>' : esc(a.trip_label || '') + ' <span class="muted">(deleted)</span>') + '</td><td>' + esc(a.reason) + '</td></tr>';
        }).join('') + '</tbody></table>';
        bindOpenLinks(el);
      });
    });
  }

  /* ---------- People ---------- */
  var newPerson = null;
  function renderPeople(app) {
    var admin = isAdmin(), roles = ['traveller', 'arranger', 'manager', 'admin'];
    // Arrangers may add and edit travellers only. Admins may do everything.
    var canEditRow = function (p, isNew) { return admin || (canManagePeople() && (isNew || p.role === 'traveller')); };
    var row = function (p, isNew) {
      var id = isNew ? 'new' : p.id, ok = canEditRow(p, isNew), dis = ok ? '' : ' disabled';
      return '<tr data-p="' + id + '"><td><input data-k="full_name" value="' + esc(p.full_name) + '" placeholder="Full name"' + dis + '></td><td><input data-k="email" type="email" value="' + esc(p.email || '') + '" placeholder="email (optional for contractors)"' + (p.user_id || !ok ? ' disabled title="Linked to a sign-in; cannot change"' : '') + '></td>' +
        '<td><select data-k="kind"' + dis + '><option value="staff" ' + (p.kind === 'staff' ? 'selected' : '') + '>Staff</option><option value="contractor" ' + (p.kind === 'contractor' ? 'selected' : '') + '>Contractor</option></select></td>' +
        '<td><select data-k="cost_centre"' + dis + '>' + ccOptions(p.cost_centre || '') + '</select></td><td><input data-k="manager_email" type="email" value="' + esc(p.manager_email || '') + '"' + dis + '></td><td><input data-k="mobile" value="' + esc(p.mobile || '') + '"' + dis + '></td>' +
        '<td><select data-k="role"' + (admin ? '' : ' disabled') + '>' + roles.map(function (r) { return '<option ' + (r === p.role ? 'selected' : '') + '>' + r + '</option>'; }).join('') + '</select></td>' +
        '<td><select data-k="active"' + dis + '><option value="1" ' + (p.active ? 'selected' : '') + '>Active</option><option value="0" ' + (!p.active ? 'selected' : '') + '>Inactive</option></select></td>' +
        '<td>' + (p.user_id ? '<span class="tag ok">Signed in</span>' : '<span class="tag">No sign-in yet</span>') + '</td><td>' + (ok ? '<button type="button" class="btn" data-save="' + id + '">' + (isNew ? 'Add' : 'Save') + '</button>' : '<span class="muted" title="Only an admin can change managers, arrangers and admins">Admin only</span>') + '</td></tr>';
    };
    newPerson = newPerson || { full_name: '', email: '', kind: 'contractor', cost_centre: '', manager_email: '', mobile: '', role: 'traveller', active: true };
    app.innerHTML = '<h1>People</h1><p class="lead">Staff appear here when they first sign in. Add contractors and anyone you enter travel for here. The line manager email on each person is who approves that person’s trips; when it changes, waiting trips move to the new manager and approved trips that have not started go back for approval. A person with an email outside ' + esc(cfg.ALLOWED_DOMAIN_HINT || 'the allowed domain') + ' can sign in only if their email is listed here first. ' + (admin ? 'Roles: traveller sees own trips; arranger enters trips for others and sees all; manager sees all and approves; admin does everything, including covering for an absent approver.' : 'Arrangers can add and edit travellers. Only an admin can change roles or edit managers, arrangers and admins.') + '</p>' +
      '<div class="panel scroll people-table"><table><thead><tr><th>Name</th><th>Email</th><th>Type</th><th>Cost centre</th><th>Line manager email</th><th>Mobile</th><th>Role</th><th>Status</th><th>Sign-in</th><th></th></tr></thead><tbody>' +
      row(newPerson, true) + state.people.map(function (p) { return row(p, false); }).join('') + '</tbody></table></div>';
    app.querySelectorAll('[data-save]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.dataset.save, tr = app.querySelector('tr[data-p="' + id + '"]'), rec = {};
        tr.querySelectorAll('[data-k]').forEach(function (el) { var k = el.dataset.k; if (el.disabled) return; rec[k] = k === 'active' ? el.value === '1' : (el.value.trim() || null); });
        if (!rec.full_name) { toast('A name is needed'); return; }
        if (rec.email) rec.email = rec.email.toLowerCase();
        if (rec.manager_email) rec.manager_email = rec.manager_email.toLowerCase();
        if (!admin) delete rec.role;
        if (id === 'new' && !admin) rec.role = 'traveller';
        b.disabled = true;
        var qry = id === 'new' ? sb.from('people').insert(rec) : sb.from('people').update(rec).eq('id', id);
        qry.then(function (r) {
          b.disabled = false;
          if (r.error) { toast(r.error.message, true); return; }
          if (id === 'new') newPerson = null;
          toast(id === 'new' ? 'Person added' : 'Saved'); reloadPeople ? reloadPeople().then(function () { refreshHeader(); route(); }) : reload();
        });
      });
    });
  }

  boot();
})();
