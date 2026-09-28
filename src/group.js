// Coach-side analysis of the group's rows from the sheet. Pure functions.

import { assessDay, daysBetween, sessionLoad, shiftDate, wellnessScore, workload } from './readiness.js';

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
export function groupDay(rows, date, opts) {
  return dayOf(groupByAthlete(rows), date, opts);
}

function dayOf(athletes, date, { activeDays = 21 } = {}) {
  const sinceISO = shiftDate(date, -activeDays);

  const checkedIn = [];
  const missing = [];
  for (const a of athletes.values()) {
    const upTo = a.entries.filter((e) => e.date <= date);
    const today = upTo.find((e) => e.date === date);
    const lastSeen = upTo.at(-1)?.date;
    if (!today) {
      // missedDays: days in a row without a check-in, up to and including `date`.
      if (lastSeen && lastSeen >= sinceISO) missing.push({ key: a.key, name: a.name, lastSeen, missedDays: daysBetween(lastSeen, date) });
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

const avg = (vals) => (vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null);

// One point per day for the last `days` days up to `endDate`: average
// readiness of those who checked in, check-in rate, and average load.
export function teamTrend(rows, endDate, days = 7) {
  const athletes = groupByAthlete(rows);
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = shiftDate(endDate, -i);
    const day = dayOf(athletes, date);
    const loads = day.checkedIn.map((c) => c.load).filter((v) => v > 0);
    out.push({
      date,
      avgReadiness: day.avgReadiness,
      checkedIn: day.checkedIn.length,
      total: day.total,
      rate: day.total ? Math.round((day.checkedIn.length / day.total) * 100) : null,
      avgLoad: loads.length ? Math.round(avg(loads)) : 0,
    });
  }
  return out;
}

// Summary of a trend: averages over its days (ignoring days with no data).
export function trendSummary(trend) {
  const pick = (k) => trend.map((d) => d[k]).filter(Number.isFinite);
  const r = avg(pick('avgReadiness'));
  const rate = avg(pick('rate'));
  const load = avg(pick('avgLoad').filter((v) => v > 0));
  return {
    avgReadiness: r === null ? null : Math.round(r),
    rate: rate === null ? null : Math.round(rate),
    avgLoad: load === null ? null : Math.round(load),
  };
}

const WATCH_RANK = { critical: 0, serious: 1, warning: 2, note: 3 };

// Swimmers worth a conversation, looking at the last week rather than one
// day: injuries, a run of low days, readiness down on their usual, load
// spikes, and short sleep. Only athletes who checked in within the week
// (the rest are on the reminder list). Most urgent first.
export function watchList(rows, date) {
  const weekAgo = shiftDate(date, -6);
  const list = [];
  for (const a of groupByAthlete(rows).values()) {
    const upTo = a.entries.filter((e) => e.date <= date);
    const week = upTo.filter((e) => e.date >= weekAgo);
    if (!week.length) continue;
    const latest = week.at(-1);
    const ago = daysBetween(latest.date, date);
    const when = ago === 0 ? 'today' : ago === 1 ? 'yesterday' : `${ago} days ago`;
    const score = (e) => assessDay(upTo, e.date).score;
    const reasons = [];

    // Injury: the most recent answer counts, if it's from the last 3 days.
    const pain = latest.pain || {};
    const where = pain.location ? ` (${pain.location})` : '';
    if (latest.date >= shiftDate(date, -2) && pain.level >= 2) {
      reasons.push({
        level: pain.level >= 3 ? 'critical' : 'serious',
        text: `${pain.level >= 3 ? 'Injury stopping certain strokes or movements' : 'Injury affecting stroke'}${where}, reported ${when}.`,
      });
    } else if (pain.level === 1) {
      const run = countRun(upTo, (e) => e.pain?.level === 1);
      if (run >= 3) reasons.push({ level: 'note', text: `Minor injury reported ${run} check-ins in a row${where}.` });
    }

    // A run of below-"Ready" days (their most recent check-ins).
    const lowRun = countRun(week, (e) => { const s = score(e); return Number.isFinite(s) && s < 70; });
    if (lowRun >= 3) {
      reasons.push({ level: 'warning', text: `Readiness below 70 on their last ${lowRun} check-ins.` });
    } else {
      // Otherwise: this week's readiness well down on their previous three weeks.
      const recent = week.map(score).filter(Number.isFinite);
      const before = upTo.filter((e) => e.date < weekAgo && e.date >= shiftDate(date, -27)).map(score).filter(Number.isFinite);
      const drop = recent.length >= 3 && before.length >= 5 ? avg(before) - avg(recent) : 0;
      if (drop >= 10) reasons.push({ level: 'warning', text: `Readiness down ${Math.round(drop)} points on their usual this week.` });
    }

    const acwr = workload(upTo, date).acwr;
    if (acwr !== null && acwr > 1.5) reasons.push({ level: 'warning', text: `Training load spike: this week is ${acwr.toFixed(1)}× their 4-week average.` });

    const sleeps = week.slice(-4).map((e) => e.wellness?.sleepHours).filter((h) => h > 0);
    const short = sleeps.filter((h) => h < 7);
    if (short.length >= 3) {
      reasons.push({ level: 'note', text: `Under 7 h sleep on ${short.length} of their last ${sleeps.length} nights (average ${avg(sleeps).toFixed(1)} h).` });
    }

    if (reasons.length) {
      reasons.sort((x, y) => WATCH_RANK[x.level] - WATCH_RANK[y.level]);
      list.push({ key: a.key, name: a.name, reasons, lastCheckIn: latest.date });
    }
  }
  return list.sort((x, y) => WATCH_RANK[x.reasons[0].level] - WATCH_RANK[y.reasons[0].level]
    || y.reasons.length - x.reasons.length || x.name.localeCompare(y.name));
}

// How many of the most recent entries in a row match `test`.
function countRun(entries, test) {
  let n = 0;
  for (let i = entries.length - 1; i >= 0 && test(entries[i]); i--) n++;
  return n;
}

// Ready-to-send reminder for the group chat.
export function reminderText(missing, appUrl) {
  const names = missing.map((m) => m.name);
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
  return `Morning check-in reminder 🏊 Still waiting on ${list}. It takes about a minute: ${appUrl}`;
}
