// All data stays on the device, in localStorage. One entry per calendar day.

const ENTRIES_KEY = 'athlete-readiness/entries/v1';
const SETTINGS_KEY = 'athlete-readiness/settings/v1';

const DEFAULT_SETTINGS = { durationSec: 60, posture: 'lying' };

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

export function todayISO() {
  // en-CA formats as YYYY-MM-DD in the device's local time zone.
  return new Date().toLocaleDateString('en-CA');
}

export function loadEntries() {
  return read(ENTRIES_KEY, []).sort((a, b) => a.date.localeCompare(b.date));
}

export function getEntry(date) {
  return loadEntries().find((e) => e.date === date) || null;
}

// Merge `patch` into the entry for `date`, creating it if needed.
export function upsertEntry(date, patch) {
  const entries = loadEntries();
  const i = entries.findIndex((e) => e.date === date);
  const now = new Date().toISOString();
  if (i >= 0) entries[i] = { ...entries[i], ...patch, updatedAt: now };
  else entries.push({ date, createdAt: now, updatedAt: now, ...patch });
  write(ENTRIES_KEY, entries);
  return entries;
}

export function deleteEntry(date) {
  write(ENTRIES_KEY, loadEntries().filter((e) => e.date !== date));
}

export function clearAll() {
  localStorage.removeItem(ENTRIES_KEY);
}

export function loadSettings() {
  return { ...DEFAULT_SETTINGS, ...read(SETTINGS_KEY, {}) };
}

export function saveSettings(patch) {
  write(SETTINGS_KEY, { ...loadSettings(), ...patch });
}

export function exportJSON() {
  return JSON.stringify({ app: 'athlete-readiness', version: 1, entries: loadEntries() }, null, 2);
}

// Replace or merge entries from a previous export. Returns the count imported.
export function importJSON(text) {
  const data = JSON.parse(text);
  const incoming = Array.isArray(data) ? data : data.entries;
  if (!Array.isArray(incoming)) throw new Error('No entries found in file.');
  const byDate = new Map(loadEntries().map((e) => [e.date, e]));
  let n = 0;
  for (const e of incoming) {
    if (typeof e?.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(e.date)) continue;
    byDate.set(e.date, e);
    n++;
  }
  write(ENTRIES_KEY, [...byDate.values()]);
  return n;
}

const CSV_COLUMNS = [
  ['date', (e) => e.date],
  ['sleep_hours', (e) => e.wellness?.sleepHours],
  ['sleep_quality', (e) => e.wellness?.sleepQuality],
  ['energy', (e) => e.wellness?.energy],
  ['soreness', (e) => e.wellness?.soreness],
  ['stress', (e) => e.wellness?.stress],
  ['mood', (e) => e.wellness?.mood],
  ['motivation', (e) => e.wellness?.motivation],
  ['injury_level', (e) => e.pain?.level],
  ['injury_location', (e) => e.pain?.location],
  ['training_min', (e) => e.training?.durationMin],
  ['session_rpe', (e) => e.training?.rpe],
  ['hr_bpm', (e) => e.hrv?.hr?.toFixed(1)],
  ['rmssd_ms', (e) => e.hrv?.rmssd?.toFixed(1)],
  ['ln_rmssd', (e) => e.hrv?.lnRmssd?.toFixed(3)],
  ['sdnn_ms', (e) => e.hrv?.sdnn?.toFixed(1)],
  ['pnn50_pct', (e) => e.hrv?.pnn50?.toFixed(1)],
  ['hrv_quality', (e) => e.hrv?.quality],
  ['hrv_posture', (e) => e.hrv?.posture],
  ['hrv_source', (e) => e.hrv?.source],
  ['notes', (e) => e.notes],
];

export function exportCSV() {
  const esc = (v) => {
    if (v === undefined || v === null || Number.isNaN(v)) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = [CSV_COLUMNS.map(([h]) => h).join(',')];
  for (const e of loadEntries()) rows.push(CSV_COLUMNS.map(([, f]) => esc(f(e))).join(','));
  return rows.join('\n');
}

// ------------------------------------------------------------ group sharing

const TEAM_KEY = 'athlete-readiness/team/v1';
const COACH_KEY = 'athlete-readiness/coach/v1';

// Athlete side: { url, group, athlete, lastSync, lastError }
export function loadTeam() {
  return read(TEAM_KEY, null);
}

export function saveTeam(team) {
  if (team) write(TEAM_KEY, team);
  else localStorage.removeItem(TEAM_KEY);
}

// Coach side: { url, password, group }
export function loadCoach() {
  return read(COACH_KEY, null);
}

export function saveCoach(coach) {
  if (coach) write(COACH_KEY, coach);
  else localStorage.removeItem(COACH_KEY);
}

// Record that these dates reached the sheet. An entry edited after `stamp`
// stays pending so the newer version is sent too.
export function markSynced(dates, stamp) {
  const set = new Set(dates);
  write(ENTRIES_KEY, loadEntries().map((e) => (
    set.has(e.date) && (!e.updatedAt || e.updatedAt <= stamp) ? { ...e, syncedAt: stamp } : e
  )));
}

// Mark everything as unsent, e.g. after joining a (new) group.
export function resetSync() {
  write(ENTRIES_KEY, loadEntries().map(({ syncedAt, ...e }) => e));
}
