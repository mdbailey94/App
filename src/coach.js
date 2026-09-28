// Team tab (athletes join the group) and the coach dashboard.

import { loadCoach, loadTeam, resetSync, saveCoach, saveTeam, todayISO } from './storage.js';
import { addressDetails, callSheet, inviteLink, isValidSheetUrl, memberAddress, syncPending, syncStatus } from './team.js';
import { groupByAthlete, groupDay, reminderText, teamTrend, trendSummary, watchList } from './group.js';
import { assessDay, sessionLoad, shiftDate, wellnessScore } from './readiness.js';
import { dayIndex, esc, fmt, prettyDate, renderTrends, shareOrCopy, shortDate, statusBadge } from './ui.js';
import { barChart, lineChart } from './charts.js';
import qrcode from './vendor/qrcode.js';

// Invite link as a QR code (SVG, dark on white so it scans in dark mode too).
function qrSvg(text) {
  const qr = qrcode(0, 'M'); // smallest size that fits, medium error correction
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true, alt: 'QR code: invite link to join the group' });
}

// Flags are worded for the athlete ("your baseline"); reword for the coach.
const theirs = (text) => text.replace(/\byour\b/g, 'their');

const since = (iso) => {
  if (!iso) return 'never';
  const mins = Math.round((Date.now() - new Date(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} h ago`;
  return new Date(iso).toLocaleDateString();
};

// ---------------------------------------------------------------- athletes

export function renderTeam(view, query, rerender) {
  const $ = (sel) => view.querySelector(sel);
  const status = syncStatus();
  const invited = addressDetails(location.search, query);
  const invitedUrl = invited.url;
  const invitedGroup = invited.group;
  const returning = Boolean(invited.athlete && invitedUrl && invitedGroup);

  if (!status.joined) {
    view.innerHTML = `
      <section class="card">
        <h2>${returning ? `Finish setting up, ${esc(invited.athlete.split(' ')[0])}` : 'Share with your coach'}</h2>
        ${returning ? `<p>This copy of the app needs to reconnect to <b>${esc(invitedGroup)}</b>. Check your name and tap
          <b>Join group</b>.</p>` : ''}
        <p${returning ? ' class="muted small"' : ''}>Join your practice group so your coach can follow your recovery. Your check-ins
          (including injuries and notes) and heart readings are sent to the group’s spreadsheet,
          which only your coach can open.</p>
        <form id="join" class="stack">
          <label class="field">Your name <input name="athlete" autocomplete="name" required maxlength="60" placeholder="First and last name" value="${esc(invited.athlete)}"></label>
          <label class="field">Group code <input name="group" required value="${esc(invitedGroup)}" autocapitalize="characters"></label>
          <label class="field" ${invitedUrl ? 'hidden' : ''}>Group sheet link
            <input name="url" type="url" required value="${esc(invitedUrl)}" placeholder="https://script.google.com/macros/s/…/exec">
            <span class="muted small">Your coach’s invite link fills this in for you.</span></label>
          <p class="form-error" id="join-error" role="alert" hidden></p>
          <button class="btn block" type="submit">Join group</button>
        </form>
      </section>
      <section class="card">
        <h3>Are you the coach?</h3>
        <p class="muted small">Set up the group spreadsheet and see everyone’s readiness.</p>
        <a class="btn secondary block" href="#coach">Open coach dashboard</a>
      </section>`;
    $('#join').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = ev.target;
      const err = $('#join-error');
      const athlete = f.athlete.value.trim();
      const group = f.group.value.trim();
      const url = f.url.value.trim();
      err.hidden = true;
      if (!athlete || !group || !isValidSheetUrl(url)) {
        err.textContent = !isValidSheetUrl(url) ? 'The group sheet link should start with https://script.google.com/' : 'Please fill in your name and group code.';
        err.hidden = false;
        return;
      }
      const btn = f.querySelector('button');
      btn.disabled = true; btn.textContent = 'Joining…';
      try {
        await callSheet(url, { action: 'ping', group });
        saveTeam({ url, group, athlete, joinedAt: new Date().toISOString() });
        resetSync(); // send the athlete's whole history to the group…
        syncPending(); // …in the background, so they can start straight away
        // Keep the group details in the address (for Add to Home Screen) and go
        // straight into today's check-in; replaceState keeps the form out of Back.
        history.replaceState(null, '', memberAddress(location.href, loadTeam(), '#morning?joined=1'));
        rerender();
      } catch (e) {
        err.textContent = e.message;
        err.hidden = false;
        btn.disabled = false; btn.textContent = 'Join group';
      }
    });
    return;
  }

  view.innerHTML = `
    <section class="card">
      <h2>Your group</h2>
      <p>Sharing with your coach as <b>${esc(status.athlete)}</b> (group ${esc(status.group)}).</p>
      <p id="sync-line">${syncLine(status)}</p>
      <div class="actions">
        <button class="btn" id="send">Send now</button>
        <button class="btn secondary danger" id="leave">Stop sharing</button>
      </div>
    </section>
    <section class="card">
      <h3>Are you the coach?</h3>
      <a class="btn secondary block" href="#coach">Open coach dashboard</a>
    </section>`;
  $('#send').onclick = async () => {
    $('#send').disabled = true;
    await syncPending();
    rerender();
  };
  $('#leave').onclick = () => {
    if (confirm('Stop sharing with your coach? Data already sent stays in the group sheet; your coach can remove it.')) {
      saveTeam(null);
      history.replaceState(null, '', `${location.pathname}#team`);
      rerender();
    }
  };
}

