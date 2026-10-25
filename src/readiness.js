// Turns questionnaire answers + HRV into a daily readiness picture.
// Pure functions only, so they can be unit tested in Node.

import { mean, std } from './signal.js';

// Questionnaire definition. Every 1–7 scale is phrased so that 7 is best,
// which keeps scoring simple and the form consistent for the athlete.
export const SCALE_MAX = 7;
export const WELLNESS_ITEMS = [
  { key: 'sleepQuality', label: 'Sleep quality', low: 'Very poor', high: 'Excellent' },
  { key: 'energy', label: 'Energy', low: 'Low', high: 'High' },
  { key: 'soreness', label: 'Muscle soreness', low: 'Very sore', high: 'None' },
  { key: 'stress', label: 'Stressed or relaxed', low: 'Very stressed', high: 'Very relaxed' },
  { key: 'mood', label: 'Mood', low: 'Negative', high: 'Positive' },
  { key: 'motivation', label: 'Motivation', low: 'Low', high: 'High' },
];

// Check-ins saved before the switch to 1–7 have no scaleMax and used 1–5.
export const scaleMaxOf = (w) => w?.scaleMax || 5;

const clamp = (x, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, x));

// Yesterday's training, as asked since sessions were split:
//   { am: { durationMin, rpe } | null,   morning practice (null = none)
//     pm: { durationMin, rpe } | null,   doubles (afternoon practice)
//     weights: boolean, meet: boolean,   did they lift / race
//     meetLevel: 'light' | 'moderate' | 'hard'   (only with meet: true)
//     durationMin, rpe }                 totals: minutes, and the
//                                        time-weighted average effort
// A weights session isn't timed or rated: for load it counts as WEIGHTS
// (45 minutes at hard effort, 5 on the 1–10 scale). Meets aren't counted in
// load (yet); how hard one was is kept, and meets reported before that was
// asked count as moderate.
// Older check-ins have only { durationMin, rpe } for the whole day; before
// doubles were asked about (Oct 12) that was morning practice, so
// `withWorkouts` reads it as the AM practice.
export const PRACTICE_KEYS = ['am', 'pm'];
const isSplit = (t) => Boolean(t) && PRACTICE_KEYS.some((k) => k in t);
export const asMorning = (t) => (!t || isSplit(t) ? t
  : { ...t, am: t.durationMin > 0 ? { durationMin: t.durationMin, rpe: t.rpe } : null, pm: null });
const practiceLoad = (s) => (s?.durationMin > 0 && s.rpe >= 0 ? Math.round(s.durationMin * s.rpe) : 0);
export const WEIGHTS = { durationMin: 45, rpe: 5 };
export const MEET_LEVELS = { light: { label: 'Light' }, moderate: { label: 'Moderate' }, hard: { label: 'Hard' } };
export const meetLevel = (t) => (t?.meet ? (MEET_LEVELS[t.meetLevel] ? t.meetLevel : 'moderate') : null);

// Load = minutes × effort (session RPE), summed over the practices and weights.
export function sessionLoad(training) {
  if (!training) return 0;
  if (isSplit(training)) {
    return practiceLoad(training.am) + practiceLoad(training.pm) + (training.weights ? practiceLoad(WEIGHTS) : 0);
  }
  return practiceLoad(training);
}

// Build the stored training from the answers (null practice = didn't go).
export function trainingFrom({ am, pm, weights = false, meet = false, meetLevel: level }) {
  const t = { am: am || null, pm: pm || null, weights: Boolean(weights), meet: Boolean(meet) };
  if (t.meet) t.meetLevel = MEET_LEVELS[level] ? level : 'moderate';
  const practices = [t.am, t.pm, t.weights && WEIGHTS].filter((s) => s?.durationMin > 0);
  const durationMin = practices.reduce((n, s) => n + s.durationMin, 0);
  const rpe = durationMin ? Math.round(practices.reduce((n, s) => n + s.durationMin * s.rpe, 0) / durationMin) : 0;
  return { ...t, durationMin, rpe };
}

