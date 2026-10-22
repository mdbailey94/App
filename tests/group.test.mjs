import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkinGrid, dataDashboard, groupByAthlete, groupDay, loadResponse, metricSeries, swimmerInsights, trainingCompare, recentNotes, reminderText, roster, teamTrend, trendSummary,
  watchList,
} from '../src/group.js';
import { addressDetails, buildItems, inviteLink, memberAddress, isValidSheetUrl, pendingEntries, stuck } from '../src/team.js';
import { shiftDate, trainingFrom } from '../src/readiness.js';

const good = { sleepHours: 8, sleepQuality: 5, energy: 5, soreness: 5, stress: 5, mood: 5, motivation: 5 };
const poor = { sleepHours: 5, sleepQuality: 2, energy: 2, soreness: 2, stress: 2, mood: 2, motivation: 2 };
const D = '2026-09-27';

const rows = [
  { athlete: 'Sam', date: D, entry: { date: D, wellness: good } },
  { athlete: 'Ana', date: D, entry: { date: D, wellness: poor } },
  { athlete: 'Kai', date: D, entry: { date: D, wellness: good, pain: { level: 3, location: 'ankle sprain' } } },
  { athlete: 'Lou', date: shiftDate(D, -2), entry: { date: shiftDate(D, -2), wellness: good } },
  { athlete: 'Old', date: shiftDate(D, -60), entry: { date: shiftDate(D, -60), wellness: good } },
  // Same athlete, different capitalisation, earlier day.
  { athlete: 'sam', date: shiftDate(D, -1), entry: { date: shiftDate(D, -1), wellness: poor } },
];

test('groupByAthlete merges names case-insensitively and sorts by date', () => {
  const g = groupByAthlete(rows);
  assert.equal(g.get('sam').entries.length, 2);
  assert.deepEqual(g.get('sam').entries.map((e) => e.date), [shiftDate(D, -1), D]);
});

test('groupDay: severe injury first, then lowest readiness; recent no-shows listed', () => {
  const day = groupDay(rows, D);
  assert.deepEqual(day.checkedIn.map((c) => c.name), ['Kai', 'Ana', 'Sam']);
  assert.equal(day.checkedIn[0].assessment.status.label, 'Check in');
  assert.deepEqual(day.missing.map((m) => m.name), ['Lou']); // "Old" is inactive
  assert.equal(day.total, 4);
  assert.equal(day.needAttention, 2);
});

test('groupDay ignores entries after the chosen date', () => {
  const day = groupDay(rows, shiftDate(D, -1));
  assert.deepEqual(day.checkedIn.map((c) => c.name), ['Sam']); // latest spelling shown
  assert.ok(!day.checkedIn[0].entry.pain);
});

test('pendingEntries: never sent, or edited since last send', () => {
  const entries = [
    { date: 'a' },
    { date: 'b', updatedAt: '2026-09-27T08:00:00Z', syncedAt: '2026-09-27T09:00:00Z' },
    { date: 'c', updatedAt: '2026-09-27T10:00:00Z', syncedAt: '2026-09-27T09:00:00Z' },
  ];
  assert.deepEqual(pendingEntries(entries).map((e) => e.date), ['a', 'c']);
});

test('buildItems sends the entry without sync bookkeeping, plus a summary', () => {
  const entries = [{ date: D, wellness: good, training: { durationMin: 60, rpe: 5 }, syncedAt: 'x' }];
  const [item] = buildItems(entries, entries);
  assert.equal(item.entry.syncedAt, undefined);
  assert.deepEqual(item.summary, { score: 100, status: 'Ready', flags: [], wellness: 100, load: 300 });
});

test('invite links and sheet URL validation', () => {
  const link = inviteLink('https://x.github.io/App/#coach', 'https://script.google.com/macros/s/AB/exec', 'Eagles 1');
  assert.equal(link, 'https://x.github.io/App/?u=https%3A%2F%2Fscript.google.com%2Fmacros%2Fs%2FAB%2Fexec&g=Eagles+1#team');
  // The group travels in the query, so an iPhone Home Screen app (fresh storage) still has it.
  const home = memberAddress('https://x.github.io/App/?old=1#today', { url: 'https://script.google.com/macros/s/AB/exec', group: 'Eagles 1', athlete: 'Sam Lee' }, '#morning');
  assert.equal(home, 'https://x.github.io/App/?u=https%3A%2F%2Fscript.google.com%2Fmacros%2Fs%2FAB%2Fexec&g=Eagles+1&n=Sam+Lee#morning');
  assert.deepEqual(addressDetails(new URL(home).search), { url: 'https://script.google.com/macros/s/AB/exec', group: 'Eagles 1', athlete: 'Sam Lee' });
  // Older invite links carried the details in the hash; those still work.
  assert.deepEqual(addressDetails('', new URLSearchParams('u=U&g=G')), { url: 'U', group: 'G', athlete: '' });
  assert.ok(isValidSheetUrl('https://script.google.com/macros/s/AB/exec'));
  assert.ok(!isValidSheetUrl('https://evil.example.com/collect'));
});

