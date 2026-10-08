// The coach dashboard (coach.html): its own page with its own tabs.
//   #group      one day: who checked in, who needs a word, who's missing
//   #history    the group over 7 or 28 days, and a check-in record
//   #swimmers   everyone in the group; #swimmers/<key> for one swimmer
//   #messages   notes and injuries from swimmers, reminders, invite link
//   #settings   the sheet this dashboard reads, setup help, sign out

import { loadCoach, loadTeam, saveCoach, todayISO } from './storage.js';
import { callSheet, inviteLink, isValidSheetUrl } from './team.js';
import {
  checkinGrid, groupByAthlete, groupDay, recentNotes, reminderText, roster, teamTrend, trendSummary, watchList,
} from './group.js';
import { assessDay, sessionLoad, shiftDate, wellnessScore } from './readiness.js';
import { dayIndex, esc, fmt, prettyDate, renderTrends, shareOrCopy, shortDate, statusBadge } from './ui.js';
import { barChart, lineChart } from './charts.js';
import qrcode from './vendor/qrcode.js';

const view = document.getElementById('view');
const tabs = document.getElementById('coach-tabs');

// Links for swimmers point at the swimmer app, next to this page.
const appUrl = () => new URL('./', location.href).href;

// Invite link as a QR code (SVG, dark on white so it scans in dark mode too).
function qrSvg(text) {
  const qr = qrcode(0, 'M'); // smallest size that fits, medium error correction
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true, alt: 'QR code: invite link to join the group' });
}

