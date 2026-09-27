import {
  deleteEntry, exportCSV, exportJSON, getEntry, importJSON, loadEntries, loadSettings,
  saveSettings, todayISO, upsertEntry, clearAll,
} from './storage.js';
import { assessDay, sessionLoad, SYMPTOMS, WELLNESS_ITEMS, wellnessScore, baseline } from './readiness.js';
import { analyzePPG, bandpass, fingerDetected, liveHeartRate, dominantPeriod, findPeaks } from './signal.js';
import { PpgCamera, cameraSupported } from './camera.js';
import { barChart, drawWaveform, lineChart } from './charts.js';

const view = document.getElementById('view');

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const fmt = (v, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : '–');
const prettyDate = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const shortDate = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

const STATUS_ICON = { good: '✓', warning: '!', serious: '▼', critical: '✕' };
const RPE_LABELS = ['Rest', 'Very, very easy', 'Easy', 'Moderate', 'Somewhat hard', 'Hard', 'Hard+', 'Very hard', 'Very hard+', 'Near maximal', 'Maximal'];
const PAIN_LEVELS = ['None', 'Mild – doesn’t affect training', 'Moderate – affects training', 'Severe – can’t train normally'];

// ------------------------------------------------------------------ router

const routes = { today: renderToday, checkin: renderCheckin, measure: renderMeasure, history: renderHistory };
let cleanup = null;

