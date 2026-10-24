// Goal times and training gears, following the coach's Gears sheet (short
// course yards). Pure functions, so they can be unit tested against rows of
// the sheet.
//
// The model: a race time predicts the pace a swimmer can hold for any length
// of effort with one "fatigue factor" F (Riegel; the sheet's Mile Chart):
//   time over distance d2 = time over d1 × (d2 / d1) ^ F
//   pace held for T seconds = race pace × (T / race time) ^ (1 − 1 / F)
// Gears are paces for set lengths of effort: G2 = what they could hold for
// 4 hours, G3 = 1 hour, G4 = 15 minutes, G5 = 5 minutes, G6 = 2 minutes
// (the sheet's T-4h … T-2 min). The IM tab splits a 200 IM at each gear into
// its strokes with elite stroke shares. The Speed Table works from the
// swimmer's clean (mid-pool) speed, found from their 50, with factors for
// the start, the turn and the finish.

export const COURSE = 'SCY';

export const STROKES = {
  free: { label: 'Freestyle', short: 'Free' },
  back: { label: 'Backstroke', short: 'Back' },
  breast: { label: 'Breaststroke', short: 'Breast' },
  fly: { label: 'Butterfly', short: 'Fly' },
  im: { label: 'Individual medley', short: 'IM' },
};

// Events a swimmer can enter times for, key = `${stroke}-${distance}`.
export const EVENTS = [
  ...[50, 100, 200, 500, 1000, 1650].map((d) => ({ key: `free-${d}`, stroke: 'free', dist: d, label: `${d} free` })),
  ...['back', 'breast', 'fly'].flatMap((s) => [50, 100, 200].map((d) => ({ key: `${s}-${d}`, stroke: s, dist: d, label: `${d} ${STROKES[s].short.toLowerCase()}` }))),
  ...[100, 200, 400].map((d) => ({ key: `im-${d}`, stroke: 'im', dist: d, label: `${d} IM` })),
];
export const eventOf = (key) => EVENTS.find((e) => e.key === key);

// The gears: how long the effort could be held, the rest ratio for a repeat
// of 60 s (the sheet's G3 to Mile tab), and the effort that should go with it.
export const GEARS = [
  { key: 'G2', T: 14400, name: '4-hour pace', rest: 0.05, rpe: '3–4' },
  { key: 'G2.5', T: 7200, name: '2-hour pace', rest: 0.08, rpe: '4–5' },
  { key: 'G3', T: 3600, name: '1-hour pace', rest: 0.12, rpe: '6–7' },
  { key: 'G3.5', T: 1800, name: '30-minute pace', rest: 0.2, rpe: '7' },
  { key: 'G4', T: 900, name: '15-minute pace', rest: 0.35, rpe: '8' },
  { key: 'G5', T: 300, name: '5-minute pace', rest: 1.0, rpe: '9' },
  { key: 'G6', T: 120, name: '2-minute pace', rest: null, rpe: '9–10' },
];
export const MAIN_GEARS = ['G2', 'G3', 'G4', 'G5', 'G6'];
export const gearOf = (key) => GEARS.find((g) => g.key === key);

// Fatigue factor: distance types about 1.03, typical 1.04–1.05, speed-leaning
// 1.06–1.07 (the sheet's Factor Calculator cut-offs).
export const FACTOR = { default: 1.045, distance: 1.035, sprinter: 1.06, min: 1.0, max: 1.12, offset200: 0.049 };
export const swimmerType = (f) => (f <= FACTOR.distance ? 'Distance' : f >= FACTOR.sprinter ? 'Sprinter' : 'Middle');

// ---- times

// A typed time → seconds; null if it isn't one. Phone keypads often have no
// colon, so minutes can also be typed straight on: "148.0" is 1:48.0,
// "1748" is 17:48, "1.48.0" is 1:48.0. Three or more digits before the
// decimal point mean minutes then two digits of seconds.
export function parseTime(text) {
  const s = String(text ?? '').trim().replace(/\s+/g, '');
  if (!s) return null;
  // 1:48.0, 1:48, or with dots for the colon: 1.48.0 (a single dot is seconds: 22.49).
  let m = /^(\d{1,2}):(\d{2})(?:[.,](\d{1,2}))?$/.exec(s) || /^(\d{1,2})\.(\d{2})\.(\d{1,2})$/.exec(s);
  let min; let sec; let frac;
  if (m) { [, min, sec, frac] = m; } else {
    m = /^(\d{1,4})(?:[.,](\d{1,2}))?$/.exec(s); // 48.0, 148.0, 1748
    if (!m) return null;
    const digits = m[1];
    if (digits.length >= 3) { min = digits.slice(0, -2); sec = digits.slice(-2); } else { min = '0'; sec = digits; }
    frac = m[2];
  }
  if (Number(sec) >= 60 && Number(min) > 0) return null;
  const t = Number(min) * 60 + Number(sec) + (frac ? Number(`0.${frac}`) : 0);
  return t > 0 ? +t.toFixed(2) : null;
}

