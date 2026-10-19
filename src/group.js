// Coach-side analysis of the group's rows from the sheet. Pure functions.

import { assessDay, daysBetween, PRACTICE_KEYS, withWorkouts, sessionLoad, sessionRpe, shiftDate, wellnessScore, workload } from './readiness.js';

// A check-in has answers. An entry can also hold training only: a Monday
// answer about Saturday, filed under Sunday. That counts for training, not
// as a check-in.
const isCheckIn = (e) => Boolean(e.wellness);

// A team average of readiness or load for a past day (charts, the team's
// "usual", yesterday, a week ago) counts only when at least this many
// swimmers gave one: a handful of check-ins on a quiet day would swing it.
export const MIN_TEAM = 6;
const teamAvg = (day) => (day.scored >= MIN_TEAM ? day.avgReadiness : null);

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
  // Logged workouts are filed under the next morning, like check-in reports.
  for (const a of map.values()) a.entries = withWorkouts(a.entries.sort((x, y) => x.date.localeCompare(y.date)));
  return map;
}

// Lower rank = needs attention sooner.
const RANK = { critical: 0, serious: 1, warning: 2, good: 3 };

// The group on `date`: who checked in (worst first) and who didn't.
// Athletes count as "in the group" if they sent anything in the last `activeDays`.
// Each check-in also gets how readiness moved: vsPrev (since their previous
// check-in, normally yesterday; Saturday on a Monday) and vsUsual (against
// their average over the 7 days before; needs 3 check-ins). The team: the
// average readiness yesterday and over the 7 days before.
export function groupDay(rows, date, opts) {
  const athletes = groupByAthlete(rows);
  const day = dayOf(athletes, date, opts);
  for (const c of day.checkedIn) Object.assign(c, readinessMove(athletes.get(c.key).entries, date, c.assessment.score));
  const prevDays = Array.from({ length: 7 }, (_, i) => shiftDate(date, -(i + 1)));
  const daily = prevDays.map((d) => teamAvg(dayOf(athletes, d))).filter((v) => v !== null);
  day.readinessYesterday = teamAvg(dayOf(athletes, prevDays[0]));
  day.readiness7 = daily.length ? Math.round(avg(daily)) : null;
  return day;
}

