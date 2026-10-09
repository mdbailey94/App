// The daily questionnaire form, shared by the Check-in and Morning screens:
// markup, live behaviour, and reading the answers back. A new day starts
// blank: every answer is the athlete's own for that day.

import { SCALE_MAX, sessionLoad, trainingFrom, WELLNESS_ITEMS } from './readiness.js';
import { esc } from './ui.js';

// Effort, 1–10 (session RPE).
const RPE_LABELS = ['', 'Very, very easy', 'Easy', 'Moderate', 'Somewhat hard', 'Hard', 'Hard+', 'Very hard', 'Very hard+', 'Near maximal', 'Maximal'];
const hoursLabel = (min) => {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return [h ? `${h} h` : '', m ? `${m} min` : ''].filter(Boolean).join(' ');
};

// Yesterday's sessions. Practices ask how long and how hard; weights only how
// hard. Each starts at "Choose…", so "didn't do it" is never a silent default.
const PRACTICES = [
  { key: 'am', title: 'Morning practice', none: 'No morning practice' },
  { key: 'pm', title: 'Afternoon practice', none: 'No afternoon practice' },
];
const choose = (picked) => `<option value="" ${picked ? '' : 'selected'} disabled>Choose…</option>`;

function practiceTimeOptions(none, current) {
  // 30 min to 3 h in half-hour steps; an older odd time (e.g. 75 min) is kept.
  const steps = Array.from({ length: 6 }, (_, i) => 30 + i * 30);
  if (current > 0 && !steps.includes(current)) steps.push(current);
  steps.sort((x, y) => x - y);
  return choose(current !== undefined) + `<option value="0" ${current === 0 ? 'selected' : ''}>${none}</option>`
    + steps.map((m) => `<option value="${m}" ${m === current ? 'selected' : ''}>${hoursLabel(m)}</option>`).join('');
}

const rpeOptions = (current, none) => choose(current !== undefined)
  + (none ? `<option value="0" ${current === null ? 'selected' : ''}>${none}</option>` : '')
  + RPE_LABELS.slice(1).map((l, i) => `<option value="${i + 1}" ${current === i + 1 ? 'selected' : ''}>${i + 1} – ${l}</option>`).join('');

function trainingSection(t) {
  // Today's saved answers when editing; blank for a new day or an older,
  // unsplit check-in.
  const split = t && ['am', 'pm', 'weights'].some((k) => k in t);
  const minutes = (k) => (split ? t[k]?.durationMin ?? 0 : undefined);
  const effort = (k) => (split ? t[k]?.rpe : undefined);
  return `
      <section class="card">
        <h3>Yesterday’s training</h3>
        ${PRACTICES.map((p) => `
        <fieldset class="session">
          <legend>${p.title}</legend>
          <label class="field">How long?
            <select name="${p.key}Min">${practiceTimeOptions(p.none, minutes(p.key))}</select></label>
          <label class="field" data-effort="${p.key}" ${minutes(p.key) > 0 ? '' : 'hidden'}>How hard was it? (1–10)
            <select name="${p.key}Rpe">${rpeOptions(effort(p.key))}</select></label>
        </fieldset>`).join('')}
        <fieldset class="session">
          <legend>Weights</legend>
          <label class="field">How hard was it? (1–10)
            <select name="wtRpe">${rpeOptions(split ? effort('weights') ?? null : undefined, 'No weights')}</select></label>
        </fieldset>
        <p class="muted small" id="load-preview"></p>
      </section>`;
}

const INJURY_LEVELS = [
  'No injury',
  'Minor – discomfort, but manageable',
  'Moderate – affecting my stroke',
  'Major – unable to perform certain strokes or movements',
];

// Quick sleep choices: 4 h to 9 h in half hours; anything else via "Other".
const SLEEP_STEPS = Array.from({ length: 11 }, (_, i) => 4 + i * 0.5);

function scaleField(item, value) {
  return `
    <fieldset class="scale">
      <legend>${esc(item.label)}</legend>
      <div class="scale-options">
        ${Array.from({ length: SCALE_MAX }, (_, i) => i + 1).map((n) => `
          <label><input type="radio" name="${item.key}" value="${n}" ${value === n ? 'checked' : ''} required><span>${n}</span></label>`).join('')}
      </div>
      <div class="scale-ends"><span>${esc(item.low)}</span><span>${esc(item.high)}</span></div>
    </fieldset>`;
}

