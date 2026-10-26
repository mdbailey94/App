/**
 * Athlete Readiness – group sheet backend.
 *
 * Paste this whole file into Extensions → Apps Script of the Google Sheet
 * that should collect your group's data, set the two values below, then
 * Deploy → New deployment → Web app (Execute as: Me, Who has access: Anyone).
 * Give the web app URL to the app's Team tab. Full steps are in the app.
 */

// Athletes need this code to send data to the sheet.
const GROUP_CODE = 'CHANGE-ME';
// The coach dashboard needs this password to read the group's data.
const COACH_PASSWORD = 'change-me-too';

// Bumped when the app needs something new from this script; the dashboard
// says when the sheet's copy is behind.
const SCRIPT_VERSION = 3;

const ENTRIES = 'Entries';
const TODAY = 'Today';
const HEADERS = [
  'Updated', 'Date', 'Athlete', 'Readiness', 'Status', 'Flags', 'Wellness',
  'Sleep h', 'Sleep quality', 'Energy', 'Soreness', 'Stress', 'Mood', 'Motivation',
  'Pain (0-3)', 'Pain location', 'Illness', 'Training min', 'Session RPE', 'Load',
  'HR bpm', 'RMSSD ms', 'ln RMSSD', 'HRV quality', 'Notes', 'Data',
];
const COL = Object.fromEntries(HEADERS.map((h, i) => [h, i + 1]));

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'Bad request.' });
  }
  if (isConfigDefault_()) {
    return json_({ ok: false, error: 'The coach needs to set GROUP_CODE and COACH_PASSWORD in the sheet script.' });
  }
  try {
    if (req.action === 'ping') return json_(ping_(req));
    if (req.action === 'submit') return json_(submit_(req));
    if (req.action === 'dashboard') return json_(dashboard_(req));
    if (req.action === 'setGoals') return json_(setGoals_(req));
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
  return json_({ ok: false, error: 'Unknown action.' });
}

function doGet() {
  return json_({ ok: true, app: 'athlete-readiness', version: SCRIPT_VERSION, message: 'Group sheet is running.' });
}