const mid = { sleepHours: 6.5, sleepQuality: 3, energy: 3, soreness: 3, stress: 3, mood: 3, motivation: 3 };
const day = (name, n, entry) => ({ athlete: name, date: shiftDate(D, -n), entry: { ...entry, date: shiftDate(D, -n) } });

test('groupDay counts days missed in a row', () => {
  assert.equal(groupDay(rows, D).missing.find((m) => m.name === 'Lou').missedDays, 2);
});

test('watchList: injuries first, then runs of low days and short sleep; quiet swimmers left off', () => {
  const r = [
    ...[3, 2, 1, 0].map((n) => day('Mia', n, { wellness: mid })), // 4 moderate days, short sleep
    day('Kai', 0, { wellness: good, pain: { level: 3, location: 'ankle' } }),
    day('Zoe', 1, { wellness: good, pain: { level: 2, location: 'shoulder' } }),
    ...[3, 2, 1, 0].map((n) => day('Sam', n, { wellness: good })),
  ];
  const list = watchList(r, D);
  assert.deepEqual(list.map((w) => w.name), ['Kai', 'Zoe', 'Mia']);
  assert.match(list[0].reasons[0].text, /stopping certain strokes.*ankle.*today/);
  assert.equal(list[0].reasons[0].level, 'critical');
  assert.match(list[1].reasons[0].text, /affecting stroke.*shoulder.*yesterday/);
  assert.deepEqual(list[2].reasons.map((x) => x.level), ['warning', 'note']);
  assert.match(list[2].reasons[0].text, /below 70 on their last 4/);
  assert.match(list[2].reasons[1].text, /Under 7 h sleep on 4 of their last 4 nights \(average 6\.5 h\)/);
});

test('watchList: readiness well down on their usual, and old injuries drop off', () => {
  const r = [
    ...Array.from({ length: 14 }, (_, i) => day('Eli', 8 + i, { wellness: good })),
    ...[2, 1, 0].map((n) => day('Eli', n, { wellness: { ...good, energy: 3, mood: 3, motivation: 3 } })),
    day('Ivy', 5, { wellness: good, pain: { level: 3 } }),
  ];
  const list = watchList(r, D);
  assert.deepEqual(list.map((w) => w.name), ['Eli']);
  assert.match(list[0].reasons[0].text, /Readiness down \d+ points/);
});

test('teamTrend: daily averages of readiness and load (with 6+ swimmers), check-in rate', () => {
  const six = ['A', 'B', 'C', 'D', 'E', 'F'];
  const r = [
    ...six.map((n, i) => day(n, 1, { wellness: i % 2 ? poor : good, training: { durationMin: 60, rpe: 4 } })),
    ...['A', 'B', 'C', 'D', 'E'].map((n) => day(n, 0, { wellness: good, training: { durationMin: 60, rpe: 5 } })),
  ];
  const t = teamTrend(r, D, 2);
  assert.deepEqual(t.map((d) => d.date), [shiftDate(D, -1), D]);
  assert.deepEqual(t.map((d) => d.rate), [100, 83]);
  assert.equal(typeof t[0].avgReadiness, 'number');
  assert.deepEqual([t[0].avgLoad, t[0].loadReported], [240, 240]);
  // Only five swimmers today: no team averages for the day.
  assert.deepEqual([t[1].avgReadiness, t[1].avgLoad, t[1].loadReported], [null, 0, null]);
  assert.deepEqual(trendSummary(t), { avgReadiness: t[0].avgReadiness, rate: 92, avgLoad: 240, rpeAm: 4.5, rpePm: null, perfAm: null, perfPm: null, weights: 0, meet: 0 });
});

test('reminderText lists who is missing', () => {
  assert.equal(reminderText([{ name: 'Lou' }, { name: 'Mia' }, { name: 'Kai' }], 'https://x/'),
    'Morning check-in reminder 🏊 Still waiting on Lou, Mia and Kai. It takes about a minute: https://x/');
});