// Seconds → "m:ss.d" (or "ss.d" under a minute). dp: decimals.
export function formatTime(sec, { dp = 1 } = {}) {
  if (!Number.isFinite(sec)) return '–';
  const whole = Math.round(sec * 10 ** dp) / 10 ** dp;
  const min = Math.floor(whole / 60);
  const rest = whole - min * 60;
  const s = rest.toFixed(dp);
  return min ? `${min}:${rest < 10 ? '0' : ''}${s}` : s;
}

// ---- the pace model

export const riegel = (t1, d1, d2, f) => t1 * (d2 / d1) ** f;

// Pace per `per` yards that a swimmer with this race could hold for T seconds.
export function gearPace(raceSec, raceDist, T, f, per = 100) {
  return (raceSec / raceDist) * per * (T / raceSec) ** (1 - 1 / f);
}

// Recommended rest for a repeat that takes `swimSec` at a gear (the sheet's
// G3 to Mile tab): swim × ratio × (swim / 60) ^ 0.5, to the whole second.
export function restFor(gear, swimSec) {
  if (gear.rest === null) return null;
  return Math.max(1, Math.round(swimSec * gear.rest * (swimSec / 60) ** 0.5));
}

// The fatigue factor from a swimmer's own races: the two longest freestyle
// races of 200+ they have times for (500 and longer are best).
//   F = ln(t2 / t1) / ln(d2 / d1)
// Falls back to the default. `times`: { 'free-500': seconds, … }.
export function fatigueFactor(times = {}, override = null) {
  if (override >= FACTOR.min && override <= FACTOR.max) return { factor: override, type: swimmerType(override), from: 'set by hand' };
  const races = EVENTS.filter((e) => e.stroke === 'free' && e.dist >= 200 && times[e.key] > 0).sort((a, b) => b.dist - a.dist);
  if (races.length >= 2) {
    const [long, short] = races;
    const f = Math.log(times[long.key] / times[short.key]) / Math.log(long.dist / short.dist);
    if (f >= FACTOR.min && f <= FACTOR.max) {
      return { factor: +f.toFixed(3), type: swimmerType(f), from: `${short.label} and ${long.label}` };
    }
  }
  return { factor: FACTOR.default, type: swimmerType(FACTOR.default), from: null };
}

// The race the gears for a stroke come from: the longest race they have a
// time for, estimated up to a 200 from a 100 when that is all there is.
// Freestyle: 1650, 1000, 500, 200, else 200 from the 100. Other strokes:
// 200, else 200 from the 100. Returns null with no usable time.
export function referenceRace(times = {}, stroke, f = FACTOR.default) {
  const own = EVENTS.filter((e) => e.stroke === stroke && e.dist >= 200 && times[e.key] > 0).sort((a, b) => b.dist - a.dist)[0];
  if (own) return { event: own, seconds: times[own.key], estimated: false };
  const hundred = EVENTS.find((e) => e.stroke === stroke && e.dist === 100);
  if (hundred && times[hundred.key] > 0) {
    const two = EVENTS.find((e) => e.stroke === stroke && e.dist === 200);
    return { event: two, seconds: +riegel(times[hundred.key], 100, 200, f + FACTOR.offset200).toFixed(1), estimated: true, from: hundred };
  }
  return null;
}

// Gears for one stroke: [{ key, name, T, pace (seconds per `per`), rest, rpe }].
export function strokeGears(times, stroke, { factor = FACTOR.default, per = 100, gears = GEARS } = {}) {
  const ref = referenceRace(times, stroke, factor);
  if (!ref) return null;
  return {
    reference: ref,
    per,
    gears: gears.map((g) => {
      const pace = gearPace(ref.seconds, ref.event.dist, g.T, factor, per);
      return { ...g, pace: +pace.toFixed(1), rest: restFor(g, pace) };
    }),
  };
}

// ---- IM