// Workouts the swimmer logs on the Workouts tab, stored on the day they
// trained (`entry.workouts`; a day can hold workouts without a check-in):
//   { am: Practice | Skipped, pm: Practice | Skipped,
//     weights: boolean, meet: boolean, meetLevel }
//   Practice = { durationMin, rpe, perf }   effort and "how well it went", 1–10
//   Skipped  = { none: 'off' | 'sick' | 'missed' | 'other', note }
// Before the Workouts tab, training was reported in the next morning's
// check-in (`entry.training` on the day after). The analysis still reads it
// there, so `withWorkouts` puts each logged day's training on the next
// morning; a logged workout wins over an older check-in report of that day.
export const SKIP_REASONS = { off: 'Off day', sick: 'Sick', missed: 'Missed', other: 'Other' };
const practiced = (p) => (p?.durationMin > 0 ? { durationMin: p.durationMin, rpe: p.rpe, perf: p.perf } : null);

export function trainingFromWorkouts(w) {
  const t = trainingFrom({ am: practiced(w.am), pm: practiced(w.pm), weights: w.weights, meet: w.meet, meetLevel: w.meetLevel });
  for (const k of PRACTICE_KEYS) if (w[k]?.none) t[`${k}None`] = w[k].none;
  return { ...t, logged: true, ...(w.assumed ? { assumed: true } : {}) };
}

// Sunday is the day off: a Sunday with nothing logged counts as an off day
// (`assumed`), until the swimmer logs something else for it.
export const isSunday = (date) => new Date(`${date}T12:00:00Z`).getUTCDay() === 0;
export const SUNDAY_OFF = { am: { none: 'off' }, pm: { none: null }, weights: false, meet: false, assumed: true };

// A save with nothing but the form's starting answers (doubles, weights and
// meet all No, morning practice skipped) says nothing about the day: it
// counts as not logged, so the swimmer is asked again.
export const hasWorkouts = (w) => Boolean(w) && ('am' in w || PRACTICE_KEYS.some((k) => w[k]?.durationMin > 0) || w.weights === true || w.meet === true);

