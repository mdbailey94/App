import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupByAthlete, groupDay } from '../src/group.js';
import { buildItems, inviteLink, isValidSheetUrl, pendingEntries } from '../src/team.js';
import { shiftDate } from '../src/readiness.js';

const good = { sleepHours: 8, sleepQuality: 5, energy: 5, soreness: 5, stress: 5, mood: 5, motivation: 5 };
const poor = { sleepHours: 5, sleepQuality: 2, energy: 2, soreness: 2, stress: 2, mood: 2, motivation: 2 };
const D = '2026-09-27';

const rows = [
  { athlete: 'Sam', date: D, entry: { date: D, wellness: good } },
  { athlete: 'Ana', date: D, entry: { date: D, wellness: poor } },
  { athlete: 'Kai', date: D, entry: { date: D, wellness: good, illness: ['Fever / chills'] } },
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

test('groupDay: illness first, then lowest readiness; recent no-shows listed', () => {
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
  assert.ok(!day.checkedIn[0].entry.illness);
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
  assert.equal(link, 'https://x.github.io/App/#team?u=https%3A%2F%2Fscript.google.com%2Fmacros%2Fs%2FAB%2Fexec&g=Eagles%201');
  assert.ok(isValidSheetUrl('https://script.google.com/macros/s/AB/exec'));
  assert.ok(!isValidSheetUrl('https://evil.example.com/collect'));
});
