/* MBS Travel Diary pilot: front end. Plain JS, no build step. */
(function () {
  'use strict';

  /* ---------- Config and client ---------- */
  var cfg = window.MBS_CONFIG || {};
  if (!cfg.SUPABASE_URL || cfg.SUPABASE_URL.indexOf('YOUR_') >= 0) {
    document.getElementById('app').innerHTML = '<div class="panel err">config.js has not been filled in. See README step 3.</div>';
    return;
  }
  var sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

  var DAY_TYPES = ['Travel', 'Working', 'Not working', 'Weekend', 'Public holiday', 'Leave'];
  var ADVICE_LABEL = { 1: 'Exercise normal safety precautions', 2: 'Exercise a high degree of caution', 3: 'Reconsider your need to travel', 4: 'Do not travel', 0: 'No Smartraveller advice found' };
  var COST_CENTRES = ['Exec Ed - MBS Asia', 'Exec Ed - Custom ANZ', 'Exec Ed - Open', 'Award - Academic allowance', 'Award - Teaching', 'Award - Other', 'Marketing', 'External relations', 'Dean\u2019s Office', 'Other'];
  var ADVICE_SHORT = { 1: 'Normal', 2: 'Caution', 3: 'Reconsider', 4: 'Do not travel', 0: 'No advice found' };
  var state = { session: null, me: null, people: [], trips: [], advice: {}, adviceFetched: null, loaded: false };
  var TODAY = iso(new Date());

  /* ---------- Small helpers ---------- */
  function iso(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function parse(s) { var p = s.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
  function addDays(s, n) { var d = parse(s); d.setDate(d.getDate() + n); return iso(d); }
  function daysBetween(a, b) { return Math.round((parse(b) - parse(a)) / 86400000); }
  function isWeekend(s) { var w = parse(s).getDay(); return w === 0 || w === 6; }
  function fmt(s, o) { return parse(s).toLocaleDateString('en-AU', o || { weekday: 'short', day: 'numeric', month: 'short' }); }
  function fmtShort(s) { return parse(s).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }); }
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

  /* ---------- Rules ---------- */
  function adviceFor(country) { if (!country) return 0; var a = state.advice[country.trim().toLowerCase()]; return a ? a.level : 0; }
  function tripCountries(t) { var s = {}; (t.days || []).forEach(function (d) { if (d.country) s[d.country] = 1; }); return Object.keys(s); }
  function tripAdvice(t) { return tripCountries(t).reduce(function (m, c) { return Math.max(m, adviceFor(c)); }, 0); }
  function advTag(level) { return '<span class="tag adv' + level + '">' + (level ? 'Level ' + level + ': ' : '') + ADVICE_LABEL[level] + '</span>'; }
  function assess(t) {
    var days = t.days || [];
    var weekdays = days.filter(function (d) { return !isWeekend(d.day_date) && d.day_type !== 'Public holiday'; });
    var qualifying = weekdays.filter(function (d) { return d.day_type === 'Travel' || (d.day_type === 'Working' && d.qualifies); });
    var selfDirected = weekdays.filter(function (d) { return d.day_type === 'Working' && !d.qualifies; });
    var allowance = days.filter(function (d) { return d.allowance; }).length;
    var leave = days.filter(function (d) { return d.day_type === 'Leave'; }).length;
    var ok = weekdays.length === 0 ? true : qualifying.length * 2 >= weekdays.length;
    return { weekdays: weekdays.length, qualifying: qualifying.length, selfDirected: selfDirected.length, allowance: allowance, leave: leave, ok: ok };
  }
  function dayFor(t, date) { return (t.days || []).find(function (d) { return d.day_date === date; }); }
  function buildDays(start, end, keep) {
    var out = [];
    if (!start || !end || daysBetween(start, end) < 0 || daysBetween(start, end) > 120) return out;
    for (var i = 0; i <= daysBetween(start, end); i++) {
      var date = addDays(start, i);
      var prev = keep ? keep.find(function (d) { return d.day_date === date; }) : null;
      out.push(prev || { day_date: date, city: '', country: '', day_type: isWeekend(date) ? 'Weekend' : 'Working', activities: '', qualifies: false, allowance: false });
    }
    return out;
  }
  function flagTags(a) {
    return (a.selfDirected ? ' <span class="tag warn">' + a.selfDirected + ' remote working day' + (a.selfDirected === 1 ? '' : 's') + '</span>' : '') + (a.leave ? ' <span class="tag warn">' + a.leave + ' leave day' + (a.leave === 1 ? '' : 's') + ' abroad</span>' : '');
  }
  function statusTag(t) {
    var names = { submitted: 'Awaiting approval', approved: 'Approved', declined: 'Declined', draft: 'Draft' };
    return '<span class="status ' + t.status + '">' + names[t.status] + '</span>';
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
  function countryList() { return '<datalist id="countries">' + Object.keys(state.advice).map(function (k) { return '<option value="' + esc(state.advice[k].country) + '">'; }).join('') + '</datalist>'; }

  /* ---------- Data ---------- */
  function loadAll() {
    return Promise.all([
      sb.from('people').select('*').order('full_name'),
      sb.from('advice_levels').select('*'),
      sb.from('trips').select('*, trip_days(*), trip_segments(*)').neq('status', 'draft').order('start_date')
    ]).then(function (r) {
      var errs = r.filter(function (x) { return x.error; });
      if (errs.length) throw new Error(errs.map(function (x) { return x.error.message; }).join('; '));
      state.people = r[0].data || [];
      state.advice = {};
      (r[1].data || []).forEach(function (a) { state.advice[a.country.toLowerCase()] = a; if (!state.adviceFetched || a.fetched_at > state.adviceFetched) state.adviceFetched = a.fetched_at; });
      state.trips = (r[2].data || []).map(function (t) {
        t.days = (t.trip_days || []).sort(function (a, b) { return a.day_date < b.day_date ? -1 : 1; });
        t.segments = (t.trip_segments || []).sort(function (a, b) { return a.sort_order - b.sort_order; });
        delete t.trip_days; delete t.trip_segments; return t;
      });
      state.me = state.people.find(function (p) { return p.user_id === state.session.user.id; }) || null;
      state.loaded = true;
    });
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

  function boot() {
    sb.auth.getSession().then(function (r) { handleSession(r.data.session); });
    sb.auth.onAuthStateChange(function (_ev, session) { if ((session && session.user.id) !== (state.session && state.session.user.id)) handleSession(session); });
  }
  function handleSession(session) {
    state.session = session; state.loaded = false;
    if (!session) { renderSignIn(); return; }
    q('app').innerHTML = '<div class="loading">Loading</div>';
    loadAll().then(function () {
      if (!state.me) { renderSignIn('Your account exists but has no person record. Ask an admin to add your email to People, then sign in again.'); return; }
      renderHeader(); route();
    }).catch(function (e) { q('app').innerHTML = '<div class="panel err">Could not load data: ' + esc(e.message) + '</div>'; });
  }
  function reload() { return loadAll().then(function () { renderHeader(); keepScroll(route); }); }

  /* ---------- Header and routing ---------- */
  function pendingForMe() {
    return state.trips.filter(function (t) { return t.status === 'submitted' && ((t.manager_email || '').toLowerCase() === myEmail() || isAdmin()); });
  }
  function renderHeader() {
    var views = [['dashboard', 'Dashboard'], ['log', 'Log a trip'], ['trips', 'Trips']];
    var pend = pendingForMe().length;
    if (pend || state.me.role === 'manager' || isAdmin() || state.trips.some(function (t) { return (t.manager_email || '').toLowerCase() === myEmail(); })) views.push(['approvals', 'Approvals' + (pend ? '<span class="badge-count">' + pend + '</span>' : '')]);
    if (canManagePeople()) views.push(['people', 'People']);
    if (isAdmin()) views.push(['audit', 'Audit log']);
    q('nav').innerHTML = views.map(function (v) { return '<a href="#' + v[0] + '" data-view="' + v[0] + '">' + v[1] + '</a>'; }).join('');
    q('who').innerHTML = '<span>' + esc(state.me.full_name) + '</span><button type="button" id="signout">Sign out</button>';
    q('signout').addEventListener('click', function () { sb.auth.signOut().then(function () { state.session = null; renderSignIn(); }); });
  }
  var editingId = null, draft = null;
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
    var app = q('app');
    if (v === 'dashboard') renderDashboard(app);
    else if (v === 'log') renderLog(app);
    else if (v === 'trips') renderTrips(app);
    else if (v === 'approvals') renderApprovals(app);
    else if (v === 'audit') renderAudit(app);
    else renderPeople(app);
  }
  window.addEventListener('hashchange', function () { route(); window.scrollTo(0, 0); });
  function openTrip(id) { editingId = id; location.hash = '#log'; }
  function bindOpenLinks(root) { root.querySelectorAll('[data-edit]').forEach(function (a) { a.addEventListener('click', function (e) { e.preventDefault(); openTrip(a.dataset.edit); }); }); }

  /* ---------- Dashboard ---------- */
  var dashDate = TODAY, dashCountry = '', dashCC = '';
  function liveTrips() { return state.trips.filter(function (t) { return t.status !== 'declined' && (!dashCC || t.cost_centre === dashCC); }); }
  function renderDashboard(app) {
    var countries = {}, ccs = {};
    state.trips.forEach(function (t) { tripCountries(t).forEach(function (c) { countries[c] = 1; }); if (t.cost_centre) ccs[t.cost_centre] = 1; });
    var snap = state.adviceFetched ? new Date(state.adviceFetched).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) : 'not yet loaded';
    app.innerHTML = '<h1>Where everyone is</h1>' +
      '<p class="lead">Pick a date to see who is away, in which city and whether it is a working day for them. Colours are Smartraveller advice levels (last refreshed ' + snap + '). The timeline shows the next eight weeks. Declined trips are not shown.</p>' +
      '<div class="toolbar">' +
      '<label><span>On this date</span><input type="date" id="dashDate" value="' + dashDate + '"></label>' +
      '<button type="button" class="btn" id="dashToday">Today</button>' +
      '<label><span>Country</span><select id="dashCountry"><option value="">All countries</option>' + Object.keys(countries).sort().map(function (c) { return '<option ' + (c === dashCountry ? 'selected' : '') + '>' + esc(c) + '</option>'; }).join('') + '</select></label>' +
      '<label><span>Cost centre</span><select id="dashCC"><option value="">All cost centres</option>' + ccOrder(ccs).map(function (c) { return '<option ' + (c === dashCC ? 'selected' : '') + '>' + esc(c) + '</option>'; }).join('') + '</select></label>' +
      '</div><div id="where"></div>' +
      (seesAll() ? '<h2>By cost centre</h2><div class="panel scroll" id="byCC"></div>' : '') +
      '<h2>Next eight weeks</h2><div id="timeline"></div>' +
      '<div class="legend"><span><i style="background:var(--adv1)"></i>Level 1 normal precautions</span><span><i style="background:var(--adv2)"></i>Level 2 high degree of caution</span><span><i style="background:var(--adv3)"></i>Level 3 reconsider need to travel</span><span><i style="background:var(--adv4)"></i>Level 4 do not travel</span><span><i style="background:var(--adv0)"></i>No advice found</span><span><i style="background:var(--red);width:3px"></i>Today</span></div>' +
      '<h2>Checks</h2><div class="panel scroll" id="checks"></div>';
    var all = function () { renderWhere(); if (seesAll()) renderByCC(); renderTimeline(); renderChecks(); };
    q('dashDate').addEventListener('change', function (e) { dashDate = e.target.value || TODAY; keepScroll(all); });
    q('dashToday').addEventListener('click', function () { dashDate = TODAY; q('dashDate').value = TODAY; keepScroll(all); });
    q('dashCountry').addEventListener('change', function (e) { dashCountry = e.target.value; keepScroll(all); });
    q('dashCC').addEventListener('change', function (e) { dashCC = e.target.value; keepScroll(all); });
    all();
  }
  function renderWhere() {
    var el = q('where'), rows = [];
    liveTrips().forEach(function (t) { var d = dayFor(t, dashDate); if (d && (!dashCountry || d.country === dashCountry)) rows.push({ t: t, d: d }); });
    if (!rows.length) { el.innerHTML = '<div class="empty">Nobody is away on ' + fmt(dashDate, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) + (dashCountry ? ' in ' + esc(dashCountry) : '') + '.</div>'; return; }
    var by = {};
    rows.forEach(function (r) { var k = r.d.country || 'Location not entered'; (by[k] = by[k] || []).push(r); });
    el.innerHTML = '<p class="muted" style="margin:0 0 10px">' + rows.length + (rows.length === 1 ? ' person' : ' people') + ' away on ' + fmt(dashDate, { weekday: 'long', day: 'numeric', month: 'long' }) + '.</p><div class="where">' +
      Object.keys(by).sort().map(function (c) {
        var lv = adviceFor(c);
        return '<div class="country adv' + lv + '"><h3>' + esc(c) + '<span class="tag info">' + by[c].length + '</span></h3><div class="advline">' + (lv ? 'Level ' + lv + ': ' : '') + ADVICE_LABEL[lv] + '</div>' +
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
    state.trips.forEach(function (t) { if (t.cost_centre) ccs[t.cost_centre] = 1; });
    el.innerHTML = '<table><thead><tr><th>Cost centre</th><th>Away on ' + fmtShort(dashDate) + '</th><th>Trips in next 8 weeks</th><th>Travellers</th><th>Allowance days</th><th>Below 50%</th><th>Remote working</th><th>Leave days abroad</th><th>Level 3 or 4</th><th>Awaiting approval</th><th>Dean permission missing</th></tr></thead><tbody>' +
      ccOrder(ccs).map(function (cc) {
        var all = state.trips.filter(function (t) { return t.cost_centre === cc && t.status !== 'declined'; });
        var soon = all.filter(function (t) { return t.end_date >= TODAY && t.start_date <= horizon; });
        var away = all.filter(function (t) { return dayFor(t, dashDate); }).length;
        var people = {}; soon.forEach(function (t) { people[t.traveller_id] = 1; });
        var allowance = soon.reduce(function (n, t) { return n + assess(t).allowance; }, 0);
        var below = soon.filter(function (t) { return !assess(t).ok; }).length;
        var selfd = soon.reduce(function (n, t) { return n + assess(t).selfDirected; }, 0);
        var leave = soon.reduce(function (n, t) { return n + assess(t).leave; }, 0);
        var high = soon.filter(function (t) { return tripAdvice(t) >= 3; }).length;
        var waiting = soon.filter(function (t) { return t.status === 'submitted'; }).length;
        var dean = soon.filter(function (t) { return tripAdvice(t) >= 3 && !t.dean_permission; }).length;
        return '<tr style="' + (cc === dashCC ? 'background:var(--blue-soft)' : '') + '"><td><a href="#dashboard" data-cc="' + esc(cc) + '">' + esc(cc) + '</a></td><td>' + away + '</td><td>' + soon.length + '</td><td>' + Object.keys(people).length + '</td><td>' + allowance + '</td>' +
          '<td>' + (below ? '<span class="tag warn">' + below + '</span>' : '0') + '</td><td>' + (selfd ? '<span class="tag warn">' + selfd + '</span>' : '0') + '</td><td>' + (leave ? '<span class="tag warn">' + leave + '</span>' : '0') + '</td><td>' + (high ? '<span class="tag adv3">' + high + '</span>' : '0') + '</td><td>' + (waiting ? '<span class="tag warn">' + waiting + '</span>' : '0') + '</td><td>' + (dean ? '<span class="tag bad">' + dean + '</span>' : '0') + '</td></tr>';
      }).join('') + '</tbody></table><p class="muted" style="margin:10px 0 0;font-size:13.5px">Select a cost centre to filter the rest of the dashboard to it. Counts cover trips that overlap the next eight weeks.</p>';
    el.querySelectorAll('[data-cc]').forEach(function (a) { a.addEventListener('click', function (e) { e.preventDefault(); dashCC = dashCC === a.dataset.cc ? '' : a.dataset.cc; q('dashCC').value = dashCC; keepScroll(function () { renderWhere(); renderByCC(); renderTimeline(); renderChecks(); }); }); });
  }
  function renderTimeline() {
    var el = q('timeline'), start = addDays(TODAY, -((parse(TODAY).getDay() + 6) % 7)), total = 56, weeks = [];
    for (var i = 0; i < 8; i++) weeks.push(addDays(start, i * 7));
    var trips = liveTrips().filter(function (t) { return !dashCountry || tripCountries(t).indexOf(dashCountry) >= 0; });
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
    var el = q('checks'), trips = liveTrips().filter(function (t) { return !dashCountry || tripCountries(t).indexOf(dashCountry) >= 0; });
    el.innerHTML = '<table><thead><tr><th>Traveller</th><th class="c-dates">Dates</th><th>Countries</th><th class="c-adv">Smartraveller</th><th>Weekdays away</th><th>Qualifying days</th><th>Business activity 50% test</th><th>Remote working</th><th>Leave days abroad</th><th>Allowance days</th><th>Approvals</th><th>Entered by</th></tr></thead><tbody>' +
      trips.map(function (t) {
        var p = person(t.traveller_id), a = assess(t), e = person(t.entered_by), lv = tripAdvice(t);
        return '<tr><td><a href="#log" data-edit="' + t.id + '">' + esc(p.full_name) + '</a>' + (p.kind === 'contractor' ? ' <span class="tag">Contractor</span>' : '') + '</td><td class="c-dates">' + fmtShort(t.start_date) + ' to ' + fmtShort(t.end_date) + '</td><td>' + esc(tripCountries(t).join(', ')) + '</td><td class="c-adv">' + advShort(lv) + '</td><td>' + a.weekdays + '</td><td>' + a.qualifying + '</td>' +
          '<td>' + (a.ok ? '<span class="tag ok">Meets</span>' : '<span class="tag warn">Below 50%</span>') + '</td><td>' + (a.selfDirected ? '<span class="tag warn">' + a.selfDirected + '</span>' : '0') + '</td><td>' + (a.leave ? '<span class="tag warn">' + a.leave + '</span>' : '0') + '</td><td>' + a.allowance + '</td>' +
          '<td>' + statusTag(t) + (t.manager_declared ? '' : ' <span class="tag bad">Not declared</span>') + (lv >= 3 ? (t.dean_permission ? ' <span class="tag ok">Dean</span>' : ' <span class="tag bad">Dean permission missing</span>') : '') + '</td>' +
          '<td>' + (e.id === p.id ? 'Self' : esc(e.full_name)) + '</td></tr>';
      }).join('') + '</tbody></table>';
    bindOpenLinks(el);
  }

  /* ---------- Log a trip ---------- */
  function blankTrip() {
    var me = state.me;
    return { id: null, traveller_id: me.id, entered_by: me.id, purpose: '', cost_centre: me.cost_centre || '', start_date: '', end_date: '', manager_email: me.manager_email || '', manager_declared: false, manager_declared_date: '', dean_permission: false, dean_permission_date: '', status: 'submitted', days: [], segments: [] };
  }
  function renderLog(app) {
    if (editingId) { var t = state.trips.find(function (x) { return x.id === editingId; }); draft = t ? JSON.parse(JSON.stringify(t)) : blankTrip(); editingId = null; }
    else if (!draft) draft = blankTrip();
    var isEdit = !!draft.id, onBehalf = draft.traveller_id !== state.me.id;
    var canPick = canManagePeople() || isAdmin();
    var travellers = state.people.filter(function (p) { return p.active; });
    app.innerHTML = countryList() + '<h1>' + (isEdit ? 'Edit trip' : 'Log a trip') + '</h1>' +
      '<p class="lead">Record where you are going, where you are staying and what each day is for. You can come back and change it until the trip ends.' + (isEdit ? ' This trip is ' + statusTag(draft) + '.' : '') + '</p>' +
      (isEdit && draft.approval_comment ? '<p class="note">Comment from approver: ' + esc(draft.approval_comment) + '</p>' : '') +
      '<div class="panel"><h3 style="margin-top:0">Who is travelling</h3><div class="row">' +
      '<label class="f"><span>Traveller</span><select id="travellerId"' + (canPick ? '' : ' disabled') + '>' + travellers.map(function (p) { return '<option value="' + p.id + '" ' + (p.id === draft.traveller_id ? 'selected' : '') + '>' + esc(p.full_name) + ' (' + (p.kind === 'contractor' ? 'contractor' : esc(p.cost_centre || 'staff')) + ')</option>'; }).join('') + '</select></label>' +
      '<label class="f"><span>Entered by</span><input value="' + esc(person(draft.entered_by).full_name) + '" disabled></label></div>' +
      (onBehalf ? '<p class="note">You are entering this on behalf of ' + esc(person(draft.traveller_id).full_name) + '. They can see and edit it when they sign in.</p>' : '') +
      '<div class="row"><label class="f" style="flex:2 1 320px"><span>Purpose of travel</span><input id="purpose" value="' + esc(draft.purpose) + '" placeholder="e.g. Deliver in-company program, Singapore"></label>' +
      '<label class="f"><span>Cost centre</span><select id="cc">' + ccOptions(draft.cost_centre) + '</select></label></div>' +
      '<div class="row"><label class="f"><span>First day away</span><input type="date" id="start" value="' + esc(draft.start_date) + '"></label>' +
      '<label class="f"><span>Last day away</span><input type="date" id="end" value="' + esc(draft.end_date) + '"></label>' +
      '<label class="f"><span>Line manager email</span><input type="email" id="manager" list="mgrs" value="' + esc(draft.manager_email) + '" placeholder="manager@' + esc(cfg.ALLOWED_DOMAIN_HINT || '') + '"><datalist id="mgrs">' + state.people.filter(function (p) { return p.email; }).map(function (p) { return '<option value="' + esc(p.email) + '">' + esc(p.full_name) + '</option>'; }).join('') + '</datalist></label></div>' +
      '<label class="check"><input type="checkbox" id="approved" ' + (draft.manager_declared ? 'checked' : '') + '><span>I confirm that approval for this travel was sought from and given by the line manager named above' + (onBehalf ? ' (or the traveller has confirmed this to me)' : '') + '. The manager will also be asked to approve it in this app.</span></label>' +
      '<div class="row" id="approvedRow" style="' + (draft.manager_declared ? '' : 'display:none') + '"><label class="f" style="flex:0 1 220px"><span>Date approval was given</span><input type="date" id="approvedDate" value="' + esc(draft.manager_declared_date || '') + '"></label></div></div>' +
      '<div class="panel seg"><h3 style="margin-top:0">Flights</h3><div class="scroll"><table id="flights"></table></div><button type="button" class="btn quiet" id="addFlight">Add a flight</button>' +
      '<h3>Accommodation</h3><div class="scroll"><table id="stays"></table></div><button type="button" class="btn quiet" id="addStay">Add accommodation</button></div>' +
      '<div class="panel"><h3 style="margin-top:0">Day by day</h3><p class="muted" style="margin:0 0 12px;max-width:72ch">For each working day, say what is happening in that location. A working day counts towards the business activity 50% test only if the work could not equally have been done from Melbourne. Online meetings and self-directed work do not count, though you do not need to take leave for them. Travel days count as necessary business travel. Mark a Melbourne public holiday as such and it is left out of the test, like a weekend.</p><div class="days" id="days"></div></div>' +
      '<div class="panel" id="summary"></div>' +
      '<div class="actions"><button type="button" class="btn primary" id="saveTrip">' + (isEdit ? 'Save changes' : 'Submit trip') + '</button><button type="button" class="btn" id="discard">' + (isEdit ? 'Cancel' : 'Clear form') + '</button>' + (isEdit ? '<button type="button" class="btn danger quiet" id="deleteTrip">Delete trip</button>' : '') + '</div>';

    q('travellerId').addEventListener('change', function (e) { draft.traveller_id = e.target.value; var p = person(draft.traveller_id); draft.manager_email = p.manager_email || draft.manager_email; draft.cost_centre = p.cost_centre || draft.cost_centre; keepScroll(function () { renderLog(app); }); });
    q('purpose').addEventListener('input', function (e) { draft.purpose = e.target.value; });
    q('cc').addEventListener('change', function (e) { draft.cost_centre = e.target.value; });
    q('manager').addEventListener('input', function (e) { draft.manager_email = e.target.value.trim().toLowerCase(); });
    q('approvedDate').addEventListener('input', function (e) { draft.manager_declared_date = e.target.value; });
    q('approved').addEventListener('change', function (e) { draft.manager_declared = e.target.checked; q('approvedRow').style.display = draft.manager_declared ? '' : 'none'; if (draft.manager_declared && !draft.manager_declared_date) { draft.manager_declared_date = TODAY; q('approvedDate').value = TODAY; } });
    q('start').addEventListener('change', function (e) { draft.start_date = e.target.value; if (draft.start_date && (!draft.end_date || draft.end_date < draft.start_date)) { draft.end_date = draft.start_date; q('end').value = draft.end_date; } regenDays(); });
    q('end').addEventListener('change', function (e) { draft.end_date = e.target.value; regenDays(); });
    q('addFlight').addEventListener('click', function () { draft.segments.push({ kind: 'flight', carrier: '', flight_number: '', origin: 'MEL', destination: '', seg_date: draft.start_date || '' }); keepScroll(renderSegs); });
    q('addStay').addEventListener('click', function () { draft.segments.push({ kind: 'stay', property: '', city: '', country: '', checkin: draft.start_date || '', checkout: draft.end_date || '', paid_by_mbs: true }); keepScroll(renderSegs); });
    q('saveTrip').addEventListener('click', saveDraft);
    q('discard').addEventListener('click', function () { draft = null; if (isEdit) location.hash = '#trips'; else renderLog(app); });
    if (isEdit) q('deleteTrip').addEventListener('click', function () {
      if (!confirm('Delete this trip?')) return;
      sb.from('trips').delete().eq('id', draft.id).then(function (r) { if (r.error) { toast(r.error.message, true); return; } draft = null; toast('Trip deleted'); location.hash = '#trips'; reload(); });
    });
    renderSegs(); renderDays(); renderSummary();
  }
  function regenDays() {
    if (!draft.start_date || !draft.end_date) return;
    draft.days = buildDays(draft.start_date, draft.end_date, draft.days);
    draft.days.forEach(function (d, i) { if (!d.country && i > 0) { d.country = draft.days[i - 1].country; d.city = d.city || draft.days[i - 1].city; } });
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
      tbl.querySelectorAll('[data-i]').forEach(function (el) { el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', function (e) { var k = e.target.dataset.k; draft.segments[+e.target.dataset.i][k] = k === 'paid_by_mbs' ? e.target.value === '1' : e.target.value; }); });
      tbl.querySelectorAll('[data-del]').forEach(function (b) { b.addEventListener('click', function () { draft.segments.splice(+b.dataset.del, 1); keepScroll(renderSegs); }); });
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
      var k = inp.dataset.k, ev = (inp.type === 'checkbox' || inp.tagName === 'SELECT') ? 'change' : 'input';
      inp.addEventListener(ev, function () {
        draft.days[i][k] = inp.type === 'checkbox' ? inp.checked : inp.value;
        if (k === 'day_type' || k === 'qualifies') { var fresh = document.createElement('div'); fresh.innerHTML = dayHtml(draft.days[i], i); var n = fresh.firstChild; card.replaceWith(n); bindDay(n); card = n; }
        renderSummary();
      });
      if (k === 'city' || k === 'country') {
        inp.addEventListener('focus', function () { inp._prev = inp.value; });
        inp.addEventListener('change', function () {
          var v = inp.value, changed = false;
          for (var j = i + 1; j < draft.days.length; j++) { var cur = draft.days[j][k]; if (!cur || cur === inp._prev) { if (cur !== v) { draft.days[j][k] = v; changed = true; } } else break; }
          if (changed) keepScroll(function () { renderDays(); renderSummary(); });
        });
      }
    });
  }
  function renderDays() {
    var el = q('days');
    if (!draft.days.length) { el.innerHTML = '<div class="empty">Enter the first and last day away and the days will appear here.</div>'; return; }
    el.innerHTML = draft.days.map(dayHtml).join('');
    el.querySelectorAll('.day').forEach(bindDay);
  }
  function renderSummary() {
    var el = q('summary'); if (!el) return;
    if (!draft.days.length) { el.innerHTML = '<h3 style="margin-top:0">Summary</h3><p class="muted" style="margin:0">Enter the dates to see the running check.</p>'; return; }
    var a = assess(draft), countries = tripCountries(draft), lv = tripAdvice(draft);
    el.innerHTML = '<h3 style="margin-top:0">Smartraveller advice</h3><div class="advice">' +
      (countries.length ? countries.map(function (c) { return '<div class="adv-row"><b>' + esc(c) + '</b>' + advTag(adviceFor(c)) + (adviceFor(c) ? '' : '<span class="muted">Pick the country from the list so it matches Smartraveller</span>') + '</div>'; }).join('') : '<p class="muted" style="margin:0">Enter a country for each day and the advice level will appear here.</p>') +
      (lv === 4 ? '<div class="policy block">MBS policy does not permit travel to a destination where Smartraveller advises do not travel. This trip cannot be submitted. Talk to your line manager about alternatives.</div>' : '') +
      (lv === 3 ? '<div class="policy dean">At least one destination is at level 3, reconsider your need to travel. MBS policy requires the Dean’s special permission for this trip, in addition to your line manager’s approval.<label class="check"><input type="checkbox" id="deanPermission" ' + (draft.dean_permission ? 'checked' : '') + '><span>The Dean has given special permission for this travel.</span></label><div class="row" id="deanRow" style="' + (draft.dean_permission ? '' : 'display:none') + '"><label class="f" style="flex:0 1 220px;margin:8px 0 0"><span>Date permission was given</span><input type="date" id="deanPermissionDate" value="' + esc(draft.dean_permission_date || '') + '"></label></div></div>' : '') +
      '</div><h3>Business activity 50% test</h3><div class="summary">' +
      '<div><div class="n">' + draft.days.length + '</div><div class="l">days away</div></div><div><div class="n">' + a.weekdays + '</div><div class="l">weekdays, less Melbourne public holidays</div></div><div><div class="n">' + a.qualifying + '</div><div class="l">qualifying working days</div></div><div><div class="n">' + a.selfDirected + '</div><div class="l">remote working days</div></div><div><div class="n">' + a.leave + '</div><div class="l">leave days abroad</div></div><div><div class="n">' + a.allowance + '</div><div class="l">allowance days claimed</div></div></div>' +
      '<div class="verdict ' + (a.ok ? 'ok' : 'bad') + '">' + (a.ok ? 'Meets the business activity 50% test: ' + a.qualifying + ' of ' + a.weekdays + ' weekdays are necessary business travel.' : 'Below the business activity 50% test: ' + a.qualifying + ' of ' + a.weekdays + ' weekdays are necessary business travel. At least ' + Math.ceil(a.weekdays / 2) + ' are needed. You can still submit, and your line manager and Finance will see this flag.') + '</div>';
    var dp = q('deanPermission');
    if (dp) {
      dp.addEventListener('change', function (e) { draft.dean_permission = e.target.checked; if (draft.dean_permission && !draft.dean_permission_date) draft.dean_permission_date = TODAY; q('deanRow').style.display = draft.dean_permission ? '' : 'none'; q('deanPermissionDate').value = draft.dean_permission_date || ''; });
      q('deanPermissionDate').addEventListener('input', function (e) { draft.dean_permission_date = e.target.value; });
    }
    var sbtn = q('saveTrip'); if (sbtn) { sbtn.disabled = lv === 4; }
  }
  function saveDraft() {
    var missing = [];
    if (!draft.purpose.trim()) missing.push('purpose');
    if (!(draft.cost_centre || '').trim()) missing.push('cost centre');
    if (!draft.start_date || !draft.end_date) missing.push('dates');
    if (!draft.manager_email.trim()) missing.push('line manager email');
    if (draft.days.some(function (d) { return !(d.country || '').trim(); })) missing.push('a country for every day');
    if (draft.days.some(function (d) { return d.day_type === 'Working' && d.qualifies && !(d.activities || '').trim(); })) missing.push('activities for each qualifying working day');
    if (missing.length) { toast('Still needed: ' + missing.join(', '), true); return; }
    var lv = tripAdvice(draft);
    if (lv === 4) { toast('This trip includes a do not travel destination and cannot be submitted', true); return; }
    if (lv === 3 && !draft.dean_permission) { toast('A level 3 destination needs the Dean’s special permission before you submit', true); return; }
    if (lv < 3) { draft.dean_permission = false; draft.dean_permission_date = ''; }
    if (!draft.manager_declared && !confirm('You have not declared manager approval. Submit anyway? The trip will show as not declared.')) return;
    var btn = q('saveTrip'); btn.disabled = true;
    var payload = { id: draft.id, traveller_id: draft.traveller_id, purpose: draft.purpose, cost_centre: draft.cost_centre, start_date: draft.start_date, end_date: draft.end_date, manager_email: draft.manager_email, manager_declared: draft.manager_declared, manager_declared_date: draft.manager_declared_date || null, dean_permission: draft.dean_permission, dean_permission_date: draft.dean_permission_date || null,
      days: draft.days.map(function (d) { return { day_date: d.day_date, city: d.city, country: d.country, day_type: d.day_type, activities: d.activities, qualifies: !!d.qualifies, allowance: !!d.allowance }; }),
      segments: draft.segments.map(function (s) { return { kind: s.kind, carrier: s.carrier, flight_number: s.flight_number, origin: s.origin, destination: s.destination, seg_date: s.seg_date || null, property: s.property, city: s.city, country: s.country, checkin: s.checkin || null, checkout: s.checkout || null, paid_by_mbs: s.paid_by_mbs == null ? null : !!s.paid_by_mbs }; }) };
    sb.rpc('save_trip', { p: payload }).then(function (r) {
      btn.disabled = false;
      if (r.error) { toast(r.error.message, true); return; }
      var wasEdit = !!draft.id; draft = null;
      toast(wasEdit ? 'Changes saved' : 'Trip submitted. Your line manager can now approve it.');
      reload().then(function () { location.hash = '#trips'; });
    });
  }

  /* ---------- Trips list ---------- */
  function tripCard(t) {
    var p = person(t.traveller_id), a = assess(t), e = person(t.entered_by), lv = tripAdvice(t);
    return '<div class="t"><div><b>' + esc(p.full_name) + '</b> ' + (p.kind === 'contractor' ? '<span class="tag">Contractor</span> ' : '') + statusTag(t) + ' ' + advTag(lv) + (a.ok ? '' : ' <span class="tag warn">Below 50%</span>') + flagTags(a) + (t.manager_declared ? '' : ' <span class="tag bad">Approval not declared</span>') + (lv >= 3 && !t.dean_permission ? ' <span class="tag bad">Dean permission missing</span>' : '') +
      '<div class="sub">' + esc(t.purpose) + '</div><div class="sub">' + esc(tripCountries(t).join(', ')) + ' · ' + fmtShort(t.start_date) + ' to ' + fmtShort(t.end_date) + ' · ' + t.days.length + ' days' + (e.id !== p.id ? ' · entered by ' + esc(e.full_name) : '') + '</div></div>' +
      '<div><a href="#log" class="btn" data-edit="' + t.id + '">Open</a></div></div>';
  }
  function renderTrips(app) {
    var me = state.me.id;
    var mine = state.trips.filter(function (t) { return t.traveller_id === me || t.entered_by === me; });
    var others = state.trips.filter(function (t) { return !(t.traveller_id === me || t.entered_by === me); });
    app.innerHTML = '<h1>Trips</h1><p class="lead">Trips you are travelling on or have entered for someone else come first.</p>' +
      '<div class="panel trips-list"><h3 style="margin-top:0">Yours</h3>' + (mine.map(tripCard).join('') || '<p class="muted">None yet. <a href="#log">Log a trip</a>.</p>') + '</div>' +
      (seesAll() ? '<div class="panel trips-list"><h3 style="margin-top:0">Everyone else</h3>' + (others.map(tripCard).join('') || '<p class="muted">None.</p>') + '</div>' : '');
    bindOpenLinks(app);
  }

  /* ---------- Approvals ---------- */
  function renderApprovals(app) {
    var mine = state.trips.filter(function (t) { return (t.manager_email || '').toLowerCase() === myEmail() || isAdmin(); });
    var waiting = mine.filter(function (t) { return t.status === 'submitted'; });
    var done = mine.filter(function (t) { return t.status !== 'submitted'; }).sort(function (a, b) { return (b.approved_at || '') < (a.approved_at || '') ? -1 : 1; });
    var item = function (t, open) {
      var p = person(t.traveller_id), a = assess(t), lv = tripAdvice(t), e = person(t.entered_by);
      return '<div class="t"><div><b>' + esc(p.full_name) + '</b> ' + (p.kind === 'contractor' ? '<span class="tag">Contractor</span> ' : '') + statusTag(t) + ' ' + advTag(lv) + (a.ok ? ' <span class="tag ok">Meets 50% test</span>' : ' <span class="tag warn">Below 50%: ' + a.qualifying + ' of ' + a.weekdays + ' weekdays</span>') + flagTags(a) + (lv >= 3 ? (t.dean_permission ? ' <span class="tag ok">Dean permission declared' + (t.dean_permission_date ? ' ' + fmtShort(t.dean_permission_date) : '') + '</span>' : ' <span class="tag bad">Dean permission missing</span>') : '') +
        '<div class="sub">' + esc(t.purpose) + '</div><div class="sub">' + esc(tripCountries(t).join(', ')) + ' · ' + fmtShort(t.start_date) + ' to ' + fmtShort(t.end_date) + ' · ' + a.allowance + ' allowance days · cost centre ' + esc(t.cost_centre || 'not set') + (e.id !== p.id ? ' · entered by ' + esc(e.full_name) : '') + '</div>' +
        '<div class="sub">' + (t.manager_declared ? 'Traveller declares approval was given' + (t.manager_declared_date ? ' on ' + fmtShort(t.manager_declared_date) : '') : 'Traveller has not declared prior approval') + (t.approved_at ? ' · ' + (t.status === 'approved' ? 'Approved' : 'Declined') + ' by ' + esc(t.approved_by) + ' on ' + new Date(t.approved_at).toLocaleDateString('en-AU') : '') + (t.approval_comment ? ' · "' + esc(t.approval_comment) + '"' : '') + '</div>' +
        '<div class="sub"><a href="#log" data-edit="' + t.id + '">Open the full trip</a></div></div>' +
        (open ? '<div><textarea id="c-' + t.id + '" placeholder="Comment for the traveller (optional)"></textarea><div class="actions"><button type="button" class="btn primary" data-dec="approved" data-t="' + t.id + '">Approve</button><button type="button" class="btn danger" data-dec="declined" data-t="' + t.id + '">Decline</button></div></div>' : '') + '</div>';
    };
    app.innerHTML = '<h1>Approvals</h1><p class="lead">Trips naming you as line manager. Approve or decline here; the traveller sees your comment on the trip.' + (isAdmin() ? ' As an admin you also see trips waiting on other managers.' : '') + '</p>' +
      '<div class="panel queue"><h3 style="margin-top:0">Waiting for you (' + waiting.length + ')</h3>' + (waiting.map(function (t) { return item(t, true); }).join('') || '<p class="muted">Nothing waiting.</p>') + '</div>' +
      '<div class="panel queue"><h3 style="margin-top:0">Decided</h3>' + (done.map(function (t) { return item(t, false); }).join('') || '<p class="muted">None yet.</p>') + '</div>';
    bindOpenLinks(app);
    app.querySelectorAll('[data-dec]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.dataset.t, dec = b.dataset.dec, c = (q('c-' + id).value || '').trim();
        if (dec === 'declined' && !c && !confirm('Decline without a comment?')) return;
        b.disabled = true;
        sb.rpc('approve_trip', { p_trip: id, p_decision: dec, p_comment: c || null }).then(function (r) {
          if (r.error) { b.disabled = false; toast(r.error.message, true); return; }
          toast(dec === 'approved' ? 'Trip approved' : 'Trip declined'); reload();
        });
      });
    });
  }

  /* ---------- Audit log (admins only) ---------- */
  function renderAudit(app) {
    app.innerHTML = '<h1>Audit log</h1><p class="lead">A record of trips edited or deleted by someone other than the traveller, and of approved trips whose Smartraveller rating changed after approval. It shows who, when and which trip, not what was changed. Visible to admins only. Newest first, up to 500 entries.</p><div class="panel scroll" id="auditBody"><div class="loading">Loading</div></div>';
    sb.from('trip_audit').select('*').order('at', { ascending: false }).limit(500).then(function (r) {
      var el = q('auditBody'); if (!el) return;
      if (r.error) { el.innerHTML = '<div class="err">Could not load the audit log: ' + esc(r.error.message) + (/trip_audit/.test(r.error.message) ? ' The database update for the audit log may not have been run yet.' : '') + '</div>'; return; }
      var rows = r.data || [];
      if (!rows.length) { el.innerHTML = '<div class="empty">No entries yet.</div>'; return; }
      el.innerHTML = '<table class="audit"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Traveller</th><th>Trip</th><th>Why it was logged</th></tr></thead><tbody>' + rows.map(function (a) {
        var exists = state.trips.some(function (t) { return t.id === a.trip_id; });
        return '<tr><td class="nowrap">' + new Date(a.at).toLocaleString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) + '</td><td>' + esc(a.changed_by_name || 'Unknown') + '</td><td>' + esc(a.action) + '</td><td>' + esc(a.traveller_name || '') + '</td><td>' + (exists ? '<a href="#log" data-edit="' + a.trip_id + '">' + esc(a.trip_label || 'Open trip') + '</a>' : esc(a.trip_label || '') + ' <span class="muted">(deleted)</span>') + '</td><td>' + esc(a.reason) + '</td></tr>';
      }).join('') + '</tbody></table>';
      bindOpenLinks(el);
    });
  }

  /* ---------- People ---------- */
  var newPerson = null;
  function renderPeople(app) {
    var roles = ['traveller', 'arranger', 'manager', 'admin'];
    var row = function (p, isNew) {
      var id = isNew ? 'new' : p.id;
      return '<tr data-p="' + id + '"><td><input data-k="full_name" value="' + esc(p.full_name) + '" placeholder="Full name"></td><td><input data-k="email" type="email" value="' + esc(p.email || '') + '" placeholder="email (optional for contractors)"' + (p.user_id ? ' disabled title="Linked to a sign-in; cannot change"' : '') + '></td>' +
        '<td><select data-k="kind"><option value="staff" ' + (p.kind === 'staff' ? 'selected' : '') + '>Staff</option><option value="contractor" ' + (p.kind === 'contractor' ? 'selected' : '') + '>Contractor</option></select></td>' +
        '<td><select data-k="cost_centre">' + ccOptions(p.cost_centre || '') + '</select></td><td><input data-k="manager_email" type="email" value="' + esc(p.manager_email || '') + '"></td><td><input data-k="mobile" value="' + esc(p.mobile || '') + '"></td>' +
        '<td><select data-k="role"' + (isAdmin() ? '' : ' disabled') + '>' + roles.map(function (r) { return '<option ' + (r === p.role ? 'selected' : '') + '>' + r + '</option>'; }).join('') + '</select></td>' +
        '<td><select data-k="active"><option value="1" ' + (p.active ? 'selected' : '') + '>Active</option><option value="0" ' + (!p.active ? 'selected' : '') + '>Inactive</option></select></td>' +
        '<td>' + (p.user_id ? '<span class="tag ok">Signed in</span>' : '<span class="tag">No sign-in yet</span>') + '</td><td><button type="button" class="btn" data-save="' + id + '">' + (isNew ? 'Add' : 'Save') + '</button></td></tr>';
    };
    newPerson = newPerson || { full_name: '', email: '', kind: 'contractor', cost_centre: '', manager_email: '', mobile: '', role: 'traveller', active: true };
    app.innerHTML = '<h1>People</h1><p class="lead">Staff appear here when they first sign in. Add contractors and anyone you enter travel for here. A person with an email outside ' + esc(cfg.ALLOWED_DOMAIN_HINT || 'the allowed domain') + ' can sign in only if their email is listed here first.' + (isAdmin() ? ' Roles: traveller sees own trips; arranger enters trips for others and sees all; manager sees all and approves; admin does everything.' : ' Only an admin can change roles.') + '</p>' +
      '<div class="panel scroll people-table"><table><thead><tr><th>Name</th><th>Email</th><th>Type</th><th>Cost centre</th><th>Line manager email</th><th>Mobile</th><th>Role</th><th>Status</th><th>Sign-in</th><th></th></tr></thead><tbody>' +
      row(newPerson, true) + state.people.map(function (p) { return row(p, false); }).join('') + '</tbody></table></div>';
    app.querySelectorAll('[data-save]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.dataset.save, tr = app.querySelector('tr[data-p="' + id + '"]'), rec = {};
        tr.querySelectorAll('[data-k]').forEach(function (el) { var k = el.dataset.k; rec[k] = k === 'active' ? el.value === '1' : (el.value.trim() || null); });
        if (!rec.full_name) { toast('A name is needed'); return; }
        if (rec.email) rec.email = rec.email.toLowerCase();
        if (rec.manager_email) rec.manager_email = rec.manager_email.toLowerCase();
        if (!isAdmin()) delete rec.role;
        b.disabled = true;
        var qry = id === 'new' ? sb.from('people').insert(rec) : sb.from('people').update(rec).eq('id', id);
        qry.then(function (r) {
          b.disabled = false;
          if (r.error) { toast(r.error.message, true); return; }
          if (id === 'new') newPerson = null;
          toast(id === 'new' ? 'Person added' : 'Saved'); reload();
        });
      });
    });
  }

  boot();
})();
