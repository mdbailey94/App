import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { loadAppsScript } from './support/apps-script-sim.mjs';

const entry = (date, extra = {}) => ({
  date,
  wellness: { sleepHours: 7.5, sleepQuality: 4, energy: 4, soreness: 3, stress: 4, mood: 4, motivation: 5 },
  training: { durationMin: 60, rpe: 6 },
  pain: { level: 0, location: '' },
  illness: [],
  hrv: { hr: 52.34, rmssd: 88.123, lnRmssd: 4.4787, quality: 'good' },
  ...extra,
});
const summary = { score: 81, status: 'Ready', flags: [], wellness: 78, load: 360 };

test('ships with placeholder settings that refuse to run', () => {
  const src = readFileSync(new URL('../apps-script/Code.gs', import.meta.url), 'utf8');
  const ctx = vm.createContext({
    JSON, Date, Map, Math, Number, String, Array, Object, isFinite,
    ContentService: { MimeType: {}, createTextOutput: (text) => ({ text, setMimeType() { return this; } }) },
  });
  vm.runInContext(src, ctx);
  const res = JSON.parse(ctx.doPost({ postData: { contents: '{"action":"ping","group":"CHANGE-ME"}' } }).text);
  assert.equal(res.ok, false);
  assert.match(res.error, /GROUP_CODE/);
});

test('ping checks the group code (case-insensitive) and coach password', () => {
  const app = loadAppsScript();
  assert.equal(app.post({ action: 'ping', group: 'eagles' }).ok, true);
  assert.equal(app.post({ action: 'ping', group: 'hawks' }).ok, false);
  assert.equal(app.post({ action: 'ping', coachPassword: 'secret' }).role, 'coach');
  assert.equal(app.post({ action: 'ping', coachPassword: 'nope' }).ok, false);
  assert.equal(app.post('not json').ok, false);
});

test('submit creates the sheets, writes rows and updates by athlete + date', () => {
  const app = loadAppsScript();
  const r1 = app.post({ action: 'submit', group: 'EAGLES', athlete: 'Sam Lee', items: [
    { entry: entry('2026-09-26'), summary },
    { entry: entry('2026-09-27'), summary },
  ] });
  assert.deepEqual(r1, { ok: true, saved: ['2026-09-26', '2026-09-27'] });
  const sh = app.sheets.get('Entries');
  assert.equal(sh.rows.length, 3); // header + 2
  assert.ok(app.sheets.get('Today').formulas.A1.startsWith('=QUERY('));
  const [header, row] = sh.rows;
  const col = (name) => row[header.indexOf(name)];
  assert.equal(col('Date'), '2026-09-26');
  assert.equal(col('Athlete'), 'Sam Lee');
  assert.equal(col('Readiness'), 81);
  assert.equal(col('HR bpm'), 52.3);
  assert.equal(col('ln RMSSD'), 4.479);
  assert.equal(col('Load'), 360);

  // Same athlete + date (different capitalisation) updates in place.
  app.post({ action: 'submit', group: 'EAGLES', athlete: 'sam lee', items: [
    { entry: entry('2026-09-27', { notes: 'tight calf' }), summary: { ...summary, score: 55, status: 'Moderate' } },
  ] });
  assert.equal(sh.rows.length, 3);
  assert.equal(sh.rows[2][header.indexOf('Readiness')], 55);
  assert.equal(sh.rows[2][header.indexOf('Notes')], 'tight calf');

  // Another athlete, same date: new row.
  app.post({ action: 'submit', group: 'EAGLES', athlete: 'Ana', items: [{ entry: entry('2026-09-27'), summary }] });
  assert.equal(sh.rows.length, 4);
});

test('submit rejects wrong codes, missing names, bad dates; de-duplicates a batch', () => {
  const app = loadAppsScript();
  assert.equal(app.post({ action: 'submit', group: 'x', athlete: 'A', items: [] }).ok, false);
  assert.equal(app.post({ action: 'submit', group: 'EAGLES', athlete: '  ', items: [] }).ok, false);
  const r = app.post({ action: 'submit', group: 'EAGLES', athlete: 'A', items: [
    { entry: { date: 'yesterday' } },
    { entry: entry('2026-09-27'), summary },
    { entry: entry('2026-09-27', { notes: 'second' }), summary },
  ] });
  assert.deepEqual(r.saved, ['2026-09-27']);
  const sh = app.sheets.get('Entries');
  assert.equal(sh.rows.length, 2);
  assert.equal(sh.rows[1][sh.rows[0].indexOf('Notes')], 'second');
});

test('text that looks like a formula is stored as plain text', () => {
  const app = loadAppsScript();
  app.post({ action: 'submit', group: 'EAGLES', athlete: '=IMPORTXML("http://x")', items: [
    { entry: entry(new Date().toISOString().slice(0, 10), { notes: '+1 sore' }), summary },
  ] });
  const sh = app.sheets.get('Entries');
  const header = sh.rows[0];
  // Written with a leading apostrophe, which Sheets hides but treats as "plain text".
  assert.equal(sh.raw[1][header.indexOf('Athlete')], `'=IMPORTXML("http://x")`);
  assert.equal(sh.raw[1][header.indexOf('Notes')], "'+1 sore");
  // …and read back without it on the dashboard.
  const d = app.post({ action: 'dashboard', coachPassword: 'secret', days: 400 });
  assert.equal(d.rows[0].athlete, '=IMPORTXML("http://x")');
});

test('dashboard needs the coach password and returns recent entries', () => {
  const app = loadAppsScript();
  const today = new Date().toISOString().slice(0, 10);
  app.post({ action: 'submit', group: 'EAGLES', athlete: 'Sam', items: [
    { entry: entry('2020-01-01'), summary },
    { entry: entry(today), summary },
  ] });
  assert.equal(app.post({ action: 'dashboard', coachPassword: 'wrong' }).ok, false);
  const d = app.post({ action: 'dashboard', coachPassword: 'secret', days: 30 });
  assert.equal(d.ok, true);
  assert.deepEqual(d.rows.map((r) => [r.athlete, r.date]), [['Sam', today]]);
  assert.equal(d.rows[0].entry.hrv.rmssd, 88.123);
});
