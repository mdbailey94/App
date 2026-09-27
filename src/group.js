// Coach-side analysis of the group's rows from the sheet. Pure functions.

import { assessDay, sessionLoad, wellnessScore } from './readiness.js';

// rows: [{ athlete, date, entry }] → Map(key → { name, entries[] }).
// Names match case-insensitively; the most recent spelling is displayed.
export function groupByAthlete(rows) {
  const map = new Map();
  for (const row of [...rows].sort((a, b) => a.date.localeCompare(b.date))) {
    const name = String(row.athlete || '').trim();
    if (!name || !row.entry) continue;
    const key = name.toLowerCase();
    const a = map.get(key) || { key, name, entries: [] };
    a.name = name;
    a.entries = a.entries.filter((e) => e.date !== row.date).concat({ ...row.entry, date: row.date });
    map.set(key, a);
  }
  for (const a of map.values()) a.entries.sort((x, y) => x.date.localeCompare(y.date));
  return map;
}

// Lower rank = needs attention sooner.
const RANK = { critical: 0, serious: 1, warning: 2, good: 3 };

// The group on `date`: who checked in (worst first) and who didn't.
// Athletes count as "in the group" if they sent anything in the last `activeDays`.
export function groupDay(rows, date, { activeDays = 21 } = {}) {
  const since = new Date(`${date}T12:00:00Z`);
  since.setUTCDate(since.getUTCDate() - activeDays);
  const sinceISO = since.toISOString().slice(0, 10);

  const checkedIn = [];
  const missing = [];
  for (const a of groupByAthlete(rows).values()) {
    const upTo = a.entries.filter((e) => e.date <= date);
    const today = upTo.find((e) => e.date === date);
    const lastSeen = upTo.at(-1)?.date;
    if (!today) {
      if (lastSeen && lastSeen >= sinceISO) missing.push({ key: a.key, name: a.name, lastSeen });
      continue;
    }
    const assessment = assessDay(upTo, date);
    checkedIn.push({
      key: a.key,
      name: a.name,
      entry: today,
      assessment,
      wellness: wellnessScore(today.wellness),
      load: sessionLoad(today.training),
    });
  }
  checkedIn.sort((x, y) => {
    const rx = RANK[x.assessment.status?.level] ?? 4;
    const ry = RANK[y.assessment.status?.level] ?? 4;
    return rx - ry || (x.assessment.score ?? 101) - (y.assessment.score ?? 101) || x.name.localeCompare(y.name);
  });
  missing.sort((x, y) => x.name.localeCompare(y.name));

  const scores = checkedIn.map((c) => c.assessment.score).filter(Number.isFinite);
  return {
    date,
    checkedIn,
    missing,
    total: checkedIn.length + missing.length,
    needAttention: checkedIn.filter((c) => c.assessment.status && c.assessment.status.level !== 'good').length,
    avgReadiness: scores.length ? Math.round(scores.reduce((s, v) => s + v, 0) / scores.length) : null,
  };
}