async function route() {
  if (cleanup) { await cleanup(); cleanup = null; }
  const [name, arg] = (location.hash.slice(1) || 'today').split('/');
  const render = routes[name] || renderToday;
  document.querySelectorAll('.tabs a').forEach((a) => a.toggleAttribute('aria-current', a.dataset.tab === name));
  view.innerHTML = '';
  render(arg);
  view.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

function statusBadge(status) {
  if (!status) return '';
  return `<span class="status status-${status.level}"><span class="status-icon" aria-hidden="true">${STATUS_ICON[status.level]}</span>${esc(status.label)}</span>`;
}

// ------------------------------------------------------------------- today

function renderToday() {
  const date = todayISO();
  const entries = loadEntries();
  const entry = entries.find((e) => e.date === date);
  const a = assessDay(entries, date);

  const components = [];
  if (a.components.wellness !== undefined) components.push(['Wellness', a.components.wellness, 'From your check-in answers']);
  if (a.components.hrv !== undefined) {
    components.push(['HRV', a.components.hrv, `ln RMSSD ${fmt(entry.hrv.lnRmssd, 2)} vs normal ${fmt(a.hrvBaseline.mean, 2)} ± ${fmt(a.hrvBaseline.sd, 2)}`]);
  }
  if (a.components.restingHr !== undefined) {
    components.push(['Resting HR', a.components.restingHr, `${fmt(entry.hrv.hr)} bpm vs normal ${fmt(a.hrBaseline.mean)} bpm`]);
  }

  view.innerHTML = `
    <section class="card hero">
      <p class="eyebrow">${esc(prettyDate(date))}</p>
      ${a.score !== null ? `
        <div class="score-row">
          <div class="score"><span class="score-num">${a.score}</span><span class="score-max">/100</span></div>
          <div>${statusBadge(a.status)}<p class="advice">${esc(a.status.advice)}</p></div>
        </div>` : `
        <h2>How are you today?</h2>
        <p class="muted">Complete your check-in to get a readiness score. Adding a morning HRV reading makes it more objective.</p>`}
      <div class="actions">
        <a class="btn ${entry?.wellness ? 'secondary' : ''}" href="#checkin">${entry?.wellness ? 'Edit check-in' : 'Start check-in'}</a>
        <a class="btn ${entry?.hrv ? 'secondary' : ''}" href="#measure">${entry?.hrv ? 'Redo HRV' : 'Measure HRV'}</a>
      </div>
    </section>

    ${a.flags.length ? `<section class="card"><h3>Things to note</h3><ul class="flags">
      ${a.flags.map((f) => `<li>${statusBadge({ level: f.level, label: f.level === 'critical' ? 'Important' : 'Note' })} ${esc(f.text)}</li>`).join('')}
    </ul></section>` : ''}

    ${components.length ? `<section class="card"><h3>Breakdown</h3>
      ${components.map(([name, v, sub]) => `
        <div class="meter">
          <div class="meter-head"><span>${name}</span><b>${v}</b></div>
          <div class="meter-track"><div class="meter-fill" style="width:${v}%"></div></div>
          <p class="muted small">${esc(sub)}</p>
        </div>`).join('')}
    </section>` : ''}

    ${entry?.hrv ? `<section class="card"><h3>This morning’s heart</h3>
      <div class="stats">
        <div><span class="stat-num">${fmt(entry.hrv.hr)}</span><span class="stat-label">bpm</span></div>
        <div><span class="stat-num">${fmt(entry.hrv.rmssd)}</span><span class="stat-label">RMSSD ms</span></div>
        <div><span class="stat-num">${fmt(entry.hrv.lnRmssd, 2)}</span><span class="stat-label">ln RMSSD</span></div>
      </div>
      ${a.baselineReadingsNeeded ? `<p class="muted small">${a.baselineReadingsNeeded} more daily reading${a.baselineReadingsNeeded > 1 ? 's' : ''} until your personal HRV baseline is ready.</p>` : ''}
    </section>` : ''}

    <section class="card"><h3>Training load</h3>
      <div class="stats">
        <div><span class="stat-num">${a.load.acute7}</span><span class="stat-label">last 7 days (AU)</span></div>
        <div><span class="stat-num">${a.load.weeklyAvg28}</span><span class="stat-label">4-week weekly avg</span></div>
        <div><span class="stat-num">${a.load.acwr !== null ? a.load.acwr.toFixed(2) : '–'}</span><span class="stat-label">acute:chronic</span></div>
      </div>
      <p class="muted small">Load = session minutes × session RPE.${a.load.acwr === null ? ' Acute:chronic ratio appears after 3 weeks of check-ins.' : ''}</p>
    </section>

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

function renderCheckin(dateArg) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateArg || '') ? dateArg : todayISO();
  const e = getEntry(date) || {};
  const w = e.wellness || {};
  const t = e.training || {};
  const pain = e.pain || { level: 0 };

  view.innerHTML = `
    <form id="checkin" class="stack" novalidate>
      <section class="card">
        <h2>Daily check-in</h2>
        <label class="field">Date <input type="date" name="date" value="${date}" max="${todayISO()}" required></label>
      </section>

      <section class="card">
        <h3>Sleep</h3>
        <label class="field">Hours slept last night
          <input type="number" name="sleepHours" inputmode="decimal" min="0" max="16" step="0.25" value="${w.sleepHours ?? ''}" placeholder="e.g. 7.5" required></label>
        ${scaleField(WELLNESS_ITEMS[0], w.sleepQuality)}
      </section>

      <section class="card">
        <h3>How do you feel?</h3>
        <p class="muted small">1 = worst, 5 = best.</p>
        ${WELLNESS_ITEMS.slice(1).map((i) => scaleField(i, w[i.key])).join('')}
      </section>

      <section class="card">
        <h3>Pain or injury</h3>
        <fieldset class="choice">
          ${PAIN_LEVELS.map((label, i) => `
            <label><input type="radio" name="painLevel" value="${i}" ${pain.level === i ? 'checked' : ''}> ${esc(label)}</label>`).join('')}
        </fieldset>
        <label class="field" id="pain-location" ${pain.level ? '' : 'hidden'}>Where?
          <input type="text" name="painLocation" value="${esc(pain.location)}" placeholder="e.g. left hamstring"></label>
      </section>

      <section class="card">
        <h3>Illness symptoms</h3>
        <fieldset class="choice grid2">
          ${SYMPTOMS.map((s) => `
            <label><input type="checkbox" name="illness" value="${esc(s)}" ${(e.illness || []).includes(s) ? 'checked' : ''}> ${esc(s)}</label>`).join('')}
        </fieldset>
      </section>

      <section class="card">
        <h3>Training in the last 24 h</h3>
        <label class="field">Total session minutes
          <input type="number" name="durationMin" inputmode="numeric" min="0" max="600" step="5" value="${t.durationMin ?? ''}" placeholder="0 for rest day"></label>
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
      </section>

      <p class="form-error" id="form-error" role="alert" hidden></p>
      <button class="btn block" type="submit">Save check-in</button>
    </form>`;

  const form = view.querySelector('#checkin');
  const loadPreview = () => {
    const load = sessionLoad({ durationMin: +form.durationMin.value, rpe: +form.rpe.value });
    form.querySelector('#load-preview').textContent = load ? `Session load: ${load} AU` : '';
  };
  form.addEventListener('input', (ev) => {
    if (ev.target.name === 'painLevel') form.querySelector('#pain-location').hidden = ev.target.value === '0';
    if (ev.target.name === 'date' && ev.target.value && ev.target.value !== date) location.hash = `#checkin/${ev.target.value}`;
    loadPreview();
  });
  loadPreview();

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const fd = new FormData(form);
    const missing = WELLNESS_ITEMS.filter((i) => !fd.get(i.key)).map((i) => i.label);
    if (!fd.get('sleepHours')) missing.unshift('Hours slept');
    const err = form.querySelector('#form-error');
    if (missing.length) {
      err.textContent = `Please answer: ${missing.join(', ')}.`;
      err.hidden = false;
      err.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    const num = (k) => (fd.get(k) === '' || fd.get(k) === null ? undefined : Number(fd.get(k)));
    const painLevel = num('painLevel') || 0;
    const wellness = { sleepHours: num('sleepHours') };
    for (const i of WELLNESS_ITEMS) wellness[i.key] = num(i.key);
    upsertEntry(fd.get('date'), {
      wellness,
      pain: { level: painLevel, location: painLevel ? fd.get('painLocation').trim() : '' },
      illness: fd.getAll('illness'),
      training: { durationMin: num('durationMin') || 0, rpe: num('rpe') || 0 },
      notes: fd.get('notes').trim(),
    });
    location.hash = fd.get('date') === todayISO() ? '#today' : '#history';
  });
}

