import {
  deleteEntry, exportCSV, exportJSON, getEntry, importJSON, loadEntries, loadSettings,
  loadTeam, saveSettings, todayISO, upsertEntry, clearAll,
} from './storage.js';
import { assessDay, sessionLoad, shiftDate, WELLNESS_ITEMS, wellnessScore } from './readiness.js';
import { PpgCamera, cameraSupported } from './camera.js';
import { drawWaveform } from './charts.js';
import { startReading } from './reading.js';
import { esc, fmt, prettyDate, renderTrends, shortDate, statusBadge } from './ui.js';
import { renderCoach, renderTeam, syncLine } from './coach.js';
import { syncPending, syncStatus } from './team.js';

const view = document.getElementById('view');

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
  return steps.map((m) => `<option value="${m}" ${m === (current ?? 0) ? 'selected' : ''}>${hoursLabel(m)}</option>`).join('');
}

const INJURY_LEVELS = [
  'No injury',
  'Minor – discomfort, but manageable',
  'Moderate – affecting my stroke',
  'Major – unable to perform certain strokes or movements',
];

// Quick sleep choices: 4 h to 10 h in half hours; anything else via "Other".
const SLEEP_STEPS = Array.from({ length: 13 }, (_, i) => 4 + i * 0.5);

// ------------------------------------------------------------------ router

const routes = {
  today: renderToday,
  checkin: renderCheckin,
  morning: (arg, query) => renderMorning(query),
  measure: (arg, query) => renderMeasure(query),
  history: renderHistory,
  team: (arg, query) => renderTeam(view, query, route),
  coach: (arg, query) => renderCoach(view, query),
};
let cleanup = null;

