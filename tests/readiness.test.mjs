import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assessDay, baseline, checkInStreak, personalBaseline, trainingOnDay, unloggedDays, withWorkouts, compareToUsual, sessionRpe, trainingFrom, isReadingDay, nextReadingDay, rollingMean, sessionLoad, shiftDate, wellnessScore, workload,
} from '../src/readiness.js';

const perfect = { sleepQuality: 5, energy: 5, soreness: 5, stress: 5, mood: 5, motivation: 5, sleepHours: 8 };
const awful = { sleepQuality: 1, energy: 1, soreness: 1, stress: 1, mood: 1, motivation: 1, sleepHours: 4 };

test('wellnessScore spans 0–100', () => {
  assert.equal(wellnessScore(perfect), 100);
  assert.equal(wellnessScore(awful), 0);
  assert.equal(wellnessScore({ ...perfect, sleepHours: 6 }), 93);
  assert.equal(wellnessScore({}), null);
});

test('sessionLoad is duration × RPE', () => {
  assert.equal(sessionLoad({ durationMin: 60, rpe: 7 }), 420);
  assert.equal(sessionLoad({ durationMin: 0, rpe: 7 }), 0);
  assert.equal(sessionLoad(undefined), 0);
});

test('baseline needs enough readings', () => {
  assert.equal(baseline([4, 4.1]), null);
  const b = baseline([4, 4.2, 4.1, 3.9, 4.0]);
  assert.ok(Math.abs(b.mean - 4.04) < 1e-9);
});

test('shiftDate crosses month boundaries', () => {
  assert.equal(shiftDate('2026-03-01', -1), '2026-02-28');
});

test('workload: coupled and EWMA acute:chronic ratios, monotony and strain, only with ≥3 weeks of data', () => {
  const entries = [];
  for (let i = 0; i < 28; i++) {
    entries.push({ date: shiftDate('2026-09-27', -i), training: { durationMin: 60, rpe: i < 7 ? 8 : 4 } });
  }
  const w = workload(entries, '2026-09-27');
  assert.equal(w.acute7, 7 * 480);
  assert.ok(Math.abs(w.acwr - 3360 / ((3360 + 21 * 240) / 4)) < 1e-9);
  // EWMA weights recent days more, so a week-old step up hasn't fully reached the 7-day average yet.
  assert.ok(w.ewmaAcwr > 1.2 && w.ewmaAcwr < w.acwr);
  // A steady month reads 1×: both averages are corrected for starting at zero
  // (uncorrected, the 28-day one is still warming up and the ratio reads ~1.1–1.3).
  const steady = Array.from({ length: 30 }, (_, i) => ({ date: shiftDate('2026-09-27', -i), training: { durationMin: 90, rpe: 5 } }));
  assert.ok(Math.abs(workload(steady, '2026-09-27').ewmaAcwr - 1) < 1e-9);
  // Seven identical days: no variation to measure.
  assert.equal(w.monotony, null);
  const short = workload(entries.slice(0, 7), '2026-09-27');
  assert.deepEqual([short.acwr, short.ewmaAcwr, short.monotony], [null, null, null]);
  // Six hard days and one off: high monotony; one hard day in an easy week: low.
  const flat = Array.from({ length: 28 }, (_, i) => ({ date: shiftDate('2026-09-27', -i), training: { durationMin: 120, rpe: i % 7 === 6 ? 0 : 6 } }));
  const m = workload(flat, '2026-09-27');
  assert.ok(m.monotony > 2);
  assert.ok(Math.abs(m.strain - m.acute7 * m.monotony) < m.acute7 * 0.01); // monotony is shown rounded
  const varied = Array.from({ length: 28 }, (_, i) => ({ date: shiftDate('2026-09-27', -i), training: { durationMin: 60, rpe: [8, 2, 6, 3, 7, 1, 0][i % 7] } }));
  assert.ok(workload(varied, '2026-09-27').monotony < 1.5);
});

