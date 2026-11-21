/* MBS Travel Diary: policy calculations and date helpers.
   Pure functions with no page or network access, so they can be tested in Node
   (see tests/rules-tests.js) and reused by every screen. The database enforces the
   same rules; these give prompt feedback in the browser. */
(function (root) {
  'use strict';

  var MAX_DAYS = 120;          // longest trip the form and the database accept
  var STALE_DAYS = 3;          // advice older than this is shown as dated
  var DOMESTIC = 'australia';

  function iso(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function parse(s) { var p = s.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
  function addDays(s, n) { var d = parse(s); d.setDate(d.getDate() + n); return iso(d); }
  function daysBetween(a, b) { return Math.round((parse(b) - parse(a)) / 86400000); }
  function isWeekend(s) { var w = parse(s).getDay(); return w === 0 || w === 6; }

  /* Destination of one day: listed on Smartraveller, domestic, or not recognised. */
  function classify(country, advice) {
    var c = (country || '').trim();
    if (!c) return { status: 'empty', level: 0, name: '' };
    var a = advice[c.toLowerCase()];
    if (a) return { status: 'listed', level: a.level, name: a.country, fetched_at: a.fetched_at };
    if (c.toLowerCase() === DOMESTIC) return { status: 'domestic', level: 0, name: 'Australia' };
    return { status: 'unresolved', level: 0, name: c };
  }
  function tripCountries(t) { var s = {}; (t.days || []).forEach(function (d) { if (d.country) s[d.country] = 1; }); return Object.keys(s); }
  /* Highest advice level over the listed destinations. Unrecognised and domestic days add nothing. */
  function tripLevel(t, advice) {
    return tripCountries(t).reduce(function (m, c) { var k = classify(c, advice); return k.status === 'listed' ? Math.max(m, k.level) : m; }, 0);
  }
  function unresolvedCountries(t, advice) { return tripCountries(t).filter(function (c) { return classify(c, advice).status === 'unresolved'; }); }
  function level3Countries(t, advice) {
    return tripCountries(t).map(function (c) { return classify(c, advice); }).filter(function (k) { return k.status === 'listed' && k.level === 3; }).map(function (k) { return k.name; });
  }
  /* Oldest advice timestamp among the trip's listed destinations (a partial feed refresh can leave one country old). */
  function oldestAdvice(t, advice) {
    var oldest = null;
    tripCountries(t).forEach(function (c) { var k = classify(c, advice); if (k.status === 'listed' && k.fetched_at && (!oldest || k.fetched_at < oldest)) oldest = k.fetched_at; });
    return oldest;
  }
  function isStale(ts, now) { return !ts || ((now || Date.now()) - new Date(ts).getTime()) > STALE_DAYS * 86400000; }

  /* Business activity 50% test and the flags shown beside it. Advisory only. */
  function assess(t) {
    var days = t.days || [];
    var weekdays = days.filter(function (d) { return !isWeekend(d.day_date) && d.day_type !== 'Public holiday'; });
    var qualifying = weekdays.filter(function (d) { return d.day_type === 'Travel' || (d.day_type === 'Working' && d.qualifies); });
    var selfDirected = weekdays.filter(function (d) { return d.day_type === 'Working' && !d.qualifies; });
    var allowance = days.filter(function (d) { return d.allowance; }).length;
    var leave = days.filter(function (d) { return d.day_type === 'Leave'; }).length;
    var none = weekdays.length === 0;
    var ok = none ? true : qualifying.length * 2 >= weekdays.length;
    return { weekdays: weekdays.length, qualifying: qualifying.length, selfDirected: selfDirected.length, allowance: allowance, leave: leave, ok: ok, noWeekdays: none };
  }
  function dayFor(t, date) { return (t.days || []).find(function (d) { return d.day_date === date; }); }

  /* One entry for each date from start to end. Existing entries are kept. Returns null when the range is not usable,
     so the caller can leave what the person has already typed untouched. */
  function buildDays(start, end, keep) {
    if (!start || !end) return null;
    var n = daysBetween(start, end);
    if (n < 0 || n + 1 > MAX_DAYS) return null;
    var out = [];
    for (var i = 0; i <= n; i++) {
      var date = addDays(start, i);
      var prev = keep ? keep.find(function (d) { return d.day_date === date; }) : null;
      out.push(prev || { day_date: date, city: '', country: '', day_type: isWeekend(date) ? 'Weekend' : 'Working', activities: '', qualifies: false, allowance: false });
    }
    return out;
  }
  /* A submitted trip needs exactly one entry per date. Returns a list of problems, empty when complete. */
  function coverageProblems(start, end, days) {
    var p = [];
    if (!start || !end) return ['dates'];
    var n = daysBetween(start, end) + 1;
    if (n < 1) return ['a last day on or after the first day'];
    if (n > MAX_DAYS) return ['a trip of at most ' + MAX_DAYS + ' days'];
    var seen = {};
    (days || []).forEach(function (d) { seen[d.day_date] = (seen[d.day_date] || 0) + 1; });
    for (var i = 0; i < n; i++) { if (seen[addDays(start, i)] !== 1) { p.push('an entry for every date'); break; } }
    if ((days || []).length !== n && p.length === 0) p.push('an entry for every date');
    return p;
  }

  /* Cost centre summary for the dashboard. The assessment of each trip is computed once and reused for every figure. */
  function ccSummary(trips, onTrips, cc, today, horizon, advice, assessFn) {
    var as = assessFn || assess, memo = {};
    var get = function (t) { return memo[t.id] || (memo[t.id] = as(t)); };
    var all = trips.filter(function (t) { return t.cost_centre === cc && t.status !== 'declined'; });
    var soon = all.filter(function (t) { return t.end_date >= today && t.start_date <= horizon; });
    var away = onTrips.filter(function (t) { return t.cost_centre === cc && t.status !== 'declined'; }).length;
    var people = {}; soon.forEach(function (t) { people[t.traveller_id] = 1; });
    var r = { away: away, soon: soon.length, travellers: Object.keys(people).length, allowance: 0, below: 0, remote: 0, leave: 0, high: 0, waiting: 0, deanMissing: 0 };
    soon.forEach(function (t) {
      var a = get(t), lv = tripLevel(t, advice);
      r.allowance += a.allowance; r.remote += a.selfDirected; r.leave += a.leave;
      if (!a.ok) r.below++;
      if (lv >= 3) r.high++;
      if (t.status === 'submitted') r.waiting++;
      if (lv >= 3 && !level3Covered(t, advice)) r.deanMissing++;
    });
    return r;
  }
  /* Every Level 3 destination on the trip has a recorded reference. */
  function level3Covered(t, advice) {
    var have = {}; (t.level3 || []).forEach(function (e) { if (e && e.ref && e.date) have[String(e.country).toLowerCase()] = 1; });
    return level3Countries(t, advice).every(function (c) { return have[c.toLowerCase()]; });
  }
  /* Approved trip whose advice has risen since it was approved. */
  function adviceRaised(t, advice) {
    return t.status === 'approved' && t.approved_level != null && tripLevel(t, advice) > t.approved_level;
  }

  var api = {
    MAX_DAYS: MAX_DAYS, STALE_DAYS: STALE_DAYS,
    iso: iso, parse: parse, addDays: addDays, daysBetween: daysBetween, isWeekend: isWeekend,
    classify: classify, tripCountries: tripCountries, tripLevel: tripLevel, unresolvedCountries: unresolvedCountries,
    level3Countries: level3Countries, oldestAdvice: oldestAdvice, isStale: isStale,
    assess: assess, dayFor: dayFor, buildDays: buildDays, coverageProblems: coverageProblems,
    ccSummary: ccSummary, level3Covered: level3Covered, adviceRaised: adviceRaised
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.MBSRules = api;
})(typeof window !== 'undefined' ? window : this);