async function route() {
  if (cleanup) { await cleanup(); cleanup = null; }
  const [path, qs] = (location.hash.slice(1) || 'today').split('?');
  const [name, arg] = path.split('/');
  const render = routes[name] || renderToday;
  const tab = !routes[name] ? 'today' : { coach: 'team', morning: 'checkin' }[name] || name;
  document.querySelectorAll('.tabs a').forEach((a) => a.toggleAttribute('aria-current', a.dataset.tab === tab));
  view.innerHTML = '';
  render(arg, new URLSearchParams(qs || ''));
  view.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

// Heart numbers shown plainly: no comparisons, no verdicts.
function heartStats(hrv) {
  return `<div class="stats two">
    <div><span class="stat-num">${fmt(hrv.hr)}</span><span class="stat-label">heart rate (bpm)</span></div>
    <div><span class="stat-num">${fmt(hrv.rmssd)}</span><span class="stat-label">HRV (ms)</span></div>
  </div>`;
}

// ------------------------------------------------------------------- today

function renderToday() {
  const date = todayISO();
  const entries = loadEntries();
  const entry = entries.find((e) => e.date === date);
  // Athletes see a score from their own answers only; HRV goes to the coach
  // and into weekly trends, so one noisy morning reading can't colour the day.
  const a = assessDay(entries, date, { heart: false });
  const answered = Boolean(entry?.wellness);
  const heartDone = Boolean(entry?.hrv);

  view.innerHTML = `
    <section class="card hero">
      <p class="eyebrow">${esc(prettyDate(date))}</p>
      ${answered && a.score !== null ? `
        <div class="score-row">
          <div class="score"><span class="score-num">${a.score}</span><span class="score-max">/100</span></div>
          <div>${statusBadge(a.status)}<p class="advice">${esc(a.status.advice)}</p></div>
        </div>
        <ul class="done-list">
          <li>✓ Questions answered</li>
          <li>${heartDone ? '✓ Heart reading saved' : '<span class="muted">– No heart reading today</span>'}</li>
        </ul>
        <div class="actions">
          <a class="btn secondary" href="#checkin">Edit answers</a>
          <a class="btn secondary" href="#measure">${heartDone ? 'Redo reading' : 'Add reading'}</a>
        </div>` : `
        <h2>Good morning</h2>
        <p class="muted">About a minute: answer a few questions while your phone reads your pulse.</p>
        <a class="btn block" href="#morning">Start my morning check-in</a>`}
      ${a.baselineReadingsNeeded && heartDone ? `<p class="muted small">Keep taking morning readings – after ${a.baselineReadingsNeeded} more, the app knows your normal range.</p>` : ''}
    </section>

    ${heartDone ? `<section class="card"><h3>This morning’s heart</h3>${heartStats(entry.hrv)}</section>` : ''}

    ${answered && a.flags.length ? `<section class="card"><h3>Things to note</h3><ul class="flags">
      ${a.flags.map((f) => `<li>${statusBadge({ level: f.level, label: f.level === 'critical' ? 'Important' : 'Note' })} ${esc(f.text)}</li>`).join('')}
    </ul></section>` : ''}

    <section class="card"><h3>Training load</h3>
      <div class="stats">
        <div><span class="stat-num">${a.load.acute7}</span><span class="stat-label">last 7 days (AU)</span></div>
        <div><span class="stat-num">${a.load.weeklyAvg28}</span><span class="stat-label">4-week weekly avg</span></div>
        <div><span class="stat-num">${a.load.acwr !== null ? a.load.acwr.toFixed(2) : '–'}</span><span class="stat-label">acute:chronic</span></div>
      </div>
      <p class="muted small">Load = training minutes × session RPE.${a.load.acwr === null ? ' Acute:chronic ratio appears after 3 weeks of check-ins.' : ''}</p>
    </section>

    ${syncStatus().joined ? `<p class="sync-line" id="sync-line">${syncLine(syncStatus())}</p>` : ''}

    <p class="disclaimer">For training guidance only — not a medical device. If you feel unwell, speak to a doctor.</p>`;
}

// ----------------------------------------------------------------- check-in

function scaleField(item, value) {
  return `
    <fieldset class="scale">
      <legend>${esc(item.label)}</legend>
      <div class="scale-options">
        ${[1, 2, 3, 4, 5].map((n) => `
          <label><input type="radio" name="${item.key}" value="${n}" ${value === n ? 'checked' : ''} required><span>${n}</span></label>`).join('')}
      </div>
      <div class="scale-ends"><span>${esc(item.low)}</span><span>${esc(item.high)}</span></div>
    </fieldset>`;
}

// The questionnaire sections, shared by the Check-in and Morning screens.
function checkinSections(e) {
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
        <p class="muted small">1 = worst, 5 = best.</p>
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

function wireCheckin(form) {
  const loadPreview = () => {
    const load = sessionLoad({ durationMin: +form.durationMin.value, rpe: +form.rpe.value });
    form.querySelector('#load-preview').textContent = load ? `Session load: ${load} AU` : '';
  };
  form.addEventListener('input', (ev) => {
    if (ev.target.name === 'painLevel') form.querySelector('#pain-location').hidden = ev.target.value === '0';
    if (ev.target.name === 'sleepHours') form.querySelector('#sleep-other').hidden = ev.target.value !== 'other';
    loadPreview();
  });
  loadPreview();
}

// "Same as yesterday": the most recent earlier check-in with answers.
function previousAnswers(date) {
  return loadEntries().filter((x) => x.date < date && x.wellness).at(-1) || null;
}

function sameAsLabel(prev, date) {
  if (prev.date === shiftDate(date, -1)) return 'yesterday';
  return new Date(`${prev.date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long' });
}

// A new day starts from the last check-in's answers (not its notes), so most
// mornings are just a quick review. Returns [entryForForm, noteHtml].
function withDefaults(date, e) {
  const prev = e.wellness ? null : previousAnswers(date);
  if (!prev) return [e, ''];
  const { wellness, pain, training } = prev;
  const note = `
      <section class="card prefill-note">
        <p><b>Pre-filled with your answers from ${esc(sameAsLabel(prev, date))}.</b>
          Change anything that’s different, then save.</p>
      </section>`;
  return [{ ...e, wellness, pain, training }, note];
}

// Read the answers: { missing: [labels] } or { patch } ready to save.
function readCheckin(form) {
  const fd = new FormData(form);
  const missing = WELLNESS_ITEMS.filter((i) => !fd.get(i.key)).map((i) => i.label);
  const sleepHours = fd.get('sleepHours') === 'other' ? Number(fd.get('sleepOther')) : Number(fd.get('sleepHours'));
  if (!fd.get('sleepHours') || !(sleepHours >= 0 && sleepHours <= 16) || (fd.get('sleepHours') === 'other' && fd.get('sleepOther') === '')) {
    missing.unshift('Hours slept');
  }
  if (missing.length) return { missing };
  const num = (k) => (fd.get(k) === '' || fd.get(k) === null ? undefined : Number(fd.get(k)));
  const painLevel = num('painLevel') || 0;
  const wellness = { sleepHours };
  for (const i of WELLNESS_ITEMS) wellness[i.key] = num(i.key);
  return {
    patch: {
      wellness,
      pain: { level: painLevel, location: painLevel ? fd.get('painLocation').trim() : '' },
      training: { durationMin: num('durationMin') || 0, rpe: num('rpe') || 0 },
      notes: fd.get('notes').trim(),
    },
  };
}

function showFormError(form, text) {
  const err = form.querySelector('#form-error');
  err.textContent = text;
  err.hidden = !text;
  if (text) err.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function renderCheckin(dateArg) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateArg || '') ? dateArg : todayISO();
  const [e, prefillNote] = withDefaults(date, getEntry(date) || {});
  view.innerHTML = `
    <form id="checkin" class="stack" novalidate>
      <section class="card">
        <h2>Daily check-in</h2>
        <label class="field">Date <input type="date" name="date" value="${date}" max="${todayISO()}" required></label>
      </section>
      ${prefillNote}
      ${checkinSections(e)}
      <p class="form-error" id="form-error" role="alert" hidden></p>
      <button class="btn block" type="submit">Save check-in</button>
    </form>`;

  const form = view.querySelector('#checkin');
  wireCheckin(form);
  form.date.addEventListener('change', () => {
    if (form.date.value && form.date.value !== date) location.hash = `#checkin/${form.date.value}`;
  });
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const { missing, patch } = readCheckin(form);
    if (missing) { showFormError(form, `Please answer: ${missing.join(', ')}.`); return; }
    upsertEntry(form.date.value, patch);
    location.hash = form.date.value === todayISO() ? '#today' : '#history';
  });
}

