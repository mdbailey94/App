import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assessDay, baseline, checkInStreak, compareToUsual, isReadingDay, nextReadingDay, rollingMean, sessionLoad, shiftDate, wellnessScore, workload,
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

test('workload computes ACWR only with ≥3 weeks of data', () => {
  const entries = [];
  for (let i = 0; i < 28; i++) {
    entries.push({ date: shiftDate('2026-09-27', -i), training: { durationMin: 60, rpe: i < 7 ? 8 : 4 } });
  }
  const w = workload(entries, '2026-09-27');
  assert.equal(w.acute7, 7 * 480);
  assert.ok(Math.abs(w.acwr - 3360 / ((3360 + 21 * 240) / 4)) < 1e-9);
  assert.equal(workload(entries.slice(0, 7), '2026-09-27').acwr, null);
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
  assert.ok(r.hrvZ < -1);
  assert.equal(r.components.hrv, 0);
  assert.ok(r.score < 100);
  assert.ok(r.flags.some((f) => /HRV/.test(f.text)));
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
  assert.deepEqual(checkInStreak(days('2026-09-26', '2026-09-27', '2026-09-28'), '2026-09-28'), { days: 3, doneToday: true });
  assert.deepEqual(checkInStreak(days('2026-09-26', '2026-09-27'), '2026-09-28'), { days: 2, doneToday: false });
  assert.deepEqual(checkInStreak(days('2026-09-25', '2026-09-27'), '2026-09-28'), { days: 1, doneToday: false });
  assert.deepEqual(checkInStreak([{ date: '2026-09-28', hrv: {} }], '2026-09-28'), { days: 0, doneToday: false });
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
