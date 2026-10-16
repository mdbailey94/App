// Coach-side analysis of the group's rows from the sheet. Pure functions.

import { assessDay, daysBetween, PRACTICE_KEYS, sessionLoad, sessionRpe, shiftDate, wellnessScore, workload } from './readiness.js';

// A check-in has answers. An entry can also hold training only: a Monday
// answer about Saturday, filed under Sunday. That counts for training, not
// as a check-in.
const isCheckIn = (e) => Boolean(e.wellness);

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
    const today = upTo.find((e) => e.date === date && isCheckIn(e));
    const lastSeen = upTo.filter(isCheckIn).at(-1)?.date;
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
    // Average effort per practice, over those who went (training is reported
    // the next morning, so this is the previous day's sessions; a Monday
    // answer about Saturday counts too), and how many lifted or raced.
    const trainings = [...athletes.values()].map((a) => a.entries.find((e) => e.date === date)?.training).filter(Boolean);
    const effort = Object.fromEntries(PRACTICE_KEYS.map((k) => {
      const vals = trainings.map((t) => sessionRpe(t, k)).filter((v) => v > 0);
      return [k, vals.length ? +avg(vals).toFixed(1) : null];
    }));
    out.push({
      rpeAm: effort.am,
      rpePm: effort.pm,
      weights: trainings.filter((t) => t.weights === true).length,
      meet: trainings.filter((t) => t.meet === true).length,
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
  const oneDp = (k) => { const v = avg(pick(k)); return v === null ? null : +v.toFixed(1); };
  return {
    avgReadiness: r === null ? null : Math.round(r),
    rate: rate === null ? null : Math.round(rate),
    avgLoad: load === null ? null : Math.round(load),
    rpeAm: oneDp('rpeAm'),
    rpePm: oneDp('rpePm'),
    weights: trend.reduce((n, d) => n + (d.weights || 0), 0),
    meet: trend.reduce((n, d) => n + (d.meet || 0), 0),
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
    const week = upTo.filter((e) => e.date >= weekAgo && isCheckIn(e));
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

// Who checked in on each of the last `days` days up to `date`: one row per
// athlete active in that window, alphabetical, with a cell per day.
// cell: null (no check-in) or { status, injury } from that day's check-in.
export function checkinGrid(rows, date, days = 14) {
  const dates = Array.from({ length: days }, (_, i) => shiftDate(date, i - days + 1));
  const athletes = [...groupByAthlete(rows).values()]
    .filter((a) => a.entries.some((e) => e.date >= dates[0] && e.date <= date))
    .sort((x, y) => x.name.localeCompare(y.name));
  return {
    dates,
    rows: athletes.map((a) => {
      const byDate = new Map(a.entries.filter(isCheckIn).map((e) => [e.date, e]));
      const cells = dates.map((d) => {
        const e = byDate.get(d);
        if (!e) return null;
        return { status: assessDay(a.entries, d).status?.level ?? null, injury: e.pain?.level >= 2 };
      });
      return { key: a.key, name: a.name, cells, count: cells.filter(Boolean).length };
    }),
  };
}

// What athletes have told the coach in the last `days` days: their notes and
// any injury they reported. Newest first.
export function recentNotes(rows, date, days = 14) {
  const from = shiftDate(date, -(days - 1));
  const out = [];
  for (const a of groupByAthlete(rows).values()) {
    for (const e of a.entries) {
      if (e.date < from || e.date > date) continue;
      const note = String(e.notes || '').trim();
      const injury = e.pain?.level > 0 ? { level: e.pain.level, location: e.pain.location || '' } : null;
      if (note || injury) out.push({ key: a.key, name: a.name, date: e.date, note, injury });
    }
  }
  return out.sort((x, y) => y.date.localeCompare(x.date) || x.name.localeCompare(y.name));
}

// Every athlete seen in the last `activeDays` days, with a short summary.
export function roster(rows, date, { activeDays = 21 } = {}) {
  const from = shiftDate(date, -activeDays);
  const weekAgo = shiftDate(date, -6);
  return [...groupByAthlete(rows).values()]
    .map((a) => {
      const upTo = a.entries.filter((e) => e.date <= date);
      const last = upTo.filter(isCheckIn).at(-1);
      if (!last || last.date < from) return null;
      const week = upTo.filter((e) => e.date >= weekAgo && isCheckIn(e));
      const scores = week.map((e) => assessDay(upTo, e.date).score).filter(Number.isFinite);
      return {
        key: a.key,
        name: a.name,
        lastDate: last.date,
        status: assessDay(upTo, last.date).status,
        checkins7: week.length,
        avg7: scores.length ? Math.round(avg(scores)) : null,
      };
    })
    .filter(Boolean)
    .sort((x, y) => x.name.localeCompare(y.name));
}

// ---- the day before: training, and readiness on the morning after

const isSplitTraining = (t) => Boolean(t) && ('am' in t || 'pm' in t);
const round1 = (v) => (v === null ? null : +v.toFixed(1));
const scoreOn = (entries, date) => assessDay(entries, date).score;

// Training reported on `date` (so done the day before) and how each swimmer's
// readiness moved. Per swimmer:
//   training, load, usualLoad (their average load reported over the 7 days
//   before), loadChange (% vs usual), score (readiness on `date`),
//   prevScore (their previous check-in), usualScore (average of their
//   check-ins in the 7 days before; needs 3), vsPrev, vsUsual.
// Team: how many swam each practice, average time and effort, weights and
// meet counts, average load against the 7 days before, and average readiness
// against yesterday and the 7 days before.
export function dayBefore(rows, date) {
  const athletes = groupByAthlete(rows);
  const weekFrom = shiftDate(date, -7);
  const swimmers = [];
  for (const a of athletes.values()) {
    const upTo = a.entries.filter((e) => e.date <= date);
    const today = upTo.find((e) => e.date === date);
    const before = upTo.filter((e) => e.date >= weekFrom && e.date < date);
    const loadsBefore = before.filter((e) => e.training).map((e) => sessionLoad(e.training));
    const scoresBefore = before.filter(isCheckIn).map((e) => scoreOn(upTo, e.date)).filter(Number.isFinite);
    const prev = upTo.filter((e) => e.date < date && isCheckIn(e)).at(-1);
    const score = today && isCheckIn(today) ? scoreOn(upTo, date) : null;
    const prevScore = prev ? scoreOn(upTo, prev.date) : null;
    const usualScore = scoresBefore.length >= 3 ? avg(scoresBefore) : null;
    const load = today?.training ? sessionLoad(today.training) : null;
    const usualLoad = loadsBefore.length >= 3 ? avg(loadsBefore) : null;
    if (!today && !before.length) continue; // not active this week
    swimmers.push({
      key: a.key,
      name: a.name,
      training: today?.training ?? null,
      load,
      usualLoad: usualLoad === null ? null : Math.round(usualLoad),
      loadChange: load !== null && usualLoad > 0 ? Math.round(((load - usualLoad) / usualLoad) * 100) : null,
      score,
      prevScore,
      usualScore: usualScore === null ? null : Math.round(usualScore),
      vsPrev: score !== null && prevScore !== null ? score - prevScore : null,
      vsUsual: score !== null && usualScore !== null ? Math.round(score - usualScore) : null,
    });
  }
  swimmers.sort((x, y) => x.name.localeCompare(y.name));

  const trainings = swimmers.map((s) => s.training).filter(isSplitTraining);
  const practice = (k) => {
    const went = trainings.map((t) => t[k]).filter((p) => p?.durationMin > 0);
    return {
      count: went.length,
      avgMin: went.length ? Math.round(avg(went.map((p) => p.durationMin))) : null,
      avgRpe: went.length ? round1(avg(went.map((p) => p.rpe))) : null,
    };
  };
  const loads = swimmers.map((s) => s.load).filter((v) => v !== null);
  // The team's average load on each of the 7 days before, then averaged.
  const prevDays = Array.from({ length: 7 }, (_, i) => shiftDate(date, -(i + 1)));
  const dailyLoad = prevDays.map((d) => {
    const vals = [...athletes.values()].map((a) => a.entries.find((e) => e.date === d)?.training).filter(Boolean).map(sessionLoad);
    return vals.length ? avg(vals) : null;
  }).filter((v) => v !== null);
  const teamScore = (d) => dayOf(athletes, d).avgReadiness;
  const dailyScore = prevDays.map(teamScore).filter((v) => v !== null);
  const avgLoad = loads.length ? Math.round(avg(loads)) : null;
  const avgLoad7 = dailyLoad.length ? Math.round(avg(dailyLoad)) : null;
  const team = {
    reported: loads.length,
    am: practice('am'),
    pm: practice('pm'),
    weights: trainings.filter((t) => t.weights).length,
    meet: trainings.filter((t) => t.meet).length,
    avgLoad,
    avgLoad7,
    loadChange: avgLoad !== null && avgLoad7 > 0 ? Math.round(((avgLoad - avgLoad7) / avgLoad7) * 100) : null,
    readiness: teamScore(date),
    readinessYesterday: teamScore(shiftDate(date, -1)),
    readiness7: dailyScore.length ? Math.round(avg(dailyScore)) : null,
  };
  return { date, trainedOn: shiftDate(date, -1), team, swimmers };
}

// Does training show up in the next morning's readiness? Over the last `days`
// days, pair each check-in's reported training load with how that swimmer's
// readiness changed from their previous check-in, then group the loads into
// light / moderate / heavy thirds. An association, not proof: other things
// (sleep, school, meets) move readiness too. Needs `minPairs` pairs.
export function loadResponse(rows, date, { days = 28, minPairs = 15 } = {}) {
  const from = shiftDate(date, -(days - 1));
  const pairs = [];
  for (const a of groupByAthlete(rows).values()) {
    const checkIns = a.entries.filter(isCheckIn);
    for (let i = 1; i < checkIns.length; i++) {
      const e = checkIns[i];
      if (e.date < from || e.date > date || !e.training) continue;
      const now = scoreOn(a.entries, e.date);
      const prev = scoreOn(a.entries, checkIns[i - 1].date);
      if (Number.isFinite(now) && Number.isFinite(prev)) pairs.push({ load: sessionLoad(e.training), change: now - prev });
    }
  }
  if (pairs.length < minPairs) return { enough: false, pairs: pairs.length, needed: minPairs };
  // Equal thirds by load (by rank, so days with the same load can't empty a group).
  pairs.sort((x, y) => x.load - y.load);
  const third = Math.round(pairs.length / 3);
  const bucket = (b) => ({
    n: b.length,
    change: round1(avg(b.map((p) => p.change))),
    loads: [b[0].load, b.at(-1).load],
  });
  return {
    enough: true,
    pairs: pairs.length,
    light: bucket(pairs.slice(0, third)),
    moderate: bucket(pairs.slice(third, pairs.length - third)),
    heavy: bucket(pairs.slice(pairs.length - third)),
  };
}