// Has this athlete done a camera reading the normal way yet? Doing the reading
// during the check-in is only offered after that.
const hasCameraReading = () => loadEntries().some((x) => x.hrv?.source === 'camera');

// Offer to switch the combined mode on or off. `onChange` re-renders.
function combinedToggle(on, onChange) {
  const html = on
    ? `<p class="muted small toggle-line">Heart reading during check-in: <b>on</b> ·
         <button class="link" type="button" id="combined-toggle">Turn off</button></p>`
    : `<section class="card offer">
         <p><b>Save time:</b> take your heart reading while you answer the questions.</p>
         <button class="btn secondary" type="button" id="combined-toggle">Turn on</button>
       </section>`;
  const wire = (root) => root.querySelector('#combined-toggle')?.addEventListener('click', () => {
    saveSettings({ hrvDuringCheckin: !on });
    onChange();
  });
  return [html, wire];
}

// Running as a Home Screen app rather than in a browser tab?
const isStandalone = () => navigator.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches;

// ------------------------------------------------------ morning check-in
// Questions and the heart reading at the same time: the reading runs in a
// bar pinned at the top while the athlete answers with their other hand.

function renderMorning(query = new URLSearchParams()) {
  const date = todayISO();
  const team = query.has('joined') ? loadTeam() : null;
  const e = getEntry(date) || {};
  const [formEntry, prefillNote] = withDefaults(date, e);
  const settings = loadSettings();
  const supported = cameraSupported();
  const experienced = supported && hasCameraReading();
  // Questions and reading together only once the athlete has opted in; until
  // then the check-in is questions only, followed by the normal HRV screen.
  const combined = experienced && settings.hrvDuringCheckin;
  const [toggleHtml, wireToggle] = experienced ? combinedToggle(combined, () => route()) : ['', () => {}];

  view.innerHTML = `
    ${combined ? `<section class="card reading-bar" id="reading">
      <div class="reading-head">
        <video id="camera" class="preview small" playsinline muted></video>
        <div class="reading-text">
          <b id="reading-title">Heart reading</b>
          <span id="reading-msg" class="muted small">${supported ? 'Cover the flashlight and the camera closest to it, then tap Start.' : 'Camera not available in this browser.'}</span>
        </div>
        ${supported ? '<button class="btn" id="reading-start" type="button">Start</button>' : ''}
      </div>
      <div class="progress" id="reading-progress" hidden><div id="progress-bar"></div></div>
    </section>` : ''}

    ${team ? `<section class="card welcome" role="status">
      <p><b>✓ You’re in, ${esc(team.athlete.split(' ')[0])}!</b> You’ve joined ${esc(team.group)}, and your check-ins will go to your coach.
        Now do today’s check-in below.</p>
      ${isStandalone() ? '' : `<p class="small home-tip">📲 <b>Add this app to your Home Screen now</b>
        (iPhone: Share → Add to Home Screen) – it will remember your group.</p>`}
    </section>` : ''}

    ${combined ? `<section class="card">
      <h2>Morning check-in</h2>
      <ol class="steps">
        <li>Hold your phone in one hand. With a fingertip of that hand, gently cover <b>both the flashlight and the camera closest to it</b> on the back.</li>
        <li>Keep that hand steady – resting your arm on your lap or a table helps.</li>
        <li>Tap <b>Start</b>, then answer the questions with your other hand.</li>
        <li>Tap <b>Save</b> when you’re done. If the reading is still going, it saves as soon as it finishes.</li>
      </ol>
      ${e.hrv ? '<p class="muted small">You already have a heart reading today. Start only if you want to redo it.</p>' : ''}
      ${toggleHtml}
    </section>` : `<section class="card">
      <h2>Morning check-in</h2>
      <p class="muted">Answer the questions, then tap <b>Save</b>.${supported && !e.hrv ? ' Your 1-minute heart reading comes next.' : ''}</p>
    </section>
    ${e.hrv ? '' : toggleHtml}`}

    <form id="checkin" class="stack" novalidate>
      ${prefillNote}
      ${checkinSections(formEntry)}
      <p class="form-error" id="form-error" role="alert" hidden></p>
      <button class="btn block" type="submit" id="save">Save check-in</button>
      <button class="btn secondary block" type="button" id="save-without" hidden>Save answers without a heart reading</button>
    </form>`;

  const $ = (sel) => view.querySelector(sel);
  const form = $('#checkin');
  wireCheckin(form);
  wireToggle(view);

  let state = 'idle'; // idle | running | done | failed
  let hrv = null;
  let pending = null; // answers waiting for the reading to finish
  let reading = null;
  const cam = combined ? new PpgCamera($('#camera')) : null;
  cleanup = async () => { reading?.stop(); await cam?.stop(); };

  const setReading = (title, msg, level) => {
    $('#reading-title').textContent = title;
    $('#reading-msg').textContent = msg;
    $('#reading').dataset.state = level || '';
  };
  const save = (patch) => {
    upsertEntry(date, hrv ? { ...patch, hrv } : patch);
    // Not doing the reading here: go on to the normal HRV screen if today
    // still needs one.
    location.hash = !combined && supported && !e.hrv && !hrv ? '#measure?after=checkin' : '#today';
  };
  const resetSave = () => { $('#save').disabled = false; $('#save').textContent = 'Save check-in'; };

  const start = () => {
    state = 'running';
    hrv = null;
    $('#reading-start').hidden = true;
    $('#reading-progress').hidden = false;
    $('#save-without').hidden = true;
    reading = startReading(cam, {
      durationSec: settings.durationSec,
      posture: settings.posture,
      onMessage: (m) => setReading('Heart reading', m),
      onFinger: (f) => {
        if (f === 'none') setReading('Place your fingertip on the lens', 'Gently cover the flashlight and the camera closest to it.', 'warn');
        else if (f === 'settling') setReading('Hold still…', 'Finding your pulse.');
        else if (f === 'lost') setReading('Finger moved', 'Put it back on the lens.', 'warn');
      },
      onProgress: (frac, left) => {
        $('#progress-bar').style.width = `${frac * 100}%`;
        if (frac > 0) setReading('Reading…', `${left} s left – keep your finger still and carry on answering.`);
      },
    });
    reading.done.then((out) => {
      reading = null;
      $('#reading-progress').hidden = true;
      if (out.cancelled) return;
      $('#reading-start').hidden = false;
      if (out.ok) {
        state = 'done';
        hrv = out.hrv;
        $('#reading-start').textContent = 'Redo';
        setReading('✓ Heart reading done', `${fmt(hrv.hr)} bpm · HRV ${fmt(hrv.rmssd)} ms – you can take your finger off the lens.`, 'ok');
        if (pending) save(pending);
        return;
      }
      state = 'failed';
      $('#reading-start').textContent = 'Try again';
      setReading('Heart reading didn’t work', out.reason, 'warn');
      if (pending) {
        pending = null;
        resetSave();
        $('#save-without').hidden = false;
        showFormError(form, 'The heart reading didn’t work. Try it again, or save your answers without it.');
      }
    });
  };
  $('#reading-start')?.addEventListener('click', start);

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const { missing, patch } = readCheckin(form);
    if (missing) { showFormError(form, `Please answer: ${missing.join(', ')}.`); return; }
    showFormError(form, '');
    if (state === 'running') {
      pending = patch;
      $('#save').disabled = true;
      $('#save').textContent = 'Saving when the heart reading finishes…';
      return;
    }
    if (!combined || state === 'done' || e.hrv) { save(patch); return; }
    $('#save-without').hidden = false;
    showFormError(form, state === 'failed'
      ? 'The heart reading didn’t work. Try it again, or save your answers without it.'
      : 'You haven’t taken today’s heart reading. Tap Start at the top, or save your answers without it.');
  });
  $('#save-without').addEventListener('click', () => {
    const { missing, patch } = readCheckin(form);
    if (missing) { showFormError(form, `Please answer: ${missing.join(', ')}.`); return; }
    hrv = null;
    reading?.stop();
    save(patch);
  });
}

