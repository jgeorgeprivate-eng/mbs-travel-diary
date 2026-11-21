// Run with: node supabase/tests/rules-tests.js   (from the repo root)
const R = require('../../rules.js');
const assert = require('assert');
let pass = 0, fail = 0;
function t(name, fn) { try { fn(); pass++; console.log('PASS', name); } catch (e) { fail++; console.log('FAIL', name, '-', e.message); } }

const adviceRows = [
  { country: 'Singapore', level: 1, fetched_at: new Date().toISOString() },
  { country: 'Nigeria', level: 3, fetched_at: new Date().toISOString() },
  { country: 'Iran', level: 4, fetched_at: '2020-01-01T00:00:00Z' }
];
const advice = {}; adviceRows.forEach(a => { advice[a.country.toLowerCase()] = a; });
const day = (date, country, type, extra) => Object.assign({ day_date: date, country: country, day_type: type || 'Working', qualifies: false, allowance: false }, extra || {});

t('classify: listed, domestic, unresolved, empty', () => {
  assert.strictEqual(R.classify('Singapore', advice).status, 'listed');
  assert.strictEqual(R.classify('singapore', advice).status, 'listed');
  assert.strictEqual(R.classify('Australia', advice).status, 'domestic');
  assert.strictEqual(R.classify('Narnia', advice).status, 'unresolved');
  assert.strictEqual(R.classify('', advice).status, 'empty');
});
t('tripLevel is the highest listed level; domestic and unresolved add nothing', () => {
  const trip = { days: [day('2026-12-01', 'Singapore'), day('2026-12-02', 'Nigeria'), day('2026-12-03', 'Narnia'), day('2026-12-04', 'Australia')] };
  assert.strictEqual(R.tripLevel(trip, advice), 3);
  assert.deepStrictEqual(R.unresolvedCountries(trip, advice), ['Narnia']);
  assert.deepStrictEqual(R.level3Countries(trip, advice), ['Nigeria']);
});
t('buildDays covers every date and returns null past the maximum', () => {
  assert.strictEqual(R.buildDays('2026-12-01', '2026-12-05', []).length, 5);
  assert.strictEqual(R.buildDays('2026-12-01', '2026-11-01', []), null);
  assert.strictEqual(R.buildDays('2026-01-01', '2026-12-31', []), null);
  assert.strictEqual(R.buildDays('2026-01-01', '2026-04-30', []).length, 120);
});
t('coverageProblems flags missing, duplicate and over-long ranges', () => {
  const ok = R.buildDays('2026-12-01', '2026-12-03', []);
  assert.deepStrictEqual(R.coverageProblems('2026-12-01', '2026-12-03', ok), []);
  assert.ok(R.coverageProblems('2026-12-01', '2026-12-03', ok.slice(0, 2)).length);
  assert.ok(R.coverageProblems('2026-12-01', '2026-12-03', ok.concat([ok[0]])).length);
  assert.ok(R.coverageProblems('2026-01-01', '2026-12-31', []).length);
  assert.ok(R.coverageProblems('2026-12-05', '2026-12-01', []).length);
});
t('assess: a Saturday-Sunday trip has no eligible weekdays', () => {
  const a = R.assess({ days: [day('2026-12-05', 'Singapore', 'Weekend'), day('2026-12-06', 'Singapore', 'Weekend')] });
  assert.strictEqual(a.weekdays, 0); assert.strictEqual(a.noWeekdays, true);
});
t('assess: meets 50% when half of weekdays qualify', () => {
  const a = R.assess({ days: [day('2026-12-01', 'Singapore', 'Working', { qualifies: true }), day('2026-12-02', 'Singapore', 'Leave')] });
  assert.strictEqual(a.weekdays, 2); assert.strictEqual(a.qualifying, 1); assert.strictEqual(a.ok, true); assert.strictEqual(a.noWeekdays, false);
});
t('assess: remote working days do not qualify', () => {
  const a = R.assess({ days: [day('2026-12-01', 'Singapore', 'Working', { qualifies: true }), day('2026-12-02', 'Singapore', 'Working'), day('2026-12-03', 'Singapore', 'Working')] });
  assert.strictEqual(a.selfDirected, 2); assert.strictEqual(a.ok, false);
});
t('ccSummary assesses each trip exactly once', () => {
  const mk = (id, cc) => ({ id, cost_centre: cc, status: 'approved', traveller_id: id, start_date: '2026-12-01', end_date: '2026-12-02', days: [day('2026-12-01', 'Singapore', 'Working', { qualifies: true, allowance: true })] });
  const trips = [mk('a', 'X'), mk('b', 'X'), mk('c', 'Y')]; let calls = {};
  const counting = t => { calls[t.id] = (calls[t.id] || 0) + 1; return R.assess(t); };
  const r = R.ccSummary(trips, trips, 'X', '2026-11-30', '2027-01-30', advice, counting);
  assert.strictEqual(r.soon, 2); assert.strictEqual(r.allowance, 2);
  assert.deepStrictEqual(calls, { a: 1, b: 1 });
});
t('ccSummary counts Level 3 trips missing Dean permission', () => {
  const trip = { id: 'a', cost_centre: 'X', status: 'submitted', traveller_id: 'a', start_date: '2026-12-01', end_date: '2026-12-02', days: [day('2026-12-01', 'Nigeria', 'Working', { qualifies: true })], level3: [] };
  const r = R.ccSummary([trip], [], 'X', '2026-11-30', '2027-01-30', advice);
  assert.strictEqual(r.high, 1); assert.strictEqual(r.deanMissing, 1);
  trip.level3 = [{ country: 'Nigeria', date: '2026-11-01', ref: 'Email' }];
  assert.strictEqual(R.ccSummary([trip], [], 'X', '2026-11-30', '2027-01-30', advice).deanMissing, 0);
});
t('adviceRaised flags approved trips whose level rose', () => {
  const trip = { status: 'approved', approved_level: 1, days: [day('2026-12-01', 'Nigeria')] };
  assert.strictEqual(R.adviceRaised(trip, advice), true);
  assert.strictEqual(R.adviceRaised(Object.assign({}, trip, { status: 'submitted' }), advice), false);
  assert.strictEqual(R.adviceRaised(Object.assign({}, trip, { approved_level: 3 }), advice), false);
});
t('isStale uses the three day threshold', () => {
  assert.strictEqual(R.isStale(new Date().toISOString()), false);
  assert.strictEqual(R.isStale(new Date(Date.now() - 4 * 86400000).toISOString()), true);
  assert.strictEqual(R.isStale(null), true);
});
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