// Stroke shares of a 400 IM (elite short course yards swims; the sheet's IM
// Zones tab), and 400 IM ÷ 200 IM.
export const IM = {
  ratio400to200: 2.15,
  shares: {
    boys: { fly: 0.232, back: 0.25, breast: 0.28, free: 0.238 },
    girls: { fly: 0.232, back: 0.25, breast: 0.283, free: 0.235 },
  },
  switches: [
    { key: 'flyBack', label: 'Fly–back', strokes: ['fly', 'back'] },
    { key: 'backBreast', label: 'Back–breast', strokes: ['back', 'breast'] },
    { key: 'breastFree', label: 'Breast–free', strokes: ['breast', 'free'] },
  ],
};

// The 400 IM the IM gears come from: their 400 IM, else 200 IM × 2.15, else
// a 200 of a stroke × the USA Swimming standards ratio for their sex and age.
export function imReference(times = {}, { sex = 'girls', age = '15-16' } = {}) {
  if (times['im-400'] > 0) return { event: eventOf('im-400'), seconds: times['im-400'], estimated: false };
  if (times['im-200'] > 0) return { event: eventOf('im-400'), seconds: +(times['im-200'] * IM.ratio400to200).toFixed(1), estimated: true, from: eventOf('im-200') };
  for (const s of ['back', 'fly', 'breast']) {
    const k = `${s}-200`;
    if (times[k] > 0) {
      const ratio = STANDARD_RATIOS[`${sex}-${age}-${s}`] ?? STANDARD_RATIOS[`girls-15-16-${s}`];
      return { event: eventOf('im-400'), seconds: +(times[k] * ratio).toFixed(1), estimated: true, from: eventOf(k) };
    }
  }
  return null;
}

// IM gears: IM pace per `per` at each gear, the 200 IM at that gear, its four
// 50s, and the switch 50s (25 + 25) and 100s (50 + 50).
export function imGears(times, { factor = FACTOR.default, per = 100, sex = 'girls', age = '15-16', gears = GEARS } = {}) {
  const ref = imReference(times, { sex, age });
  if (!ref) return null;
  const shares = IM.shares[sex] || IM.shares.girls;
  return {
    reference: ref,
    per,
    im200: ref.seconds / IM.ratio400to200,
    gears: gears.map((g) => {
      const per100 = gearPace(ref.seconds, 400, g.T, factor, 100);
      const im200 = per100 * 2;
      // Each stroke's 50 inside a 200 IM; `splits(per)` gives its 25, 50 or
      // 100 (the 100 is its share of a 400 IM at this gear) with rest.
      const strokes = Object.fromEntries(Object.entries(shares).map(([s, sh]) => [s, +(im200 * sh).toFixed(1)]));
      const splits = (d) => Object.fromEntries(Object.entries(shares).map(([s, sh]) => {
        const t = (im200 * sh * d) / 50;
        return [s, { time: +t.toFixed(1), rest: restFor(g, t) }];
      }));
      const switches = Object.fromEntries(IM.switches.map((sw) => {
        const hundred = sw.strokes.reduce((n, s) => n + im200 * shares[s], 0);
        return [sw.key, { fifty: +(hundred / 2).toFixed(1), hundred: +hundred.toFixed(1), rest50: restFor(g, hundred / 2), rest100: restFor(g, hundred) }];
      }));
      return { ...g, pace: +((per100 / 100) * per).toFixed(1), rest: restFor(g, (per100 / 100) * per), im200: +im200.toFixed(1), strokes, splits, switches };
    }),
  };
}

// 400 IM ÷ 200 of a stroke from the USA Swimming motivational standards
// (SCY 2025–2028, averaged over B to AAAA; the sheet's USA Standards tab).
export const STANDARD_RATIOS = {
  'girls-13-14-back': 2.199, 'girls-13-14-breast': 1.915, 'girls-13-14-fly': 2.137,
  'girls-15-16-back': 2.188, 'girls-15-16-breast': 1.909, 'girls-15-16-fly': 2.141,
  'girls-17-18-back': 2.209, 'girls-17-18-breast': 1.899, 'girls-17-18-fly': 2.154,
  'boys-13-14-back': 2.183, 'boys-13-14-breast': 1.931, 'boys-13-14-fly': 2.154,
  'boys-15-16-back': 2.182, 'boys-15-16-breast': 1.928, 'boys-15-16-fly': 2.145,
  'boys-17-18-back': 2.206, 'boys-17-18-breast': 1.956, 'boys-17-18-fly': 2.167,
};
export const AGE_GROUPS = ['13-14', '15-16', '17-18'];

// ---- speed (the sheet's Speed Table, one factor set per stroke)