test('personalBaseline: each answer, sleep and the score against the athlete\'s own last 28 days', () => {
  const W7 = (v, sleep = 8) => ({ sleepHours: sleep, scaleMax: 7, sleepQuality: v, energy: v, soreness: v, stress: v, mood: v, motivation: v });
  const day = (n, w) => ({ date: shiftDate('2026-10-20', -n), wellness: w });
  const steady = [1, 2, 3, 4, 5, 6, 7].map((n) => day(n, W7(5)));
  assert.deepEqual(personalBaseline([...steady.slice(0, 3), day(0, W7(5))], '2026-10-20'), { ready: false, remaining: 2 });
  assert.equal(personalBaseline(steady, '2026-10-20'), null); // no check-in that day
  const same = personalBaseline([...steady, day(0, W7(5))], '2026-10-20');
  assert.equal(same.ready, true);
  assert.equal(same.z, 0);
  assert.equal(same.items.energy.z, 0);
  // One answer two points down on a steady swimmer: a big deviation (SD floor keeps it finite).
  const dip = personalBaseline([...steady, day(0, { ...W7(5), energy: 3 })], '2026-10-20');
  assert.equal(dip.items.energy.usual, 5);
  assert.ok(dip.items.energy.z <= -2);
  assert.ok(dip.z < 0 && dip.z > -2);
  // Short sleep against their usual 8 h.
  assert.ok(personalBaseline([...steady, day(0, W7(5, 5.5))], '2026-10-20').items.sleepHours.z < -2);
  // Older 1–5 check-ins are put on the 1–7 scale first.
  const old5 = (v) => ({ sleepHours: 8, sleepQuality: v, energy: v, soreness: v, stress: v, mood: v, motivation: v });
  const mixed = personalBaseline([...[1, 2, 3, 4, 5].map((n) => day(n, old5(3))), day(0, W7(4))], '2026-10-20');
  assert.equal(mixed.items.energy.z, 0); // 3/5 and 4/7 are both the midpoint
  // Only the last 28 days count.
  const ancient = [30, 31, 32, 33, 34].map((n) => day(n, W7(2)));
  assert.equal(personalBaseline([...ancient, ...steady, day(0, W7(5))], '2026-10-20').items.energy.usual, 5);
});

test('assessDay: well under their own usual lowers the status, never the score', () => {
  const W7 = (v) => ({ sleepHours: 8, scaleMax: 7, sleepQuality: v, energy: v, soreness: v, stress: v, mood: v, motivation: v });
  const day = (n, w) => ({ date: shiftDate('2026-10-20', -n), wellness: w });
  const high = [1, 2, 3, 4, 5, 6, 7].map((n) => day(n, W7(7)));
  // 5/7 everywhere scores 71 (Ready on the fixed scale) but is far under a swimmer who always answers 7.
  const r = assessDay([...high, day(0, W7(5))], '2026-10-20');
  assert.equal(r.score, 71);
  assert.equal(r.status.label, 'Low');
  assert.equal(r.ownLevel, 'serious');
  assert.ok(r.flags.some((f) => /Well below your usual \(answers score 71, usually about 100\)/.test(f.text)));
  // One answer well down (energy 4 after always 7): Moderate.
  const r2 = assessDay([...high, day(0, { ...W7(7), energy: 4 })], '2026-10-20');
  assert.equal(r2.status.label, 'Moderate');
  assert.equal(r2.ownLevel, 'warning');
  // Two answers one point down: within a normal swing.
  assert.equal(assessDay([...high, day(0, { ...W7(7), energy: 6, mood: 6 })], '2026-10-20').ownLevel, null);
  // The same answers with no history: judged on the fixed scale only.
  assert.equal(assessDay([day(0, W7(5))], '2026-10-20').status.label, 'Ready');
  // Their usual can never make a low day look better.
  const lowUsual = [1, 2, 3, 4, 5, 6, 7].map((n) => day(n, W7(2)));
  assert.equal(assessDay([...lowUsual, day(0, W7(2))], '2026-10-20').status.label, 'Low');
});