// Never saved: for analysis only. Idempotent, so it is safe to apply twice.
export function withWorkouts(entries) {
  if (!entries.length) return entries;
  const byDate = new Map(entries.map((e) => [e.date, e.training && !isSplit(e.training) ? { ...e, training: asMorning(e.training) } : e]));
  for (const e of entries) {
    if (!hasWorkouts(e.workouts)) continue;
    const next = shiftDate(e.date, 1);
    byDate.set(next, { ...(byDate.get(next) || { date: next }), training: trainingFromWorkouts(e.workouts) });
  }
  // An unlogged Sunday is an off day, filed on the Monday after (when they
  // have a Monday entry).
  for (const [mon, e] of byDate) {
    const sun = shiftDate(mon, -1);
    if (isSunday(sun) && !e.training && !hasWorkouts(byDate.get(sun)?.workouts)) byDate.set(mon, { ...e, training: trainingFromWorkouts(SUNDAY_OFF) });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// Training done on `date`: what was logged that day, or (older reports) what
// the next morning's check-in said, or for a Sunday in their history, an
// assumed off day. null if none of these.
export function trainingOnDay(entries, date) {
  const w = entries.find((e) => e.date === date)?.workouts;
  if (hasWorkouts(w)) return trainingFromWorkouts(w);
  const legacy = entries.find((e) => e.date === shiftDate(date, 1))?.training;
  if (legacy) return asMorning(legacy);
  if (isSunday(date) && entries.some((e) => e.date <= date)) return trainingFromWorkouts(SUNDAY_OFF);
  return null;
}

// Days in the last `days` (before today) with nothing logged, newest first:
// the ones to prompt for. Sundays are assumed off; before yesterday, only
// days since their first entry count.
export function unloggedDays(entries, today, days = 7) {
  const first = entries.reduce((m, e) => (!m || e.date < m ? e.date : m), null);
  const out = [];
  for (let i = 1; i <= days; i++) {
    const d = shiftDate(today, -i);
    if (i > 1 && (!first || d < first)) break;
    if (!isSunday(d) && !trainingOnDay(entries, d)) out.push(d);
  }
  return out;
}

// Effort (1–10) for one practice: a number, null if they didn't go, or
// undefined for an older check-in that wasn't split into practices.
export function sessionRpe(training, which) {
  if (!isSplit(training)) return undefined;
  return training[which]?.rpe ?? null;
}

// 0–100 from the six subjective scales plus sleep duration.
export function wellnessScore(w) {
  if (!w) return null;
  const max = scaleMaxOf(w);
  const parts = WELLNESS_ITEMS.map((i) => w[i.key]).filter((v) => v >= 1 && v <= max).map((v) => ((v - 1) / (max - 1)) * 100);
  if (w.sleepHours > 0) {
    // 8 h+ scores full marks, 4 h or less scores zero.
    parts.push(clamp(((w.sleepHours - 4) / 4) * 100));
  }
  return parts.length ? Math.round(mean(parts)) : null;
}

// Personal baseline from previous days (never including today).
// Uses up to the last 30 readings; needs a handful before it is meaningful.
export function baseline(values, { minCount = 5, window = 30 } = {}) {
  const v = values.filter(Number.isFinite).slice(-window);
  if (v.length < minCount) return null;
  const sd = std(v);
  return { mean: mean(v), sd: sd > 0 ? sd : 1e-9, count: v.length };
}

// Training load over time, from daily loads (minutes × session RPE; a day
// with nothing logged counts as 0):
//   acute7, weeklyAvg28   the last 7 days, and the average week of the last 4
//   acwr                  acute:chronic ratio, 7-day total over the 28-day
//                         weekly average (the coupled ratio, kept for reference)
//   ewmaAcwr              the same idea with exponentially weighted averages
//                         (7-day and 28-day time constants), which weight
//                         recent days more and tracked injury risk better in
//                         Williams et al. 2017; this is the one the flags use
//   monotony, strain      Foster 1998: monotony = mean ÷ SD of the last 7
//                         daily loads (over 2 = every day much the same);
//                         strain = weekly load × monotony. Noted when
//                         monotony is high and the week is 10%+ above usual
// Ratios need 3 weeks of data. The ratio is a prompt to look, not a
// prediction (Impellizzeri et al. 2020): a spike with poor wellness is worth
// a conversation.
export const LOAD = { acwrSpike: 1.5, monotonyHigh: 2.0, monotonyWeek: 1.1, minDays: 21 };
export function workload(entries, today) {
  entries = withWorkouts(entries);
  const byDate = new Map(entries.map((e) => [e.date, sessionLoad(e.training)]));
  const loadOn = (d) => byDate.get(d) || 0;
  const sumDays = (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += loadOn(shiftDate(today, -i));
    return s;
  };
  const acute7 = sumDays(7);
  const chronic28 = sumDays(28);
  const first = entries.map((e) => e.date).sort()[0];
  const daysOfData = first ? daysBetween(first, today) + 1 : 0;
  const enough = daysOfData >= LOAD.minDays;
  const acwr = enough && chronic28 > 0 ? acute7 / (chronic28 / 4) : null;
  // EWMA from their first day: load_t × λ + ewma_(t-1) × (1 − λ), λ = 2 / (N + 1).
  // Both start at zero, which leaves the slow (28-day) one too low for its
  // first weeks and the ratio too high; dividing each by 1 − (1 − λ)^n (the
  // weight it has gathered after n days) removes that start-up bias.
  const la = 2 / 8;
  const lc = 2 / 29;
  let ewmaA = 0;
  let ewmaC = 0;
  let n = 0;
  if (first) {
    for (let d = first; d <= today; d = shiftDate(d, 1)) {
      const l = loadOn(d);
      ewmaA = l * la + ewmaA * (1 - la);
      ewmaC = l * lc + ewmaC * (1 - lc);
      n += 1;
    }
  }
  const unbiasA = ewmaA / (1 - (1 - la) ** n);
  const unbiasC = ewmaC / (1 - (1 - lc) ** n);
  const ewmaAcwr = enough && unbiasC > 0 ? unbiasA / unbiasC : null;
  const week = Array.from({ length: 7 }, (_, i) => loadOn(shiftDate(today, -i)));
  const sd = std(week);
  const monotony = enough && acute7 > 0 && sd > 0 ? mean(week) / sd : null;
  return {
    acute7, weeklyAvg28: Math.round(chronic28 / 4), acwr, ewmaAcwr, daysOfData,
    monotony: monotony === null ? null : +monotony.toFixed(2),
    strain: monotony === null ? null : Math.round(acute7 * monotony),
  };
}

export function shiftDate(date, days) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a, b) {
  return Math.round((new Date(`${b}T12:00:00Z`) - new Date(`${a}T12:00:00Z`)) / 86400000);
}

// ---- the athlete's own baseline
// Subjective wellness is most useful against the athlete's own usual, not a
// fixed scale (Saw, Main & Gastin 2016; Gallo et al. 2017): the same answer
// means different things for different swimmers. Each answer, sleep hours
// and the wellness score are compared with that athlete's check-ins over the
// `days` before (needs `minCheckIns`) as z-scores, with a floor on the SD so
// a swimmer who always answers the same number isn't flagged by a one-point
// change. Answers are put on the 1–7 scale first (older 1–5 check-ins too).
export const BASELINE = {
  days: 28, minCheckIns: 5,
  watch: -1, // wellness score this many SDs under their usual: at least "Moderate"
  low: -1.5, // this far under: at least "Low"
  itemLow: -2, // any one answer this far under: at least "Moderate"
  sdFloor: { item: 0.75, sleepHours: 0.75, score: 6 },
};
const to7 = (w, k) => { const s = share(w, k); return s === null ? null : 1 + s * 6; };
const share = (w, k) => {
  const max = scaleMaxOf(w);
  const v = w?.[k];
  return v >= 1 && v <= max ? (v - 1) / (max - 1) : null;
};

// { ready, remaining } until there is a baseline; then { ready: true, count,
// z, usual, items: { key: { value, usual, sd, z } } } where `z` is the
// wellness score against their usual and `items` holds each answer plus
// sleepHours. `date` must have a check-in; null otherwise.
export function personalBaseline(entries, date, C = BASELINE) {
  const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date));
  const today = sorted.find((e) => e.date === date);
  if (!today?.wellness) return null;
  const prior = sorted.filter((e) => e.wellness && e.date < date && e.date >= shiftDate(date, -C.days));
  if (prior.length < C.minCheckIns) return { ready: false, remaining: C.minCheckIns - prior.length };
  const zOf = (value, past, floor) => {
    const v = past.filter(Number.isFinite);
    if (value === null || !Number.isFinite(value) || v.length < C.minCheckIns) return null;
    const usual = mean(v);
    const sd = Math.max(std(v), floor);
    return { value: +value.toFixed(1), usual: +usual.toFixed(1), sd: +sd.toFixed(2), z: +((value - usual) / sd).toFixed(2) };
  };
  const items = {};
  for (const { key } of WELLNESS_ITEMS) {
    const r = zOf(to7(today.wellness, key), prior.map((e) => to7(e.wellness, key)), C.sdFloor.item);
    if (r) items[key] = r;
  }
  const sleep = zOf(today.wellness.sleepHours > 0 ? today.wellness.sleepHours : null, prior.map((e) => (e.wellness.sleepHours > 0 ? e.wellness.sleepHours : NaN)), C.sdFloor.sleepHours);
  if (sleep) items.sleepHours = sleep;
  const score = zOf(wellnessScore(today.wellness), prior.map((e) => wellnessScore(e.wellness)), C.sdFloor.score);
  return { ready: true, count: prior.length, z: score?.z ?? null, usual: score?.usual ?? null, items };
}