test('stuck: only when something is waiting and sending has failed for over a day', () => {
  const now = Date.parse('2026-10-05T08:00:00Z');
  assert.equal(stuck({ pending: 1, failingSince: '2026-10-04T07:00:00Z' }, now), true);
  assert.equal(stuck({ pending: 1, failingSince: '2026-10-05T07:00:00Z' }, now), false);
  assert.equal(stuck({ pending: 0, failingSince: '2026-10-01T07:00:00Z' }, now), false);
  assert.equal(stuck({ pending: 2, failingSince: null }, now), false);
});

test('checkinGrid: a row per recent swimmer, a cell per day, injuries marked', () => {
  const r = [
    day('Sam', 0, { wellness: good }), day('Sam', 2, { wellness: good }),
    day('Ana', 1, { wellness: good, pain: { level: 2, location: 'knee' } }),
    day('Old', 30, { wellness: good }),
  ];
  const g = checkinGrid(r, D, 3);
  assert.deepEqual(g.dates, [shiftDate(D, -2), shiftDate(D, -1), D]);
  assert.deepEqual(g.rows.map((x) => x.name), ['Ana', 'Sam']); // 'Old' isn't in the window
  assert.deepEqual(g.rows[1].cells.map(Boolean), [true, false, true]);
  assert.equal(g.rows[1].count, 2);
  assert.equal(g.rows[0].cells[1].injury, true);
});

test('recentNotes: notes and injuries, newest first, only in the window', () => {
  const r = [
    day('Sam', 0, { wellness: good, notes: 'Tired after the meet' }),
    day('Ana', 1, { wellness: good, pain: { level: 1, location: 'shoulder' } }),
    day('Kai', 2, { wellness: good }), // nothing to say
    day('Lou', 20, { wellness: good, notes: 'old note' }),
  ];
  const n = recentNotes(r, D, 14);
  assert.deepEqual(n.map((x) => x.name), ['Sam', 'Ana']);
  assert.equal(n[0].note, 'Tired after the meet');
  assert.deepEqual(n[1].injury, { level: 1, location: 'shoulder' });
});

test('roster: recent swimmers with check-ins this week and their average', () => {
  const r = [
    ...[3, 2, 1, 0].map((n) => day('Mia', n, { wellness: good })),
    day('Leo', 10, { wellness: good }),
    day('Old', 40, { wellness: good }),
  ];
  const list = roster(r, D);
  assert.deepEqual(list.map((x) => x.name), ['Leo', 'Mia']);
  assert.equal(list[1].checkins7, 4);
  assert.equal(list[1].avg7, 100);
  assert.equal(list[0].checkins7, 0);
  assert.equal(list[0].avg7, null);
});

test('teamTrend: average effort per practice over those who went, and weights / meet counts', () => {
  const split = (am, pm, weights = false, meet = false) => trainingFrom({ am: am && { durationMin: 90, rpe: am }, pm: pm && { durationMin: 120, rpe: pm }, weights, meet });
  const r = [
    day('A', 0, { wellness: good, training: split(4, 8, true) }),
    day('B', 0, { wellness: good, training: split(6, null, false, true) }), // no afternoon practice; a meet
    day('C', 0, { wellness: good, training: { durationMin: 60, rpe: 5 } }), // older, unsplit check-in: counts as AM
    day('D', 0, { training: split(2, null) }), // Monday's answer about Saturday: training only
  ];
  const [t] = teamTrend(r, D, 1);
  assert.deepEqual([t.rpeAm, t.rpePm, t.weights, t.meet], [4.3, 8, 1, 1]);
  // Training-only entries are not check-ins.
  assert.equal(t.checkedIn, 3);
  assert.deepEqual(groupDay(r, D).checkedIn.map((c) => c.name).sort(), ['A', 'B', 'C']);
});

const W7 = (v) => ({ sleepHours: 8, scaleMax: 7, sleepQuality: v, energy: v, soreness: v, stress: v, mood: v, motivation: v });
const sessions = (am, pm, extra = {}) => trainingFrom({ am: am && { durationMin: am[0], rpe: am[1] }, pm: pm && { durationMin: pm[0], rpe: pm[1] }, ...extra });