export function syncLine(status) {
  if (!status.joined) return '';
  if (status.lastError && status.pending) {
    return `${statusBadge({ level: 'warning', label: 'Not sent yet' })} ${esc(status.lastError)} It will retry automatically.`;
  }
  if (status.pending) return `${statusBadge({ level: 'warning', label: 'Sending' })} ${status.pending} day${status.pending > 1 ? 's' : ''} waiting to send.`;
  return `${statusBadge({ level: 'good', label: 'Shared with coach' })} Last sent ${since(status.lastSync)}.`;
}

// ------------------------------------------------------------------ coach

let cache = null; // { at, rows } – kept while the app is open

function signOut() {
  saveCoach(null);
  cache = null;
  location.hash = '#coach';
}

async function loadRows(coach, force) {
  if (!force && cache && Date.now() - cache.at < 5 * 60000) return cache.rows;
  const res = await callSheet(coach.url, { action: 'dashboard', coachPassword: coach.password, days: 120 });
  cache = { at: Date.now(), rows: res.rows };
  return res.rows;
}

export function renderCoach(view, query) {
  const coach = loadCoach();
  if (!coach) return renderCoachLogin(view);
  const athleteKey = query.get('a');
  view.innerHTML = '<section class="card"><p class="muted">Loading the group sheet…</p></section>';
  loadRows(coach, query.has('refresh'))
    .then((rows) => (athleteKey ? renderAthlete(view, rows, athleteKey)
      : renderGroup(view, coach, rows, query.get('d') || todayISO(), query.get('t') === '28' ? 28 : 7)))
    .catch((e) => {
      view.innerHTML = `<section class="card"><h3>Couldn’t load the group sheet</h3><p>${esc(e.message)}</p>
        <div class="actions"><a class="btn" href="#coach?refresh=${Date.now()}">Try again</a>
        <button class="btn secondary" id="signout">Sign out</button></div></section>`;
      view.querySelector('#signout').onclick = signOut;
    });
}

const WATCH_LABEL = { critical: 'Talk today', serious: 'Talk soon', warning: 'Keep an eye', note: 'FYI' };