// Combine everything for the entry on `date`, given the full history.
// `heart: false` leaves HRV and resting HR out of the score and flags: the
// athlete's own view, so one noisy morning reading can't colour their day.
// The score is the day's answers on a fixed 0–100 scale (plus heart, for the
// coach); the status also takes the athlete's own baseline into account.
export function assessDay(entries, date, { heart = true } = {}) {
  const sorted = [...withWorkouts(entries)].sort((a, b) => a.date.localeCompare(b.date));
  const today = sorted.find((e) => e.date === date);
  const prior = sorted.filter((e) => e.date < date);
  const flags = [];
  const components = {};

  const wellness = wellnessScore(today?.wellness);
  if (wellness !== null) components.wellness = wellness;

  // HRV: the 7-day rolling average of ln RMSSD against the baseline, with
  // the single reading as a fallback. Day-to-day HRV is noisy; the weekly
  // average tracks training status far better (Plews et al. 2013).
  const hrv = heart ? today?.hrv : null;
  const hrvBase = baseline(prior.map((e) => e.hrv?.lnRmssd));
  const hrBase = baseline(prior.map((e) => e.hrv?.hr));
  let hrvZ = null;
  let hrZ = null;
  if (hrv && Number.isFinite(hrv.lnRmssd) && hrvBase) {
    const week = sorted.filter((e) => e.date > shiftDate(date, -7) && e.date <= date).map((e) => e.hrv?.lnRmssd).filter(Number.isFinite);
    const value = week.length >= 3 ? mean(week) : hrv.lnRmssd;
    hrvZ = (value - hrvBase.mean) / hrvBase.sd;
    components.hrv = Math.round(clamp(50 + hrvZ * 25));
    if (hrvZ < -1) flags.push({ level: 'warning', text: `HRV ${week.length >= 3 ? '(7-day average) ' : ''}is well below your normal range.` });
  }
  if (hrv && Number.isFinite(hrv.hr) && hrBase) {
    hrZ = (hrv.hr - hrBase.mean) / hrBase.sd;
    components.restingHr = Math.round(clamp(50 - hrZ * 25));
    if (hrZ > 1.5) flags.push({ level: 'warning', text: 'Resting heart rate is elevated versus your baseline.' });
  }

  const w = today?.wellness;
  if (w?.sleepHours > 0 && w.sleepHours < 6) flags.push({ level: 'warning', text: `Short sleep (${w.sleepHours} h).` });
  // `pain` holds the injury answer: 0 none, 1 minor (manageable),
  // 2 moderate (affecting stroke), 3 major (can't perform some strokes).
  if (today?.pain?.level >= 2) {
    const where = today.pain.location ? ` (${today.pain.location})` : '';
    flags.push({
      level: today.pain.level >= 3 ? 'critical' : 'warning',
      text: `${today.pain.level >= 3 ? 'Injury stopping certain strokes or movements' : 'Injury affecting stroke'}${where}.`,
    });
  }
  const load = workload(sorted.filter((e) => e.date <= date), date);
  if (load.ewmaAcwr !== null && load.ewmaAcwr > LOAD.acwrSpike) {
    flags.push({ level: 'warning', text: `Training load spike (acute:chronic ${load.ewmaAcwr.toFixed(2)}).` });
  }
  if (load.monotony !== null && load.monotony >= LOAD.monotonyHigh && load.acute7 > load.weeklyAvg28 * LOAD.monotonyWeek) {
    flags.push({ level: 'note', text: `Training is much the same every day (monotony ${load.monotony.toFixed(1)}) and above your usual week.` });
  }

  // Weighted blend of whatever components are available.
  const weights = { wellness: 0.6, hrv: 0.25, restingHr: 0.15 };
  let total = 0;
  let wsum = 0;
  for (const [k, v] of Object.entries(components)) { total += v * weights[k]; wsum += weights[k]; }
  const score = wsum ? Math.round(total / wsum) : null;

  // Status: the score on the fixed scale, then the athlete's own baseline
  // can only make it worse (well under their usual is a reason to look even
  // when the number itself is fine).
  const STATUS = {
    good: { level: 'good', label: 'Ready', advice: 'Train as planned.' },
    warning: { level: 'warning', label: 'Moderate', advice: 'Train, but consider trimming volume or intensity.' },
    serious: { level: 'serious', label: 'Low', advice: 'Prioritise recovery or a light session today.' },
  };
  let status = null;
  const own = personalBaseline(sorted, date);
  let ownLevel = null;
  if (score !== null) {
    status = score >= 70 ? STATUS.good : score >= 50 ? STATUS.warning : STATUS.serious;
    if (own?.ready && own.z !== null) {
      const items = Object.values(own.items);
      if (own.z <= BASELINE.low) ownLevel = 'serious';
      else if (own.z <= BASELINE.watch || items.some((i) => i.z <= BASELINE.itemLow)) ownLevel = 'warning';
      const rank = { good: 0, warning: 1, serious: 2 };
      if (ownLevel && rank[ownLevel] > rank[status.level]) {
        status = STATUS[ownLevel];
        flags.push({ level: 'warning', text: `Well below your usual (answers score ${wellness}, usually about ${Math.round(own.usual)}).` });
      }
    }
  }
  if (today?.pain?.level >= 3) {
    status = { level: 'critical', label: 'Check in', advice: 'Talk to your coach or medical staff before training.' };
  }

  return {
    date, score, status, components, flags, load, own, ownLevel,
    hrvZ, hrZ, hrvBaseline: hrvBase, hrBaseline: hrBase,
    baselineReadingsNeeded: hrvBase ? 0 : Math.max(0, 5 - prior.filter((e) => Number.isFinite(e.hrv?.lnRmssd)).length),
  };
}