test('assessDay: wellness-only score and status', () => {
  const r = assessDay([{ date: '2026-09-27', wellness: perfect }], '2026-09-27');
  assert.equal(r.score, 100);
  assert.equal(r.status.label, 'Ready');
  assert.equal(r.baselineReadingsNeeded, 5);
});

test('assessDay: low HRV vs baseline lowers score and raises a flag', () => {
  const entries = [];
  for (let i = 1; i <= 10; i++) {
    entries.push({ date: shiftDate('2026-09-27', -i), hrv: { lnRmssd: 4.2 + (i % 2 ? 0.05 : -0.05), hr: 50 + (i % 2) } });
  }
  entries.push({ date: '2026-09-27', wellness: perfect, hrv: { lnRmssd: 3.8, hr: 58 } });
  const r = assessDay(entries, '2026-09-27');
  // Judged on the 7-day average (today's 3.8 with six days near 4.2), not the one reading.
  assert.ok(r.hrvZ < -1 && r.hrvZ > -8);
  assert.ok(r.components.hrv > 0 && r.components.hrv < 50);
  assert.ok(r.score < 100);
  assert.ok(r.flags.some((f) => /HRV \(7-day average\) is well below/.test(f.text)));
  assert.ok(r.flags.some((f) => /Resting heart rate/.test(f.text)));
});

test('assessDay: a major injury overrides the score', () => {
  const r = assessDay([{ date: '2026-09-27', wellness: perfect, pain: { level: 3, location: 'ankle sprain' } }], '2026-09-27');
  assert.equal(r.status.level, 'critical');
  assert.ok(r.flags.some((f) => f.text === 'Injury stopping certain strokes or movements (ankle sprain).'));
});

test('assessDay: injury levels 1–2 flag without overriding', () => {
  const minor = assessDay([{ date: '2026-09-27', wellness: perfect, pain: { level: 1 } }], '2026-09-27');
  assert.equal(minor.flags.length, 0);
  const moderate = assessDay([{ date: '2026-09-27', wellness: perfect, pain: { level: 2, location: 'knee' } }], '2026-09-27');
  assert.equal(moderate.status.label, 'Ready');
  assert.ok(moderate.flags.some((f) => f.level === 'warning' && f.text === 'Injury affecting stroke (knee).'));
});

test('assessDay with heart: false ignores HRV and resting HR', () => {
  const entries = [];
  for (let i = 1; i <= 10; i++) entries.push({ date: shiftDate('2026-09-27', -i), hrv: { lnRmssd: 4.2 + (i % 2 ? 0.05 : -0.05), hr: 50 + (i % 2) } });
  entries.push({ date: '2026-09-27', wellness: perfect, hrv: { lnRmssd: 3.8, hr: 58 } });
  const athlete = assessDay(entries, '2026-09-27', { heart: false });
  assert.equal(athlete.score, 100);
  assert.deepEqual(Object.keys(athlete.components), ['wellness']);
  assert.ok(!athlete.flags.some((f) => /HRV|heart rate/.test(f.text)));
  const coach = assessDay(entries, '2026-09-27');
  assert.ok(coach.score < 100);
});

test('rollingMean smooths over 7 days and needs 3 readings', () => {
  const entries = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({ date: shiftDate('2026-09-01', i), v: i === 4 ? 10 : 4 }));
  const r = rollingMean(entries, (e) => e.v);
  assert.ok(Number.isNaN(r[0]) && Number.isNaN(r[1]));
  assert.equal(r[2], 4);
  assert.ok(Math.abs(r[4] - 5.2) < 1e-9); // one bad day moves the average only a little
  assert.ok(Math.abs(r[8] - (4 * 6 + 10) / 7) < 1e-9);
});

