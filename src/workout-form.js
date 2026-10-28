// The Workouts tab's form for one day's training: for each practice, did
// they go (how long, how hard, how well they did) or why not (off day,
// sick, missed, other); then weights and a meet. Swimmers log on the day or later
// (backfilling); doubles can be left unanswered and filled in later.

import { MEET_LEVELS, PRACTICE_KEYS, SKIP_REASONS, sessionLoad, trainingFromWorkouts } from './readiness.js';
import { esc } from './ui.js';

// Morning practice, and doubles (a second practice later in the day). Only
// a missed morning practice asks why; doubles aren't every day, so doubles,
// weights and meet start on No.
export const PRACTICES = [
  { key: 'am', title: 'Morning practice', tag: 'AM', short: 'AM', usual: 120, askWhy: true },
  { key: 'pm', title: 'Doubles', tag: 'Doubles', short: 'Dbl', usual: 90 },
];
// Doubles are asked about once they could have happened: for today after
// 4:30 pm, and any time for earlier days (logged the next morning).
export const DOUBLES_FROM = 16 * 60 + 30;
// From 6:30 am the check-in also asks about today's morning practice (a
// swimmer who checks in after practice rates the one they just swam).
export const TODAY_FROM = 6 * 60 + 30;
export const asksToday = (now = new Date()) => now.getHours() * 60 + now.getMinutes() >= TODAY_FROM;
export function asksDoubles(date, today, now = new Date()) {
  return date < today || now.getHours() * 60 + now.getMinutes() >= DOUBLES_FROM;
}
const checked = (on) => (on ? 'checked' : '');
const hoursLabel = (min) => {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return [h ? `${h} h` : '', m ? `${m} min` : ''].filter(Boolean).join(' ');
};

