// Follow-up categories for the coach's Group tab: who may need a word today,
// and why. Each swimmer is compared with their own history where there is
// enough of it; illness and injury show regardless. These are prompts for a
// conversation, not diagnoses, and never a change to the training plan.
// Pure functions.

import { groupByAthlete } from './group.js';
import { assessDay, daysBetween, PRACTICE_KEYS, scaleMaxOf, shiftDate, trainingOnDay, workload } from './readiness.js';

// The thresholds, in one place so they're easy to adjust.
export const FOLLOW_UP = {
  activeDays: 21, // in the group: checked in within this many days
  baselineDays: 14, // a swimmer's usual answers: their check-ins over this many days before…
  baselineMin: 5, // …once there are this many
  itemDrop: 0.3, // an answer this far under their usual (share of the scale: 2 points on 1–7)
  itemLow: 1 / 6, // or this low on its own (1–2 on 1–7) before there is a usual
  readinessDrop: 10, // readiness this many points under their usual (7 days before; needs 3)
  lowReadiness: 70, // a run of check-ins under this…
  lowRun: 3, // …this long
  shortSleep: 7, // nights under this many hours…
  shortNights: 3, // …on this many of their last 4 check-ins
  acwr: 1.5, // last 7 days' load against their 4-week average
  hardEffort: 7, // a practice this hard (effort, 1–10)…
  poorPerf: 4, // …that went this poorly (how well they did, 1–10)…
  mismatches: 2, // …on this many different days in the last week
  perfDrop: 2, // how well they did: last 3 practices this far under their usual…
  perfMin: 6, // …once they have logged this many in 4 weeks
  sickDays: 3, // practices missed sick in the last this many days
  trendDays: 6, // how far back "for N days" looks
};

export const CATEGORIES = [
  { key: 'health', label: 'Illness / injury' },
  { key: 'recovery', label: 'Recovery / fatigue' },
  { key: 'stress', label: 'Stress / mood' },
  { key: 'response', label: 'Training response' },
  { key: 'missing', label: 'Missing data' },
  { key: 'ready', label: 'Ready for planned training' },
];

const isCheckIn = (e) => Boolean(e.wellness);
const avg = (v) => v.reduce((s, x) => s + x, 0) / v.length;
const ITEM = {
  sleepQuality: 'Sleep quality', energy: 'Energy', soreness: 'Soreness (7 = none)',
  stress: 'Stress (7 = relaxed)', mood: 'Mood', motivation: 'Motivation',
};
// An answer as a share of its scale (0 = worst, 1 = best); older check-ins used 1–5.
const share = (w, k) => {
  const max = scaleMaxOf(w);
  const v = w?.[k];
  return v >= 1 && v <= max ? (v - 1) / (max - 1) : null;
};
const SEVERITY = { critical: 0, serious: 1, warning: 2, note: 3 };