// ------------------------------------------------------------ HRV measure

function renderMeasure(query = new URLSearchParams()) {
  const settings = loadSettings();
  const supported = cameraSupported();
  const afterCheckin = query.get('after') === 'checkin';
  view.innerHTML = `
    ${afterCheckin ? `<section class="card welcome" id="next-step" role="status">
      <p><b>✓ Answers saved.</b> Last step: your 1-minute heart reading.
        <a href="#today" id="skip">Skip for today</a></p>
    </section>` : ''}
    <section class="card" id="measure-intro">
      <h2>Heart reading</h2>
      <p>Uses your phone’s camera and flashlight to see the pulse in your fingertip.</p>
      <ol class="steps">
        <li>Best done each morning right after waking, before coffee, in the same position.</li>
        <li><b>Before tapping Start</b>, gently cover <b>both the flashlight and the camera closest to it</b> with a fingertip. The app checks which camera is covered and uses that one. Pressing hard blocks the pulse.</li>
        <li>Hold the phone steady – resting your arm on your lap or a table helps. The small round preview should glow red or look dark. If you can see the room in it, your finger is on the wrong lens.</li>
        <li>Breathe normally and stay still and quiet until it finishes.</li>
      </ol>
      <div class="row">
        <label class="field">Position
          <select id="posture">
            ${['lying', 'sitting', 'standing'].map((p) => `<option ${settings.posture === p ? 'selected' : ''}>${p}</option>`).join('')}
          </select></label>
        <label class="field">Duration
          <select id="duration">
            ${[60, 120, 180].map((s) => `<option value="${s}" ${settings.durationSec === s ? 'selected' : ''}>${s / 60} min</option>`).join('')}
          </select></label>
      </div>
      ${supported ? '<button class="btn block" id="start">Start reading</button>'
    : '<p class="form-error">Camera access needs a secure (https) page in a modern browser.</p>'}
      <details class="small"><summary>Have a chest strap or other HRV app?</summary>
        <form id="manual" class="stack">
          <div class="row">
            <label class="field">Resting HR (bpm) <input name="hr" type="number" inputmode="decimal" min="25" max="200" required></label>
            <label class="field">RMSSD (ms) <input name="rmssd" type="number" inputmode="decimal" min="1" max="400" step="0.1" required></label>
          </div>
          <button class="btn secondary" type="submit">Save manual reading</button>
        </form>
      </details>
    </section>

    <section class="card" id="measure-live" hidden>
      <div class="live-head">
        <span id="finger" class="status status-warning"><span class="status-icon" aria-hidden="true">!</span>Place finger on lens</span>
        <span id="countdown" class="countdown"></span>
      </div>
      <div class="live-main">
        <video id="camera" class="preview" playsinline muted></video>
      </div>
      <canvas id="wave" class="wave" aria-label="Pulse detected"></canvas>
      <div class="progress"><div id="progress-bar"></div></div>
      <p id="live-msg" class="muted small"></p>
      <button class="btn secondary block" id="cancel">Cancel</button>
    </section>

    <section class="card" id="measure-result" hidden></section>`;

  const $ = (sel) => view.querySelector(sel);
  $('#posture').addEventListener('change', (e) => saveSettings({ posture: e.target.value }));
  $('#duration').addEventListener('change', (e) => saveSettings({ durationSec: +e.target.value }));

  $('#manual').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const hr = +ev.target.hr.value;
    const rmssd = +ev.target.rmssd.value;
    upsertEntry(todayISO(), {
      hrv: { hr, rmssd, lnRmssd: Math.log(rmssd), source: 'manual', posture: $('#posture').value, measuredAt: new Date().toISOString() },
    });
    location.hash = '#today';
  });

  if (!supported) return;
  const cam = new PpgCamera($('#camera'));
  let reading = null;
  cleanup = async () => { reading?.stop(); await cam.stop(); };

  const setFinger = (ok, text) => {
    $('#finger').className = `status status-${ok ? 'good' : 'warning'}`;
    $('#finger').innerHTML = `<span class="status-icon" aria-hidden="true">${ok ? '✓' : '!'}</span>${text}`;
  };
  const showResult = (html) => {
    $('#measure-live').hidden = true;
    const box = $('#measure-result');
    box.hidden = false;
    box.innerHTML = html;
  };

  $('#start').addEventListener('click', () => {
    $('#measure-intro').hidden = true;
    $('#next-step')?.remove();
    $('#measure-live').hidden = false;
    reading = startReading(cam, {
      durationSec: +$('#duration').value,
      posture: $('#posture').value,
      onMessage: (m) => { $('#live-msg').textContent = m; },
      onFinger: (f) => setFinger(f === 'recording' || f === 'settling',
        { none: 'Place finger on lens', settling: 'Hold still…', recording: 'Reading', lost: 'Finger moved' }[f]),
      onProgress: (frac, left) => {
        $('#progress-bar').style.width = `${frac * 100}%`;
        $('#countdown').textContent = frac > 0 ? `${left} s` : '';
      },
      onWave: (values, peaks) => drawWaveform($('#wave'), values, peaks),
    });
    reading.done.then((out) => {
      reading = null;
      if (out.cancelled) return;
      if (out.ok) {
        // No numbers here on purpose: single readings vary a lot, so the
        // athlete sees the weekly trend and the coach sees the details.
        upsertEntry(todayISO(), { hrv: out.hrv });
        // After a first reading the normal way, offer to do it during the check-in.
        const [offer, wireOffer] = loadSettings().hrvDuringCheckin ? ['', () => {}]
          : combinedToggle(false, () => {
            const card = view.querySelector('#measure-result .offer');
            if (card) card.innerHTML = '<p><b>✓ Turned on.</b> Next time, your heart reading runs while you answer the questions.</p>';
          });
        showResult(`<h3>✓ Reading saved</h3>
          ${heartStats(out.hrv)}
          <a class="btn block" href="#today">Done</a>
          ${offer}`);
        wireOffer(view);
        return;
      }
      showResult(`<h3>${out.poor ? 'Weak signal' : 'Reading didn’t work'}</h3><p>${esc(out.reason)}</p>
        <p class="muted small">Tip: rest your arm on your lap or a table, press lightly, and stay still and quiet.</p>
        <button class="btn block" id="retry">Try again</button>`);
      $('#retry').onclick = () => route();
    });
  });
  $('#cancel').addEventListener('click', () => { reading?.stop(); route(); });
}