// "2h", "1½h", "45m": for tight lists.
const shortHours = (min) => {
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h}${m === 30 ? '½' : m ? `:${String(m).padStart(2, '0')}` : ''}h` : `${m}m`;
};

// 30 min to 5 h in half hours; an older odd time (e.g. 75 min) is kept.
function timeOptions(current) {
  const steps = Array.from({ length: 10 }, (_, i) => 30 + i * 30);
  if (current > 0 && !steps.includes(current)) steps.push(current);
  steps.sort((x, y) => x - y);
  return steps.map((m) => `<option value="${m}" ${m === current ? 'selected' : ''}>${hoursLabel(m)}</option>`).join('');
}

export const yesNoButtons = (name, value) => `
          <div class="chips yn">
            <label><input type="radio" name="${name}" value="yes" ${checked(value === true)}><span>Yes</span></label>
            <label><input type="radio" name="${name}" value="no" ${checked(value === false)}><span>No</span></label>
          </div>`;

// Ten small squares in one row, 1–10.
function tenButtons(name, current, label) {
  return `<div class="effort-row" role="radiogroup" aria-label="${esc(label)}, 1 to 10">
    ${Array.from({ length: 10 }, (_, i) => `<label style="--hue:${140 + i * 9}"><input type="radio" name="${name}" value="${i + 1}" ${checked(current === i + 1)} aria-label="${i + 1}"><span>${i + 1}</span></label>`).join('')}
  </div>`;
}

// What to show in the form: the day's logged workouts, or (older days) what
// the next morning's check-in reported, converted. Reasons for no practice
// weren't asked before, so those come back unanswered.
export function formValues(workouts, legacy) {
  if (workouts) return workouts;
  if (!legacy || !PRACTICE_KEYS.some((k) => k in legacy)) return {};
  const v = { weights: legacy.weights, meet: legacy.meet, meetLevel: legacy.meetLevel };
  for (const k of PRACTICE_KEYS) v[k] = legacy[k]?.durationMin > 0 ? { ...legacy[k] } : { none: null };
  return v;
}

export function workoutSections(v = {}, { doubles = true } = {}) {
  const went = (k) => (v[k] ? v[k].durationMin > 0 : undefined);
  return `
      ${PRACTICES.filter((p) => doubles || p.key !== 'pm').map((p) => {
    const s = v[p.key] || {};
    return `
      <section class="card session-card" data-session="${p.key}">
        <div class="field inline-q yes-no"><span class="q">${p.title}?</span>${yesNoButtons(`${p.key}Did`, went(p.key) ?? (p.askWhy ? undefined : false))}</div>
        <div data-went="${p.key}" ${went(p.key) ? '' : 'hidden'}>
          <label class="field inline-q"><span class="q">How long?</span>
            <select name="${p.key}Min">${timeOptions(s.durationMin || p.usual)}</select></label>
          <div class="field"><span class="q">How hard was it?</span>${tenButtons(`${p.key}Rpe`, s.rpe, 'How hard')}</div>
          <div class="field"><span class="q">How well did you do?</span>${tenButtons(`${p.key}Perf`, s.perf, 'How well you did')}
            <div class="scale-ends"><span>Not well</span><span>Very well</span></div></div>
        </div>
        ${p.askWhy ? `<div class="field" data-skipped="${p.key}" ${went(p.key) === false ? '' : 'hidden'}><span class="q">Why not?</span>
          <div class="chips reasons">${Object.entries(SKIP_REASONS).map(([k, l]) => `
            <label><input type="radio" name="${p.key}Why" value="${k}" ${checked(s.none === k)}><span>${l}</span></label>`).join('')}</div>
          <label class="field" data-note="${p.key}" ${s.none === 'other' ? '' : 'hidden'}>What happened? <span class="muted small">(optional)</span>
            <input type="text" name="${p.key}Note" maxlength="120" value="${esc(s.note || '')}"></label>
        </div>` : ''}
      </section>`;
  }).join('')}
      <section class="card">
        <div class="field inline-q yes-no"><span class="q">Weights?</span>${yesNoButtons('weights', v.weights ?? false)}</div>
        <div class="field inline-q yes-no"><span class="q">Meet?</span>${yesNoButtons('meet', v.meet ?? false)}</div>
        <div class="field inline-q" data-meet ${v.meet ? '' : 'hidden'}><span class="q">How hard?</span>
          <div class="chips meet-level">${Object.entries(MEET_LEVELS).map(([k, l]) => `
            <label><input type="radio" name="meetLevel" value="${k}" ${checked(v.meet && (v.meetLevel || 'moderate') === k)}><span>${l.label}</span></label>`).join('')}
          </div></div>
        <p class="muted small" data-load-preview></p>
      </section>`;
}

// Read the form: { missing, missingKeys } for half-answered questions, or
// { workouts }. Morning practice must be answered; doubles can be left for
// later.
export function readWorkouts(form) {
  const fd = new FormData(form);
  const missing = [];
  const w = {};
  for (const p of PRACTICES) {
    const did = fd.get(`${p.key}Did`);
    if (did === 'yes') {
      const rpe = Number(fd.get(`${p.key}Rpe`));
      const perf = Number(fd.get(`${p.key}Perf`));
      if (!rpe) missing.push({ key: `${p.key}Rpe`, label: `How hard ${p.title.toLowerCase()} was` });
      if (!perf) missing.push({ key: `${p.key}Perf`, label: `How well you did at ${p.title.toLowerCase()}` });
      w[p.key] = { durationMin: Number(fd.get(`${p.key}Min`)), rpe, perf };
    } else if (did === 'no' && !p.askWhy) {
      w[p.key] = { none: null }; // didn't do doubles: no reason asked
    } else if (did === 'no') {
      const why = fd.get(`${p.key}Why`);
      if (!why) missing.push({ key: `${p.key}Why`, label: `Why no ${p.title.toLowerCase()}` });
      w[p.key] = { none: why, ...(why === 'other' && fd.get(`${p.key}Note`).trim() ? { note: fd.get(`${p.key}Note`).trim() } : {}) };
    }
  }
  for (const k of ['weights', 'meet']) if (fd.get(k)) w[k] = fd.get(k) === 'yes';
  if (w.meet) {
    if (!fd.get('meetLevel')) missing.push({ key: 'meetLevel', label: 'How hard the meet was' });
    else w.meetLevel = fd.get('meetLevel');
  }
  // Doubles, weights and meet start on No, so morning practice is the one
  // answer that says the day was actually filled in.
  if (!w.am) missing.unshift({ key: 'amDid', label: `${PRACTICES[0].title}?` });
  if (missing.length) return { missing: missing.map((m) => m.label), missingKeys: missing.map((m) => m.key) };
  return { workouts: w };
}

// Whether every question for the day has an answer (doubles only once asked).
export const complete = (w, { doubles = true } = {}) => Boolean(w)
  && PRACTICES.every((p) => w[p.key] || (p.key === 'pm' && !doubles)) && 'weights' in w && 'meet' in w;

export function wireWorkouts(form) {
  const preview = form.querySelector('[data-load-preview]');
  const update = () => {
    const out = readWorkouts(form);
    const load = out.workouts ? sessionLoad(trainingFromWorkouts(out.workouts)) : 0;
    preview.textContent = load ? `Training load: ${load} (minutes × effort; weights count as 45 min, hard)` : '';
  };
  form.addEventListener('input', (ev) => {
    const t = ev.target;
    t.closest('.missing')?.classList.remove('missing');
    const did = /^(am|pm)Did$/.exec(t.name)?.[1];
    if (did) {
      form.querySelector(`[data-went="${did}"]`).hidden = t.value !== 'yes';
      const why = form.querySelector(`[data-skipped="${did}"]`);
      if (why) why.hidden = t.value !== 'no';
    }
    const why = /^(am|pm)Why$/.exec(t.name)?.[1];
    if (why) form.querySelector(`[data-note="${why}"]`).hidden = t.value !== 'other';
    if (t.name === 'meet') form.querySelector('[data-meet]').hidden = t.value !== 'yes';
    update();
  });
  update();
}

// One line per day: "AM 2 h · effort 7 · how well 8/10 · Doubles 1 h 30 min …",
// or `short` for lists: "AM 2h 7·8 · Dbl 1½h 6·7 · Wt" (time, effort·how well).
// No doubles shows nothing.
// The day's practices as parts: [{ tag, text, kind }], kind = 'swim' | 'off' | 'extra'.
export function workoutParts(w, { short = false } = {}) {
  if (!w) return [];
  const part = (p) => {
    const s = w[p.key];
    if (!s) return null;
    const tag = short ? p.short : p.tag;
    if (s.durationMin > 0) {
      return { tag, kind: 'swim', text: short ? `${shortHours(s.durationMin)} ${s.rpe}${s.perf ? `·${s.perf}` : ''}`
        : `${hoursLabel(s.durationMin)} · effort ${s.rpe}${s.perf ? ` · how well ${s.perf}/10` : ''}` };
    }
    if (!s.none) return p.askWhy ? { tag, kind: 'off', text: 'no' } : null;
    const why = SKIP_REASONS[s.none].toLowerCase();
    return { tag, kind: 'off', text: short ? why.replace(' day', '') : why };
  };
  return [...PRACTICES.map(part),
    w.weights && { tag: short ? 'Wt' : 'Weights', kind: 'extra', text: '' },
    w.meet && { tag: 'Meet', kind: 'extra', text: w.meetLevel && !short ? `(${w.meetLevel})` : '' }].filter(Boolean);
}

export function workoutSummary(w, opts) {
  return workoutParts(w, opts).map((x) => [x.tag, x.text].filter(Boolean).join(' ')).join(' · ');
}
