import {
  deleteEntry, exportCSV, exportJSON, getEntry, importJSON, loadEntries, loadSettings,
  loadTeam, saveSettings, todayISO, upsertEntry, clearAll, fixMisloggedSunday,
} from './storage.js';
import {
  assessDay, checkInStreak, compareToUsual, sessionLoad, shiftDate, trainingOnDay, unloggedDays, WEEKDAYS, wellnessScore, withWorkouts,
} from './readiness.js';
import { PpgCamera, cameraSupported } from './camera.js';
import { drawWaveform } from './charts.js';
import { startReading } from './reading.js';
import {
  checkinSections, readCheckin, showFormError, showMissing, wireCheckin,
} from './checkin-form.js';
import {
  asksDoubles, complete, formValues, readWorkouts, wireWorkouts, workoutSections, workoutSummary,
} from './workout-form.js';
import { esc, fmt, prettyDate, renderTrends, shareOrCopy, shortDate } from './ui.js';
import { renderTeam, syncLine } from './team-tab.js';
import { renderGoals } from './goals.js';
import { stuck, syncPending, syncStatus } from './team.js';

const view = document.getElementById('view');

// ------------------------------------------------------------------ router

const routes = {
  today: renderToday,
  checkin: renderCheckin,
  morning: (arg, query) => renderMorning(query),
  measure: (arg, query) => renderMeasure(query),
  workouts: (arg, query) => renderWorkouts(arg, query),
  saturday: () => location.replace('#workouts'), // older links: the Monday question about Saturday
  history: renderHistory,
  goals: (arg, query) => renderGoals(view, arg, query),
  team: (arg, query) => renderTeam(view, query, route),
};
let cleanup = null;

async function route() {
  if (cleanup) { await cleanup(); cleanup = null; }
  const [path, qs] = (location.hash.slice(1) || 'today').split('?');
  const [name, arg] = path.split('/');
  const render = routes[name] || renderToday;
  const tab = !routes[name] ? 'today' : { morning: 'checkin', saturday: 'workouts' }[name] || name;
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
  const { solo } = loadSettings();
  const yesterday = shiftDate(date, -1);
  const trainedYesterday = trainingOnDay(entries, yesterday);
  const gaps = unloggedDays(entries, date).filter((d) => d !== yesterday);
  const status = syncStatus();
  const streak = checkInStreak(entries, date);
  const streakLine = streak.days >= 2
    ? `<p class="streak">🔥 <b>${streak.days}-day streak</b>${streak.nudge ? ' – check in today to keep it going' : ''}</p>` : '';

  view.innerHTML = `
    <section class="card hero${answered ? ' hero-done' : ''}">
      <p class="eyebrow">${esc(prettyDate(date))}</p>
      ${answered ? `
        <span class="hero-badge" aria-hidden="true">✓</span>
        <h2>Thanks for checking in${first ? `, ${esc(first)}` : ''}!</h2>
        ${compareLine(compareToUsual(entries, date))}
        ${injuryNote(entry.pain)}
        <ul class="done-list">
          <li>✓ Questions answered</li>
          <li id="yesterday-line">${trainedYesterday?.assumed ? '✓ Yesterday: day off (Sunday)' : trainedYesterday ? '✓ Yesterday’s training logged'
    : `<span class="muted">– Yesterday’s training not logged</span> <a href="#workouts/${yesterday}">Log it</a>`}</li>
          ${gaps.length ? `<li id="gaps-line"><span class="muted">– ${gaps.length === 1 ? `${esc(weekdayName(gaps[0]))}’s training` : `${gaps.length} earlier days`} not logged</span> <a href="#workouts/${gaps[0]}">Fill in</a></li>` : ''}
          ${heartDone ? '<li>✓ Heart reading saved</li>' : ''}
        </ul>
        ${streakLine}
        <div class="actions">
          <a class="btn secondary" href="#checkin">Edit answers</a>
          <a class="btn secondary" href="#workouts">Workouts</a>
        </div>
        <p class="small heart-link"><a href="#measure">${heartDone ? 'Redo heart reading' : 'Add a heart reading'}</a> <span class="muted">(optional)</span></p>
        ${status.joined ? `<p class="sync-line" id="sync-line">${sendStatus(status)}</p>` : ''}` : `
        <h2>Good morning</h2>
        <p class="muted">About a minute: a few quick questions.</p>
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

    <section class="card"><h3>Your training</h3>
      <div class="stats">
        <div><span class="stat-num">${a.load.acute7}</span><span class="stat-label">last 7 days</span></div>
        <div><span class="stat-num">${a.load.weeklyAvg28}</span><span class="stat-label">usual week</span></div>
        <div><span class="stat-num">${a.load.ewmaAcwr !== null ? `${a.load.ewmaAcwr.toFixed(2)}×` : '–'}</span><span class="stat-label">vs usual</span></div>
      </div>
      <p class="muted small">Load = training minutes × effort. “Vs usual” weighs your last week against your last 4 weeks, recent days counting most: around 1× is a normal week.${a.load.ewmaAcwr === null ? ' It appears after 3 weeks of logged training.' : ''}${a.load.monotony !== null ? ` Variety: ${a.load.monotony < 1.5 ? 'a good mix of harder and easier days' : a.load.monotony < 2 ? 'days are fairly similar' : 'every day is much the same'} (monotony ${a.load.monotony.toFixed(1)}).` : ''}</p>
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

// After today's check-in (and after each day logged from there): on to the
// most recent day this past week with no training logged, if any. Sundays
// count as off days unless they log otherwise.
const nextUnlogged = () => unloggedDays(loadEntries(), todayISO())[0];
function afterCheckin() {
  const d = nextUnlogged();
  location.hash = d ? `#workouts/${d}?after=checkin` : '#today';
}
const weekdayName = (d) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long' });

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
      <div class="save-bar"><span class="save-progress" data-progress aria-live="polite"></span>
        <button class="btn block" type="submit">${saveLabel()}</button></div>
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
      if (form.date.value === todayISO()) afterCheckin();
      else location.hash = '#history';
    });
  });
}