function isConfigDefault_() {
  return GROUP_CODE === 'CHANGE-ME' || COACH_PASSWORD === 'change-me-too';
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function sameCode_(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

function ping_(req) {
  if (req.coachPassword !== undefined) {
    return req.coachPassword === COACH_PASSWORD ? { ok: true, role: 'coach', version: SCRIPT_VERSION } : { ok: false, error: 'Wrong coach password.' };
  }
  return sameCode_(req.group, GROUP_CODE) ? { ok: true, role: 'athlete', version: SCRIPT_VERSION } : { ok: false, error: 'Wrong group code.' };
}

// Text that Sheets would treat as a formula is stored as plain text.
function text_(v) {
  if (v === undefined || v === null) return '';
  const s = String(v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function num_(v, digits) {
  if (typeof v !== 'number' || !isFinite(v)) return '';
  return digits === undefined ? v : Number(v.toFixed(digits));
}

function toRow_(athlete, entry, summary) {
  const w = entry.wellness || {};
  const t = entry.training || {};
  const h = entry.hrv || {};
  const s = summary || {};
  return [
    new Date(),
    "'" + entry.date, // keep dates as text so Sheets doesn't reformat them
    text_(athlete),
    num_(s.score),
    text_(s.status),
    text_((s.flags || []).join(' | ')),
    num_(s.wellness),
    num_(w.sleepHours), num_(w.sleepQuality), num_(w.energy), num_(w.soreness),
    num_(w.stress), num_(w.mood), num_(w.motivation),
    num_(entry.pain && entry.pain.level), text_(entry.pain && entry.pain.location),
    text_((entry.illness || []).join(', ')),
    num_(t.durationMin), num_(t.rpe), num_(s.load),
    num_(h.hr, 1), num_(h.rmssd, 1), num_(h.lnRmssd, 3), text_(h.quality),
    text_(entry.notes),
    JSON.stringify(entry),
  ];
}

function entriesSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(ENTRIES);
  if (!sh) {
    sh = ss.insertSheet(ENTRIES, 0);
    setupEntries_(sh);
    setupToday_(ss);
  }
  return sh;
}

function setupEntries_(sh) {
  sh.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.setFrozenColumns(3);
  sh.hideColumns(COL.Data);
  const readiness = sh.getRange(2, COL.Readiness, sh.getMaxRows() - 1, 1);
  const status = sh.getRange(2, COL.Status, sh.getMaxRows() - 1, 1);
  sh.setConditionalFormatRules([
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('Check in').setBackground('#f4c7c3').setRanges([status]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThanOrEqualTo(70).setBackground('#c9ecc9').setRanges([readiness]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenNumberBetween(50, 69.99).setBackground('#fde8b0').setRanges([readiness]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenNumberLessThan(50).setBackground('#f9d3c3').setRanges([readiness]).build(),
  ]);
}

// A second tab listing today's check-ins, lowest readiness first.
function setupToday_(ss) {
  if (ss.getSheetByName(TODAY)) return;
  const sh = ss.insertSheet(TODAY, 1);
  sh.getRange('A1').setFormula(
    '=QUERY(' + ENTRIES + '!A:Y, "select C, D, E, F, G, H, O, Q, T, U, V where B = \'"&TEXT(TODAY(),"yyyy-mm-dd")&"\' order by D asc", 1)'
  );
  sh.setFrozenRows(1);
}

// Run once from the Apps Script editor (optional – it also runs on first use).
function setup() {
  entriesSheet_();
}

function submit_(req) {
  if (!sameCode_(req.group, GROUP_CODE)) return { ok: false, error: 'Wrong group code.' };
  const athlete = String(req.athlete || '').trim().slice(0, 60);
  if (!athlete) return { ok: false, error: 'Missing athlete name.' };
  const items = Array.isArray(req.items) ? req.items.slice(0, 400) : [];
  // One row per date; if a batch repeats a date, the last copy wins.
  const byDate = new Map();
  items.forEach((it) => {
    if (it && it.entry && /^\d{4}-\d{2}-\d{2}$/.test(it.entry.date)) byDate.set(it.entry.date, it);
  });
  const valid = Array.from(byDate.values());

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = entriesSheet_();
    const last = sh.getLastRow();
    const keys = last > 1 ? sh.getRange(2, COL.Date, last - 1, 2).getValues() : [];
    const data = last > 1 ? sh.getRange(2, COL.Data, last - 1, 1).getValues() : [];
    const rowOf = new Map();
    keys.forEach(([date, name], i) => rowOf.set(String(name).toLowerCase() + '|' + String(date), i + 2));

    const appended = [];
    for (const it of valid) {
      const at = rowOf.get(athlete.toLowerCase() + '|' + it.entry.date);
      // Goal times the coach set from the dashboard live in this row's JSON;
      // a phone that hasn't picked them up yet must not wipe them.
      const entry = at ? withNewerGoals_(it.entry, parseJson_(data[at - 2][0])) : it.entry;
      const row = toRow_(athlete, entry, it.summary);
      if (at) sh.getRange(at, 1, 1, row.length).setValues([row]);
      else appended.push(row);
    }
    if (appended.length) {
      sh.getRange(sh.getLastRow() + 1, 1, appended.length, HEADERS.length).setValues(appended);
    }
  } finally {
    lock.releaseLock();
  }
  const res = { ok: true, saved: valid.map((it) => it.entry.date), version: SCRIPT_VERSION };
  // The athlete's newest goal times (theirs or the coach's), so the phone can adopt them.
  const goals = newestGoals_(entriesSheet_(), athlete);
  if (goals) res.goals = goals;
  return res;
}

function parseJson_(text) {
  try { return JSON.parse(text); } catch (err) { return null; }
}

// `entry` with `existing`'s goals when those are newer (or the entry has none).
function withNewerGoals_(entry, existing) {
  const theirs = existing && existing.goals;
  if (!theirs) return entry;
  const mine = entry.goals;
  if (!mine || String(theirs.updatedAt || '') > String(mine.updatedAt || '')) return Object.assign({}, entry, { goals: theirs });
  return entry;
}

// The newest `goals` across an athlete's rows, by updatedAt.
function newestGoals_(sh, athlete) {
  const last = sh.getLastRow();
  if (last < 2) return null;
  const names = sh.getRange(2, COL.Athlete, last - 1, 1).getValues();
  const data = sh.getRange(2, COL.Data, last - 1, 1).getValues();
  let best = null;
  for (let i = 0; i < names.length; i++) {
    if (String(names[i][0]).replace(/^'/, '').toLowerCase() !== athlete.toLowerCase()) continue;
    const e = parseJson_(data[i][0]);
    if (e && e.goals && (!best || String(e.goals.updatedAt || '') > String(best.updatedAt || ''))) best = e.goals;
  }
  return best;
}

// The coach sets a swimmer's goal times from the dashboard: they go into
// that swimmer's row for the day (made if needed) and reach the phone with
// its next send.
function setGoals_(req) {
  if (req.coachPassword !== COACH_PASSWORD) return { ok: false, error: 'Wrong coach password.' };
  const athlete = String(req.athlete || '').trim().slice(0, 60);
  if (!athlete) return { ok: false, error: 'Missing athlete name.' };
  const g = req.goals;
  if (!g || typeof g !== 'object' || typeof g.times !== 'object') return { ok: false, error: 'Missing goal times.' };
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.date) ? req.date : new Date().toISOString().slice(0, 10);
  const goals = {
    sex: g.sex === 'boys' || g.sex === 'girls' ? g.sex : '',
    age: String(g.age || '15-16').slice(0, 5),
    factor: typeof g.factor === 'number' && isFinite(g.factor) ? g.factor : null,
    course: 'SCY',
    suitPct: typeof g.suitPct === 'number' && g.suitPct >= 0 && g.suitPct <= 5 ? g.suitPct : undefined,
    times: {},
    updatedAt: new Date().toISOString(),
    setBy: 'coach',
  };
  Object.keys(g.times).slice(0, 40).forEach((k) => {
    const t = g.times[k] || {};
    const out = {};
    if (typeof t.best === 'number' && t.best > 0) out.best = t.best;
    if (typeof t.goal === 'number' && t.goal > 0) out.goal = t.goal;
    if (Object.keys(out).length && /^[a-z]+-\d+$/.test(k)) goals.times[k] = out;
  });

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = entriesSheet_();
    const last = sh.getLastRow();
    const keys = last > 1 ? sh.getRange(2, COL.Date, last - 1, 2).getValues() : [];
    let at = 0;
    keys.forEach(([d, name], i) => { if (String(name).toLowerCase() === athlete.toLowerCase() && String(d) === date) at = i + 2; });
    if (at) {
      const entry = parseJson_(sh.getRange(at, COL.Data).getValue()) || { date: date };
      entry.goals = goals;
      sh.getRange(at, 1).setValue(new Date());
      sh.getRange(at, COL.Data).setValue(JSON.stringify(entry));
    } else {
      sh.getRange(sh.getLastRow() + 1, 1, 1, HEADERS.length).setValues([toRow_(athlete, { date: date, goals: goals }, {})]);
    }
  } finally {
    lock.releaseLock();
  }
  return { ok: true, goals: goals };
}

function dashboard_(req) {
  if (req.coachPassword !== COACH_PASSWORD) return { ok: false, error: 'Wrong coach password.' };
  const days = Math.min(Math.max(Number(req.days) || 90, 7), 400);
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const sh = entriesSheet_();
  const last = sh.getLastRow();
  if (last < 2) return { ok: true, rows: [] };
  const values = sh.getRange(2, 1, last - 1, HEADERS.length).getValues();
  const rows = [];
  for (const v of values) {
    const date = String(v[COL.Date - 1]);
    if (date < since) continue;
    let entry;
    try { entry = JSON.parse(v[COL.Data - 1]); } catch (err) { continue; }
    rows.push({ athlete: String(v[COL.Athlete - 1]).replace(/^'/, ''), date, entry });
  }
  return { ok: true, rows };
}