function renderGroup(view, coach, rows, date, span) {
  const day = groupDay(rows, date);
  const watch = watchList(rows, date);
  const trend = teamTrend(rows, date, span);
  const prev = trendSummary(teamTrend(rows, shiftDate(date, -span), span));
  const now = trendSummary(trend);
  const isToday = date === todayISO();
  const appUrl = `${location.origin}${location.pathname}`;
  const here = (extra) => `#coach?d=${date}${extra}`;
  const change = (a, b, unit = '') => (a === null || b === null || a === b ? ''
    : ` <span class="muted small">${a > b ? '▲' : '▼'} ${Math.abs(a - b)}${unit}</span>`);
  const link = coach.group ? inviteLink(location.href, coach.url, coach.group) : '';
  const hrvCell = (c) => {
    const e = c.entry.hrv;
    if (!e) return '–';
    const z = c.assessment.hrvZ;
    const arrow = z === null ? '' : z < -1 ? ' ▼' : z > 1 ? ' ▲' : '';
    return `${fmt(e.lnRmssd, 2)}${arrow}`;
  };

  view.innerHTML = `
    <section class="card">
      <div class="coach-head">
        <a class="btn secondary icon-btn" href="#coach?d=${shiftDate(date, -1)}" aria-label="Previous day">‹</a>
        <h2>${esc(prettyDate(date))}</h2>
        <a class="btn secondary icon-btn" href="#coach?d=${shiftDate(date, 1)}" aria-label="Next day" ${date >= todayISO() ? 'hidden' : ''}>›</a>
      </div>
      <div class="stats">
        <div><span class="stat-num">${day.checkedIn.length}/${day.total}</span><span class="stat-label">checked in</span></div>
        <div><span class="stat-num">${day.needAttention}</span><span class="stat-label">need attention</span></div>
        <div><span class="stat-num">${day.avgReadiness ?? '–'}</span><span class="stat-label">avg readiness</span></div>
      </div>
      <div class="actions"><a class="btn secondary" href="#coach?d=${date}&refresh=${Date.now()}">Refresh</a></div>
    </section>

    <section class="card">
      <h3>Watch list</h3>
      ${watch.length ? `<p class="muted small">Swimmers worth a word, based on their last 7 days.</p>
        <ul class="watch">${watch.map((w) => `
          <li><div class="watch-head"><a href="#coach?a=${encodeURIComponent(w.key)}">${esc(w.name)}</a>
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
            <td class="who"><a href="#coach?a=${encodeURIComponent(c.key)}">${esc(c.name)}</a><br>${statusBadge(c.assessment.status)}</td>
            <td><b>${c.assessment.score ?? '–'}</b></td>
            <td>${c.wellness ?? '–'}</td>
            <td>${hrvCell(c)}</td>
            <td>${fmt(c.entry.hrv?.hr)}</td>
            <td>${c.load || '–'}</td>
          </tr>
          ${c.assessment.flags.length ? `<tr class="flag-row"><td colspan="6">${c.assessment.flags.map((f) => esc(theirs(f.text))).join(' · ')}</td></tr>` : ''}`).join('')}
        </tbody></table></div>
        <p class="muted small">Worst first. HRV = ln RMSSD; ▼/▲ = well below/above that athlete’s normal range. Load = minutes × RPE.</p>`
    : '<p class="muted">No check-ins for this day yet.</p>'}
    </section>

    ${day.missing.length ? `<section class="card"><h3>Not checked in</h3><ul class="plain">
      ${day.missing.map((m) => `<li><a href="#coach?a=${encodeURIComponent(m.key)}">${esc(m.name)}</a>
        <span class="muted small">last ${esc(shortDate(m.lastSeen))}</span>${m.missedDays >= 2 ? `<span class="missed">· missed ${m.missedDays} days</span>` : ''}</li>`).join('')}
    </ul>
    ${isToday ? `<label class="field">Reminder for your group chat
        <textarea id="reminder" rows="3">${esc(reminderText(day.missing, appUrl))}</textarea></label>
      <div class="actions"><button class="btn" id="send-reminder">${navigator.share ? 'Share reminder' : 'Copy reminder'}</button></div>` : ''}
    </section>` : ''}

    <section class="card">
      <div class="card-head"><h3>Team trends</h3>
        <span class="seg"><a href="${here('&t=7')}" ${span === 7 ? 'aria-current="true"' : ''}>7 days</a><a href="${here('&t=28')}" ${span === 28 ? 'aria-current="true"' : ''}>28 days</a></span></div>
      <div class="stats small-stats">
        <div><span class="stat-num">${now.avgReadiness ?? '–'}${change(now.avgReadiness, prev.avgReadiness)}</span><span class="stat-label">avg readiness</span></div>
        <div><span class="stat-num">${now.rate ?? '–'}%${change(now.rate, prev.rate, '%')}</span><span class="stat-label">check-in rate</span></div>
        <div><span class="stat-num">${now.avgLoad ?? '–'}${change(now.avgLoad, prev.avgLoad)}</span><span class="stat-label">avg daily load</span></div>
      </div>
      <p class="muted small">Last ${span} days to ${esc(shortDate(date))}; arrows compare with the ${span} days before.</p>
      <div class="trend-block"><h4>Average readiness</h4><div data-t="ready"></div></div>
      <div class="trend-block"><h4>Checked in (%)</h4><div data-t="rate"></div></div>
      <div class="trend-block"><h4>Average training load</h4><div data-t="load"></div></div>
    </section>

    <section class="card">
      <h3>Invite athletes</h3>
      ${link ? `<p class="muted small">Athletes scan this with their phone camera, or you send them the link.
        It fills in the group details; they just add their name.</p>
        <div class="qr">${qrSvg(link)}</div>
        <input class="copy-field" id="invite" readonly value="${esc(link)}">
        <div class="actions"><button class="btn secondary" id="copy">Copy link</button></div>`
    : '<p class="muted small">Sign out and back in with your group code to get an invite link.</p>'}
    </section>

    <section class="card">
      <h3>Spreadsheet</h3>
      <p class="muted small">Every check-in is also a row in the <b>Entries</b> tab of your Google Sheet, and the
        <b>Today</b> tab lists today’s check-ins, lowest readiness first.</p>
      <button class="btn secondary block" id="signout">Sign out of coach dashboard</button>
    </section>`;

  const series = (k, none = NaN) => trend.map((d) => ({ x: dayIndex(d.date), y: d[k] ?? none, label: shortDate(d.date) }));
  const $t = (k) => view.querySelector(`[data-t="${k}"]`);
  requestAnimationFrame(() => {
    lineChart($t('ready'), series('avgReadiness'), { yMin: 0, yMax: 100 });
    barChart($t('rate'), series('rate', 0), { yMax: 100, tip: (d) => `${d.label}: <b>${d.y}%</b>` });
    barChart($t('load'), series('avgLoad'), { tip: (d) => `${d.label}: <b>${d.y} AU</b>` });
  });

  const send = view.querySelector('#send-reminder');
  if (send) {
    send.onclick = async () => {
      const field = view.querySelector('#reminder');
      if (await shareOrCopy(field.value, { share: true, field }) === 'copied') send.textContent = 'Copied – paste it in your group chat';
    };
  }

  const copy = view.querySelector('#copy');
  if (copy) {
    copy.onclick = async () => {
      const field = view.querySelector('#invite');
      if (await shareOrCopy(field.value, { field }) === 'copied') copy.textContent = 'Copied';
    };
  }
  view.querySelector('#signout').onclick = signOut;
}