// Running as a Home Screen app rather than in a browser tab?
const isStandalone = () => navigator.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches;

// ------------------------------------------------------ morning check-in
// The questions only. Training is logged on the Workouts tab (asked about
// yesterday right after this, if it isn't logged yet); a heart reading is
// optional, from Today.

function renderMorning(query = new URLSearchParams()) {
  const date = todayISO();
  const team = query.has('joined') ? loadTeam() : null;
  const e = getEntry(date) || {};

  view.innerHTML = `
    ${team ? `<section class="card welcome" role="status">
      <p><b>✓ You’re in, ${esc(team.athlete.split(' ')[0])}!</b> You’ve joined ${esc(team.group)}, and your check-ins will go to your coach.
        Now do today’s check-in below.</p>
      ${isStandalone() ? '' : `<p class="small home-tip">📲 <b>Add this app to your Home Screen now</b>
        (iPhone: Share → Add to Home Screen) – it will remember your group.</p>`}
    </section>` : ''}

    <section class="card">
      <h2>Morning check-in</h2>
      <p class="muted">A few quick questions, then tap <b>${saveLabel()}</b>.</p>
    </section>

    <form id="checkin" class="stack" novalidate>
      ${checkinSections(e)}
      <p class="form-error" id="form-error" role="alert" hidden></p>
      <div class="save-bar"><span class="save-progress" data-progress aria-live="polite"></span>
        <button class="btn block" type="submit" id="save">${saveLabel()}</button></div>
    </form>`;

  // Show the welcome once: an app added to the Home Screen from this page
  // would otherwise reopen it every time.
  if (team) history.replaceState(null, '', location.href.replace(/\?joined=1$/, ''));

  const form = view.querySelector('#checkin');
  wireCheckin(form);
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const answers = readCheckin(form);
    if (answers.missing) { showMissing(form, answers); return; }
    showFormError(form, '');
    upsertEntry(date, answers.patch);
    sendAndWait(form.querySelector('#save')).then(() => afterCheckin());
  });
}

// ---------------------------------------------------------------- workouts
// Training logged by the swimmer for the day it happened: today and
// yesterday first, then the last few weeks, each with its status, and any
// day can be filled in or corrected later.

const dayName = (d, today = todayISO()) => (d === today ? 'Today' : d === shiftDate(today, -1) ? 'Yesterday' : prettyDate(d));

function workoutStatus(entries, d, opts) {
  const w = entries.find((e) => e.date === d)?.workouts;
  const done = complete(w, { doubles: asksDoubles(d, todayISO()) });
  if (w) return { state: done ? 'logged' : 'partly', label: done ? 'Logged' : 'Partly logged', summary: workoutSummary(w, opts) };
  const legacy = trainingOnDay(entries, d);
  if (legacy?.assumed) return { state: 'assumed', label: 'Off (Sunday)', summary: '' };
  if (legacy) return { state: 'checkin', label: 'From check-in', summary: workoutSummary(formValues(null, legacy), opts) };
  return { state: 'none', label: 'Not logged', summary: '' };
}

