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

// Training questions. Each practice: how long (a drop-down that starts at
// the usual length, so most days it's untouched) and how hard (ten small
// buttons, nothing picked). Then two yes/no questions: weights, and a meet.
// Afternoon practice is a yes/no first (many days have none); a Yes brings
// up its time and effort. Morning practice asks time and effort straight away.
const PRACTICES = [
  { key: 'am', title: 'Morning practice', usual: 120 },
  { key: 'pm', title: 'Afternoon practice', usual: 90, askFirst: true },
];
const YES_NO = [
  { key: 'weights', title: 'Weights?' },
  { key: 'meet', title: 'Meet?' },
];
const checked = (on) => (on ? 'checked' : '');

function timeOptions(current, { none = true } = {}) {
  // (No practice,) then 30 min to 5 h in half hours; an older odd time (e.g. 75 min) is kept.
  const steps = Array.from({ length: 10 }, (_, i) => 30 + i * 30);
  if (current > 0 && !steps.includes(current)) steps.push(current);
  steps.sort((x, y) => x - y);
  return (none ? `<option value="0" ${current === 0 ? 'selected' : ''}>No practice</option>` : '')
    + steps.map((m) => `<option value="${m}" ${m === current ? 'selected' : ''}>${hoursLabel(m)}</option>`).join('');
}

const yesNoButtons = (name, value) => `
          <div class="chips yn">
            <label><input type="radio" name="${name}" value="yes" ${checked(value === true)}><span>Yes</span></label>
            <label><input type="radio" name="${name}" value="no" ${checked(value === false)}><span>No</span></label>
          </div>`;

// Ten small squares in one row, green (easy) to blue (maximal): effort isn't
// good or bad, so no red.
function effortButtons(name, current) {
  return `<div class="effort-row" role="radiogroup" aria-label="How hard, 1 to 10">
    ${RPE_LABELS.slice(1).map((l, i) => `<label style="--hue:${140 + i * 9}" title="${i + 1} – ${l}"><input type="radio" name="${name}" value="${i + 1}" ${checked(current === i + 1)} aria-label="${i + 1} – ${l}"><span>${i + 1}</span></label>`).join('')}
  </div>`;
}

// The training card. `prefix` keeps the fields apart when a second card is
// on screen (the Monday question about Saturday).
export function trainingSection(t, { title = 'Yesterday’s training', prefix = '' } = {}) {
  // Saved answers when editing today; otherwise the usual practice lengths.
  const split = t && PRACTICES.some((p) => p.key in t);
  const minutes = (p) => (split ? t[p.key]?.durationMin ?? (p.askFirst ? p.usual : 0) : p.usual);
  const effort = (p) => (split ? t[p.key]?.rpe : undefined);
  const yesNo = (k) => (split ? Boolean(t[k]) : undefined);
  const timeAndEffort = (p) => `
          <label class="field inline-q"><span class="q">How long?</span>
            <select name="${prefix}${p.key}Min">${timeOptions(minutes(p), { none: !p.askFirst })}</select></label>
          <div class="field" data-effort="${prefix}${p.key}" ${p.askFirst || minutes(p) > 0 ? '' : 'hidden'}>
            <span class="q">How hard was it?</span>
            ${effortButtons(`${prefix}${p.key}Rpe`, effort(p))}</div>`;
  return `
      <section class="card training" data-prefix="${prefix}">
        <h3>${esc(title)}</h3>
        ${PRACTICES.map((p) => (p.askFirst ? `
        <fieldset class="session asked-first">
          <div class="field inline-q yes-no"><span class="q">${p.title}?</span>${yesNoButtons(`${prefix}${p.key}Did`, yesNo(p.key))}</div>
          <div data-details="${prefix}${p.key}" ${yesNo(p.key) ? '' : 'hidden'}>
            ${timeAndEffort(p)}
          </div>
        </fieldset>` : `
        <fieldset class="session">
          <legend>${p.title}</legend>
          ${timeAndEffort(p)}
        </fieldset>`)).join('')}
        ${YES_NO.map((q) => `
        <div class="field inline-q yes-no"><span class="q">${q.title}</span>${yesNoButtons(`${prefix}${q.key}`, yesNo(q.key))}</div>`).join('')}
        <p class="muted small" data-load-preview="${prefix}"></p>
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
    const fd = new FormData(form);
    form.querySelectorAll('[data-load-preview]').forEach((el) => {
      const load = sessionLoad(readTraining(fd, el.dataset.loadPreview));
      el.textContent = load ? `Training load: ${load} AU (minutes × effort; weights count as 45 min, hard)` : '';
    });
  };
  form.addEventListener('input', (ev) => {
    ev.target.closest('.missing')?.classList.remove('missing');
    if (ev.target.name === 'painLevel') form.querySelector('#pain-location').hidden = ev.target.value === '0';
    if (ev.target.name === 'sleepHours') form.querySelector('#sleep-other').hidden = ev.target.value !== 'other';
    const practice = /^(.*am)Min$/.exec(ev.target.name)?.[1];
    if (practice) form.querySelector(`[data-effort="${practice}"]`).hidden = !(Number(ev.target.value) > 0);
    const asked = /^(.*pm)Did$/.exec(ev.target.name)?.[1];
    if (asked) form.querySelector(`[data-details="${asked}"]`).hidden = ev.target.value !== 'yes';
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
  unanswered.push(...trainingMissing(fd));
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

// Unanswered training questions: how hard, for each practice they went to,
// and both yes/no questions.
// Did they go? A practice asked first (afternoon) counts only after a Yes.
const went = (fd, prefix, p) => (p.askFirst ? fd.get(`${prefix}${p.key}Did`) === 'yes' : true)
  && Number(fd.get(`${prefix}${p.key}Min`)) > 0;

function trainingMissing(fd, prefix = '') {
  const out = [];
  for (const p of PRACTICES) {
    if (p.askFirst && fd.get(`${prefix}${p.key}Did`) === null) {
      out.push({ key: `${prefix}${p.key}Did`, label: `${p.title}?` });
    } else if (went(fd, prefix, p) && fd.get(`${prefix}${p.key}Rpe`) === null) {
      out.push({ key: `${prefix}${p.key}Rpe`, label: `How hard ${p.title.toLowerCase()} was` });
    }
  }
  for (const q of YES_NO) if (fd.get(`${prefix}${q.key}`) === null) out.push({ key: `${prefix}${q.key}`, label: q.title });
  return out;
}

function readTraining(fd, prefix = '') {
  const practice = (p) => (went(fd, prefix, p)
    ? { durationMin: Number(fd.get(`${prefix}${p.key}Min`)), rpe: Number(fd.get(`${prefix}${p.key}Rpe`)) }
    : null);
  return trainingFrom({
    am: practice(PRACTICES[0]), pm: practice(PRACTICES[1]),
    weights: fd.get(`${prefix}weights`) === 'yes', meet: fd.get(`${prefix}meet`) === 'yes',
  });
}

// Just a training card (the Monday question about Saturday): { missing } or { training }.
export function readTrainingOnly(form, prefix) {
  const fd = new FormData(form);
  const unanswered = trainingMissing(fd, prefix);
  if (unanswered.length) return { missing: unanswered.map((i) => i.label), missingKeys: unanswered.map((i) => i.key) };
  return { training: readTraining(fd, prefix) };
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