function renderAthlete(view, rows, key) {
  const a = groupByAthlete(rows).get(key);
  if (!a) {
    view.innerHTML = '<section class="card"><p>No data for this athlete.</p><a href="#coach">Back to group</a></section>';
    return;
  }
  const latest = a.entries.at(-1);
  const assessment = assessDay(a.entries, latest.date);
  view.innerHTML = `
    <section class="card">
      <p><a href="#coach">‹ Group</a></p>
      <h2>${esc(a.name)}</h2>
      <p class="muted small">Latest check-in ${esc(prettyDate(latest.date))}</p>
      <div class="score-row">
        <div class="score"><span class="score-num">${assessment.score ?? '–'}</span><span class="score-max">/100</span></div>
        <div>${statusBadge(assessment.status)}</div>
      </div>
      ${assessment.flags.length ? `<ul class="flags">${assessment.flags.map((f) => `<li>${statusBadge({ level: f.level, label: f.level === 'critical' ? 'Important' : 'Note' })} ${esc(theirs(f.text))}</li>`).join('')}</ul>` : ''}
    </section>
    <div id="trends"></div>
    <section class="card"><h3>Recent days</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Date</th><th>Ready</th><th>Well</th><th>Sleep</th><th>HR</th><th>RMSSD</th><th>Load</th></tr></thead>
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
    </section>`;
  renderTrends(view.querySelector('#trends'), a.entries, { who: 'their' });
}

function renderCoachLogin(view) {
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
      renderCoach(view, new URLSearchParams());
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
      btn.disabled = false; btn.textContent = 'Open dashboard';
    }
  });
}