// Factors by stroke. The freestyle set is the sheet's (calibrated to elite
// NCAA splits and a European short course study). The other strokes keep
// the same model with factors set from how each stroke starts and turns:
//   back    starts in the water (no block; `block` is the reaction and
//           push), a backstroke flip turn, strong underwater kick
//   breast  one pullout to 15 m (fast against a slow surface speed), an
//           open two-hand turn (no flip, longer on the wall)
//   fly     the same block start as free, underwater kick to 15 m, an
//           open two-hand turn, a bigger fade on the second 25
// They are starting points: fit them to each swimmer with their own
// 15 m, flag and 25 times. `block` and `dive` differ by sex.
export const SPEED_FACTORS = {
  free: {
    boys: { block: 0.63, dive: 0.72 }, girls: { block: 0.70, dive: 0.79 },
    push: 0.84, turnPush: 0.88, rotation: 0.20, contact: 0.30, reach: 0.5, fade: 0.955,
    firstLength: 0.91, firstShare: 0.227, dive100: 0.72,
    start: 'from the start', feet: 'from feet leaving the block',
  },
  back: {
    boys: { block: 0.58, dive: 0.78 }, girls: { block: 0.62, dive: 0.84 },
    push: 0.82, turnPush: 0.86, rotation: 0.25, contact: 0.30, reach: 0.4, fade: 0.96,
    firstLength: 0.92, firstShare: 0.232, dive100: 0.78,
    start: 'from the signal', feet: 'from feet leaving the wall',
  },
  breast: {
    boys: { block: 0.63, dive: 0.68 }, girls: { block: 0.70, dive: 0.74 },
    push: 0.78, turnPush: 0.82, rotation: 0, contact: 0.45, reach: 0.5, fade: 0.95,
    firstLength: 0.92, firstShare: 0.224, dive100: 0.68,
    start: 'from the start', feet: 'from feet leaving the block',
  },
  fly: {
    boys: { block: 0.63, dive: 0.70 }, girls: { block: 0.70, dive: 0.77 },
    push: 0.80, turnPush: 0.85, rotation: 0, contact: 0.45, reach: 0.5, fade: 0.95,
    firstLength: 0.92, firstShare: 0.221, dive100: 0.70,
    start: 'from the start', feet: 'from feet leaving the block',
  },
  zones: { S2: 0.96, S3: 0.88, S4: 0.82 }, // 50, 100 and 200 race pace as shares of clean speed
};
export const YD15M = 16.4; // 15 m in yards
// Speed zones, with the rest that goes with them (Rushall's USRPT work and
// the sheet's notes): S1 near full recovery, S2 about 1:4, S3 25s on about
// 15 s, S4 50s on about 20 s.
export const ZONES = [
  { key: 'S1', label: 'Max speed', pct: '98–100%', trains: 'alactic power', work: '15 yd flag to flag, 12.5s, 15 m dives; under about 10 s', rest: 'near full recovery', restFor: (swim) => Math.max(60, Math.round(swim * 6)) },
  { key: 'S2', label: '50 race pace', pct: '96%', trains: '50 speed and stroke rate', work: '25s from a push; broken 50s', rest: 'about 1:4', restFor: (swim) => Math.round(swim * 4) },
  { key: 'S3', label: '100 race pace', pct: '88%', trains: 'speed endurance for the 100', work: '25s at 100 pace', rest: '25s on about 15 s (roughly 1:1)', restFor: () => 15 },
  { key: 'S4', label: '200 race pace', pct: '82%', trains: 'speed endurance for the 200', work: '50s at 200 pace', rest: '50s on about 20 s', restFor: () => 20 },
];

const factorsFor = (stroke, sex) => {
  const f = SPEED_FACTORS[stroke] || SPEED_FACTORS.free;
  return { ...f, ...(f[sex] || f.boys), zones: SPEED_FACTORS.zones };
};

// A 50 from clean speed v (yd/s): start, first length, turn, tired second length.
export function fiftyFrom(v, sex = 'boys', stroke = 'free') {
  const F = factorsFor(stroke, sex);
  const first = F.block + (F.dive * YD15M) / v + (25 - YD15M) / v + F.rotation;
  const v2 = v * F.fade;
  const second = F.contact + (F.turnPush * YD15M) / v2 + (25 - YD15M - F.reach) / v2;
  return first + second;
}

// Clean speed from a 50 time (bisection: a faster 50 means a faster v).
export function cleanSpeed(t50, sex = 'boys', stroke = 'free') {
  let lo = 0.6;
  let hi = 4;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (fiftyFrom(mid, sex, stroke) > t50) lo = mid; else hi = mid;
  }
  return +((lo + hi) / 2).toFixed(3);
}