test('1–7 scales score on their own range; older 1–5 check-ins still score the same', () => {
  const top7 = { scaleMax: 7, sleepQuality: 7, energy: 7, soreness: 7, stress: 7, mood: 7, motivation: 7 };
  const mid7 = { scaleMax: 7, sleepQuality: 4, energy: 4, soreness: 4, stress: 4, mood: 4, motivation: 4 };
  const top5 = { sleepQuality: 5, energy: 5, soreness: 5, stress: 5, mood: 5, motivation: 5 };
  assert.equal(wellnessScore(top7), 100);
  assert.equal(wellnessScore(mid7), 50);
  assert.equal(wellnessScore(top5), 100);
  assert.equal(wellnessScore({ ...top5, energy: 3 }), wellnessScore({ ...top7, energy: 4 })); // both midpoints
});

test('reading days: Mon/Wed/Fri by weekday; none set means every day', () => {
  const mwf = [1, 3, 5];
  assert.equal(isReadingDay(mwf, '2026-09-28'), true); // Monday
  assert.equal(isReadingDay(mwf, '2026-09-29'), false); // Tuesday
  assert.equal(nextReadingDay(mwf, '2026-09-29'), 'Wed');
  assert.equal(nextReadingDay(mwf, '2026-10-02'), 'Mon'); // Friday → Monday
  assert.equal(isReadingDay([], '2026-09-29'), true);
  assert.equal(nextReadingDay([], '2026-09-29'), null);
});

test('checkInStreak counts days in a row, still alive before today is done', () => {
  const w = { energy: 5 };
  const days = (...ds) => ds.map((date) => ({ date, wellness: w }));
  // 2026-09-23 is a Wednesday.
  assert.deepEqual(checkInStreak(days('2026-09-21', '2026-09-22', '2026-09-23'), '2026-09-23'), { days: 3, doneToday: true, nudge: false });
  assert.deepEqual(checkInStreak(days('2026-09-21', '2026-09-22'), '2026-09-23'), { days: 2, doneToday: false, nudge: true });
  assert.deepEqual(checkInStreak(days('2026-09-20', '2026-09-22'), '2026-09-23'), { days: 1, doneToday: false, nudge: true });
  assert.deepEqual(checkInStreak([{ date: '2026-09-23', hrv: {} }], '2026-09-23'), { days: 0, doneToday: false, nudge: true });
});

test('checkInStreak: Sunday counts when made up on Monday, and never nags', () => {
  const w = { energy: 5 };
  const checkIns = (...ds) => ds.map((date) => ({ date, wellness: w }));
  const madeUp = (date) => ({ date, training: { am: null, pm: null, weights: false, meet: false, durationMin: 0, rpe: 0 } });
  // Thu 1 … Sat 3 Oct 2026, no Sunday check-in, Monday 5 Oct.
  const week = checkIns('2026-10-01', '2026-10-02', '2026-10-03');
  // Sunday: no "check in today".
  assert.deepEqual(checkInStreak(week, '2026-10-04'), { days: 3, doneToday: false, nudge: false });
  // Monday before checking in: Sunday can still be made up, so the streak is still 3.
  assert.equal(checkInStreak(week, '2026-10-05').days, 3);
  // Monday checked in and Saturday made up: Sunday counts, the streak continues.
  assert.equal(checkInStreak([...week, madeUp('2026-10-04'), ...checkIns('2026-10-05')], '2026-10-05').days, 5);
  // Monday checked in but Saturday skipped: the streak starts again.
  assert.equal(checkInStreak([...week, ...checkIns('2026-10-05')], '2026-10-05').days, 1);
  // A training-only entry on another day isn't a check-in.
  assert.equal(checkInStreak([...checkIns('2026-10-06'), madeUp('2026-10-07'), ...checkIns('2026-10-08')], '2026-10-08').days, 1);
});

