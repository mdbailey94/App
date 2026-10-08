import {
  deleteEntry, exportCSV, exportJSON, getEntry, importJSON, loadEntries, loadSettings,
  loadTeam, saveSettings, todayISO, upsertEntry, clearAll,
} from './storage.js';
import {
  assessDay, checkInStreak, compareToUsual, isReadingDay, nextReadingDay, sessionLoad, WEEKDAYS, wellnessScore,
} from './readiness.js';
import { PpgCamera, cameraSupported } from './camera.js';
import { drawWaveform } from './charts.js';
import { startReading } from './reading.js';
import { checkinSections, readCheckin, showFormError, showMissing, wireCheckin } from './checkin-form.js';
import { esc, fmt, prettyDate, renderTrends, shareOrCopy, shortDate } from './ui.js';
import { renderTeam, syncLine } from './team-tab.js';
import { stuck, syncPending, syncStatus } from './team.js';

const view = document.getElementById('view');

// ------------------------------------------------------------------ router

const routes = {
  today: renderToday,
  checkin: renderCheckin,
  morning: (arg, query) => renderMorning(query),
  measure: (arg, query) => renderMeasure(query),
  history: renderHistory,
  team: (arg, query) => renderTeam(view, query, route),
};
let cleanup = null;

async function route() {
  if (cleanup) { await cleanup(); cleanup = null; }
  const [path, qs] = (location.hash.slice(1) || 'today').split('?');
  const [name, arg] = path.split('/');
  const render = routes[name] || renderToday;
  const tab = !routes[name] ? 'today' : { morning: 'checkin' }[name] || name;
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

// What the athlete sees after checking in: thanks, and once there's enough
// history, how today compares with their own usual. Never a verdict or advice
// to change training: the program stands, and the coach looks at the trend.
const USUAL = {
  same: ['About your usual', 'Keep following your program.'],
  higher: ['Feeling better than usual', 'Nice. Keep following your program.'],
  lower: ['Feeling a bit below usual', 'Off days happen, and one day doesn’t change much. Keep following your program – your coach looks at how you’re doing over several days.'],
};

function compareLine(c) {
  if (!c.ready) {
    return `<p class="muted">After ${c.remaining} more check-in${c.remaining > 1 ? 's' : ''}, you’ll see how each day compares with your usual.</p>`;
  }
  const [label, line] = USUAL[c.level];
  return `<p class="usual usual-${c.level}"><b>${label}</b></p><p class="muted small">${line}</p>`;
}

// An injury that changes how they swim is the one thing worth raising today.
function injuryNote(pain) {
  if (!(pain?.level >= 2)) return '';
  return `<p class="injury-note">${pain.level >= 3
    ? 'You said an injury is stopping some strokes or movements – talk to your coach before practice.'
    : 'You said an injury is affecting your stroke – make sure your coach knows.'}</p>`;
}

function renderToday() {
  const date = todayISO();
  const entries = loadEntries();
  const entry = entries.find((e) => e.date === date);
  // Athletes see a score from their own answers only; HRV goes to the coach
  // and into weekly trends, so one noisy morning reading can't colour the day.
  const a = assessDay(entries, date, { heart: false });
  const answered = Boolean(entry?.wellness);
  const first = loadTeam()?.athlete?.split(' ')[0];
  const heartDone = Boolean(entry?.hrv);
  const { hrvDays, solo } = loadSettings();
  const readingDay = isReadingDay(hrvDays, date);
  const status = syncStatus();
  const streak = checkInStreak(entries, date);
  const streakLine = streak.days >= 2
    ? `<p class="streak">🔥 <b>${streak.days}-day streak</b>${streak.doneToday ? '' : ' – check in today to keep it going'}</p>` : '';

  view.innerHTML = `
    <section class="card hero">
      <p class="eyebrow">${esc(prettyDate(date))}</p>
      ${answered ? `
        <h2>Thanks for checking in${first ? `, ${esc(first)}` : ''}!</h2>
        ${compareLine(compareToUsual(entries, date))}
        ${injuryNote(entry.pain)}
        <ul class="done-list">
          <li>✓ Questions answered</li>
          <li>${heartDone ? '✓ Heart reading saved' : readingDay ? '<span class="muted">– No heart reading today</span>'
    : `<span class="muted">– No heart reading needed today (next: ${esc(nextReadingDay(hrvDays, date))})</span>`}</li>
        </ul>
        ${streakLine}
        <div class="actions">
          <a class="btn secondary" href="#checkin">Edit answers</a>
          <a class="btn secondary" href="#measure">${heartDone ? 'Redo reading' : 'Add reading'}</a>
        </div>
        ${status.joined ? `<p class="sync-line" id="sync-line">${sendStatus(status)}</p>` : ''}` : `
        <h2>Good morning</h2>
        <p class="muted">${readingDay ? 'About two minutes: a few questions and a 1-minute heart reading.' : 'About a minute: a few quick questions. No heart reading needed today.'}</p>
        ${streakLine}
        <a class="btn block" href="#morning">Start my morning check-in</a>`}
      ${a.baselineReadingsNeeded && heartDone ? `<p class="muted small">Keep taking morning readings – after ${a.baselineReadingsNeeded} more, the app knows your normal range.</p>` : ''}
    </section>

    ${!status.joined && !solo ? `<section class="card offer" id="join-nudge">
      <p><b>Not connected to your coach.</b> Your check-ins stay on this phone until you join your group –
        scan your coach’s QR code or open their invite link.</p>
      <div class="actions"><a class="btn secondary" href="#team">Join a group</a>
        <button class="link" type="button" id="solo">I’m using the app on my own</button></div>
    </section>` : ''}

    ${heartDone ? `<section class="card"><h3>This morning’s heart</h3>${heartStats(entry.hrv)}</section>` : ''}

    <section class="card"><h3>Training load</h3>
      <div class="stats">
        <div><span class="stat-num">${a.load.acute7}</span><span class="stat-label">last 7 days (AU)</span></div>
        <div><span class="stat-num">${a.load.weeklyAvg28}</span><span class="stat-label">4-week weekly avg</span></div>
        <div><span class="stat-num">${a.load.acwr !== null ? a.load.acwr.toFixed(2) : '–'}</span><span class="stat-label">acute:chronic</span></div>
      </div>
      <p class="muted small">Load = training minutes × session RPE.${a.load.acwr === null ? ' Acute:chronic ratio appears after 3 weeks of check-ins.' : ''}</p>
    </section>

    ${status.joined && !answered ? `<p class="sync-line" id="sync-line">${sendStatus(status)}</p>` : ''}

    <p class="disclaimer">For training guidance only — not a medical device. If you feel unwell, speak to a doctor.</p>`;
  view.querySelector('#solo')?.addEventListener('click', () => { saveSettings({ solo: true }); route(); });
}


// The check-in button saves and then sends: for athletes in a group it says
// "Save and send" and waits (up to 10 s) for the sheet to confirm before
// moving on. If it can't get through, the answers are still saved, and Today
// says so with a Send now button while it keeps retrying.
const saveLabel = () => (syncStatus().joined ? 'Save and send' : 'Save check-in');

async function sendAndWait(btn) {
  if (!syncStatus().joined) return;
  if (btn) { btn.disabled = true; btn.textContent = 'Sending to your coach…'; }
  await Promise.race([sync(), new Promise((r) => setTimeout(r, 10000))]);
}

function renderCheckin(dateArg) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(dateArg || '') ? dateArg : todayISO();
  const e = getEntry(date) || {};
  view.innerHTML = `
    <form id="checkin" class="stack" novalidate>
      <section class="card">
        <h2>Daily check-in</h2>
        <label class="field">Date <input type="date" name="date" value="${date}" max="${todayISO()}" required></label>
      </section>
      ${checkinSections(e)}
      <p class="form-error" id="form-error" role="alert" hidden></p>
      <button class="btn block" type="submit">${saveLabel()}</button>
    </form>`;

  const form = view.querySelector('#checkin');
  wireCheckin(form);
  form.date.addEventListener('change', () => {
    if (form.date.value && form.date.value !== date) location.hash = `#checkin/${form.date.value}`;
  });
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const answers = readCheckin(form);
    if (answers.missing) { showMissing(form, answers); return; }
    const { patch } = answers;
    upsertEntry(form.date.value, patch);
    sendAndWait(form.querySelector('button[type=submit]')).then(() => {
      location.hash = form.date.value === todayISO() ? '#today' : '#history';
    });
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
  const settings = loadSettings();
  const supported = cameraSupported();
  // Heart readings are only asked for on the athlete's reading days.
  const readingDay = isReadingDay(settings.hrvDays, date);
  const experienced = supported && hasCameraReading();
  // Questions and reading together only once the athlete has opted in; until
  // then the check-in is questions only, followed by the normal HRV screen.
  // The front-camera reading needs the screen as its light, so it can't run
  // alongside the questions.
  const canCombine = readingDay && experienced && !settings.frontCamera;
  const combined = canCombine && settings.hrvDuringCheckin;
  const [toggleHtml, wireToggle] = canCombine ? combinedToggle(combined, () => route()) : ['', () => {}];

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
        <li>Tap <b>Save</b> when you’re done. Your answers are saved straight away; if the reading is still going, it’s added when it finishes.</li>
      </ol>
      ${e.hrv ? '<p class="muted small">You already have a heart reading today. Start only if you want to redo it.</p>' : ''}
      ${toggleHtml}
    </section>` : `<section class="card">
      <h2>Morning check-in</h2>
      <p class="muted">Answer the questions, then tap <b>Save</b>.${!readingDay ? ' No heart reading needed today.'
    : supported && !e.hrv ? ' Your 1-minute heart reading comes next.' : ''}</p>
    </section>
    ${e.hrv ? '' : toggleHtml}`}

    <form id="checkin" class="stack" novalidate>
      ${checkinSections(e)}
      <p class="form-error" id="form-error" role="alert" hidden></p>
      <button class="btn block" type="submit" id="save">${saveLabel()}</button>
    </form>`;

  // Show the welcome once: an app added to the Home Screen from this page
  // would otherwise reopen it every time.
  if (team) history.replaceState(null, '', location.href.replace(/\?joined=1$/, ''));

  const $ = (sel) => view.querySelector(sel);
  const form = $('#checkin');
  wireCheckin(form);
  wireToggle(view);

  let state = 'idle'; // idle | running | done | failed
  let hrv = null;
  let savedEarly = false; // answers saved while the reading was still going
  let reading = null;
  const cam = combined ? new PpgCamera($('#camera')) : null;
  cleanup = async () => { reading?.stop(); await cam?.stop(); };

  const setReading = (title, msg, level) => {
    $('#reading-title').textContent = title;
    $('#reading-msg').textContent = msg;
    $('#reading').dataset.state = level || '';
  };
  const save = async (patch) => {
    upsertEntry(date, hrv ? { ...patch, hrv } : patch);
    await sendAndWait($('#save'));
    // Not doing the reading here: go on to the normal HRV screen if today
    // still needs one.
    location.hash = readingDay && !combined && supported && !e.hrv && !hrv ? '#measure?after=checkin' : '#today';
  };

  const start = () => {
    state = 'running';
    hrv = null;
    $('#reading-start').hidden = true;
    $('#reading-progress').hidden = false;
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
        if (savedEarly) {
          upsertEntry(date, { hrv });
          sendAndWait($('#save')).then(() => { location.hash = '#today'; });
        }
        return;
      }
      state = 'failed';
      $('#reading-start').textContent = 'Try again';
      setReading('Heart reading didn’t work', out.reason, 'warn');
      if (savedEarly) {
        // The answers are already saved; the reading can be retried or skipped.
        $('#save').disabled = false;
        $('#save').textContent = 'Done – skip the heart reading';
      }
    });
  };
  $('#reading-start')?.addEventListener('click', start);

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const answers = readCheckin(form);
    if (answers.missing) { showMissing(form, answers); return; }
    const { patch } = answers;
    showFormError(form, '');
    if (state === 'running') {
      // Save the answers now, so nothing is lost if the app is closed before
      // the reading finishes; the reading is added when it does.
      upsertEntry(date, patch);
      savedEarly = true;
      sendAndWait($('#save')).then(() => {
        if (state !== 'running') return; // the reading already finished
        $('#save').textContent = syncStatus().joined && !syncStatus().pending
          ? '✓ Answers sent – finishing your heart reading…'
          : '✓ Answers saved – finishing your heart reading…';
      });
      return;
    }
    reading?.stop();
    save(patch);
  });
}