// Flags are worded for the athlete ("your baseline"); reword for the coach.
const theirs = (text) => text.replace(/\byour\b/g, 'their');
const first = (name) => String(name).split(' ')[0];
const ago = (at) => {
  const mins = Math.round((Date.now() - at) / 60000);
  return mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`;
};
const athleteLink = (key, name) => `<a href="#swimmers/${encodeURIComponent(key)}">${esc(name)}</a>`;

// Share sheet on phones, clipboard elsewhere; the button says what happened.
function wireShare(root, button, field, copiedText = 'Copied') {
  const btn = root.querySelector(button);
  if (!btn) return;
  btn.onclick = async () => {
    const box = root.querySelector(field);
    const text = box.value ?? box.textContent;
    if (await shareOrCopy(text, { share: true, field: box }) === 'copied') btn.textContent = copiedText;
  };
}

// ------------------------------------------------------------- group data

let cache = null; // { at, rows } – shared by every tab while the page is open

async function loadRows(coach, force) {
  if (!force && cache && Date.now() - cache.at < 5 * 60000) return cache.rows;
  const res = await callSheet(coach.url, { action: 'dashboard', coachPassword: coach.password, days: 120 });
  cache = { at: Date.now(), rows: res.rows };
  return res.rows;
}

const refreshLine = (href) => `<p class="muted small refresh-line">Updated ${ago(cache?.at ?? Date.now())} ·
  <a href="${href}${href.includes('?') ? '&' : '?'}refresh=${Date.now()}">Refresh</a></p>`;

function signOut() {
  saveCoach(null);
  cache = null;
  location.hash = '#group';
  route();
}

// ------------------------------------------------------------------ router

const SCREENS = { group: renderGroup, history: renderHistory, swimmers: renderSwimmers, messages: renderMessages, settings: renderSettings };

function route() {
  const [path, qs] = (location.hash.slice(1) || 'group').split('?');
  const [name, arg] = path.split('/');
  const screen = SCREENS[name] ? name : 'group';
  const query = new URLSearchParams(qs || '');
  tabs.querySelectorAll('a').forEach((a) => a.toggleAttribute('aria-current', a.dataset.tab === screen));
  window.scrollTo(0, 0);

  const coach = loadCoach();
  tabs.hidden = !coach;
  if (!coach) { renderLogin(); return; }
  if (screen === 'settings') { renderSettings(coach); return; }

  view.innerHTML = '<section class="card"><p class="muted">Loading the group sheet…</p></section>';
  loadRows(coach, query.has('refresh'))
    .then((rows) => {
      if (query.has('refresh')) history.replaceState(null, '', location.href.replace(/[?&]refresh=\d+/, ''));
      SCREENS[screen]({ coach, rows, query, arg: arg && decodeURIComponent(arg) });
    })
    .catch((e) => {
      view.innerHTML = `<section class="card"><h3>Couldn’t load the group sheet</h3><p>${esc(e.message)}</p>
        <div class="actions"><a class="btn" href="#${screen}?refresh=${Date.now()}">Try again</a>
        <a class="btn secondary" href="#settings">Settings</a></div></section>`;
    });
}
window.addEventListener('hashchange', route);

// ------------------------------------------------------------------- group

const WATCH_LABEL = { critical: 'Talk today', serious: 'Talk soon', warning: 'Keep an eye', note: 'FYI' };

function renderGroup({ rows, query }) {
  const date = query.get('d') || todayISO();
  const day = groupDay(rows, date);
  const watch = watchList(rows, date);
  const hrvCell = (c) => {
    const e = c.entry.hrv;
    if (!e) return '–';
    const z = c.assessment.hrvZ;
    const arrow = z === null ? '' : z < -1 ? ' ▼' : z > 1 ? ' ▲' : '';
    return `${fmt(e.rmssd ?? Math.exp(e.lnRmssd))}${arrow}`;
  };

  view.innerHTML = `
    <section class="card">
      <div class="coach-head">
        <a class="btn secondary icon-btn" href="#group?d=${shiftDate(date, -1)}" aria-label="Previous day">‹</a>
        <h2>${esc(prettyDate(date))}</h2>
        <a class="btn secondary icon-btn" href="#group?d=${shiftDate(date, 1)}" aria-label="Next day" ${date >= todayISO() ? 'hidden' : ''}>›</a>
      </div>
      <div class="stats">
        <div><span class="stat-num">${day.checkedIn.length}/${day.total}</span><span class="stat-label">checked in</span></div>
        <div><span class="stat-num">${day.needAttention}</span><span class="stat-label">need attention</span></div>
        <div><span class="stat-num">${day.avgReadiness ?? '–'}</span><span class="stat-label">avg readiness</span></div>
      </div>
      ${refreshLine(`#group?d=${date}`)}
    </section>

    <section class="card">
      <h3>Watch list</h3>
      ${watch.length ? `<p class="muted small">Swimmers worth a word, based on their last 7 days.</p>
        <ul class="watch">${watch.map((w) => `
          <li><div class="watch-head">${athleteLink(w.key, w.name)}
            ${statusBadge({ level: w.reasons[0].level, label: WATCH_LABEL[w.reasons[0].level] })}</div>
            <ul>${w.reasons.map((r) => `<li>${esc(r.text)}</li>`).join('')}</ul></li>`).join('')}
        </ul>`
    : '<p class="muted">Nobody stands out over the last 7 days.</p>'}
    </section>

    <section class="card">
      <h3>Check-ins</h3>
      ${day.checkedIn.length ? `<div class="table-wrap"><table class="group-table">
        <thead><tr><th>Athlete</th><th>Ready</th><th>Well</th><th>HRV</th><th>HR</th><th>Load</th></tr></thead>
        <tbody>${day.checkedIn.map((c) => `
          <tr>
            <td class="who">${athleteLink(c.key, c.name)}<br>${statusBadge(c.assessment.status)}</td>
            <td><b>${c.assessment.score ?? '–'}</b></td>
            <td>${c.wellness ?? '–'}</td>
            <td>${hrvCell(c)}</td>
            <td>${fmt(c.entry.hrv?.hr)}</td>
            <td>${c.load || '–'}</td>
          </tr>
          ${c.assessment.flags.length ? `<tr class="flag-row"><td colspan="6">${c.assessment.flags.map((f) => esc(theirs(f.text))).join(' · ')}</td></tr>` : ''}`).join('')}
        </tbody></table></div>
        <p class="muted small">Worst first. HRV = RMSSD in ms; ▼/▲ = well below/above that athlete’s normal range. Load = minutes × RPE.</p>`
    : '<p class="muted">No check-ins for this day yet.</p>'}
    </section>

    ${day.missing.length ? `<section class="card"><h3>Not checked in</h3><ul class="plain">
      ${day.missing.map((m) => `<li>${athleteLink(m.key, m.name)}
        <span class="muted small">last ${esc(shortDate(m.lastSeen))}</span>${m.missedDays >= 2 ? `<span class="missed">· missed ${m.missedDays} days</span>` : ''}</li>`).join('')}
    </ul>
    ${date === todayISO() ? '<div class="actions"><a class="btn secondary" href="#messages">Send a reminder</a></div>' : ''}
    </section>` : ''}`;
}

// ----------------------------------------------------------------- history

function renderHistory({ rows, query }) {
  const date = todayISO();
  const span = query.get('t') === '28' ? 28 : 7;
  const trend = teamTrend(rows, date, span);
  const now = trendSummary(trend);
  const prev = trendSummary(teamTrend(rows, shiftDate(date, -span), span));
  const grid = checkinGrid(rows, date, 14);
  const change = (a, b, unit = '') => (a === null || b === null || a === b ? ''
    : ` <span class="muted small">${a > b ? '▲' : '▼'} ${Math.abs(a - b)}${unit}</span>`);
  const cell = (c) => {
    if (!c) return '<td class="grid-miss" title="No check-in">·</td>';
    const level = c.injury ? 'critical' : c.status || 'good';
    return `<td class="grid-in grid-${level}" title="${c.injury ? 'Injury reported' : 'Checked in'}">${c.injury ? '✕' : '✓'}</td>`;
  };

  view.innerHTML = `
    <section class="card">
      <div class="card-head"><h3>Team trends</h3>
        <span class="seg"><a href="#history?t=7" ${span === 7 ? 'aria-current="true"' : ''}>7 days</a><a href="#history?t=28" ${span === 28 ? 'aria-current="true"' : ''}>28 days</a></span></div>
      <div class="stats small-stats">
        <div><span class="stat-num">${now.avgReadiness ?? '–'}${change(now.avgReadiness, prev.avgReadiness)}</span><span class="stat-label">avg readiness</span></div>
        <div><span class="stat-num">${now.rate ?? '–'}%${change(now.rate, prev.rate, '%')}</span><span class="stat-label">check-in rate</span></div>
        <div><span class="stat-num">${now.avgLoad ?? '–'}${change(now.avgLoad, prev.avgLoad)}</span><span class="stat-label">avg daily load</span></div>
      </div>
      <p class="muted small">Last ${span} days; arrows compare with the ${span} days before.</p>
      <div class="trend-block"><h4>Average readiness</h4><div data-t="ready"></div></div>
      <div class="trend-block"><h4>Checked in (%)</h4><div data-t="rate"></div></div>
      <div class="trend-block"><h4>Average training load</h4><div data-t="load"></div></div>
      ${refreshLine(`#history?t=${span}`)}
    </section>

    <section class="card">
      <h3>Check-in record</h3>
      <p class="muted small">Last 14 days, oldest on the left. ✓ checked in (coloured by readiness) · ✕ injury reported · dot = no check-in.</p>
      ${grid.rows.length ? `<div class="table-wrap"><table class="checkin-grid">
        <thead><tr><th>Swimmer</th>${grid.dates.map((d) => `<th title="${esc(prettyDate(d))}">${new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'narrow' })}</th>`).join('')}</tr></thead>
        <tbody>${grid.rows.map((r) => `<tr><td class="who">${athleteLink(r.key, first(r.name))} <span class="grid-count muted small">${r.count}/14</span></td>${r.cells.map(cell).join('')}</tr>`).join('')}</tbody>
      </table></div>` : '<p class="muted">No check-ins in the last 14 days.</p>'}
    </section>`;

  const series = (k, none = NaN) => trend.map((d) => ({ x: dayIndex(d.date), y: d[k] ?? none, label: shortDate(d.date) }));
  const $t = (k) => view.querySelector(`[data-t="${k}"]`);
  requestAnimationFrame(() => {
    lineChart($t('ready'), series('avgReadiness'), { yMin: 0, yMax: 100 });
    barChart($t('rate'), series('rate', 0), { yMax: 100, tip: (d) => `${d.label}: <b>${d.y}%</b>` });
    barChart($t('load'), series('avgLoad'), { tip: (d) => `${d.label}: <b>${d.y} AU</b>` });
  });
}

// ---------------------------------------------------------------- swimmers

function renderSwimmers(ctx) {
  if (ctx.arg) { renderSwimmer(ctx); return; }
  const list = roster(ctx.rows, todayISO());
  view.innerHTML = `
    <section class="card">
      <h2>Swimmers</h2>
      <p class="muted small">Everyone who has checked in in the last 3 weeks. Tap a name for their history.</p>
      ${list.length ? `<ul class="roster">${list.map((s) => `
        <li><a href="#swimmers/${encodeURIComponent(s.key)}">
          <span class="roster-name">${esc(s.name)}</span>
          <span class="roster-meta">${statusBadge(s.status)}
            <span class="muted small">${s.checkins7}/7 days${s.avg7 !== null ? ` · avg ${s.avg7}` : ''} · last ${esc(shortDate(s.lastDate))}</span></span>
        </a></li>`).join('')}</ul>` : '<p class="muted">Nobody has checked in yet. Invite your swimmers from the Messages tab.</p>'}
      ${refreshLine('#swimmers')}
    </section>`;
}

function renderSwimmer({ rows, arg }) {
  const a = groupByAthlete(rows).get(arg);
  if (!a) {
    view.innerHTML = '<section class="card"><p>No data for this swimmer.</p><a href="#swimmers">‹ Swimmers</a></section>';
    return;
  }
  const latest = a.entries.at(-1);
  const assessment = assessDay(a.entries, latest.date);
  view.innerHTML = `
    <section class="card">
      <p><a href="#swimmers">‹ Swimmers</a></p>
      <h2>${esc(a.name)}</h2>
      <p class="muted small">Latest check-in ${esc(prettyDate(latest.date))}</p>
      <div class="score-row">
        <div class="score"><span class="score-num">${assessment.score ?? '–'}</span><span class="score-max">/100</span></div>
        <div>${statusBadge(assessment.status)}</div>
      </div>
      ${assessment.flags.length ? `<ul class="flags">${assessment.flags.map((f) => `<li>${statusBadge({ level: f.level, label: f.level === 'critical' ? 'Important' : 'Note' })} ${esc(theirs(f.text))}</li>`).join('')}</ul>` : ''}
      <div class="actions"><a class="btn secondary" href="#messages?to=${encodeURIComponent(a.key)}">Message ${esc(first(a.name))}</a></div>
    </section>
    <div id="trends"></div>
    <section class="card"><h3>Recent days</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Date</th><th>Ready</th><th>Well</th><th>Sleep</th><th>HR</th><th>HRV</th><th>Load</th></tr></thead>
        <tbody>${[...a.entries].reverse().slice(0, 28).map((e) => `
          <tr>
            <td>${esc(shortDate(e.date))}</td>
            <td>${assessDay(a.entries, e.date).score ?? '–'}</td>
            <td>${wellnessScore(e.wellness) ?? '–'}</td>
            <td>${fmt(e.wellness?.sleepHours, 1)}</td>
            <td>${fmt(e.hrv?.hr)}</td>
            <td>${fmt(e.hrv?.rmssd)}</td>
            <td>${sessionLoad(e.training) || '–'}</td>
          </tr>
          ${e.notes || e.pain?.level ? `<tr class="flag-row"><td colspan="7">${[
    e.pain?.level ? `Injury ${e.pain.level}/3${e.pain.location ? ` (${esc(e.pain.location)})` : ''}` : '',
    e.notes ? `“${esc(e.notes)}”` : '',
  ].filter(Boolean).join(' · ')}</td></tr>` : ''}`).join('')}
        </tbody></table></div>
      <p class="muted small">HRV = RMSSD in ms.</p>
    </section>`;
  renderTrends(view.querySelector('#trends'), a.entries, { who: 'their' });
}

// ---------------------------------------------------------------- messages

const INJURY = ['', 'Minor – manageable', 'Moderate – affecting stroke', 'Major – stopping some strokes'];

function renderMessages({ coach, rows, query }) {
  const date = todayISO();
  const day = groupDay(rows, date);
  const notes = recentNotes(rows, date, 14);
  const link = coach.group ? inviteLink(appUrl(), coach.url, coach.group) : '';
  const to = query.get('to') && groupByAthlete(rows).get(query.get('to'));

  view.innerHTML = `
    ${to ? `<section class="card" id="direct">
      <h3>Message ${esc(to.name)}</h3>
      <label class="field">Your message
        <textarea id="direct-text" rows="4">Hi ${esc(first(to.name))}, just checking in. How are you feeling about training this week? Grab me before practice if anything’s up.</textarea></label>
      <div class="actions"><button class="btn" id="send-direct">${navigator.share ? 'Share message' : 'Copy message'}</button></div>
      <p class="muted small">Opens your phone’s share sheet so you can send it by text or your usual chat app.</p>
    </section>` : ''}

    <section class="card">
      <h3>From your swimmers</h3>
      <p class="muted small">Notes and injuries from check-ins in the last 14 days, newest first.</p>
      ${notes.length ? `<ul class="notes-feed">${notes.map((n) => `
        <li>
          <div class="note-head">${athleteLink(n.key, n.name)} <span class="muted small">${esc(prettyDate(n.date))}</span></div>
          ${n.injury ? `<p class="note-injury">${statusBadge({ level: n.injury.level >= 3 ? 'critical' : n.injury.level === 2 ? 'serious' : 'warning', label: 'Injury' })}
            ${esc(INJURY[n.injury.level])}${n.injury.location ? ` – ${esc(n.injury.location)}` : ''}</p>` : ''}
          ${n.note ? `<p class="note-text">“${esc(n.note)}”</p>` : ''}
          <a class="small" href="#messages?to=${encodeURIComponent(n.key)}">Reply to ${esc(first(n.name))}</a>
        </li>`).join('')}</ul>` : '<p class="muted">No notes or injuries in the last 14 days.</p>'}
    </section>

    <section class="card">
      <h3>Check-in reminder</h3>
      ${day.missing.length ? `<p class="muted small">${day.missing.length} swimmer${day.missing.length > 1 ? 's haven’t' : ' hasn’t'} checked in today.</p>
        <label class="field">Message for your group chat
          <textarea id="reminder" rows="3">${esc(reminderText(day.missing, appUrl()))}</textarea></label>
        <div class="actions"><button class="btn" id="send-reminder">${navigator.share ? 'Share reminder' : 'Copy reminder'}</button></div>`
    : '<p class="muted">Everyone in the group has checked in today.</p>'}
    </section>

    <section class="card">
      <h3>Invite swimmers</h3>
      ${link ? `<p class="muted small">Swimmers scan this with their phone camera, or you send them the link.
        It fills in the group details; they just add their name.</p>
        <div class="qr">${qrSvg(link)}</div>
        <input class="copy-field" id="invite" readonly value="${esc(link)}">
        <div class="actions"><button class="btn secondary" id="copy-invite">${navigator.share ? 'Share link' : 'Copy link'}</button></div>`
    : '<p class="muted small">Add your group code in Settings to get an invite link and QR code.</p>'}
    </section>`;

  wireShare(view, '#send-direct', '#direct-text', 'Copied – paste it in a message');
  wireShare(view, '#send-reminder', '#reminder', 'Copied – paste it in your group chat');
  wireShare(view, '#copy-invite', '#invite');
  if (to) view.querySelector('#direct').scrollIntoView({ block: 'start' });
}

// ---------------------------------------------------------------- settings

function renderSettings(coach) {
  view.innerHTML = `
    <section class="card">
      <h2>Settings</h2>
      <dl class="settings-list">
        <dt>Group sheet</dt><dd class="small">${esc(coach.url)}</dd>
        <dt>Group code</dt><dd>${coach.group ? esc(coach.group) : '<span class="muted">Not set – needed for the invite link</span>'}</dd>
      </dl>
      <form id="group-form" class="stack">
        <label class="field">Group code <input name="group" value="${esc(coach.group || '')}" autocomplete="off"></label>
        <p class="form-error" id="group-error" role="alert" hidden></p>
        <button class="btn secondary" type="submit">Save group code</button>
      </form>
    </section>

    <section class="card">
      <h3>Spreadsheet</h3>
      <p class="muted small">Every check-in is also a row in the <b>Entries</b> tab of your Google Sheet, and the
        <b>Today</b> tab lists today’s check-ins, lowest readiness first.</p>
      <p class="muted small">If you edit the script, use <b>Deploy → Manage deployments → Edit → New version</b>.
        A <i>new deployment</i> changes the link, and swimmers’ check-ins would stop arriving.</p>
    </section>

    <section class="card">
      <h3>Add this dashboard to your Home Screen</h3>
      <p class="muted small">On iPhone: Share → Add to Home Screen. It opens straight to this dashboard.
        You’ll sign in once more in the Home Screen app.</p>
    </section>

    <section class="card">
      <a class="btn secondary block" href="./">Open the swimmer app</a>
      <button class="btn secondary danger block" id="signout">Sign out of coach dashboard</button>
    </section>`;

  view.querySelector('#group-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const group = ev.target.group.value.trim();
    const err = view.querySelector('#group-error');
    err.hidden = true;
    try {
      if (group) await callSheet(coach.url, { action: 'ping', group });
      saveCoach({ ...coach, group });
      renderSettings(loadCoach());
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
    }
  });
  view.querySelector('#signout').onclick = signOut;
}

// ------------------------------------------------------------------- login

function renderLogin() {
  view.innerHTML = `
    <section class="card">
      <h2>Coach dashboard</h2>
      <p>See your group’s readiness each day. Data comes from a Google Sheet you own.</p>
      <details ${loadTeam() ? '' : 'open'}>
        <summary>First time? Set up the group sheet (5 minutes)</summary>
        <ol class="steps">
          <li>Create a new Google Sheet: <a href="https://sheets.new" target="_blank" rel="noopener">sheets.new</a>.</li>
          <li>In the sheet, open <b>Extensions → Apps Script</b>. Delete what’s there and paste the group script
            <button class="btn secondary small-btn" id="copy-script" type="button">Copy script</button></li>
          <li>At the top of the script, change <code>GROUP_CODE</code> (athletes type this) and
            <code>COACH_PASSWORD</code> (only you know this). Click <b>Save</b>.</li>
          <li>Click <b>Deploy → New deployment</b>, choose type <b>Web app</b>, set
            <b>Execute as: Me</b> and <b>Who has access: Anyone</b>, then <b>Deploy</b>.
            Google will ask you to authorize; if it says the app isn’t verified, choose <b>Advanced → Go to … (unsafe)</b>
            — it’s your own script.</li>
          <li>Copy the <b>Web app URL</b> and paste it below with your password and group code.</li>
        </ol>
        <p class="muted small">If you edit the script later, use <b>Deploy → Manage deployments → Edit → New version</b> so the link stays the same.</p>
      </details>
      <form id="coach-login" class="stack">
        <label class="field">Web app URL <input name="url" type="url" required placeholder="https://script.google.com/macros/s/…/exec"></label>
        <label class="field">Coach password <input name="password" type="password" required autocomplete="current-password"></label>
        <label class="field">Group code <span class="muted small">(for the invite link)</span> <input name="group"></label>
        <p class="form-error" id="login-error" role="alert" hidden></p>
        <button class="btn block" type="submit">Open dashboard</button>
      </form>
      <p class="muted small">Your password is remembered on this device only. Use Sign out on shared devices.</p>
      <p class="small"><a href="./">‹ Back to the swimmer app</a></p>
    </section>`;
  view.querySelector('#copy-script').onclick = async (ev) => {
    const btn = ev.target;
    try {
      const text = await (await fetch('apps-script/Code.gs')).text();
      await navigator.clipboard.writeText(text);
      btn.textContent = 'Copied';
    } catch {
      window.open('apps-script/Code.gs', '_blank');
    }
  };
  view.querySelector('#coach-login').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const err = view.querySelector('#login-error');
    const url = f.url.value.trim();
    err.hidden = true;
    if (!isValidSheetUrl(url)) {
      err.textContent = 'The web app URL should start with https://script.google.com/';
      err.hidden = false;
      return;
    }
    const btn = f.querySelector('button');
    btn.disabled = true; btn.textContent = 'Checking…';
    try {
      await callSheet(url, { action: 'ping', coachPassword: f.password.value });
      if (f.group.value.trim()) await callSheet(url, { action: 'ping', group: f.group.value.trim() });
      saveCoach({ url, password: f.password.value, group: f.group.value.trim() });
      cache = null;
      route();
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
      btn.disabled = false; btn.textContent = 'Open dashboard';
    }
  });
}

// -------------------------------------------------------------------- boot

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  // Take updates as soon as they arrive: nothing on these screens is lost by a reload.
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) location.reload(); });
  navigator.serviceWorker.register('sw.js').then((reg) => reg.update().catch(() => {})).catch(() => {});
}

route();