test('compareToUsual: thanks only until 5 earlier check-ins, then today against their own usual', () => {
  const day = (n, v) => ({ date: shiftDate('2026-10-02', -n), wellness: { sleepHours: 8, scaleMax: 7, sleepQuality: v, energy: v, soreness: v, stress: v, mood: v, motivation: v } });
  const usual = [6, 5, 4, 3, 2, 1].map((n) => day(n, 5));
  assert.deepEqual(compareToUsual([...usual.slice(0, 2), day(0, 5)], '2026-10-02'), { ready: false, remaining: 3 });
  assert.equal(compareToUsual([...usual, day(0, 5)], '2026-10-02').level, 'same');
  assert.equal(compareToUsual([...usual, day(0, 7)], '2026-10-02').level, 'higher');
  assert.equal(compareToUsual([...usual, day(0, 2)], '2026-10-02').level, 'lower');
  // One point off isn't "below usual".
  assert.equal(compareToUsual([...usual, day(0, 4.8)], '2026-10-02').level, 'same');
  // A swimmer whose answers swing a lot needs a bigger gap before it counts.
  const swingy = [6, 5, 4, 3, 2, 1].map((n) => day(n, n % 2 ? 7 : 3));
  assert.equal(compareToUsual([...swingy, day(0, 3)], '2026-10-02').level, 'same');
});

test('training split into practices; weights count as 45 min at hard (5); a meet records how hard it was', () => {
  const t = trainingFrom({ am: { durationMin: 90, rpe: 4 }, pm: { durationMin: 120, rpe: 8 }, weights: true, meet: false });
  assert.equal(t.durationMin, 255); // 90 + 120 + 45 for weights
  assert.equal(t.rpe, 6); // (90×4 + 120×8 + 45×5) / 255 = 6.1
  assert.equal(sessionLoad(t), 90 * 4 + 120 * 8 + 45 * 5);
  assert.equal(sessionLoad(trainingFrom({ am: null, pm: null, weights: true })), 225);
  assert.deepEqual(['am', 'pm'].map((k) => sessionRpe(t, k)), [4, 8]);
  assert.equal(t.weights, true);
  assert.equal(t.meet, false);

  const restDay = trainingFrom({ am: null, pm: null });
  assert.deepEqual(restDay, { am: null, pm: null, weights: false, meet: false, durationMin: 0, rpe: 0 });
  assert.equal(sessionLoad(restDay), 0);
  assert.equal(sessionRpe(restDay, 'am'), null);

  // How hard a meet was is kept (earlier meets count as moderate), but meets
  // aren't counted in load.
  const meet = (level) => trainingFrom({ am: null, pm: null, meet: true, meetLevel: level });
  assert.deepEqual(['light', 'moderate', 'hard'].map((l) => sessionLoad(meet(l))), [0, 0, 0]);
  assert.equal(meet('hard').meetLevel, 'hard');
  assert.equal(meet(undefined).meetLevel, 'moderate');
  assert.equal(meet('hard').durationMin, 0);
  assert.equal('meetLevel' in trainingFrom({ am: null, pm: null, meet: false, meetLevel: 'hard' }), false);

  // Older check-ins: one number for the whole day, no per-session effort.
  assert.equal(sessionLoad({ durationMin: 60, rpe: 5 }), 300);
  assert.equal(sessionRpe({ durationMin: 60, rpe: 5 }, 'am'), undefined);
});