// ------------------------------------------------------------ HRV measure

function renderMeasure(query = new URLSearchParams()) {
  const settings = loadSettings();
  const supported = cameraSupported();
  const afterCheckin = query.get('after') === 'checkin';
  const front = settings.frontCamera;
  view.innerHTML = `
    ${afterCheckin ? `<section class="card welcome" id="next-step" role="status">
      <p><b>✓ Answers ${syncStatus().joined && !syncStatus().pending ? 'sent to your coach' : 'saved'}.</b> Last step: your 1-minute heart reading.
        <a href="#today" id="skip">Skip for today</a></p>
    </section>` : ''}
    <section class="card" id="measure-intro">
      <h2>Heart reading</h2>
      <p>Uses your phone’s camera and flashlight to see the pulse in your fingertip.</p>
      ${front ? `<ol class="steps">
        <li>Best done each morning right after waking, before coffee, in the same position.</li>
        <li>Turn your <b>screen brightness all the way up</b>. During the reading the screen turns white to light your finger.</li>
        <li>After tapping Start, lightly cover the <b>front camera</b> (top of the screen) with a fingertip. Pressing hard blocks the pulse.</li>
        <li>Hold the phone steady – resting your arm on your lap or a table helps – and stay still and quiet until it finishes.</li>
      </ol>` : `<ol class="steps">
        <li>Best done each morning right after waking, before coffee, in the same position.</li>
        <li><b>Before tapping Start</b>, gently cover <b>both the flashlight and the camera closest to it</b> with a fingertip. The app checks which camera is covered and uses that one. Pressing hard blocks the pulse.</li>
        <li>Hold the phone steady – resting your arm on your lap or a table helps. The small round preview should glow red or look dark. If you can see the room in it, your finger is on the wrong lens.</li>
        <li>Breathe normally and stay still and quiet until it finishes.</li>
      </ol>`}
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
      <fieldset class="scale">
        <legend>My reading days</legend>
        <div class="chips days">
          ${[1, 2, 3, 4, 5, 6, 0].map((d) => `<label><input type="checkbox" name="hrvDay" value="${d}" aria-label="${WEEKDAYS[d]}" ${settings.hrvDays.includes(d) ? 'checked' : ''}><span aria-hidden="true">${WEEKDAYS[d].slice(0, 2)}</span></label>`).join('')}
        </div>
        <p class="muted small days-note">The check-in asks for a reading on these days. Three a week is plenty.</p>
      </fieldset>
      ${supported ? '<button class="btn block" id="start">Start reading</button>'
    : '<p class="form-error">Camera access needs a secure (https) page in a modern browser.</p>'}
      ${supported ? `<label class="toggle-line small"><input type="checkbox" id="front-mode" ${front ? 'checked' : ''}>
        Use the front camera, lit by the screen <span class="muted">(experimental – try this if readings keep failing)</span></label>` : ''}
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

    <section class="card ${front ? 'front-light' : ''}" id="measure-live" hidden>
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
  $('#front-mode')?.addEventListener('change', (e) => { saveSettings({ frontCamera: e.target.checked }); route(); });
  view.querySelectorAll('input[name=hrvDay]').forEach((box) => box.addEventListener('change', () => {
    const days = [...view.querySelectorAll('input[name=hrvDay]:checked')].map((x) => +x.value);
    saveSettings({ hrvDays: days }); // none ticked = every day
  }));

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
  cam.front = front;
  let reading = null;
  cleanup = async () => { reading?.stop(); await cam.stop(); document.body.classList.remove('lit'); };

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
    if (front) document.body.classList.add('lit');
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
      document.body.classList.remove('lit');
      if (out.cancelled) return;
      if (out.ok) {
        // No numbers here on purpose: single readings vary a lot, so the
        // athlete sees the weekly trend and the coach sees the details.
        upsertEntry(todayISO(), { hrv: out.hrv });
        // After a first reading the normal way, offer to do it during the check-in.
        const [offer, wireOffer] = loadSettings().hrvDuringCheckin || front ? ['', () => {}]
          : combinedToggle(false, () => {
            const card = view.querySelector('#measure-result .offer');
            if (card) card.innerHTML = '<p><b>✓ Turned on.</b> Next time, your heart reading runs while you answer the questions.</p>';
          });
        showResult(`<h3>✓ Thanks – reading saved</h3>
          ${heartStats(out.hrv)}
          <a class="btn block" href="#today">Done</a>
          ${offer}`);
        wireOffer(view);
        return;
      }
      showResult(`<h3>${out.poor ? 'Weak signal' : 'Reading didn’t work'}</h3><p>${esc(out.reason)}</p>
        <p class="muted small">Tip: rest your arm on your lap or a table, press lightly, and stay still and quiet.</p>
        <button class="btn block" id="retry">Try again</button>
        ${front ? '' : '<button class="btn secondary block" id="try-front">Try the front camera instead (experimental)</button>'}
        ${diagnostics(out.diag)}`);
      $('#retry').onclick = () => route();
      $('#try-front')?.addEventListener('click', () => { saveSettings({ frontCamera: true }); route(); });
      wireDiagnostics(view);
    });
  });
  $('#cancel').addEventListener('click', () => { reading?.stop(); route(); });
}

// A reading that fails can be sent to the coach (or whoever maintains the
// app) so problems on particular phones can be fixed.
function diagnostics(diag) {
  if (!diag) return '';
  const text = `Heart reading details\n${JSON.stringify(diag, null, 1)}`;
  return `<details class="diag small"><summary>Keeps failing? Send the details</summary>
    <p class="muted">This shows what the camera saw (no pictures, just numbers). Send it to your coach to help get your phone working.</p>
    <textarea id="diag-text" rows="6" readonly>${esc(text)}</textarea>
    <div class="actions"><button class="btn secondary" type="button" id="diag-send">${navigator.share ? 'Share details' : 'Copy details'}</button></div>
  </details>`;
}

function wireDiagnostics(root) {
  const btn = root.querySelector('#diag-send');
  if (!btn) return;
  btn.onclick = async () => {
    const field = root.querySelector('#diag-text');
    if (await shareOrCopy(field.value, { share: true, field }) === 'copied') btn.textContent = 'Copied';
  };
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
// Whether today's answers have reached the coach, with a way to push them
// through by hand when they haven't.
const STUCK_HELP = 'Your check-ins haven’t reached your coach for over a day. Their sheet link may have changed – ask them for a new QR code or invite link.';
const sendNow = '<button class="btn small-btn" type="button" data-send-now>Send now</button>';

function sendStatus(status) {
  if (!status.joined) return '';
  if (stuck(status)) return `${syncLine(status)} ${sendNow}<br><span class="stuck-help">${STUCK_HELP} <a href="#team">Rejoin</a></span>`;
  return syncLine(status) + (status.pending ? ` ${sendNow}` : '');
}

// On every other screen: a banner while something has failed to send, so an
// unsent check-in can't go unnoticed.
function updateSendUI() {
  const status = syncStatus();
  const line = document.getElementById('sync-line');
  if (line) line.innerHTML = sendStatus(status);
  const banner = document.getElementById('send-banner');
  const route = (location.hash.slice(1) || 'today').split(/[?/]/)[0];
  const show = status.joined && status.pending && status.lastError && route !== 'today';
  banner.hidden = !show;
  banner.innerHTML = show
    ? `<span>${status.pending} check-in${status.pending > 1 ? 's haven’t' : ' hasn’t'} reached your coach yet.</span> ${sendNow}${stuck(status) ? `<span class="stuck-help">${STUCK_HELP} <a href="#team">Rejoin</a></span>` : ''}`
    : '';
}

// Send new or edited days to the group sheet whenever there's a chance.
function sync(opts) {
  return syncPending(opts).then(updateSendUI);
}
window.addEventListener('hashchange', () => sync());
window.addEventListener('online', () => sync());
// When the athlete leaves the app the request goes with keepalive, so it can
// still get through if the app is closed straight after saving.
document.addEventListener('visibilitychange', () => sync({ leaving: document.visibilityState === 'hidden' }));
window.addEventListener('pagehide', () => sync({ leaving: true }));
document.addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-send-now]');
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = 'Sending…';
  sync();
});
setInterval(() => { if (syncStatus().pending) sync(); }, 60000);

// A Home Screen app on iPhone starts with empty storage but keeps the address
// it was added from. If that address carries group details and this copy
// hasn't joined yet, open the (pre-filled) join screen: one tap to finish.
if (!loadTeam() && new URLSearchParams(location.search).get('u') && !/^#team/.test(location.hash)) {
  history.replaceState(null, '', `${location.pathname}${location.search}#team`);
}

// A Home Screen app saved on the check-in page: once today's check-in is
// done, open on Today instead.
if (/^#morning$/.test(location.hash) && getEntry(todayISO())?.wellness) {
  history.replaceState(null, '', `${location.pathname}${location.search}#today`);
}

// The coach dashboard moved to its own page; old #coach links still work.
if (/^#coach/.test(location.hash)) location.replace('coach.html');

route();
sync();