// ------------------------------------------------------------ HRV measure

function renderMeasure() {
  const settings = loadSettings();
  const supported = cameraSupported();
  view.innerHTML = `
    <section class="card" id="measure-intro">
      <h2>Heart rate &amp; HRV</h2>
      <p>Uses your phone’s camera and flashlight to see the pulse in your fingertip.</p>
      <ol class="steps">
        <li>Best done each morning right after waking, before coffee, in the same position.</li>
        <li>Rest your hand so it can’t move. Place a fingertip <b>gently</b> over the <b>telephoto</b> (zoom) lens <b>and</b> the flash — pressing hard blocks the pulse.</li>
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
      ${supported ? '<button class="btn block" id="start">Start measurement</button>'
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
        <div class="live-bpm"><span id="bpm">--</span> <small>bpm</small></div>
      </div>
      <canvas id="wave" class="wave" aria-label="Live pulse waveform"></canvas>
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
  let session = null;
  cleanup = async () => { session?.stop(); await cam.stop(); };

  $('#start').addEventListener('click', async () => {
    const durationSec = +$('#duration').value;
    $('#measure-intro').hidden = true;
    $('#measure-live').hidden = false;
    $('#measure-result').hidden = true;
    $('#live-msg').textContent = 'Finding the telephoto camera…';
    try {
      const info = await cam.start(loadSettings().telephotoCameraId);
      if (info.telephoto) saveSettings({ telephotoCameraId: info.deviceId });
      const name = info.label ? ` (${info.label})` : '';
      const using = info.telephoto
        ? `Using the telephoto camera${name}. `
        : `No telephoto camera found, so using the camera next to the flash${name}. `;
      $('#live-msg').textContent = info.torch
        ? `${using}Cover that lens and the lit flashlight with your fingertip.`
        : `${using}The flashlight can’t be switched on for this camera in this browser (iPhone browsers never allow it). Measure next to a bright lamp or window so light shines through your fingertip.`;
      session = measureSession(cam, durationSec, $('#posture').value);
    } catch (err) {
      await cam.stop();
      showError(err.name === 'NotAllowedError' ? 'Camera permission was denied. Allow camera access in your browser settings and try again.' : `Couldn’t start the camera: ${err.message}`);
    }
  });
  $('#cancel').addEventListener('click', async () => { session?.stop(); await cam.stop(); route(); });

  function showError(msg) {
    $('#measure-live').hidden = true;
    const box = $('#measure-result');
    box.hidden = false;
    box.innerHTML = `<h3>Measurement failed</h3><p>${esc(msg)}</p><button class="btn block" id="retry">Try again</button>`;
    $('#retry').onclick = () => route();
  }

  function measureSession(camera, durationSec, posture) {
    const SETTLE_MS = 3000; // let auto-exposure settle once the finger is on
    const LOST_MS = 2500;
    const times = [], red = [], green = [];
    let fingerSince = null;
    let lastFinger = null;
    let startT = null;
    let done = false;
    let lastUi = 0;

    const fingerEl = $('#finger');
    const setFinger = (ok, text) => {
      fingerEl.className = `status status-${ok ? 'good' : 'warning'}`;
      fingerEl.innerHTML = `<span class="status-icon" aria-hidden="true">${ok ? '✓' : '!'}</span>${text}`;
    };

    camera.onSample = (s) => {
      if (done) return;
      const covered = fingerDetected(s);
      if (covered) { lastFinger = s.t; fingerSince ??= s.t; } else if (startT === null) fingerSince = null;

      if (startT === null) {
        if (covered && s.t - fingerSince >= SETTLE_MS) startT = s.t;
      } else {
        if (s.t - lastFinger > LOST_MS) {
          finish(false, 'Your finger moved off the lens. Rest your hand on something steady and try again.');
          return;
        }
        times.push(s.t); red.push(s.r); green.push(s.g);
        if (s.t - startT >= durationSec * 1000) { finish(true); return; }
      }
      const now = performance.now();
      if (now - lastUi > 100) { lastUi = now; updateUi(covered, s.t); }
    };

    function updateUi(covered, t) {
      if (startT === null) {
        setFinger(covered, covered ? 'Hold still…' : 'Place finger on lens');
        $('#countdown').textContent = '';
        $('#progress-bar').style.width = '0%';
        return;
      }
      setFinger(covered, covered ? 'Recording' : 'Finger lost');
      const elapsed = (t - startT) / 1000;
      $('#countdown').textContent = `${Math.max(0, Math.ceil(durationSec - elapsed))} s`;
      $('#progress-bar').style.width = `${Math.min(100, (elapsed / durationSec) * 100)}%`;

      // Live waveform + rate from the trailing few seconds.
      const from = times.findIndex((x) => x >= t - 8000);
      const tt = times.slice(from), rr = red.slice(from);
      const bpm = liveHeartRate(tt, rr);
      $('#bpm').textContent = bpm ?? '--';
      if (rr.length > 30) {
        const wave = bandpass(rr.map((v) => -v), 30).slice(-150);
        const { periodSamples } = dominantPeriod(wave, 30);
        drawWaveform($('#wave'), wave, findPeaks(wave, 30, periodSamples));
      }
    }

    async function finish(ok, message) {
      done = true;
      await camera.stop();
      if (!ok) { showError(message); return; }
      showResult(analyzePPG(times, { red, green }), posture, durationSec);
    }

    return { stop() { done = true; } };
  }

  function showResult(r, posture, durationSec) {
    $('#measure-live').hidden = true;
    const box = $('#measure-result');
    box.hidden = false;
    if (!r.ok) { showError(r.reason); return; }
    const qualityStatus = { good: 'good', fair: 'warning', poor: 'critical' }[r.quality];
    box.innerHTML = `
      <h3>Result ${statusBadge({ level: qualityStatus, label: `${r.quality} signal` })}</h3>
      <div class="stats">
        <div><span class="stat-num">${fmt(r.hr)}</span><span class="stat-label">bpm</span></div>
        <div><span class="stat-num">${fmt(r.rmssd)}</span><span class="stat-label">RMSSD ms</span></div>
        <div><span class="stat-num">${fmt(r.lnRmssd, 2)}</span><span class="stat-label">ln RMSSD</span></div>
      </div>
      <div class="stats small-stats">
        <div><span class="stat-num">${fmt(r.sdnn)}</span><span class="stat-label">SDNN ms</span></div>
        <div><span class="stat-num">${fmt(r.pnn50)}%</span><span class="stat-label">pNN50</span></div>
        <div><span class="stat-num">${Math.round(r.validFraction * 100)}%</span><span class="stat-label">clean beats</span></div>
      </div>
      <h4>Beat-to-beat intervals</h4>
      <div id="tachogram"></div>
      ${r.quality === 'poor' ? '<p class="form-error">Signal quality was poor, so these numbers may be unreliable. Consider measuring again.</p>' : ''}
      <div class="actions">
        <button class="btn" id="save">Save</button>
        <button class="btn secondary" id="again">Retry</button>
      </div>`;
    const tacho = r.ibis
      .map((ibi, i) => ({ x: (r.peakTimes[i + 1] - r.peakTimes[0]) / 1000, y: r.valid[i] ? ibi : NaN }))
      .map((d) => ({ ...d, label: `${d.x.toFixed(0)} s` }));
    lineChart($('#tachogram'), tacho, {
      height: 140, showDots: false, yFormat: (v) => `${Math.round(v)} ms`,
      tip: (d) => (Number.isFinite(d.y) ? `${d.label}: <b>${Math.round(d.y)} ms</b> (${Math.round(60000 / d.y)} bpm)` : `${d.label}: artifact removed`),
    });
    $('#save').onclick = () => {
      upsertEntry(todayISO(), {
        hrv: {
          hr: r.hr, rmssd: r.rmssd, lnRmssd: r.lnRmssd, sdnn: r.sdnn, pnn50: r.pnn50,
          beats: r.beats, validFraction: r.validFraction, quality: r.quality, channel: r.channel,
          durationSec, posture, source: 'camera', measuredAt: new Date().toISOString(),
        },
      });
      location.hash = '#today';
    };
    $('#again').onclick = () => route();
  }
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
  const recent = entries.slice(-42);
  const dayIndex = (iso) => Math.round(new Date(`${iso}T12:00:00Z`) / 86400000);

  view.innerHTML = `
    <section class="card"><h3>Readiness</h3><div id="c-ready"></div></section>
    <section class="card"><h3>HRV (ln RMSSD)</h3><p class="muted small">Shaded band = your normal range (mean ± 1 SD of recent readings).</p><div id="c-hrv"></div></section>
    <section class="card"><h3>Resting heart rate</h3><div id="c-hr"></div></section>
    <section class="card"><h3>Wellness</h3><div id="c-well"></div></section>
    <section class="card"><h3>Daily training load</h3><div id="c-load"></div></section>

    <section class="card"><h3>Entries</h3>
      ${entries.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Date</th><th>Ready</th><th>Well</th><th>HR</th><th>RMSSD</th><th>Load</th><th></th></tr></thead>
        <tbody>${[...entries].reverse().map((e) => {
    const a = assessDay(entries, e.date);
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
      <p class="muted small">Everything is stored only on this device. Export regularly to back it up or share with your coach.</p>
      <div class="actions wrap">
        <button class="btn secondary" id="csv">Export CSV</button>
        <button class="btn secondary" id="json">Backup</button>
        <label class="btn secondary">Restore<input type="file" id="import" accept="application/json,.json" hidden></label>
        <button class="btn secondary danger" id="clear">Delete all</button>
      </div>
    </section>`;

  const $ = (sel) => view.querySelector(sel);
  const series = (fn) => recent.map((e) => ({ x: dayIndex(e.date), y: fn(e), label: shortDate(e.date) }));

  requestAnimationFrame(() => {
    lineChart($('#c-ready'), series((e) => assessDay(entries, e.date).score ?? NaN), { yMin: 0, yMax: 100 });
    const hrvBase = baseline(entries.map((e) => e.hrv?.lnRmssd));
    lineChart($('#c-hrv'), series((e) => e.hrv?.lnRmssd ?? NaN), {
      yFormat: (v) => v.toFixed(1),
      band: hrvBase ? { lo: hrvBase.mean - hrvBase.sd, hi: hrvBase.mean + hrvBase.sd } : null,
      tip: (d) => `${d.label}: <b>${fmt(d.y, 2)}</b>`,
    });
    lineChart($('#c-hr'), series((e) => e.hrv?.hr ?? NaN), { yFormat: (v) => `${Math.round(v)}`, tip: (d) => `${d.label}: <b>${fmt(d.y)} bpm</b>` });
    lineChart($('#c-well'), series((e) => wellnessScore(e.wellness) ?? NaN), { yMin: 0, yMax: 100 });
    barChart($('#c-load'), series((e) => sessionLoad(e.training)), { tip: (d) => `${d.label}: <b>${d.y} AU</b>` });
  });

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

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
route();