test('groupDay: each check-in against yesterday and their usual; team averages', () => {
  const usualWeek = (name, v = 5) => [7, 6, 5, 4, 3, 2, 1].map((n) => day(name, n, { wellness: W7(v) }));
  const r = [
    ...usualWeek('Ana'), day('Ana', 0, { wellness: W7(3) }),
    ...usualWeek('Ben'), day('Ben', 0, { wellness: W7(5) }),
    ...['Dee', 'Eve', 'Fay', 'Gus'].flatMap((n) => [...usualWeek(n), day(n, 0, { wellness: W7(5) })]),
    day('Cy', 2, { wellness: W7(4) }), day('Cy', 0, { wellness: W7(6) }), // no usual yet
  ];
  const g = groupDay(r, D);
  const ana = g.checkedIn.find((c) => c.name === 'Ana');
  assert.equal(ana.prevDate, shiftDate(D, -1));
  assert.equal(ana.vsPrev, ana.assessment.score - ana.prevScore);
  assert.ok(ana.vsPrev < 0 && ana.vsUsual < 0);
  assert.equal(g.checkedIn.find((c) => c.name === 'Ben').vsUsual, 0);
  const cy = g.checkedIn.find((c) => c.name === 'Cy');
  assert.equal(cy.prevDate, shiftDate(D, -2)); // their previous check-in, not necessarily yesterday
  assert.ok(cy.vsPrev > 0);
  assert.equal(cy.usualScore, null);
  assert.ok(g.avgReadiness < g.readinessYesterday);
  assert.equal(typeof g.readiness7, 'number');
});

test('trainingCompare: yesterday against the same day last week and the usual for that weekday', () => {
  const r = [];
  // Four previous Mondays-to-be: same session each week; this week Ana goes harder and lifts.
  for (const w of [4, 3, 2, 1]) {
    r.push(day('Ana', 7 * w, { wellness: W7(5), training: sessions([120, 4], [90, 5]) }));
    r.push(day('Ben', 7 * w, { wellness: W7(5), training: sessions([120, 4], null, { meet: w === 1, meetLevel: 'hard' }) })); // meets don't add load
  }
  r.push(day('Ana', 1, { wellness: W7(5), training: sessions([60, 2], null) })); // a different weekday: ignored
  r.push(day('Ana', 0, { wellness: W7(3), training: sessions([120, 8], [90, 9], { weights: true }) }));
  r.push(day('Ben', 0, { wellness: W7(5), training: sessions([120, 4], null) }));
  r.push(day('Cal', 0, { wellness: W7(5), training: sessions([120, 4], null) })); // new: nothing to compare
  const c = trainingCompare(r, D);
  assert.equal(c.trainedOn, shiftDate(D, -1));
  assert.equal(c.weekAgo, shiftDate(D, -7));
  assert.deepEqual(c.team.now.am, { count: 3, avgMin: 120, avgRpe: 5.3, avgPerf: null });
  assert.deepEqual(c.team.now.pm, { count: 1, avgMin: 90, avgRpe: 9, avgPerf: null });
  assert.equal(c.team.now.weights, 1);
  assert.equal(c.team.weekAgo.meet, 1);
  assert.equal(c.team.weekAgo.reported, 2);
  assert.equal(c.team.usual.days, 4);
  assert.equal(c.team.usual.meet, 0.3); // 1 meet in 4 weeks, averaged per day
  assert.equal(c.team.usual.pm.count, 1);

  const ana = c.swimmers.find((s) => s.name === 'Ana');
  const usual = 120 * 4 + 90 * 5;
  assert.equal(c.swimmers[0].name, 'Ana'); // heaviest first
  assert.equal(ana.load, 120 * 8 + 90 * 9 + 45 * 5);
  assert.equal(ana.weekAgoLoad, usual);
  assert.equal(ana.usualLoad, usual);
  assert.equal(ana.vsWeekAgo, Math.round(((ana.load - usual) / usual) * 100));
  const ben = c.swimmers.find((s) => s.name === 'Ben');
  assert.equal(ben.weekAgoLoad, 480);
  assert.equal(ben.usualLoad, 480);
  const cal = c.swimmers.find((s) => s.name === 'Cal');
  assert.deepEqual([cal.weekAgoLoad, cal.usualLoad, cal.vsWeekAgo, cal.vsUsual], [null, null, null, null]);
});

