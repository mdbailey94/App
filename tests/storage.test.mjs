import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
const { fixMisloggedSunday, loadEntries } = await import('../src/storage.js');
const KEY = 'athlete-readiness/entries/v1';
const put = (entries) => { store.clear(); store.set(KEY, JSON.stringify(entries)); };
const am = { am: { durationMin: 120, rpe: 7, perf: 8 }, pm: { none: null }, weights: false, meet: false };

test('fixMisloggedSunday: a practice logged Monday under Sunday moves to Monday, once', () => {
  put([
    { date: '2026-10-18', wellness: { energy: 5 }, workouts: { ...am, loggedAt: '2026-10-19T08:30:00Z' }, syncedAt: '2026-10-19T09:00:00Z', updatedAt: '2026-10-19T08:30:00Z' },
    { date: '2026-10-19', wellness: { energy: 6 }, syncedAt: '2026-10-19T09:00:00Z', updatedAt: '2026-10-19T08:30:00Z' },
  ]);
  assert.equal(fixMisloggedSunday(), true);
  const [sun, mon] = loadEntries();
  assert.equal(sun.workouts, undefined);
  assert.deepEqual(sun.wellness, { energy: 5 });
  assert.equal(mon.workouts.am.durationMin, 120);
  assert.ok(mon.updatedAt > mon.syncedAt && sun.updatedAt > sun.syncedAt); // both re-sent
  assert.equal(fixMisloggedSunday(), false); // only once
});

test('fixMisloggedSunday leaves off days, Sunday-logged practices, and a logged Monday alone', () => {
  const cases = [
    [{ date: '2026-10-18', workouts: { am: { none: 'off' }, weights: true, loggedAt: '2026-10-19T08:30:00Z' } }],
    [{ date: '2026-10-18', workouts: { ...am, loggedAt: '2026-10-18T15:00:00Z' } }],
    [{ date: '2026-10-18', workouts: { ...am, loggedAt: '2026-10-19T08:30:00Z' } }, { date: '2026-10-19', workouts: am }],
  ];
  for (const entries of cases) {
    put(entries);
    assert.equal(fixMisloggedSunday(), false);
    assert.deepEqual(loadEntries(), entries);
  }
});
