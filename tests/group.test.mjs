import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupByAthlete, groupDay, reminderText, teamTrend, trendSummary, watchList } from '../src/group.js';
import { addressDetails, buildItems, inviteLink, memberAddress, isValidSheetUrl, pendingEntries } from '../src/team.js';
import { shiftDate } from '../src/readiness.js';

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

test('teamTrend: daily average readiness, check-in rate and load', () => {
  const r = [
    day('A', 1, { wellness: good, training: { durationMin: 60, rpe: 5 } }),
    day('B', 1, { wellness: poor, training: { durationMin: 60, rpe: 3 } }),
    day('A', 0, { wellness: good }),
  ];
  const t = teamTrend(r, D, 2);
  assert.deepEqual(t.map((d) => d.date), [shiftDate(D, -1), D]);
  assert.deepEqual(t.map((d) => d.rate), [100, 50]);
  assert.equal(t[0].avgLoad, 240);
  assert.deepEqual(trendSummary(t), { avgReadiness: Math.round((t[0].avgReadiness + 100) / 2), rate: 75, avgLoad: 240 });
});

test('reminderText lists who is missing', () => {
  assert.equal(reminderText([{ name: 'Lou' }, { name: 'Mia' }, { name: 'Kai' }], 'https://x/'),
    'Morning check-in reminder: still waiting on Lou, Mia and Kai. It takes about a minute: https://x/');
});