// What stands out for one swimmer on `date`, by category: { cat: { reasons:
// [{ level, text }], ask } } for the first four categories, empty ones left out.
export function concernsOn(entries, date, C = FOLLOW_UP) {
  const upTo = entries.filter((e) => e.date <= date);
  const checkIns = upTo.filter(isCheckIn);
  const latest = checkIns.at(-1);
  const recent = latest && latest.date >= shiftDate(date, -1) ? latest : null; // today's or yesterday's answers
  const when = recent?.date === date ? 'today' : 'yesterday';
  const out = {};
  const add = (cat, level, text, ask) => {
    out[cat] ||= { reasons: [], ask };
    out[cat].reasons.push({ level, text });
    if (ask && !out[cat].ask) out[cat].ask = ask;
  };

  // Illness / injury: whatever the baselines say.
  const pain = recent?.pain;
  const where = pain?.location ? ` (${pain.location})` : '';
  if (pain?.level >= 2) {
    add('health', pain.level >= 3 ? 'critical' : 'serious',
      `${pain.level >= 3 ? 'Injury stopping certain strokes or movements' : 'Injury affecting stroke'}${where}, reported ${when}.`,
      `How is ${pain.location ? `your ${pain.location}` : 'the injury'} feeling? Has someone looked at it?`);
  } else if (pain?.level === 1) {
    let run = 0;
    for (let i = checkIns.length - 1; i >= 0 && checkIns[i].pain?.level === 1; i--) run++;
    if (run >= 3) add('health', 'note', `Minor injury reported ${run} check-ins in a row${where}.`, `How is ${pain.location ? `your ${pain.location}` : 'that'} holding up?`);
  }
  // Missed practice sick (Workouts tab), whether or not they checked in.
  const sickDays = [];
  for (let i = 0; i < C.sickDays; i++) {
    const d = shiftDate(date, -i);
    if (PRACTICE_KEYS.some((k) => trainingOnDay(entries, d)?.[`${k}None`] === 'sick')) sickDays.push(d);
  }
  if (sickDays.length) {
    add('health', 'serious', `Missed practice sick: ${sickDays.map((d) => (d === date ? 'today' : d === shiftDate(date, -1) ? 'yesterday' : `${daysBetween(d, date)} days ago`)).join(', ')}.`,
      'How are you feeling – ready to get back in the water?');
  }

  if (recent) {
    // Answers well under their own usual (or very low, before there is one).
    const before = checkIns.filter((e) => e.date < recent.date && e.date >= shiftDate(recent.date, -C.baselineDays));
    const max = scaleMaxOf(recent.wellness);
    const item = (k, cat, ask) => {
      const v = share(recent.wellness, k);
      if (v === null) return;
      const base = before.map((e) => share(e.wellness, k)).filter((x) => x !== null);
      const raw = recent.wellness[k];
      if (base.length >= C.baselineMin) {
        const usual = avg(base);
        if (usual - v >= C.itemDrop) add(cat, 'warning', `${ITEM[k]} ${raw}/${max} ${when}, usually about ${Math.round(usual * (max - 1) + 1)}.`, ask);
      } else if (v <= C.itemLow) {
        add(cat, 'warning', `${ITEM[k]} ${raw}/${max} ${when}.`, ask);
      }
    };
    const sleepAsk = 'How have you been sleeping this week?';
    const bodyAsk = 'How is your body feeling after this week’s training?';
    item('sleepQuality', 'recovery', sleepAsk);
    item('energy', 'recovery', bodyAsk);
    item('soreness', 'recovery', bodyAsk);
    const mindAsk = 'How are things going outside the pool?';
    for (const k of ['stress', 'mood', 'motivation']) item(k, 'stress', mindAsk);

    // Readiness under their usual, or a run of low days.
    const score = (e) => assessDay(upTo, e.date).score;
    const now = score(recent);
    const week = checkIns.filter((e) => e.date < recent.date && e.date >= shiftDate(recent.date, -7)).map(score).filter(Number.isFinite);
    const recentScores = checkIns.filter((e) => e.date >= shiftDate(date, -6)).map(score);
    let low = 0;
    for (let i = recentScores.length - 1; i >= 0 && Number.isFinite(recentScores[i]) && recentScores[i] < C.lowReadiness; i--) low++;
    if (low >= C.lowRun) add('recovery', 'warning', `Readiness under ${C.lowReadiness} on their last ${low} check-ins.`, bodyAsk);
    // Overall readiness under their usual: only when no single answer above
    // already explains it (a stressful week shouldn't also read as fatigue).
    else if (!out.recovery && !out.stress && Number.isFinite(now) && week.length >= 3 && avg(week) - now >= C.readinessDrop) {
      add('recovery', 'warning', `Readiness ${now} ${when}, usually about ${Math.round(avg(week))}.`, bodyAsk);
    }

    const nights = checkIns.filter((e) => e.date >= shiftDate(date, -6)).slice(-4).map((e) => e.wellness?.sleepHours).filter((h) => h > 0);
    const short = nights.filter((h) => h < C.shortSleep);
    if (short.length >= C.shortNights) {
      add('recovery', 'warning', `Under ${C.shortSleep} h sleep on ${short.length} of their last ${nights.length} nights (average ${avg(nights).toFixed(1)} h).`, sleepAsk);
    }
  }
  const acwr = workload(upTo, date).acwr;
  if (acwr !== null && acwr > C.acwr) add('recovery', 'warning', `Training load: the last 7 days are ${acwr.toFixed(1)}× their 4-week average.`, 'How is your body handling the extra work this week?');

  // Training response: practices that felt hard and went poorly on several
  // days, or "how well did you do" well under their usual.
  const practices = [];
  for (let i = 1; i <= 28; i++) {
    const d = shiftDate(date, -i + 1);
    const t = trainingOnDay(entries, d);
    for (const k of [...PRACTICE_KEYS].reverse()) if (t?.[k]?.perf) practices.push({ day: d, rpe: t[k].rpe, perf: t[k].perf });
  }
  const last3 = practices.filter((p) => p.day >= shiftDate(date, -7)).slice(0, 3);
  const tough = hardButPoor(entries, date, C);
  if (tough.flagged) {
    add('response', 'note', `Practice felt hard (${C.hardEffort}+) but went poorly (${C.poorPerf} or less) on ${tough.days.length} days this week.`,
      'Practices have felt tough lately – what’s getting in the way?');
  } else if (last3.length === 3 && practices.length >= C.perfMin) {
    const usual = avg(practices.slice(3).map((p) => p.perf));
    const lately = avg(last3.map((p) => p.perf));
    if (practices.length - 3 >= 3 && usual - lately >= C.perfDrop) {
      add('response', 'note', `How well they did: ${lately.toFixed(1)} over their last 3 practices, usually about ${usual.toFixed(1)}.`,
        'How do you feel practices have been going this week?');
    }
  }
  return out;
}