function renderWorkouts(arg, query) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(arg || '')) { renderWorkoutDay(arg, query); return; }
  const today = todayISO();
  const entries = loadEntries();
  const card = (d) => {
    const st = workoutStatus(entries, d);
    return `<section class="card workout-day" data-day="${d}">
      <div class="workout-head"><h3>${esc(dayName(d))} <span class="muted small">${d === today || d === shiftDate(today, -1) ? esc(prettyDate(d)) : ''}</span></h3>
        <span class="wk-status wk-${st.state}">${st.label}</span></div>
      ${st.summary ? `<p class="small">${esc(st.summary)}</p>` : ''}
      <a class="btn ${st.state === 'none' ? '' : 'secondary'} block" href="#workouts/${d}">${st.state === 'none' ? `Log ${d === today ? 'today’s' : d === shiftDate(today, -1) ? 'yesterday’s' : 'this day’s'} training` : 'Edit'}</a>
    </section>`;
  };
  const earlier = Array.from({ length: 19 }, (_, i) => shiftDate(today, -(i + 2)));
  view.innerHTML = `
    <section class="card"><h2>Workouts</h2>
      <p class="muted small">Log each practice: how long, how hard, and how well it went – or why you didn’t go.</p></section>
    ${card(today)}
    ${card(shiftDate(today, -1))}
    <section class="card"><h3>Earlier</h3>
      <p class="muted small">Time, then effort · how well it went.</p>
      <ul class="workout-list">${earlier.map((d) => {
    const st = workoutStatus(entries, d, { short: true });
    return `<li><a href="#workouts/${d}">
          <span class="wl-date">${esc(prettyDate(d))}</span>
          <span class="wl-sum muted small">${esc(st.summary || '')}</span>
          <span class="wk-status wk-${st.state}">${st.label}</span></a></li>`;
  }).join('')}</ul>
      <form id="other-day" class="row other-day">
        <label class="field">Another day <input type="date" name="d" max="${today}" required></label>
        <button class="btn secondary" type="submit">Open</button>
      </form>
    </section>`;
  view.querySelector('#other-day').addEventListener('submit', (ev) => {
    ev.preventDefault();
    location.hash = `#workouts/${ev.target.d.value}`;
  });
}

function renderWorkoutDay(date, query) {
  const today = todayISO();
  if (date > today) { location.replace('#workouts'); return; }
  const entries = loadEntries();
  const own = entries.find((e) => e.date === date)?.workouts;
  const values = formValues(own, own ? null : trainingOnDay(entries, date));
  const afterCheckin = query.get('after') === 'checkin';
  const doubles = asksDoubles(date, today);
  view.innerHTML = `
    ${afterCheckin ? `<section class="card welcome" role="status">
      <p><b>✓ ${date === shiftDate(today, -1) ? `Check-in ${syncStatus().joined && !syncStatus().pending ? 'sent' : 'saved'}.</b> One more: how was <b>yesterday’s</b> training`
    : `Saved.</b> ${esc(weekdayName(date))}’s training isn’t logged yet: how was it`}
        (${esc(date === shiftDate(today, -1) ? weekdayName(date) : prettyDate(date))})?
        <a href="#today" id="skip">Skip</a></p>
      <p class="muted small">Already trained this morning? <a href="#workouts/${today}" id="log-today">Log today’s instead</a>.</p></section>` : ''}
    <form id="workout" class="stack" novalidate>
      <section class="card"><p><a href="#workouts">‹ Workouts</a></p>
        <h2>${esc(dayName(date) === 'Today' || dayName(date) === 'Yesterday' ? `${dayName(date)}’s training` : 'Training')}</h2>
        <p class="eyebrow">${esc(prettyDate(date))}</p>
        ${own?.loggedAt && own.loggedAt.slice(0, 10) > date ? `<p class="muted small">Filled in later, on ${esc(shortDate(own.loggedAt.slice(0, 10)))}.</p>` : ''}
      </section>
      ${workoutSections(values, { doubles })}
      ${doubles ? '' : '<p class="muted small doubles-later">Doubles today? Log them after 4:30 pm, or tomorrow morning.</p>'}
      <p class="form-error" id="form-error" role="alert" hidden></p>
      <div class="save-bar"><button class="btn block" type="submit" id="save-workout">${syncStatus().joined ? 'Save and send' : 'Save'}</button></div>
    </form>`;
  const form = view.querySelector('#workout');
  wireWorkouts(form);
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const out = readWorkouts(form);
    if (out.missing) { showMissing(form, out); return; }
    showFormError(form, '');
    // When it was logged, kept apart from the day it's for (backfilling shows).
    // Doubles not asked yet today: keep any already logged.
    const kept = !doubles && own?.pm ? { pm: own.pm } : {};
    upsertEntry(date, { workouts: { ...kept, ...out.workouts, loggedAt: own?.loggedAt || new Date().toISOString() } });
    sendAndWait(form.querySelector('#save-workout')).then(() => {
      const next = afterCheckin && nextUnlogged();
      location.hash = next ? `#workouts/${next}?after=checkin` : afterCheckin ? '#today' : '#workouts';
    });
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
        showResult(`<h3>✓ Thanks – reading saved</h3>
          ${heartStats(out.hrv)}
          <a class="btn block" href="#today">Done</a>`);
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
    const load = sessionLoad(withWorkouts(entries).find((x) => x.date === e.date)?.training);
    return `<tr>
            <td><a href="${e.wellness ? `#checkin/${e.date}` : `#workouts/${e.date}`}">${esc(shortDate(e.date))}</a></td>
            <td>${a.score ?? '–'}</td>
            <td>${wellnessScore(e.wellness) ?? '–'}</td>
            <td>${fmt(e.hrv?.hr)}</td>
            <td>${fmt(e.hrv?.rmssd)}</td>
            <td>${load || '–'}</td>
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
  const busy = () => /^#(checkin|measure|morning|workouts\/)/.test(location.hash);
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

fixMisloggedSunday();
route();
sync();