// 7-day rolling mean of `pick(entry)` for each entry, using readings from
// that day and the six before it; needs `min` readings, else NaN. Smooths
// out single noisy mornings for the athlete's trend charts.
export function rollingMean(entries, pick, { days = 7, min = 3 } = {}) {
  const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date));
  return sorted.map((e) => {
    const from = shiftDate(e.date, -(days - 1));
    const vals = sorted.filter((x) => x.date >= from && x.date <= e.date).map(pick).filter(Number.isFinite);
    return vals.length >= min ? mean(vals) : NaN;
  });
}

// ---- heart-reading days and check-in streaks

const weekday = (date) => new Date(`${date}T12:00:00Z`).getUTCDay();
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function isReadingDay(days, date) {
  return !Array.isArray(days) || !days.length || days.includes(weekday(date));
}

// The next reading day after `date`, as a weekday name (null if none set).
export function nextReadingDay(days, date) {
  if (!Array.isArray(days) || !days.length) return null;
  for (let i = 1; i <= 7; i++) {
    const d = shiftDate(date, i);
    if (days.includes(weekday(d))) return WEEKDAYS[weekday(d)];
  }
  return null;
}

// Check-ins in a row up to today. A streak is still alive until today is
// over, so it counts back from yesterday if today isn't done yet.
// Swimmers don't usually check in on Sundays: a Sunday counts if they
// checked in, or logged Saturday's training (which the analysis files under
// Sunday morning; older app versions asked about it on Monday). Until Monday's check-in is done,
// Sunday can still be made up, so it doesn't break the streak yet.
// `nudge`: whether to say "check in today" (not on Sundays).
export function checkInStreak(entries, today) {
  entries = withWorkouts(entries);
  const done = new Set(entries.filter((e) => e.wellness).map((e) => e.date));
  const madeUp = new Set(entries.filter((e) => !e.wellness && e.training).map((e) => e.date));
  const isSunday = (d) => weekday(d) === 0;
  const counts = (d) => done.has(d) || (isSunday(d) && madeUp.has(d));
  const doneToday = done.has(today);
  let d = doneToday ? today : shiftDate(today, -1);
  if (!doneToday && weekday(today) === 1 && !counts(d)) d = shiftDate(d, -1); // Sunday: not made up yet
  let n = 0;
  while (counts(d)) { n++; d = shiftDate(d, -1); }
  return { days: n, doneToday, nudge: !doneToday && !isSunday(today) };
}

// ---- today compared with the athlete's own usual

// How today's answers-only score sits against the athlete's own recent
// check-ins (up to 30 before today). Until there are `minDays` of those,
// `ready` is false and `remaining` says how many more are needed.
// level: 'same' | 'higher' | 'lower'. A gap counts only if it is bigger than
// both 6 points and the athlete's usual day-to-day spread.
export function compareToUsual(entries, date, { minDays = 5 } = {}) {
  const sorted = [...entries].sort((x, y) => x.date.localeCompare(y.date));
  const today = assessDay(sorted, date, { heart: false }).score;
  const before = sorted
    .filter((e) => e.date < date && e.wellness)
    .slice(-30)
    .map((e) => assessDay(sorted, e.date, { heart: false }).score)
    .filter(Number.isFinite);
  if (today === null || before.length < minDays) {
    return { ready: false, remaining: Math.max(1, minDays - before.length) };
  }
  const usual = mean(before);
  const band = Math.max(6, std(before));
  const diff = today - usual;
  return { ready: true, level: diff > band ? 'higher' : diff < -band ? 'lower' : 'same', diff: Math.round(diff) };
}