// Everything the Speed Table shows for one 50 time: the start, push and
// 25 benchmarks and the zone targets with their rest, all in seconds.
export function speedTargets(t50, sex = 'boys', stroke = 'free') {
  if (!(t50 > 0)) return null;
  const F = factorsFor(stroke, sex);
  const v = cleanSpeed(t50, sex, stroke);
  const r = (x) => +x.toFixed(2);
  const dive15feet = (F.dive * YD15M) / v;
  const push15 = (F.push * YD15M) / v;
  const toWall25 = (25 - YD15M - F.reach) / v;
  const first25 = F.block + (F.dive100 * YD15M) / v + (25 - YD15M) / (F.firstLength * v) + F.rotation;
  const push25At = (k) => (F.push * YD15M) / (k * v) + (25 - YD15M - F.reach) / (k * v);
  const zones = { S1: r(push25At(1)), S2: r(push25At(F.zones.S2)), S3: r(push25At(F.zones.S3)), S4: r(push25At(F.zones.S4)) };
  return {
    stroke,
    labels: { start: F.start, feet: F.feet },
    cleanSpeed: v,
    flagToFlag15: r(15 / v),
    flagsToWall: r(4.5 / v),
    flagsToFeet: r(5 / v + F.rotation),
    dive15: { fromStart: r(F.block + dive15feet), fromFeet: r(dive15feet) },
    push15: r(push15),
    toFarFlags20: r(F.block + dive15feet + (20 - YD15M) / v),
    dive25: { fromStart: r(F.block + dive15feet + toWall25), fromFeet: r(dive15feet + toWall25) },
    push25: r(push15 + toWall25),
    fifty: r(fiftyFrom(v, sex, stroke)),
    hundred: r(first25 / F.firstShare),
    zones,
    zoneRest: Object.fromEntries(ZONES.map((z) => [z.key, z.restFor(zones[z.key])])),
  };
}

// ---- the swimmer's goals and the gear set built from them

// goals: { sex, age, factor (number | null = worked out), times: { 'free-200':
// { best, goal } }, updatedAt }. The latest entry carrying `goals` wins.
export const latestGoals = (entries) => [...entries].sort((a, b) => b.date.localeCompare(a.date)).find((e) => e.goals)?.goals ?? null;

// Which times feed the gears: 'goal' or 'best'.
export const timesOf = (goals, use = 'goal') => Object.fromEntries(Object.entries(goals?.times || {}).map(([k, t]) => [k, t?.[use] > 0 ? t[use] : null]).filter(([, v]) => v));

// All the gear pages at once: per stroke, IM, speed per stroke with a 50.
export function gearSet(goals, { use = 'goal', per = 100 } = {}) {
  if (!goals) return null;
  const times = timesOf(goals, use);
  const sex = goals.sex || 'girls';
  const ff = fatigueFactor(timesOf(goals, 'best'), goals.factor);
  const opts = { factor: ff.factor, per };
  const speed = {};
  for (const s of ['free', 'back', 'breast', 'fly']) if (times[`${s}-50`] > 0) speed[s] = speedTargets(times[`${s}-50`], sex, s);
  return {
    use,
    factor: ff,
    strokes: Object.fromEntries(['free', 'back', 'breast', 'fly'].map((s) => [s, strokeGears(times, s, opts)])),
    im: imGears(times, { ...opts, sex, age: goals.age || '15-16' }),
    speed,
    hasAny: Object.keys(times).length > 0,
  };
}

// ---- practice times (sets the swimmer logs)

// A set: { stroke, dist, gear ('G2'…'G6', 'S1'…'S4' or 'race'), reps, avg
// (seconds), rest (seconds, optional), note }. Stored on the day's entry as
// `sets`. Trend for one stroke and distance: every set, oldest first, with
// a rolling average of the last `window` sets, and the current gear targets
// for that distance so the chart can show where they sit.
export function setTrend(entries, { stroke, dist, window = 3 }, gearsForStroke = null) {
  const points = [];
  for (const e of [...entries].sort((a, b) => a.date.localeCompare(b.date))) {
    for (const s of e.sets || []) {
      if (s.stroke === stroke && Number(s.dist) === Number(dist) && s.avg > 0) points.push({ date: e.date, ...s });
    }
  }
  const out = points.map((p, i) => {
    const last = points.slice(Math.max(0, i - window + 1), i + 1).map((x) => x.avg);
    return { ...p, rolling: +(last.reduce((a, b) => a + b, 0) / last.length).toFixed(2) };
  });
  const targets = gearsForStroke ? Object.fromEntries(gearsForStroke.gears.map((g) => [g.key, +((g.pace / gearsForStroke.per) * dist).toFixed(1)])) : {};
  return { points: out, targets };
}
