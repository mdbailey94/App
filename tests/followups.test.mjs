import { test } from 'node:test';
import assert from 'node:assert/strict';
import { concernsOn, followUps, followUpsFor, hardButPoor } from '../src/followups.js';
import { groupByAthlete } from '../src/group.js';
import { shiftDate } from '../src/readiness.js';

const D = '2026-09-29'; // a Tuesday
const W = (v, extra = {}) => ({ sleepHours: 8, scaleMax: 7, sleepQuality: v, energy: v, soreness: v, stress: v, mood: v, motivation: v, ...extra });
const LOG = { am: { durationMin: 120, rpe: 5, perf: 7 }, pm: { none: null }, weights: false, meet: false };
const day = (name, n, entry) => ({ athlete: name, date: shiftDate(D, -n), entry: { ...entry, date: shiftDate(D, -n) } });
// A usual fortnight: check-ins at `v` with each day's workouts logged.
const usual = (name, v = 5, days = 10) => Array.from({ length: days }, (_, i) => day(name, days - i, { wellness: W(v), workouts: LOG }));
const cat = (fu, key) => fu.categories.find((c) => c.key === key);
const names = (fu, key) => cat(fu, key).swimmers.map((s) => s.name);

test('categories: injury and sickness first, answers against their own usual, training response, missing, ready', () => {
  const rows = [
    ...usual('Ana'), day('Ana', 0, { wellness: W(5), pain: { level: 3, location: 'left shoulder' } }),
    ...usual('Ben'), day('Ben', 0, { wellness: W(5, { energy: 2, soreness: 2 }) }),
    ...usual('Cal'), day('Cal', 0, { wellness: W(5, { stress: 2, mood: 2 }) }),
    ...usual('Dee'), day('Dee', 0, { wellness: W(5) }),
    ...usual('Eve').slice(0, 9), day('Eve', 1, { wellness: W(5), workouts: { am: { none: 'sick' }, pm: { none: null }, weights: false, meet: false } }),
    ...usual('Fay').slice(0, 9), day('Fay', 0, { wellness: W(5) }), // yesterday not logged
    day('Old', 40, { wellness: W(5) }), // not active
  ];
  const fu = followUps(rows, D);
  assert.deepEqual(fu.categories.map((c) => c.key), ['health', 'recovery', 'stress', 'response', 'missing', 'ready']);
  assert.deepEqual(names(fu, 'health'), ['Ana', 'Eve']); // the injury that stops strokes first
  const ana = cat(fu, 'health').swimmers[0];
  assert.equal(ana.level, 'critical');
  assert.match(ana.reasons[0].text, /Injury stopping certain strokes or movements \(left shoulder\), reported today/);
  assert.match(ana.ask, /left shoulder/);
  assert.match(cat(fu, 'health').swimmers[1].reasons[0].text, /Missed practice sick: yesterday/);

  const ben = cat(fu, 'recovery').swimmers.find((s) => s.name === 'Ben');
  assert.deepEqual(ben.reasons.map((r) => r.text), ['Energy 2/7 today, usually about 5.', 'Soreness (7 = none) 2/7 today, usually about 5.']);
  assert.equal(ben.days, 1); // new today
  assert.deepEqual(names(fu, 'stress'), ['Cal']);
  assert.match(cat(fu, 'stress').swimmers[0].ask, /outside the pool/);

  // Missing data is its own thing: Eve didn't check in today; Fay didn't log yesterday.
  assert.deepEqual(names(fu, 'missing'), ['Eve', 'Fay']);
  assert.match(cat(fu, 'missing').swimmers[0].reasons[0].text, /No check-in \(last yesterday\)/);
  assert.match(cat(fu, 'missing').swimmers[1].reasons[0].text, /training not logged/);
  // Ready: checked in and nothing stands out (Fay is still ready; she just didn't log).
  assert.deepEqual(names(fu, 'ready'), ['Dee', 'Fay']);
  assert.ok(!fu.categories.some((c) => c.swimmers.some((s) => s.name === 'Old')));
});

test('without a usual yet, only very low answers count; with one, a drop counts', () => {
  const fresh = groupByAthlete([day('New', 1, { wellness: W(5) }), day('New', 0, { wellness: W(5, { energy: 3, mood: 1 }) })]).get('new').entries;
  const c = concernsOn(fresh, D);
  assert.equal(c.recovery, undefined); // energy 3 isn't very low, and there is no usual yet
  assert.deepEqual(c.stress.reasons.map((r) => r.text), ['Mood 1/7 today.']);
});

test('short sleep, low readiness runs and how long a concern has lasted', () => {
  const rows = [
    ...usual('Gus', 6),
    ...[3, 2, 1, 0].map((n) => day('Gus', n, { wellness: W(2, { sleepHours: 5.5 }), workouts: LOG })),
  ];
  const fu = followUpsFor(groupByAthlete(rows).get('gus').entries, D);
  const rec = fu.find((c) => c.key === 'recovery');
  assert.ok(rec.reasons.some((r) => /Under 7 h sleep on 4 of their last 4 nights/.test(r.text)));
  assert.ok(rec.reasons.some((r) => /Readiness under 70 on their last 4 check-ins/.test(r.text)));
  assert.ok(rec.days >= 3); // it's been building for days, not new
  assert.match(rec.ask, /sleeping|body/);
});

test('training response: hard practices that went poorly, or how well they did dropping', () => {
  const tough = { am: { durationMin: 120, rpe: 8, perf: 3 }, pm: { none: null }, weights: false, meet: false };
  const rows = [...usual('Hal'), ...[2, 1, 0].map((n) => day('Hal', n, { wellness: W(5), workouts: tough }))];
  const r = concernsOn(groupByAthlete(rows).get('hal').entries, D).response;
  assert.match(r.reasons[0].text, /Practice felt hard \(7\+\) but went poorly \(4 or less\) on 3 days this week/);
  // One such day isn't a pattern.
  const once = [...usual('Hap'), day('Hap', 0, { wellness: W(5), workouts: tough })];
  const e = groupByAthlete(once).get('hap').entries;
  assert.deepEqual(hardButPoor(e, D), { days: [D], flagged: false });
  assert.equal(concernsOn(e, D).response, undefined);
  // High effort that went well is not a concern.
  const good = { am: { durationMin: 120, rpe: 9, perf: 9 }, pm: { none: null }, weights: false, meet: false };
  const ok = [...usual('Ivy'), ...[2, 1, 0].map((n) => day('Ivy', n, { wellness: W(5), workouts: good }))];
  assert.equal(concernsOn(groupByAthlete(ok).get('ivy').entries, D).response, undefined);
  // Easy-feeling but well under their usual "how well".
  const meh = { am: { durationMin: 120, rpe: 4, perf: 4 }, pm: { none: null }, weights: false, meet: false };
  const drop = [...usual('Jo'), ...[2, 1, 0].map((n) => day('Jo', n, { wellness: W(5), workouts: meh }))];
  assert.match(concernsOn(groupByAthlete(drop).get('jo').entries, D).response.reasons[0].text, /How well they did: 4\.0 over their last 3 practices, usually about 7\.0/);
});

test('Sundays: no check-in is not counted as missing', () => {
  const sunday = '2026-09-27';
  const rows = [...usual('Kim').map((r) => ({ ...r }))];
  const fu = followUps(rows, sunday);
  assert.ok(!cat(fu, 'missing').swimmers.some((s) => s.reasons.some((r) => /No check-in/.test(r.text))));
});