// Days in the week up to `date` with a practice that felt hard (hardEffort+)
// but went poorly (poorPerf or less), newest first; flagged on `mismatches`
// or more different days.
export function hardButPoor(entries, date, C = FOLLOW_UP) {
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = shiftDate(date, -i);
    const t = trainingOnDay(entries, d);
    if (PRACTICE_KEYS.some((k) => t?.[k]?.perf && t[k].rpe >= C.hardEffort && t[k].perf <= C.poorPerf)) days.push(d);
  }
  return { days, flagged: days.length >= C.mismatches };
}

// Days in a row (before `date`) that `cat` was also flagged, up to trendDays.
function flaggedFor(entries, date, cat, C) {
  let n = 0;
  for (let i = 1; i <= C.trendDays && concernsOn(entries, shiftDate(date, -i), C)[cat]; i++) n++;
  return n;
}

// The whole group on `date`, by category. Each category: { key, label,
// swimmers: [{ key, name, reasons, ask, days }] } where `days` is how many
// days in a row it has been flagged (1 = new today). A swimmer can be in
// more than one category. Missing data: no check-in on the day, or the day
// before's training not logged. Ready: checked in, nothing in the first four.
export function followUps(rows, date, C = FOLLOW_UP) {
  const athletes = groupByAthlete(rows);
  const cats = Object.fromEntries(CATEGORIES.map((c) => [c.key, { ...c, swimmers: [] }]));
  for (const a of athletes.values()) {
    const upTo = a.entries.filter((e) => e.date <= shiftDate(date, 1));
    const lastSeen = upTo.filter((e) => isCheckIn(e) && e.date <= date).at(-1)?.date;
    const logged = a.entries.some((e) => e.workouts && e.date >= shiftDate(date, -C.activeDays) && e.date <= date);
    if (!(lastSeen >= shiftDate(date, -C.activeDays)) && !logged) continue; // not active
    const me = { key: a.key, name: a.name };
    const found = concernsOn(a.entries, date, C);
    for (const [cat, f] of Object.entries(found)) {
      f.reasons.sort((x, y) => SEVERITY[x.level] - SEVERITY[y.level]);
      cats[cat].swimmers.push({ ...me, ...f, level: f.reasons[0].level, days: 1 + flaggedFor(a.entries, date, cat, C) });
    }
    const checkedIn = lastSeen === date;
    const missing = [];
    // Sundays are a day off from checking in.
    const sunday = new Date(`${date}T12:00:00Z`).getUTCDay() === 0;
    if (!checkedIn && !sunday) missing.push({ level: 'note', text: lastSeen ? `No check-in (last ${daysBetween(lastSeen, date) === 1 ? 'yesterday' : `${daysBetween(lastSeen, date)} days ago`}).` : 'No check-in yet.' });
    if (!trainingOnDay(a.entries, shiftDate(date, -1))) missing.push({ level: 'note', text: 'The day before’s training not logged.' });
    if (missing.length) cats.missing.swimmers.push({ ...me, reasons: missing, level: 'note', ask: missing.length === 2 || !checkedIn ? 'Quick reminder to check in.' : 'Quick reminder to log yesterday’s training.' });
    if (checkedIn && !['health', 'recovery', 'stress', 'response'].some((k) => found[k])) cats.ready.swimmers.push({ ...me, reasons: [] });
  }
  for (const c of Object.values(cats)) {
    c.swimmers.sort((x, y) => (SEVERITY[x.level] ?? 9) - (SEVERITY[y.level] ?? 9) || y.reasons.length - x.reasons.length || x.name.localeCompare(y.name));
  }
  return { date, categories: CATEGORIES.map((c) => cats[c.key]) };
}

// One swimmer's categories on `date` (for their page): [{ key, label, reasons, ask, days }].
export function followUpsFor(entries, date, C = FOLLOW_UP) {
  const found = concernsOn(entries, date, C);
  return CATEGORIES.filter((c) => found[c.key]).map((c) => ({
    ...c, ...found[c.key], days: 1 + flaggedFor(entries, date, c.key, C),
  }));
}
