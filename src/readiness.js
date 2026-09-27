// Turns questionnaire answers + HRV into a daily readiness picture.
// Pure functions only, so they can be unit tested in Node.

import { mean, std } from './signal.js';

// Questionnaire definition. Every 1–5 scale is phrased so that 5 is best,
// which keeps scoring simple and the form consistent for the athlete.
export const WELLNESS_ITEMS = [
  { key: 'sleepQuality', label: 'Sleep quality', low: 'Very poor', high: 'Excellent' },
  { key: 'energy', label: 'Energy / fatigue', low: 'Exhausted', high: 'Very fresh' },
  { key: 'soreness', label: 'Muscle soreness', low: 'Very sore', high: 'None' },
  { key: 'stress', label: 'Stress', low: 'Very stressed', high: 'Very relaxed' },
  { key: 'mood', label: 'Mood', low: 'Very low', high: 'Very positive' },
  { key: 'motivation', label: 'Motivation to train', low: 'None', high: 'Very high' },
];

export const SYMPTOMS = [
  'Sore throat', 'Runny / blocked nose', 'Cough', 'Fever / chills',
  'Headache', 'Upset stomach', 'Unusual tiredness',
];

const clamp = (x, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, x));
const scale1to5 = (v) => ((v - 1) / 4) * 100;

export function sessionLoad(training) {
  if (!training) return 0;
  const { durationMin, rpe } = training;
  return durationMin > 0 && rpe >= 0 ? Math.round(durationMin * rpe) : 0;
}

// 0–100 from the six subjective scales plus sleep duration.
export function wellnessScore(w) {
  if (!w) return null;
  const parts = WELLNESS_ITEMS.map((i) => w[i.key]).filter((v) => v >= 1 && v <= 5).map(scale1to5);
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

// Acute:chronic workload ratio from daily loads keyed by YYYY-MM-DD.
export function workload(entries, today) {
  const byDate = new Map(entries.map((e) => [e.date, sessionLoad(e.training)]));
  const sumDays = (n) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += byDate.get(shiftDate(today, -i)) || 0;
    return s;
  };
  const acute7 = sumDays(7);
  const chronic28 = sumDays(28);
  const first = entries.map((e) => e.date).sort()[0];
  const daysOfData = first ? daysBetween(first, today) + 1 : 0;
  const acwr = daysOfData >= 21 && chronic28 > 0 ? acute7 / (chronic28 / 4) : null;
  return { acute7, weeklyAvg28: Math.round(chronic28 / 4), acwr, daysOfData };
}

export function shiftDate(date, days) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(a, b) {
  return Math.round((new Date(`${b}T12:00:00Z`) - new Date(`${a}T12:00:00Z`)) / 86400000);
}

// Combine everything for the entry on `date`, given the full history.
export function assessDay(entries, date) {
  const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date));
  const today = sorted.find((e) => e.date === date);
  const prior = sorted.filter((e) => e.date < date);
  const flags = [];
  const components = {};

  const wellness = wellnessScore(today?.wellness);
  if (wellness !== null) components.wellness = wellness;

  const hrv = today?.hrv;
  const hrvBase = baseline(prior.map((e) => e.hrv?.lnRmssd));
  const hrBase = baseline(prior.map((e) => e.hrv?.hr));
  let hrvZ = null;
  let hrZ = null;
  if (hrv && Number.isFinite(hrv.lnRmssd) && hrvBase) {
    hrvZ = (hrv.lnRmssd - hrvBase.mean) / hrvBase.sd;
    components.hrv = Math.round(clamp(50 + hrvZ * 25));
    if (hrvZ < -1) flags.push({ level: 'warning', text: 'HRV is well below your normal range.' });
  }
  if (hrv && Number.isFinite(hrv.hr) && hrBase) {
    hrZ = (hrv.hr - hrBase.mean) / hrBase.sd;
    components.restingHr = Math.round(clamp(50 - hrZ * 25));
    if (hrZ > 1.5) flags.push({ level: 'warning', text: 'Resting heart rate is elevated versus your baseline.' });
  }

  const w = today?.wellness;
  if (w?.sleepHours > 0 && w.sleepHours < 6) flags.push({ level: 'warning', text: `Short sleep (${w.sleepHours} h).` });
  if (today?.pain?.level >= 2) {
    const where = today.pain.location ? ` (${today.pain.location})` : '';
    flags.push({
      level: today.pain.level >= 3 ? 'critical' : 'warning',
      text: `${today.pain.level >= 3 ? 'Significant' : 'Moderate'} pain reported${where}.`,
    });
  }
  const symptoms = today?.illness || [];
  if (symptoms.length) {
    flags.push({ level: 'critical', text: `Illness symptoms: ${symptoms.join(', ').toLowerCase()}.` });
  }
  const load = workload(sorted.filter((e) => e.date <= date), date);
  if (load.acwr !== null && load.acwr > 1.5) {
    flags.push({ level: 'warning', text: `Training load spike (acute:chronic ${load.acwr.toFixed(2)}).` });
  }

  // Weighted blend of whatever components are available.
  const weights = { wellness: 0.6, hrv: 0.25, restingHr: 0.15 };
  let total = 0;
  let wsum = 0;
  for (const [k, v] of Object.entries(components)) { total += v * weights[k]; wsum += weights[k]; }
  const score = wsum ? Math.round(total / wsum) : null;

  let status = null;
  if (score !== null) {
    if (score >= 70) status = { level: 'good', label: 'Ready', advice: 'Train as planned.' };
    else if (score >= 50) status = { level: 'warning', label: 'Moderate', advice: 'Train, but consider trimming volume or intensity.' };
    else status = { level: 'serious', label: 'Low', advice: 'Prioritise recovery or a light session today.' };
  }
  if (symptoms.length || today?.pain?.level >= 3) {
    status = { level: 'critical', label: 'Check in', advice: 'Talk to your coach or medical staff before training.' };
  }

  return {
    date, score, status, components, flags, load,
    hrvZ, hrZ, hrvBaseline: hrvBase, hrBaseline: hrBase,
    baselineReadingsNeeded: hrvBase ? 0 : Math.max(0, 5 - prior.filter((e) => Number.isFinite(e.hrv?.lnRmssd)).length),
  };
}
