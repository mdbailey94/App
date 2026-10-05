// The daily questionnaire form, shared by the Check-in and Morning screens:
// markup, live behaviour, and reading the answers back. A new day starts
// blank: every answer is the athlete's own for that day.

import { SCALE_MAX, sessionLoad, WELLNESS_ITEMS } from './readiness.js';
import { esc } from './ui.js';

const RPE_LABELS = ['Rest', 'Very, very easy', 'Easy', 'Moderate', 'Somewhat hard', 'Hard', 'Hard+', 'Very hard', 'Very hard+', 'Near maximal', 'Maximal'];
// Training time in half-hour steps, stored as minutes.
const hoursLabel = (min) => {
  if (!min) return 'Rest day';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return [h ? `${h} h` : '', m ? `${m} min` : ''].filter(Boolean).join(' ');
};

function trainingTimeOptions(current) {
  // Rest day, then 1 h to 5 h in half-hour steps.
  const steps = [0, ...Array.from({ length: 9 }, (_, i) => 60 + i * 30)];
  // Keep an older entry's exact time (e.g. 75 min) rather than silently rounding it.
  if (Number.isFinite(current) && !steps.includes(current)) steps.push(current);
  steps.sort((a, b) => a - b);
  // Nothing is chosen until the athlete picks, so "Rest day" is never a silent default.
  return `<option value="" ${Number.isFinite(current) ? '' : 'selected'} disabled>Choose…</option>`
    + steps.map((m) => `<option value="${m}" ${m === current ? 'selected' : ''}>${hoursLabel(m)}</option>`).join('');
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
  const t = e.training || {};
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

      <section class="card">
        <h3>Yesterday’s training</h3>
        <label class="field">How long did you train yesterday? (all sessions)
          <select name="durationMin">${trainingTimeOptions(t.durationMin)}</select></label>
        <label class="field">How hard was it overall? (session RPE)
          <select name="rpe">
            <option value="" ${Number.isFinite(t.rpe) ? '' : 'selected'} disabled>Choose…</option>
            ${RPE_LABELS.map((l, i) => `<option value="${i}" ${t.rpe === i ? 'selected' : ''}>${i} – ${l}</option>`).join('')}
          </select></label>
        <p class="muted small" id="load-preview"></p>
      </section>

      <section class="card">
        <h3>Notes <span class="muted small">(optional)</span></h3>
        <label class="field">
          <textarea name="notes" rows="3" aria-label="Notes" placeholder="Anything your coach should know">${esc(e.notes)}</textarea></label>
      </section>`;
}

export function wireCheckin(form) {
  const loadPreview = () => {
    const load = sessionLoad({ durationMin: +form.durationMin.value, rpe: +form.rpe.value });
    form.querySelector('#load-preview').textContent = load ? `Session load: ${load} AU` : '';
  };
  form.addEventListener('input', (ev) => {
    ev.target.closest('.missing')?.classList.remove('missing');
    if (ev.target.name === 'painLevel') form.querySelector('#pain-location').hidden = ev.target.value === '0';
    if (ev.target.name === 'sleepHours') form.querySelector('#sleep-other').hidden = ev.target.value !== 'other';
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
  // Training: how long is always asked; how hard only when they trained.
  const trained = Number(fd.get('durationMin')) > 0;
  if (!fd.get('durationMin')) unanswered.push({ key: 'durationMin', label: 'Yesterday’s training time' });
  else if (trained && fd.get('rpe') === null) unanswered.push({ key: 'rpe', label: 'How hard training was' });
  if (unanswered.length) return { missing: unanswered.map((i) => i.label), missingKeys: unanswered.map((i) => i.key) };
  const num = (k) => (fd.get(k) === '' || fd.get(k) === null ? undefined : Number(fd.get(k)));
  const painLevel = num('painLevel') || 0;
  const wellness = { sleepHours, scaleMax: SCALE_MAX };
  for (const i of WELLNESS_ITEMS) wellness[i.key] = num(i.key);
  return {
    patch: {
      wellness,
      pain: { level: painLevel, location: painLevel ? fd.get('painLocation').trim() : '' },
      training: { durationMin: num('durationMin') || 0, rpe: trained ? num('rpe') || 0 : 0 },
      notes: fd.get('notes').trim(),
    },
  };
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