test('withWorkouts: a logged day lands on the next morning, wins over an older report, and is idempotent', () => {
  const entries = [
    { date: '2026-10-10', wellness: { sleepHours: 8 }, workouts: { am: { durationMin: 90, rpe: 6, perf: 7 }, pm: { none: 'off' }, weights: true, meet: false } },
    { date: '2026-10-11', wellness: { sleepHours: 8 }, training: { durationMin: 30, rpe: 2 } }, // an older check-in's report of the 10th
  ];
  const out = withWorkouts(entries);
  const t = out.find((e) => e.date === '2026-10-11').training;
  assert.deepEqual([t.am, t.pm, t.pmNone, t.weights, t.logged], [{ durationMin: 90, rpe: 6, perf: 7 }, null, 'off', true, true]);
  assert.equal(sessionLoad(t), 90 * 6 + 45 * 5);
  assert.deepEqual(withWorkouts(out), out);
  assert.equal(entries[1].training.durationMin, 30); // the stored entries are untouched
  // A workout with no check-in the next day makes a training-only entry.
  const only = withWorkouts([{ date: '2026-10-10', workouts: { am: { none: 'sick' } } }]);
  assert.deepEqual(only.map((e) => e.date), ['2026-10-10', '2026-10-11']);
  assert.equal(only[1].training.amNone, 'sick');
  assert.equal(only[1].wellness, undefined);
  // trainingOnDay reads either kind.
  assert.equal(trainingOnDay(entries, '2026-10-10').am.perf, 7);
  assert.equal(trainingOnDay([{ date: '2026-10-11', training: { durationMin: 30, rpe: 2 } }], '2026-10-10').durationMin, 30);
  assert.equal(trainingOnDay(entries, '2026-10-12'), null);
  // Older whole-day reports were morning practice.
  assert.deepEqual(trainingOnDay([{ date: '2026-10-11', training: { durationMin: 30, rpe: 2 } }], '2026-10-10').am, { durationMin: 30, rpe: 2 });
  const old = withWorkouts([{ date: '2026-10-11', training: { durationMin: 90, rpe: 6 } }])[0].training;
  assert.deepEqual([old.am, old.pm, sessionRpe(old, 'am'), sessionLoad(old)], [{ durationMin: 90, rpe: 6 }, null, 6, 540]);
});

test('Sundays with nothing logged are an off day; unloggedDays skips them', () => {
  // 2026-10-11 is a Sunday.
  const entries = [
    { date: '2026-10-08', wellness: {}, workouts: { am: { durationMin: 120, rpe: 5 } } },
    { date: '2026-10-10', wellness: {} },
    { date: '2026-10-12', wellness: {} },
  ];
  const sun = trainingOnDay(entries, '2026-10-11');
  assert.deepEqual([sun.assumed, sun.amNone, sessionLoad(sun)], [true, 'off', 0]);
  assert.equal(withWorkouts(entries).find((e) => e.date === '2026-10-12').training.assumed, true);
  // Logged Sunday training wins.
  const trained = [...entries, { date: '2026-10-11', workouts: { am: { durationMin: 60, rpe: 4 } } }];
  assert.equal(trainingOnDay(trained, '2026-10-11').assumed, undefined);
  // On Tuesday the 13th: Monday, Saturday and Friday unlogged; Sunday skipped; nothing before the first entry.
  assert.deepEqual(unloggedDays(entries, '2026-10-13'), ['2026-10-12', '2026-10-10', '2026-10-09']);
  // Yesterday is asked about even for a new swimmer.
  assert.deepEqual(unloggedDays([{ date: '2026-10-14', wellness: {} }], '2026-10-14'), ['2026-10-13']);
});

test('a save with only the starting answers (no morning practice) counts as not logged', () => {
  const empty = { pm: { none: null }, weights: false, meet: false, loggedAt: '2026-10-20T08:37:12Z' };
  const entries = [{ date: '2026-10-16', wellness: {} }, { date: '2026-10-17', workouts: empty }, { date: '2026-10-19', wellness: {} }];
  assert.equal(trainingOnDay(entries, '2026-10-17'), null);
  assert.deepEqual(unloggedDays(entries, '2026-10-19'), ['2026-10-17', '2026-10-16']);
  assert.equal(withWorkouts(entries).find((e) => e.date === '2026-10-18')?.training, undefined);
  // Weights alone is an answer.
  assert.equal(trainingOnDay([{ date: '2026-10-17', workouts: { ...empty, weights: true } }], '2026-10-17').weights, true);
});