test('loadResponse: readiness change after light, moderate and heavy days, absolute and per swimmer', () => {
  const r = [];
  // A and B train three times as much as C and D, so in absolute terms nearly all
  // their days are "heavy"; relative to themselves, the pattern is the same.
  for (const [name, scale] of [['A', 3], ['B', 3], ['C', 1], ['D', 1]]) {
    for (let n = 20; n >= 0; n--) {
      const heavy = n % 3 === 0;
      const light = n % 3 === 1;
      r.push(day(name, n, {
        wellness: W7(heavy ? 3 : light ? 6 : 5),
        training: heavy ? sessions([90 * scale, 9], null) : light ? sessions([30 * scale, 2], null) : sessions([60 * scale, 5], null),
      }));
    }
  }
  const out = loadResponse(r, D);
  for (const kind of ['absolute', 'relative']) {
    const b = out[kind];
    assert.equal(b.enough, true);
    assert.equal(b.light.n + b.moderate.n + b.heavy.n, b.pairs);
    assert.ok(b.light.range[1] <= b.moderate.range[0] && b.moderate.range[1] <= b.heavy.range[0]);
  }
  // Relative to each swimmer, heavy days are clearly followed by drops and light ones by rises.
  assert.ok(out.relative.heavy.change < -5, 'readiness drops after their heavy days');
  assert.ok(out.relative.light.change > 0, 'and rises after their light ones');
  assert.ok(out.relative.heavy.range[0] > 100, 'heavy = above their usual');
  // In absolute terms the groups mix swimmers, so the split is blurrier.
  assert.ok(out.absolute.heavy.change > out.relative.heavy.change);
  assert.deepEqual(loadResponse(r.slice(0, 5), D).absolute, { enough: false, pairs: 4, needed: 15 });
  assert.equal(loadResponse(r, D, { days: 7 }).absolute.pairs, 28);
});

test('swimmerInsights: one swimmer’s readiness change, training comparison, watch list and own pattern', () => {
  const r = [];
  for (let n = 27; n >= 0; n--) {
    const heavy = n % 3 === 0;
    r.push(day('Ana', n, {
      wellness: W7(heavy ? 3 : 6),
      training: heavy ? sessions([120, 9], [90, 9]) : sessions([60, 3], null),
      pain: n === 0 ? { level: 3, location: 'knee' } : { level: 0 },
    }));
    r.push(day('Ben', n, { wellness: W7(5), training: sessions([60, 5], null) }));
  }
  const i = swimmerInsights(r, 'ana');
  assert.equal(i.date, D);
  assert.equal(i.readiness.prevDate, shiftDate(D, -1));
  assert.ok(i.readiness.vsPrev < 0); // today followed a heavy day
  assert.equal(i.training.load, 120 * 9 + 90 * 9);
  assert.equal(i.training.vsWeekAgo, Math.round(((1890 - 180) / 180) * 100)); // a week ago was light
  assert.equal(i.watch[0].level, 'critical');
  assert.equal(i.response.enough, true);
  assert.ok(i.response.heavy.change < 0 && i.response.light.change > 0);
  assert.equal(swimmerInsights(r, 'nobody'), null);
});

test('teamTrend: the team’s average readiness against each swimmer’s own usual', () => {
  const names = ['A', 'B', 'C', 'D', 'E', 'F'];
  const r = [];
  for (const n of names) for (let k = 7; k >= 1; k--) r.push(day(n, k, { wellness: W7(5) }));
  names.forEach((n, i) => r.push(day(n, 0, { wellness: W7(i < 3 ? 3 : 5) }))); // half the team dips today
  const t = teamTrend(r, D, 2);
  const g = groupDay(r, D);
  const expected = +(g.checkedIn.reduce((s, c) => s + c.vsUsual, 0) / 6).toFixed(1);
  assert.ok(expected < 0);
  assert.equal(t[1].vsUsual, expected);
  assert.equal(t[0].vsUsual, 0); // yesterday everyone was at their usual
  // Fewer than 6 swimmers with a usual: no team number for the day.
  assert.equal(teamTrend(r.filter((x) => x.athlete !== 'F'), D, 1)[0].vsUsual, null);
});