function readinessMove(entries, date, score) {
  const upTo = entries.filter((e) => e.date <= date);
  const prev = upTo.filter((e) => e.date < date && isCheckIn(e)).at(-1);
  const before = upTo.filter((e) => e.date >= shiftDate(date, -7) && e.date < date && isCheckIn(e))
    .map((e) => scoreOn(upTo, e.date)).filter(Number.isFinite);
  const prevScore = prev ? scoreOn(upTo, prev.date) : null;
  const usualScore = before.length >= 3 ? Math.round(avg(before)) : null;
  const ok = (v) => Number.isFinite(score) && Number.isFinite(v);
  return {
    prevDate: prev?.date ?? null,
    prevScore,
    usualScore,
    vsPrev: ok(prevScore) ? score - prevScore : null,
    vsUsual: ok(usualScore) ? score - usualScore : null,
  };
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
    scored: scores.length,
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
    // The day before's work as the team reported it this morning, rest days
    // (0) included, so it sits fairly next to the morning's readiness.
    const reported = day.checkedIn.filter((c) => c.entry.training).map((c) => c.load);
    // How far the team is from its own usual: each swimmer's readiness minus
    // their usual (their average over the 7 days before), averaged. Unlike
    // the plain average, this doesn't move just because different swimmers
    // checked in.
    const moves = day.checkedIn
      .map((c) => readinessMove(athletes.get(c.key).entries, date, c.assessment.score).vsUsual)
      .filter((v) => v !== null);
    // Average effort per practice, over those who went (training is reported
    // the next morning, so this is the previous day's sessions; a Monday
    // answer about Saturday counts too), and how many lifted or raced.
    const trainings = [...athletes.values()].map((a) => a.entries.find((e) => e.date === date)?.training).filter(Boolean);
    const effort = Object.fromEntries(PRACTICE_KEYS.map((k) => {
      const vals = trainings.map((t) => sessionRpe(t, k)).filter((v) => v > 0);
      return [k, vals.length ? +avg(vals).toFixed(1) : null];
    }));
    // And how well it went (1–10), logged on the Workouts tab.
    const went = Object.fromEntries(PRACTICE_KEYS.map((k) => {
      const vals = trainings.map((t) => t[k]?.perf).filter((v) => v > 0);
      return [k, vals.length ? +avg(vals).toFixed(1) : null];
    }));
    out.push({
      rpeAm: effort.am,
      rpePm: effort.pm,
      perfAm: went.am,
      perfPm: went.pm,
      weights: trainings.filter((t) => t.weights === true).length,
      meet: trainings.filter((t) => t.meet === true).length,
      date,
      avgReadiness: teamAvg(day),
      checkedIn: day.checkedIn.length,
      total: day.total,
      rate: day.total ? Math.round((day.checkedIn.length / day.total) * 100) : null,
      avgLoad: loads.length >= MIN_TEAM ? Math.round(avg(loads)) : 0,
      loadReported: reported.length >= MIN_TEAM ? Math.round(avg(reported)) : null,
      vsUsual: moves.length >= MIN_TEAM ? +avg(moves).toFixed(1) : null,
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
    perfAm: oneDp('perfAm'),
    perfPm: oneDp('perfPm'),
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
    // Off sick (Workouts tab): practices missed for illness in the last 3
    // days, whether or not they checked in. Training is filed under the next
    // morning, so today's log sits on tomorrow's entry.
    const sickDays = a.entries
      .filter((e) => e.date > shiftDate(date, -2) && e.date <= shiftDate(date, 1)
        && PRACTICE_KEYS.some((k) => e.training?.[`${k}None`] === 'sick'))
      .map((e) => shiftDate(e.date, -1))
      .reverse(); // most recent first
    const sick = sickDays.length ? {
      level: 'serious',
      text: `Missed practice sick: ${sickDays.map((d) => (d === date ? 'today' : d === shiftDate(date, -1) ? 'yesterday' : `${daysBetween(d, date)} days ago`)).join(', ')}.`,
    } : null;
    if (!week.length) {
      if (sick) list.push({ key: a.key, name: a.name, reasons: [sick], lastCheckIn: upTo.filter(isCheckIn).at(-1)?.date ?? null });
      continue;
    }
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

    if (sick) reasons.push(sick);

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

const pctChange = (now, base) => (now !== null && base > 0 ? Math.round(((now - base) / base) * 100) : null);
const trainingOn = (a, d) => a.entries.find((e) => e.date === d)?.training ?? null;
// The same weekday in each of the `weeks` weeks before `date`.
const sameWeekdays = (date, weeks = 4) => Array.from({ length: weeks }, (_, i) => shiftDate(date, -7 * (i + 1)));

// The team's training reported on one day: how many swam each practice, their
// average time and effort, how many lifted and raced, and the average load
// (for a past day, only with MIN_TEAM reports).
function teamTraining(athletes, d, { past = false } = {}) {
  const trainings = [...athletes.values()].map((a) => trainingOn(a, d)).filter(Boolean);
  const split = trainings.filter(isSplitTraining);
  const practice = (k) => {
    const went = split.map((t) => t[k]).filter((p) => p?.durationMin > 0);
    const perfs = went.map((p) => p.perf).filter((v) => v > 0);
    return {
      count: went.length,
      avgMin: went.length ? Math.round(avg(went.map((p) => p.durationMin))) : null,
      avgRpe: went.length ? round1(avg(went.map((p) => p.rpe))) : null,
      avgPerf: perfs.length ? round1(avg(perfs)) : null, // how well it went, 1–10 (logged on the Workouts tab)
    };
  };
  // Swimmers who said why they missed a practice (Workouts tab).
  const skipped = (reason) => split.filter((t) => PRACTICE_KEYS.some((k) => t[`${k}None`] === reason)).length;
  const loads = trainings.map(sessionLoad);
  return {
    reported: trainings.length,
    am: practice('am'),
    pm: practice('pm'),
    weights: split.filter((t) => t.weights).length,
    meet: split.filter((t) => t.meet).length,
    sick: skipped('sick'),
    missed: skipped('missed'),
    avgLoad: loads.length >= (past ? MIN_TEAM : 1) ? Math.round(avg(loads)) : null,
  };
}

// The usual over several days: each number averaged over the days that had it.
function usualOf(days) {
  const got = days.filter((d) => d.reported > 0);
  if (got.length < 2) return null;
  const mean = (f, digits = 1) => {
    const vals = got.map(f).filter((v) => v !== null && v !== undefined);
    return vals.length ? +avg(vals).toFixed(digits) : null;
  };
  const practice = (k) => ({
    count: mean((d) => d[k].count), avgMin: mean((d) => d[k].avgMin, 0), avgRpe: mean((d) => d[k].avgRpe), avgPerf: mean((d) => d[k].avgPerf),
  });
  return {
    days: got.length,
    reported: mean((d) => d.reported),
    am: practice('am'),
    pm: practice('pm'),
    weights: mean((d) => d.weights),
    meet: mean((d) => d.meet),
    sick: mean((d) => d.sick),
    missed: mean((d) => d.missed),
    avgLoad: mean((d) => d.avgLoad, 0),
  };
}

// Training reported on `date` (so done the day before), against the same day
// a week earlier (Monday to Monday) and the usual for that weekday: the
// average of the same weekday over the 4 weeks before (needs 2).
// team: { now, weekAgo, usual } as teamTraining (usual may be null).
// swimmers: everyone who reported training on `date`, with load, weekAgoLoad,
// usualLoad, and the % changes vsWeekAgo, vsUsual.
export function trainingCompare(rows, date) {
  const athletes = groupByAthlete(rows);
  const weeks = sameWeekdays(date);
  const swimmers = [];
  for (const a of athletes.values()) {
    const training = trainingOn(a, date);
    if (!training) continue;
    const load = sessionLoad(training);
    const past = weeks.map((d) => trainingOn(a, d)).map((t) => (t ? sessionLoad(t) : null));
    const weekAgoLoad = past[0];
    const reported = past.filter((v) => v !== null);
    const usualLoad = reported.length >= 2 ? Math.round(avg(reported)) : null;
    swimmers.push({
      key: a.key,
      name: a.name,
      training,
      load,
      weekAgoLoad,
      usualLoad,
      vsWeekAgo: pctChange(load, weekAgoLoad),
      vsUsual: pctChange(load, usualLoad),
    });
  }
  swimmers.sort((x, y) => y.load - x.load || x.name.localeCompare(y.name));
  return {
    date,
    trainedOn: shiftDate(date, -1),
    weekAgo: weeks[0],
    team: {
      now: teamTraining(athletes, date),
      weekAgo: teamTraining(athletes, weeks[0], { past: true }),
      usual: usualOf(weeks.map((d) => teamTraining(athletes, d, { past: true }))),
    },
    swimmers,
  };
}

// Does training show up in the next morning's readiness? Over the last `days`
// days, pair each check-in's reported training load with how that swimmer's
// readiness changed from their previous check-in, then group the pairs into
// light / moderate / heavy thirds two ways:
//   absolute: by the load itself, the same cut-offs for everyone;
//   relative: by the load against that swimmer's own usual (their average
//     reported load over the 28 days up to `date`; needs 5 reports), so a
//     heavy day is heavy for them.
// An association, not proof: other things (sleep, school, meets) move
// readiness too. Each needs `minPairs` pairs.
// `only`: one athlete's key, for their own pattern.
export function loadResponse(rows, date, { days = 28, minPairs = 15, only } = {}) {
  const from = shiftDate(date, -(days - 1));
  const usualFrom = shiftDate(date, -27);
  const pairs = [];
  for (const a of groupByAthlete(rows).values()) {
    if (only && a.key !== only) continue;
    const loads = a.entries.filter((e) => e.training && e.date >= usualFrom && e.date <= date).map((e) => sessionLoad(e.training));
    const usual = loads.length >= 5 && avg(loads) > 0 ? avg(loads) : null;
    const checkIns = a.entries.filter(isCheckIn);
    for (let i = 1; i < checkIns.length; i++) {
      const e = checkIns[i];
      if (e.date < from || e.date > date || !e.training) continue;
      const now = scoreOn(a.entries, e.date);
      const prev = scoreOn(a.entries, checkIns[i - 1].date);
      if (!Number.isFinite(now) || !Number.isFinite(prev)) continue;
      const load = sessionLoad(e.training);
      pairs.push({ load, ratio: usual ? Math.round((load / usual) * 100) : null, change: now - prev });
    }
  }
  return {
    days,
    absolute: thirds(pairs, 'load', minPairs),
    relative: thirds(pairs.filter((p) => p.ratio !== null), 'ratio', minPairs),
  };
}

// Equal thirds by `key` (by rank, so days with the same load can't empty a
// group), each with its size, average readiness change and range of `key`.
function thirds(pairs, key, minPairs) {
  if (pairs.length < minPairs) return { enough: false, pairs: pairs.length, needed: minPairs };
  const sorted = [...pairs].sort((x, y) => x[key] - y[key]);
  const third = Math.round(sorted.length / 3);
  const bucket = (b) => ({ n: b.length, change: round1(avg(b.map((p) => p.change))), range: [b[0][key], b.at(-1)[key]] });
  return {
    enough: true,
    pairs: sorted.length,
    light: bucket(sorted.slice(0, third)),
    moderate: bucket(sorted.slice(third, sorted.length - third)),
    heavy: bucket(sorted.slice(sorted.length - third)),
  };
}

// One swimmer, for the coach's page about them, as of their latest
// check-in: readiness against yesterday and their usual, the training they
// reported that morning against the same day a week earlier and their usual
// for that weekday, anything that puts them on the watch list, and how their
// readiness has moved after their own light, moderate and heavy days (needs 9).
export function swimmerInsights(rows, key, { days = 28 } = {}) {
  const a = groupByAthlete(rows).get(key);
  const last = a?.entries.filter(isCheckIn).at(-1);
  if (!last) return null;
  const date = last.date;
  const me = (list) => list.find((x) => x.key === key) ?? null;
  return {
    date,
    readiness: me(groupDay(rows, date).checkedIn),
    training: me(trainingCompare(rows, date).swimmers),
    watch: me(watchList(rows, date))?.reasons ?? [],
    response: loadResponse(rows, date, { days, minPairs: 9, only: key }).absolute,
  };
}