// ----------------------------------------------------------------- history

function download(name, type, text) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderHistory() {
  const entries = loadEntries();
  view.innerHTML = `
    <div id="trends"></div>

    <section class="card"><h3>Entries</h3>
      ${entries.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Date</th><th>Ready</th><th>Well</th><th>HR</th><th>HRV</th><th>Load</th><th></th></tr></thead>
        <tbody>${[...entries].reverse().map((e) => {
    const a = assessDay(entries, e.date, { heart: false });
    return `<tr>
            <td><a href="#checkin/${e.date}">${esc(shortDate(e.date))}</a></td>
            <td>${a.score ?? '–'}</td>
            <td>${wellnessScore(e.wellness) ?? '–'}</td>
            <td>${fmt(e.hrv?.hr)}</td>
            <td>${fmt(e.hrv?.rmssd)}</td>
            <td>${sessionLoad(e.training) || '–'}</td>
            <td><button class="link danger" data-del="${e.date}" aria-label="Delete ${e.date}">Delete</button></td>
          </tr>`;
  }).join('')}</tbody></table></div>` : '<p class="muted">No entries yet. Start with today’s check-in.</p>'}
    </section>

    <section class="card"><h3>Your data</h3>
      <p class="muted small">${syncStatus().joined
    ? 'Stored on this device and shared with your coach’s group sheet (see Team).'
    : 'Everything is stored only on this device. Export regularly to back it up, or join your group in the Team tab.'}</p>
      <div class="actions wrap">
        <button class="btn secondary" id="csv">Export CSV</button>
        <button class="btn secondary" id="json">Backup</button>
        <label class="btn secondary">Restore<input type="file" id="import" accept="application/json,.json" hidden></label>
        <button class="btn secondary danger" id="clear">Delete all</button>
      </div>
    </section>`;

  const $ = (sel) => view.querySelector(sel);
  renderTrends($('#trends'), entries, { athlete: true });

  view.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
    if (confirm(`Delete the entry for ${b.dataset.del}?`)) { deleteEntry(b.dataset.del); route(); }
  }));
  $('#csv').onclick = () => download(`athlete-readiness-${todayISO()}.csv`, 'text/csv', exportCSV());
  $('#json').onclick = () => download(`athlete-readiness-backup-${todayISO()}.json`, 'application/json', exportJSON());
  $('#import').onchange = async (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    try {
      const n = importJSON(await file.text());
      alert(`Imported ${n} entries.`);
      route();
    } catch (err) {
      alert(`Import failed: ${err.message}`);
    }
  };
  $('#clear').onclick = () => {
    if (confirm('Delete ALL entries from this device? Export a backup first if you want to keep them.')) { clearAll(); route(); }
  };
}

// -------------------------------------------------------------------- boot

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  // When an update takes over, reload so every file comes from the new
  // release — but not in the middle of a check-in or HRV reading; then wait
  // for the next screen change.
  const hadController = Boolean(navigator.serviceWorker.controller);
  let updateReady = false;
  const busy = () => /^#(checkin|measure|morning)/.test(location.hash);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController || updateReady) return;
    updateReady = true;
    if (!busy()) location.reload();
  });
  window.addEventListener('hashchange', () => { if (updateReady) location.reload(); });
  // Browsers check for updates lazily (iPhones especially), so ask on every
  // open and whenever the app comes back on screen.
  navigator.serviceWorker.register('sw.js')
    .then((reg) => {
      reg.update().catch(() => {});
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    })
    .catch(() => {});
}
// Send new or edited days to the group sheet whenever there's a chance.
function sync() {
  syncPending().then(() => {
    const line = document.getElementById('sync-line');
    if (line) line.innerHTML = syncLine(syncStatus());
  });
}
window.addEventListener('hashchange', sync);
window.addEventListener('online', sync);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
setInterval(() => { if (syncStatus().pending) sync(); }, 60000);

// A Home Screen app on iPhone starts with empty storage but keeps the address
// it was added from. If that address carries group details and this copy
// hasn't joined yet, open the (pre-filled) join screen: one tap to finish.
if (!loadTeam() && new URLSearchParams(location.search).get('u') && !/^#(team|coach)/.test(location.hash)) {
  history.replaceState(null, '', `${location.pathname}${location.search}#team`);
}

route();
sync();