test('workouts logged on the Workouts tab count like check-in reports, filed under the next morning', () => {
  // One entry (one sheet row) per day: that morning's check-in and that day's workouts.
  const workouts = {
    2: { am: { durationMin: 120, rpe: 6, perf: 8 }, pm: { none: 'sick' }, weights: true, meet: false },
    1: { am: { none: 'sick' }, pm: { none: 'sick' }, weights: false, meet: false },
  };
  const r = [
    ...[3, 2, 1, 0].map((n) => day('Ana', n, { wellness: W7(5), ...(workouts[n] ? { workouts: workouts[n] } : {}) })),
    day('Ben', 0, { wellness: W7(5) }),
  ];
  const ana = groupByAthlete(r).get('ana');
  // Day 2's workout shows up on day 1's morning entry, day 1's on today's.
  const t1 = ana.entries.find((e) => e.date === shiftDate(D, -1)).training;
  assert.deepEqual([t1.am.perf, t1.pmNone, t1.weights, t1.logged], [8, 'sick', true, true]);
  assert.equal(ana.entries.find((e) => e.date === shiftDate(D, -1)).wellness.energy, 5); // check-in kept
  const c = trainingCompare(r, shiftDate(D, -1));
  assert.equal(c.team.now.am.avgPerf, 8);
  assert.equal(c.team.now.sick, 1);
  // Off sick: on the watch list, even with an otherwise fine week.
  const w = watchList(r, D).find((x) => x.name === 'Ana');
  assert.equal(w.reasons[0].level, 'serious');
  assert.match(w.reasons[0].text, /Missed practice sick: yesterday, 2 days ago\./);
});

test('metricSeries: a team average needs 6+ swimmers; one swimmer; training from the day before; 1–5 answers rescaled', () => {
  const W5 = { sleepHours: 7, sleepQuality: 5, energy: 5, soreness: 5, stress: 5, mood: 5, motivation: 5 }; // old 1–5 scale
  const T = { am: { durationMin: 120, rpe: 6, perf: 8 }, pm: null, weights: false, meet: false };
  const rows = ['A', 'B', 'C', 'D', 'E', 'F'].flatMap((n, i) => [
    { athlete: n, date: '2026-10-06', entry: { wellness: W5 } },
    // Only five check in on the 7th; A also logs that day's practice.
    ...(i < 5 ? [{ athlete: n, date: '2026-10-07', entry: { wellness: W5, ...(i === 0 ? { workouts: T } : {}) } }] : []),
  ]);
  const days = ['2026-10-06', '2026-10-07'];
  assert.deepEqual(metricSeries(rows, 'energy', days).map((p) => [p.value, p.n]), [[7, 6], [null, 5]]);
  assert.deepEqual(metricSeries(rows, 'sleepHours', days, 'a').map((p) => p.value), [7, 7]);
  // A's practice on the 7th is filed on the morning of the 8th.
  assert.deepEqual(metricSeries(rows, 'perfAm', ['2026-10-08'], 'a').map((p) => p.value), [8]);
  assert.deepEqual(metricSeries(rows, 'load', ['2026-10-08'], 'a').map((p) => p.value), [720]);
  assert.equal(metricSeries(rows, 'rate', ['2026-10-07'])[0].value, 83);
});

test('dataDashboard: each swimmer by day with period averages; check-in rate from joining; training by session day', () => {
  const W7 = (v) => ({ sleepHours: 8, scaleMax: 7, sleepQuality: v, energy: v, soreness: v, stress: v, mood: v, motivation: v });
  const T = { am: { durationMin: 120, rpe: 6, perf: 7 }, pm: { none: null }, weights: false, meet: false };
  const rows = [
    // Ann: three weeks of check-ins, logging each day's practice.
    ...Array.from({ length: 21 }, (_, i) => ({ athlete: 'Ann', date: shiftDate('2026-10-14', -i), entry: { wellness: W7(i < 7 ? 4 : 6), workouts: T } })),
    // Bo joined on the 12th and missed the 13th.
    ...['2026-10-12', '2026-10-14'].map((date) => ({ athlete: 'Bo', date, entry: { wellness: W7(5) } })),
  ];
  const energy = dataDashboard(rows, 'energy', '2026-10-14', 7);
  assert.equal(energy.days.length, 7);
  assert.equal(energy.days.at(-1), '2026-10-14');
  const ann = energy.swimmers.find((r) => r.name === 'Ann');
  assert.deepEqual([ann.avg, ann.prevAvg, ann.change, ann.latest], [4, 6, -2, 4]);
  assert.equal(energy.team.avg, null); // fewer than 6 swimmers
  const rate = dataDashboard(rows, 'rate', '2026-10-14', 7).swimmers.find((r) => r.name === 'Bo');
  assert.deepEqual(rate.values.slice(-3), [100, 0, 100]);
  assert.equal(rate.values[0], null); // before joining
  assert.equal(rate.avg, 67);
  // Ann's practice on the 14th is in (filed on the morning of the 15th).
  assert.equal(dataDashboard(rows, 'perfAm', '2026-10-14', 7).swimmers.find((r) => r.name === 'Ann').latest, 7);
  assert.deepEqual(dataDashboard(rows, 'energy', '2026-10-14', 7, { swimmers: false }).swimmers, []);
});
