import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessDay, baseline, sessionLoad, shiftDate, wellnessScore, workload } from '../src/readiness.js';

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

test('assessDay: an injury that prevents training overrides the score', () => {
  const r = assessDay([{ date: '2026-09-27', wellness: perfect, pain: { level: 3, location: 'ankle sprain' } }], '2026-09-27');
  assert.equal(r.status.level, 'critical');
  assert.ok(r.flags.some((f) => f.text === 'Injury preventing training (ankle sprain).'));
});

test('assessDay: injury levels 1–2 flag without overriding', () => {
  const minor = assessDay([{ date: '2026-09-27', wellness: perfect, pain: { level: 1 } }], '2026-09-27');
  assert.equal(minor.flags.length, 0);
  const moderate = assessDay([{ date: '2026-09-27', wellness: perfect, pain: { level: 2, location: 'knee' } }], '2026-09-27');
  assert.equal(moderate.status.label, 'Ready');
  assert.ok(moderate.flags.some((f) => f.level === 'warning' && f.text === 'Injury limiting training (knee).'));
});