// The questionnaire sections.
export function checkinSections(e) {
  const w = e.wellness || {};
  const pain = e.pain || { level: 0 };
  const otherSleep = Number.isFinite(w.sleepHours) && !SLEEP_STEPS.includes(w.sleepHours);
  return `
      <section class="card">
        <h3>Sleep</h3>
        <fieldset class="scale">
          <legend>Hours slept last night</legend>
          <div class="chips">
            ${SLEEP_STEPS.map((h) => `
              <label><input type="radio" name="sleepHours" value="${h}" ${w.sleepHours === h ? 'checked' : ''}><span>${h}</span></label>`).join('')}
            <label><input type="radio" name="sleepHours" value="other" ${otherSleep ? 'checked' : ''}><span>Other</span></label>
          </div>
        </fieldset>
        <label class="field" id="sleep-other" ${otherSleep ? '' : 'hidden'}>Hours slept
          <input type="number" name="sleepOther" inputmode="decimal" min="0" max="16" step="0.25" value="${otherSleep ? w.sleepHours : ''}" placeholder="e.g. 3.5"></label>
        ${scaleField(WELLNESS_ITEMS[0], w.sleepQuality)}
      </section>

      <section class="card">
        <h3>How do you feel?</h3>
        <p class="muted small">1 = worst, 7 = best.</p>
        ${WELLNESS_ITEMS.slice(1).map((i) => scaleField(i, w[i.key])).join('')}
      </section>

      <section class="card">
        <h3>Injury</h3>
        <p class="muted small">An injury is pain from a specific problem, such as a strain, sprain, or joint or bone pain.
          Normal muscle soreness from training goes in the soreness question above.</p>
        <fieldset class="choice">
          ${INJURY_LEVELS.map((label, i) => `
            <label><input type="radio" name="painLevel" value="${i}" ${pain.level === i ? 'checked' : ''}> ${esc(label)}</label>`).join('')}
        </fieldset>
        <label class="field" id="pain-location" ${pain.level ? '' : 'hidden'}>What and where?
          <input type="text" name="painLocation" value="${esc(pain.location)}" placeholder="e.g. left hamstring strain"></label>
      </section>

${trainingSection(e.training)}

      <section class="card">
        <h3>Notes <span class="muted small">(optional)</span></h3>
        <label class="field">
          <textarea name="notes" rows="3" aria-label="Notes" placeholder="Anything your coach should know">${esc(e.notes)}</textarea></label>
      </section>`;
}

export function wireCheckin(form) {
  const loadPreview = () => {
    const load = sessionLoad(readTraining(new FormData(form)));
    form.querySelector('#load-preview').textContent = load ? `Practice load: ${load} AU (minutes × effort)` : '';
  };
  form.addEventListener('input', (ev) => {
    ev.target.closest('.missing')?.classList.remove('missing');
    if (ev.target.name === 'painLevel') form.querySelector('#pain-location').hidden = ev.target.value === '0';
    if (ev.target.name === 'sleepHours') form.querySelector('#sleep-other').hidden = ev.target.value !== 'other';
    const practice = /^(am|pm)Min$/.exec(ev.target.name)?.[1];
    if (practice) form.querySelector(`[data-effort="${practice}"]`).hidden = !(Number(ev.target.value) > 0);
    loadPreview();
  });
  loadPreview();
}

// Read the answers: { missing: [labels] } or { patch } ready to save.
export function readCheckin(form) {
  const fd = new FormData(form);
  const unanswered = WELLNESS_ITEMS.filter((i) => !fd.get(i.key));
  const sleepHours = fd.get('sleepHours') === 'other' ? Number(fd.get('sleepOther')) : Number(fd.get('sleepHours'));
  if (!fd.get('sleepHours') || !(sleepHours >= 0 && sleepHours <= 16) || (fd.get('sleepHours') === 'other' && fd.get('sleepOther') === '')) {
    unanswered.unshift({ key: 'sleepHours', label: 'Hours slept' });
  }
  // Training: each practice asks how long, and how hard if they went;
  // weights ask how hard (or "No weights").
  for (const p of PRACTICES) {
    const lower = p.title.toLowerCase();
    if (fd.get(`${p.key}Min`) === null) unanswered.push({ key: `${p.key}Min`, label: `${p.title} time` });
    else if (Number(fd.get(`${p.key}Min`)) > 0 && fd.get(`${p.key}Rpe`) === null) unanswered.push({ key: `${p.key}Rpe`, label: `How hard ${lower} was` });
  }
  if (fd.get('wtRpe') === null) unanswered.push({ key: 'wtRpe', label: 'Weights' });
  if (unanswered.length) return { missing: unanswered.map((i) => i.label), missingKeys: unanswered.map((i) => i.key) };
  const num = (k) => (fd.get(k) === '' || fd.get(k) === null ? undefined : Number(fd.get(k)));
  const painLevel = num('painLevel') || 0;
  const wellness = { sleepHours, scaleMax: SCALE_MAX };
  for (const i of WELLNESS_ITEMS) wellness[i.key] = num(i.key);
  return {
    patch: {
      wellness,
      pain: { level: painLevel, location: painLevel ? fd.get('painLocation').trim() : '' },
      training: readTraining(fd),
      notes: fd.get('notes').trim(),
    },
  };
}

function readTraining(fd) {
  const practice = (k) => {
    const durationMin = Number(fd.get(`${k}Min`));
    return durationMin > 0 ? { durationMin, rpe: Number(fd.get(`${k}Rpe`)) } : null;
  };
  const wt = Number(fd.get('wtRpe'));
  return trainingFrom({ am: practice('am'), pm: practice('pm'), weights: wt > 0 ? { rpe: wt } : null });
}

export function showFormError(form, text, { scroll = true } = {}) {
  const err = form.querySelector('#form-error');
  err.textContent = text;
  err.hidden = !text;
  if (text && scroll) err.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// Unanswered questions: outline each one and take the athlete to the first,
// rather than leaving them to hunt for what's missing.
export function showMissing(form, { missing, missingKeys }) {
  form.querySelectorAll('.missing').forEach((el) => el.classList.remove('missing'));
  const boxes = missingKeys.map((k) => form.querySelector(`[name="${k}"]`)?.closest('fieldset, .field')).filter(Boolean);
  boxes.forEach((el) => el.classList.add('missing'));
  showFormError(form, `Please answer: ${missing.join(', ')}.`, { scroll: !boxes.length });
  boxes[0]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}
