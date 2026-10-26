// The coach dashboard (coach.html): its own page with its own tabs.
//   #group      one day: who checked in, yesterday's training, who's missing
//   #watchlist  who may need a word, by category (follow-up), and why
//   #data       the dashboard: any measure over 7–28 days, by swimmer and day (#history still works)
//   #swimmers   everyone in the group; #swimmers/<key> for one swimmer
//   #messages   notes and injuries from swimmers, reminders, invite link
//   #settings   the sheet this dashboard reads, setup help, sign out

import { loadCoach, loadTeam, saveCoach, todayISO } from './storage.js';
import { callSheet, inviteLink, isValidSheetUrl } from './team.js';
import {
  checkinGrid, dataDashboard, groupByAthlete, groupDay, loadResponse, METRICS, metricSeries, MIN_TEAM, recentNotes, reminderText, roster,
  swimmerInsights, teamTrend, trainingCompare, trendSummary,
} from './group.js';
import { followUps, followUpsFor, hardButPoor } from './followups.js';
import { goalsSummary, readTimesForm, timesFormHtml, wireTimesForm } from './goals.js';
import { formatTime, gearSet, latestGoals, MAIN_GEARS, STROKES, SUIT } from './gears.js';
import {
  assessDay, MEET_LEVELS, meetLevel, PRACTICE_KEYS, sessionLoad, sessionRpe, shiftDate, SKIP_REASONS, trainingOnDay, wellnessScore,
} from './readiness.js';
import { dayIndex, esc, fmt, prettyDate, qrSvg, shareOrCopy, shortDate, statusBadge } from './ui.js';
import { barChart, lineChart, pairChart, sparkline } from './charts.js';

const view = document.getElementById('view');
const tabs = document.getElementById('coach-tabs');

// Links for swimmers point at the swimmer app, next to this page.
const appUrl = () => new URL('./', location.href).href;

// The invite: QR code, the link itself, and a share/copy button.
const inviteBlock = (link) => `<p class="muted small">Swimmers scan this with their phone camera, or you send them the link.
        It fills in the group details; they just add their name.</p>
        <div class="qr">${qrSvg(link)}</div>
        <input class="copy-field" id="invite" readonly value="${esc(link)}">
        <div class="actions"><button class="btn secondary" id="copy-invite">${navigator.share ? 'Share link' : 'Copy link'}</button></div>`;

// Flags are worded for the athlete ("your baseline"); reword for the coach.
const theirs = (text) => text.replace(/\byour\b/g, 'their');
const first = (name) => String(name).split(' ')[0];
const ago = (at) => {
  const mins = Math.round((Date.now() - at) / 60000);
  return mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`;
};
// Yesterday's effort (1–10) for morning practice · doubles (– = didn't
// go), plus Wt / Meet tags. Older check-ins had one effort for the whole day.
function effortCell(t) {
  if (!t) return '–';
  const am = sessionRpe(t, 'am');
  if (am === undefined) return t.durationMin > 0 ? `<span title="Whole day">${t.rpe}</span>` : '–';
  const tags = sessionTags(t);
  // Logged on the Workouts tab: how well it went, or why they didn't go.
  const went = (k) => (t[k]?.perf ? t[k].perf : t[`${k}None`] ? SKIP_REASONS[t[`${k}None`]].toLowerCase() : '–');
  const second = t.logged ? `<br><span class="muted small">went ${went('am')} · ${went('pm')}</span>` : '';
  return `${am ?? '–'} · ${sessionRpe(t, 'pm') ?? '–'}${second}${tags ? `<br>${tags}` : ''}`;
}

// +5 / −3 / 0, with an arrow; bold when it's a big move.
function delta(v, { unit = '', big = 10 } = {}) {
  if (v === null || v === undefined) return '<span class="muted">–</span>';
  const arrow = v > 0 ? '▲' : v < 0 ? '▼' : '';
  const text = `${arrow}${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v)}${unit}`;
  return `<span class="delta ${v < 0 ? 'down' : v > 0 ? 'up' : ''} ${Math.abs(v) >= big ? 'big' : ''}">${text}</span>`;
}
const shortTime = (min) => {
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h}${m === 30 ? '½' : m ? `:${String(m).padStart(2, '0')}` : ''}h` : `${m}m`;
};
// "2h · 7 · 8": time, effort, and how well it went (when logged on the Workouts tab).
const practiceCell = (p) => (p?.durationMin > 0 ? `${shortTime(p.durationMin)} · ${p.rpe}${p.perf ? ` · ${p.perf}` : ''}` : '–');
// Wt if they lifted; Meet with how hard it was (older reports count as moderate).
const sessionTags = (t) => [
  t?.weights && '<span class="tag">Wt</span>',
  t?.meet && `<span class="tag tag-meet">Meet · ${MEET_LEVELS[meetLevel(t)].label.toLowerCase()}</span>`,
].filter(Boolean).join('');
// Both practices in one cell, a line each.
const practicesCell = (t) => {
  if (!t) return '–';
  if (t.assumed) return '<span class="muted">Off (Sunday)</span>';
  if (!('am' in t) && !('pm' in t)) return t.durationMin > 0 ? `<span title="Whole day">${shortTime(t.durationMin)} · ${t.rpe}</span>` : 'Rest';
  const tag = { am: 'AM', pm: 'Dbl' };
  const line = (k) => (t[k]?.durationMin > 0 ? `${tag[k]} ${practiceCell(t[k])}`
    : t[`${k}None`] ? `<span class="muted">${tag[k]} ${esc(SKIP_REASONS[t[`${k}None`]].toLowerCase())}</span>` : null);
  const lines = PRACTICE_KEYS.map(line).filter(Boolean);
  return lines.length ? lines.join('<br>') : (t.weights || t.meet ? '' : 'Rest');
};
// 6, 6.5, or – (usuals are averages, so they can have a decimal).
const num = (v) => (v === null || v === undefined ? '–' : typeof v !== 'number' || Number.isInteger(v) ? String(v) : v.toFixed(1));

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

// The group's rows, shared by every tab while the page is open and kept in
// this browser between opens, so the dashboard shows the last data at once
// and refreshes behind it (every 5 minutes, or on Refresh).
const CACHE_KEY = 'athlete-readiness/coach-rows/v1';
const FRESH_MS = 5 * 60000;
let cache = null; // { at, rows, url }
let refreshing = null;
let lastRefreshError = null;

function readCache(coach) {
  if (cache?.url === coach.url) return cache;
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY));
    if (c?.url === coach.url && Array.isArray(c.rows)) cache = c;
  } catch { /* nothing kept */ }
  return cache?.url === coach.url ? cache : null;
}

function keepCache(c) {
  cache = c;
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch { /* too big for this browser: in memory only */ }
}

async function fetchRows(coach) {
  if (refreshing) return refreshing;
  setStatus('refreshing');
  refreshing = callSheet(coach.url, { action: 'dashboard', coachPassword: coach.password, days: 120 })
    .then((res) => { keepCache({ at: Date.now(), rows: res.rows, url: coach.url }); lastRefreshError = null; return res.rows; })
    .catch((e) => { lastRefreshError = e.message; throw e; })
    .finally(() => { refreshing = null; setStatus(); });
  return refreshing;
}

// Rows to draw with now, and whether fresher ones are on the way:
// { rows, stale } (stale: a refresh is running and will redraw the screen).
async function loadRows(coach, force) {
  const kept = readCache(coach);
  if (kept && !force && Date.now() - kept.at < FRESH_MS) return { rows: kept.rows, stale: false };
  if (kept && !force) return { rows: kept.rows, stale: true };
  return { rows: await fetchRows(coach), stale: false };
}

// "Updated 3 min ago · refresh" in the top bar.
function setStatus(state) {
  const el = document.getElementById('coach-status');
  if (!el) return;
  if (!loadCoach()) { el.hidden = true; return; }
  el.hidden = false;
  const at = cache?.at;
  el.innerHTML = state === 'refreshing' ? '<span class="muted">Refreshing…</span>'
    : `<span class="muted">${at ? `Updated ${ago(at)}` : 'No data yet'}${lastRefreshError ? ' · couldn’t refresh' : ''}</span>
       <button type="button" class="link" id="refresh-now" aria-label="Refresh from the sheet">↻</button>`;
  el.querySelector('#refresh-now')?.addEventListener('click', () => { const h = location.hash.split('?')[0] || '#group'; location.hash = `${h}?refresh=${Date.now()}`; });
}

const refreshLine = (href) => `<p class="muted small refresh-line">Updated ${ago(cache?.at ?? Date.now())}${lastRefreshError ? ` · couldn’t refresh: ${esc(lastRefreshError)}` : ''} ·
  <a href="${href}${href.includes('?') ? '&' : '?'}refresh=${Date.now()}">Refresh</a></p>`;

function signOut() {
  saveCoach(null);
  cache = null;
  try { localStorage.removeItem(CACHE_KEY); } catch { /* nothing to remove */ }
  setStatus();
  location.hash = '#group';
  route();
}

// ------------------------------------------------------------------ router

const SCREENS = { group: renderGroup, watchlist: renderWatchlist, data: renderData, swimmers: renderSwimmers, gearcard: renderGearCard, messages: renderMessages, settings: renderSettings };

function route() {
  const [path, qs] = (location.hash.slice(1) || 'group').split('?');
  const [name, arg] = path.split('/');
  const screen = name === 'history' ? 'data' : SCREENS[name] ? name : 'group'; // #history: the tab's old name
  const query = new URLSearchParams(qs || '');
  tabs.querySelectorAll('a').forEach((a) => a.toggleAttribute('aria-current', a.dataset.tab === (screen === 'gearcard' ? 'swimmers' : screen)));
  window.scrollTo(0, 0);

  const coach = loadCoach();
  tabs.hidden = !coach;
  if (!coach) { renderLogin(); return; }
  if (screen === 'settings') { renderSettings(coach); return; }

  const draw = (rows) => SCREENS[screen]({ coach, rows, query, arg: arg && decodeURIComponent(arg) });
  const ticket = ++routeTicket;
  if (!readCache(coach)) view.innerHTML = skeleton();
  setStatus();
  loadRows(coach, query.has('refresh'))
    .then(({ rows, stale }) => {
      if (query.has('refresh')) history.replaceState(null, '', location.href.replace(/[?&]refresh=\d+/, ''));
      draw(rows);
      if (stale) {
        // Fresher rows are on the way: redraw with them, unless the coach has
        // started typing into something in the meantime.
        fetchRows(coach).then((fresh) => {
          if (ticket !== routeTicket) return;
          if (view.querySelector('form:not([hidden]) :focus')) return;
          draw(fresh);
        }).catch(() => { refreshLineUpdate(); });
      }
    })
    .catch((e) => {
      view.innerHTML = `<section class="card"><h3>Couldn’t load the group sheet</h3><p>${esc(e.message)}</p>
        <div class="actions"><a class="btn" href="#${screen}?refresh=${Date.now()}">Try again</a>
        <a class="btn secondary" href="#settings">Settings</a></div></section>`;
    });
}
let routeTicket = 0;

// A refresh that failed behind a drawn screen: say so on its refresh line.
function refreshLineUpdate() {
  const line = view.querySelector('.refresh-line');
  if (line && lastRefreshError) line.insertAdjacentHTML('afterbegin', `<span class="muted">Couldn’t refresh: ${esc(lastRefreshError)} · </span>`);
}

// Grey blocks in the shape of a screen, while the first load runs.
const skeleton = () => `
  <section class="card skeleton" aria-busy="true" aria-label="Loading">
    <div class="sk-line w40"></div><div class="sk-tiles"><div></div><div></div><div></div><div></div></div>
    <div class="sk-line"></div><div class="sk-line"></div><div class="sk-line w70"></div><div class="sk-line"></div>
  </section>
  <section class="card skeleton" aria-hidden="true"><div class="sk-line w40"></div><div class="sk-line"></div><div class="sk-line w70"></div></section>`;
window.addEventListener('hashchange', route);

// ------------------------------------------------------------------- group

const WATCH_LABEL = { critical: 'Talk today', serious: 'Talk soon', warning: 'Keep an eye', note: 'FYI' };

// Watchlist: one swimmer in one category, with the evidence, whether it's new
// or has been showing for a few days, and a question to start with.
const since = (days) => `<span class="fu-since">${days === 1 ? 'New today' : `${days > 6 ? '7+' : days} days`}</span>`;
const followUpItem = (s, { name = true } = {}) => `
  <li>
    <div class="fu-head">${name ? athleteLink(s.key, s.name) : ''}
      ${s.key && s.level && ['critical', 'serious'].includes(s.level) ? statusBadge({ level: s.level, label: WATCH_LABEL[s.level] }) : ''}
      ${s.days ? since(s.days) : ''}</div>
    <ul class="fu-reasons">${s.reasons.map((r) => `<li>${esc(r.text)}</li>`).join('')}</ul>
    ${s.ask ? `<p class="fu-ask">Ask: “${esc(s.ask)}”</p>` : ''}
  </li>`;

function followUpCard(fu) {
  const cat = (c) => {
    const n = c.swimmers.length;
    if (c.key === 'ready') {
      return `<details class="fu-cat" id="fu-ready"><summary><b>${c.label}</b> <span class="muted">(${n})</span></summary>
        <p class="small">${n ? c.swimmers.map((s) => athleteLink(s.key, s.name)).join(', ') : 'Nobody yet.'}</p>
        <p class="muted small">Checked in, and nothing in their answers or training stands out.</p></details>`;
    }
    const list = `<ul class="fu-list">${c.swimmers.map((s) => followUpItem(s)).join('')}</ul>`;
    if (c.key === 'missing') {
      return `<details class="fu-cat" id="fu-missing"><summary><b>${c.label}</b> <span class="muted">(${n})</span></summary>
        ${n ? list : '<p class="muted small">Nothing missing.</p>'}<p class="muted small">Missing means not reported – not a sign of how they are.</p></details>`;
    }
    return n ? `<div class="fu-cat" id="fu-${c.key}"><h4>${c.label} <span class="muted">(${n})</span></h4>${list}</div>` : '';
  };
  return `
    <section class="card" id="watchlist">
      <p class="muted small">Who may need a word, and why – each swimmer against their own usual. Prompts for a
        conversation, not a diagnosis or a change to the plan.</p>
      <div class="fu-tiles">${fu.categories.map((c) => `<button type="button" class="fu-tile fu-tile-${c.key}" data-go="fu-${c.key}" ${c.swimmers.length ? '' : 'disabled'}>
        <span class="fu-count">${c.swimmers.length}</span><span class="fu-label">${c.label}</span></button>`).join('')}</div>
      ${fu.categories.map(cat).join('')}
    </section>`;
}

// On the Group tab: a pointer to the Watchlist tab with its counts.
function watchLine(fu) {
  const n = (k) => fu.categories.find((c) => c.key === k).swimmers.length;
  const concerns = new Set(fu.categories.filter((c) => !['missing', 'ready'].includes(c.key)).flatMap((c) => c.swimmers.map((s) => s.key))).size;
  return `<section class="card watch-line"><a href="#watchlist?d=${fu.date}">
    <b>Watchlist</b> <span class="muted small">${concerns ? `${concerns} swimmer${concerns === 1 ? '' : 's'} to follow up with${n('health') ? ` · ${n('health')} illness / injury` : ''}` : 'nobody stands out'}</span> ›</a></section>`;
}

function renderWatchlist({ rows, query }) {
  const date = query.get('d') || todayISO();
  view.innerHTML = `
    <section class="card">
      <div class="coach-head">
        <a class="btn secondary icon-btn" href="#watchlist?d=${shiftDate(date, -1)}" aria-label="Previous day">‹</a>
        <h2>Watchlist</h2>
        <a class="btn secondary icon-btn" href="#watchlist?d=${shiftDate(date, 1)}" aria-label="Next day" ${date >= todayISO() ? 'hidden' : ''}>›</a>
      </div>
      <p class="eyebrow" style="text-align:center">${esc(prettyDate(date))}</p>
      ${refreshLine(`#watchlist?d=${date}`)}
    </section>
    ${followUpCard(followUps(rows, date))}`;
  wireFollowUp(view);
}

function wireFollowUp(root) {
  root.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => {
    const el = root.querySelector(`#${b.dataset.go}`);
    if (!el) return;
    if (el.tagName === 'DETAILS') el.open = true;
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
}

// One day's training: the team against the same day last week and a usual
// one for that weekday (the 4 before), then each swimmer's effort, how well
// they did and load, their load against those same days. Anyone whose
// practices felt hard but went poorly on 2+ days this week is flagged first.
function trainingCard(rows, athletes, trainedOn, { id, title, today = false }) {
  // Training is filed on the morning after (see withWorkouts).
  const tr = trainingCompare(rows, shiftDate(trainedOn, 1));
  const { now, weekAgo, usual } = tr.team;
  const weekday = new Date(`${trainedOn}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long' });
  const pctOf = (a, b) => (a !== null && b > 0 ? Math.round(((a - b) / b) * 100) : null);
  const compareRow = (label, f, { load = false, sub = false } = {}) => {
    const n = f(now);
    const cell = (d) => {
      if (!d) return '<td class="muted">–</td>';
      const v = f(d);
      return `<td>${num(v)}${load ? `<br>${delta(pctOf(n, v), { unit: '%', big: 25 })}` : ''}</td>`;
    };
    return `<tr${sub ? ' class="sub-row"' : ''}><th scope="row">${label}</th><td><b>${num(n)}</b></td>${cell(weekAgo.reported ? weekAgo : null)}${cell(usual)}</tr>`;
  };
  const swimmers = tr.swimmers
    .map((s) => ({ ...s, tough: hardButPoor(athletes.get(s.key)?.entries || [], trainedOn) }))
    .sort((x, y) => y.tough.flagged - x.tough.flagged || y.load - x.load || x.name.localeCompare(y.name));
  // Morning · doubles values (– = didn't go), or why there was no practice.
  const perPractice = (t, f) => {
    if (!('am' in t) && !('pm' in t)) return t.durationMin > 0 ? `<span title="Whole day">${num(f(t))}</span>` : '–';
    if (!PRACTICE_KEYS.some((k) => t[k]?.durationMin > 0)) return practicesCell(t);
    return PRACTICE_KEYS.map((k) => (t[k]?.durationMin > 0 ? num(f(t[k])) : '–')).join(' · ');
  };
  const when = (d) => (d === todayISO() ? 'today' : d === shiftDate(todayISO(), -1) ? 'yesterday'
    : new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short' }));
  return `
    <section class="card training-day" id="${id}">
      <h3>${esc(title)} <span class="muted small">${esc(prettyDate(trainedOn))}</span></h3>
      ${now.reported ? `<p class="muted small">Against last ${esc(weekday)} (${esc(shortDate(shiftDate(trainedOn, -7)))}) and a usual ${esc(weekday)}
        (average of the 4 before${usual ? '' : '; needs 2'}).</p>
      <div class="table-wrap"><table class="group-table compare-table">
        <thead><tr><th></th><th>${today ? 'Today' : esc(shortDate(trainedOn))}</th><th>Last week</th><th>Avg</th></tr></thead>
        <tbody>
          ${compareRow('Logged', (d) => d.reported)}
          ${compareRow('Morning practice', (d) => d.am.count)}
          ${compareRow('effort', (d) => d.am.avgRpe, { sub: true })}
          ${compareRow('how well', (d) => d.am.avgPerf, { sub: true })}
          ${compareRow('Doubles', (d) => d.pm.count)}
          ${compareRow('effort', (d) => d.pm.avgRpe, { sub: true })}
          ${compareRow('how well', (d) => d.pm.avgPerf, { sub: true })}
          ${compareRow('Lifted', (d) => d.weights)}
          ${compareRow('Raced', (d) => d.meet)}
          ${compareRow('Missed: sick', (d) => d.sick)}
          ${compareRow('Missed: other', (d) => d.missed)}
          ${compareRow('Avg load', (d) => d.avgLoad, { load: true })}
        </tbody></table></div>
      <div class="table-wrap"><table class="group-table day-table">
        <thead><tr><th>Swimmer</th><th>Effort<br><span class="th-sub">AM · Dbl</span></th><th>How well<br><span class="th-sub">AM · Dbl</span></th><th>Load</th><th class="vs-col">vs last<br>week</th><th class="vs-col">vs<br>avg</th></tr></thead>
        <tbody>${swimmers.map((s) => `
          <tr${s.tough.flagged ? ' class="tough"' : ''}>
            <td class="who">${athleteLink(s.key, s.name)} ${sessionTags(s.training)}</td>
            <td class="effort">${perPractice(s.training, (p) => p.rpe)}</td>
            <td class="perf">${perPractice(s.training, (p) => p.perf)}</td>
            <td><b>${s.load}</b>${s.vsWeekAgo !== null || s.vsUsual !== null ? `<span class="narrow-deltas"><span title="vs last week">wk ${delta(s.vsWeekAgo, { unit: '%', big: 25 })}</span> <span title="vs usual">avg ${delta(s.vsUsual, { unit: '%', big: 25 })}</span></span>` : ''}</td>
            <td class="vs-col">${delta(s.vsWeekAgo, { unit: '%', big: 25 })}</td>
            <td class="vs-col">${delta(s.vsUsual, { unit: '%', big: 25 })}</td>
          </tr>
          ${s.tough.flagged ? `<tr class="flag-row tough-row"><td colspan="6">⚑ Felt hard but went poorly on ${s.tough.days.length} days this week (${s.tough.days.map(when).join(', ')})</td></tr>` : ''}`).join('')}
        </tbody></table></div>
      <p class="muted small">Effort and how well they did, 1–10. Load = minutes × effort; weights count as 45 min at 5 (meets
        aren’t counted). Each swimmer’s load is against their own last ${esc(weekday)} and usual ${esc(weekday)}.
        ⚑ = effort 7+ but how well 4 or less, on 2+ days this week.</p>`
    : `<p class="muted">No training logged ${today ? 'yet today' : 'for this day'}.</p>`}
    </section>`;
}

function renderGroup({ rows, query }) {
  const date = query.get('d') || todayISO();
  const day = groupDay(rows, date);
  const athletes = groupByAthlete(rows);
  const fu = followUps(rows, date);
  const vsDay = (a, b) => (a !== null && b !== null ? a - b : null);

  view.innerHTML = `
    <div class="coach-grid">
    <div class="col">
    <section class="card" id="checkins">
      <div class="coach-head">
        <a class="btn secondary icon-btn" href="#group?d=${shiftDate(date, -1)}" aria-label="Previous day">‹</a>
        <h2>${esc(prettyDate(date))}</h2>
        <a class="btn secondary icon-btn" href="#group?d=${shiftDate(date, 1)}" aria-label="Next day" ${date >= todayISO() ? 'hidden' : ''}>›</a>
      </div>
      <div class="stats four">
        <div><span class="stat-num">${day.checkedIn.length}/${day.total}</span><span class="stat-label">checked in</span></div>
        <div><span class="stat-num">${day.avgReadiness ?? '–'}</span><span class="stat-label">avg readiness</span></div>
        <div><span class="stat-num">${delta(vsDay(day.avgReadiness, day.readinessYesterday), { big: 5 })}</span><span class="stat-label">vs yesterday<br><span class="muted">${day.readinessYesterday ?? '–'}</span></span></div>
        <div><span class="stat-num">${delta(vsDay(day.avgReadiness, day.readiness7), { big: 5 })}</span><span class="stat-label">vs usual<br><span class="muted">${day.readiness7 ?? '–'}</span></span></div>
      </div>
      ${day.checkedIn.length ? `<div class="table-wrap"><table class="group-table checkin-table">
        <thead><tr><th>Swimmer</th><th>Ready</th><th>vs yesterday</th><th>vs usual</th></tr></thead>
        <tbody>${day.checkedIn.map((c) => `
          <tr>
            <td class="who">${athleteLink(c.key, c.name)}<br>${statusBadge(c.assessment.status)}</td>
            <td><b>${c.assessment.score ?? '–'}</b></td>
            <td>${delta(c.vsPrev)}${c.prevDate && c.prevDate !== shiftDate(date, -1) ? `<br><span class="muted small">since ${esc(shortDate(c.prevDate))}</span>` : ''}</td>
            <td>${delta(c.vsUsual)}</td>
          </tr>
          ${c.assessment.flags.length ? `<tr class="flag-row"><td colspan="4">${c.assessment.flags.map((f) => esc(theirs(f.text))).join(' · ')}</td></tr>` : ''}`).join('')}
        </tbody></table></div>
        <p class="muted small">Worst first. vs yesterday = since their previous check-in; vs usual = against their average
          over the 7 days before (needs 3 check-ins).</p>`
    : '<p class="muted">No check-ins for this day yet.</p>'}
      ${refreshLine(`#group?d=${date}`)}
    </section>

    ${watchLine(fu)}

    </div>
    <div class="col">
    ${trainingCard(rows, athletes, shiftDate(date, -1), { id: 'yesterday-training', title: date === todayISO() ? 'Yesterday’s training' : 'The day before' })}
    ${trainingCard(rows, athletes, date, { id: 'day-training', title: date === todayISO() ? 'Today’s training' : 'This day’s training', today: date === todayISO() })}
    </div>
    </div>

    ${day.missing.length ? `<section class="card" id="not-in"><h3>Not checked in (${day.missing.length})</h3>
        <ul class="plain">${day.missing.map((m) => `<li>${athleteLink(m.key, m.name)}
          <span class="muted small">last ${esc(shortDate(m.lastSeen))}</span>${m.missedDays >= 2 ? `<span class="missed">· missed ${m.missedDays} days</span>` : ''}</li>`).join('')}
        </ul>
        ${date === todayISO() ? '<div class="actions"><a class="btn secondary" href="#messages">Send a reminder</a></div>' : ''}</section>` : ''}`;
}

// --------------------------------------------------------------- charts
// The chart picker: any measure for the team or one swimmer, alone, against
// a second measure (two panels on one day axis), or against the team
// average. The choice lives in the address (so Back and links keep it) and
// is remembered for next time.

const PICKS_KEY = 'athlete-readiness/coach-charts/v1';
const loadPicks = () => { try { return JSON.parse(localStorage.getItem(PICKS_KEY)) || {}; } catch { return {}; } };
const savePicks = (where, pick) => { try { localStorage.setItem(PICKS_KEY, JSON.stringify({ ...loadPicks(), [where]: pick })); } catch { /* private mode */ } };
const PRESETS = [
  { a: 'readiness', b: 'load', label: 'Readiness & load' },
  { a: 'readiness', b: 'sleepHours', label: 'Readiness & sleep' },
  { a: 'soreness', b: 'load', label: 'Soreness & load' },
  { a: 'rpeAm', b: 'perfAm', label: 'Effort & how well' },
  { a: 'vsUsual', b: '', label: 'Vs usual' },
  { a: 'rate', b: '', label: 'Check-ins' },
];

// The picker's state from the address, else last time's, else the default.
function picks(query, where, { team = true } = {}) {
  const saved = loadPicks()[where] || {};
  const ok = (k) => METRICS[k] && (team || !METRICS[k].teamOnly);
  const a = ok(query.get('a')) ? query.get('a') : ok(saved.a) ? saved.a : 'readiness';
  const bq = query.has('b') ? query.get('b') : saved.b ?? (team ? 'load' : 'team');
  const b = bq === a ? '' : bq === 'team' && !team ? 'team' : ok(bq) ? bq : '';
  return { a, b };
}

function pickerHtml({ a, b, who }, { swimmers = null, team = true } = {}) {
  const opts = (sel, skip = []) => {
    const groups = {};
    for (const [k, m] of Object.entries(METRICS)) {
      if (skip.includes(k) || (!team && m.teamOnly)) continue;
      (groups[m.group] ||= []).push(`<option value="${k}" ${k === sel ? 'selected' : ''}>${esc(m.label)}</option>`);
    }
    return Object.entries(groups).map(([g, o]) => `<optgroup label="${esc(g)}">${o.join('')}</optgroup>`).join('');
  };
  return `
      <div class="picker">
        <label class="field">Show <select name="a">${opts(a)}</select></label>
        <label class="field">Compare with <select name="b">
          <option value="" ${b ? '' : 'selected'}>Nothing</option>
          ${team ? '' : `<option value="team" ${b === 'team' ? 'selected' : ''}>Team average</option>`}
          ${opts(b, [a])}</select></label>
        ${swimmers ? `<label class="field">For <select name="who">
          <option value="team">Whole team</option>
          ${swimmers.map((s) => `<option value="${esc(s.key)}" ${s.key === who ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>` : ''}
      </div>
      <div class="presets" role="group" aria-label="Quick picks">${PRESETS.filter((p) => team || !METRICS[p.a].teamOnly).map((p) => `
        <button type="button" class="preset${p.a === a && p.b === b ? ' on' : ''}" data-a="${p.a}" data-b="${p.b}">${p.label}</button>`).join('')}</div>
      <div data-t="picker"></div>
      <p class="muted small" data-picker-note></p>`;
}

// Draw the picked chart into `root` [data-t=picker].
function drawPicker(root, athletes, { a, b, who, span }) {
  const el = root.querySelector('[data-t="picker"]');
  const A = METRICS[a];
  const B = b && b !== 'team' ? METRICS[b] : null;
  // Training is filed on the morning after. All training: chart the days
  // the sessions happened, up to today. Mixed with a morning measure: chart
  // the mornings, training being the day before's.
  const sessions = A.training && (!B || B.training);
  const today = todayISO();
  const mornings = Array.from({ length: span }, (_, i) => shiftDate(today, i - span + 1 + (sessions ? 1 : 0)));
  const day = (m) => (sessions ? shiftDate(m, -1) : m);
  const title = (M) => `${M.label}${M.training && !sessions ? ' (day before)' : ''}`;
  const unit = (M) => M.unit || '';
  const show = (M, v) => (Number.isFinite(v) ? `${fmt(v, Number.isInteger(v) ? 0 : 1)}${unit(M)}` : '–');
  const sa = metricSeries(athletes, a, mornings, who);
  const base = mornings.map((m, i) => ({ x: dayIndex(day(m)), label: shortDate(day(m)), n: sa[i].n }));
  const forWho = who === 'team' ? 'Team average' : athletes.get(who)?.name || '';
  const notes = [A, B].filter(Boolean).map((M) => (M.hint ? `${M.label}: ${M.hint}.` : '')).filter(Boolean);
  if (who === 'team' && [A, B].some((M) => M?.team > 1)) notes.push(`Team averages need ${MIN_TEAM}+ swimmers that day.`);
  if (B) {
    const sb = metricSeries(athletes, b, mornings, who);
    const panel = (M) => ({ kind: M.kind, min: M.min, max: M.max, title: title(M) });
    pairChart(el, base.map((d, i) => ({ ...d, top: sa[i].value ?? NaN, bottom: sb[i].value ?? NaN })), {
      top: panel(A),
      bottom: panel(B),
      tip: (d) => `${d.label}<br>${esc(title(A))}: <b>${show(A, d.top)}</b><br>${esc(title(B))}: <b>${show(B, d.bottom)}</b>`,
    });
  } else if (b === 'team') {
    const st = metricSeries(athletes, a, mornings, 'team');
    lineChart(el, base.map((d, i) => ({ ...d, y: sa[i].value ?? NaN, y2: st[i].value ?? NaN })), {
      yMin: A.min, yMax: A.max, yFormat: (v) => String(+v.toFixed(1)),
      tip: (d) => `${d.label}<br>${esc(forWho)}: <b>${show(A, d.y)}</b><br>Team: <b>${show(A, d.y2)}</b>`,
    });
    notes.unshift('Solid = this swimmer · dashed = team average.');
  } else if (A.kind === 'line') {
    lineChart(el, base.map((d, i) => ({ ...d, y: sa[i].value ?? NaN })), {
      yMin: A.min, yMax: A.max, yFormat: (v) => String(+v.toFixed(1)),
      tip: (d) => `${d.label}: <b>${show(A, d.y)}</b>${who === 'team' ? ` <span class="muted">(${d.n} swimmers)</span>` : ''}`,
    });
  } else {
    const vals = sa.map((p) => Math.abs(p.value ?? 0));
    const reach = A.kind === 'signed' ? Math.max(10, Math.ceil(Math.max(...vals) / 10) * 10) : undefined;
    barChart(el, base.map((d, i) => ({ ...d, y: sa[i].value ?? (A.kind === 'signed' ? NaN : 0) })), {
      signed: A.kind === 'signed', yMin: reach && -reach, yMax: reach ?? A.max,
      yFormat: (v) => (A.kind === 'signed' && v > 0 ? `+${v}` : String(v)),
      tip: (d) => `${d.label}: <b>${Number.isFinite(d.y) ? show(A, d.y) : '–'}</b>`,
    });
  }
  root.querySelector('[data-picker-note]').textContent = [`${forWho}, last ${span} days${sessions ? ' (training days, up to today)' : ''}.`, ...notes].join(' ');
}

// Wire the picker: redraw in place and keep the address up to date.
function wirePicker(root, athletes, state, { where, base }) {
  const go = (patch) => {
    Object.assign(state, patch);
    const team = state.who === 'team';
    if (!team && METRICS[state.a].teamOnly) state.a = 'readiness';
    if (state.b === state.a || (team && state.b === 'team') || (!team && METRICS[state.b]?.teamOnly)) state.b = '';
    savePicks(where, { a: state.a, b: state.b });
    const q = new URLSearchParams({ t: state.span, a: state.a, b: state.b });
    history.replaceState(null, '', `${location.pathname}${location.search}${base}?${q}`);
    root.querySelector('.picker-body').innerHTML = pickerHtml(state, { team });
    // Keep the 7 / 14 / 28-day links on the same picks.
    view.querySelectorAll('.seg a[data-span]').forEach((x) => { x.href = `${base}?${new URLSearchParams({ ...Object.fromEntries(q), t: x.dataset.span })}`; });
    drawPicker(root, athletes, state);
  };
  root.addEventListener('change', (ev) => { if (['a', 'b', 'who'].includes(ev.target.name)) go({ [ev.target.name]: ev.target.value }); });
  root.addEventListener('click', (ev) => {
    const p = ev.target.closest('.preset');
    if (p) go({ a: p.dataset.a, b: p.dataset.b });
  });
  requestAnimationFrame(() => drawPicker(root, athletes, state));
}


// Light / moderate / heavy days and the readiness change after each.
function responseTable(b, range, note = '') {
  if (!b.enough) {
    return `<p class="muted small">${note}Shows once there are ${b.needed} check-ins with training and a previous check-in to compare (${b.pairs} so far).</p>`;
  }
  return `<table class="group-table response-table">
        <thead><tr><th>Day before</th><th>Load</th><th>Readiness change</th></tr></thead>
        <tbody>${[['Light', b.light], ['Moderate', b.moderate], ['Heavy', b.heavy]].map(([label, x]) => `
          <tr><td><b>${label}</b></td><td class="muted">${range(x.range)}</td><td>${delta(x.change, { big: 5 })} <span class="muted small">avg of ${x.n}</span></td></tr>`).join('')}
        </tbody></table>`;
}

// ------------------------------------------------------------------- data
// The Data tab: one dashboard driven by the picked measure. Tiles (tap one
// to explore it), the chart (alone, against a second measure, or one
// swimmer against the team), every swimmer's average for the period
// (sortable; tap a name to chart them) and a swimmers × days heatmap, with
// a CSV of what's shown. Everything updates in place; the picks stay in the
// address and are remembered.

const TILES = ['readiness', 'rate', 'sleepHours', 'load', 'rpeAm', 'perfAm'];
const SORTS = ['name', 'avg', 'change', 'latest'];

function renderData({ rows, query }) {
  const date = todayISO();
  const athletes = groupByAthlete(rows);
  const swimmers = [...athletes.values()].map((a) => ({ key: a.key, name: a.name })).sort((x, y) => x.name.localeCompare(y.name));
  const saved = loadPicks().history || {};
  const whoQ = query.get('who') || saved.who;
  const who = athletes.has(whoQ) ? whoQ : 'team';
  const sortQ = query.get('sort') || saved.sort || 'name';
  const state = {
    ...picks(query, 'history', { team: who === 'team' }),
    who,
    span: [14, 28].includes(Number(query.get('t'))) ? Number(query.get('t')) : 7,
    sort: SORTS.includes(sortQ.replace('-', '')) ? sortQ : 'name',
  };
  const cache = new Map(); // dataDashboard results by measure and span
  const dash = (key, span, opts) => {
    const id = `${key}|${span}|${opts?.swimmers === false}`;
    if (!cache.has(id)) cache.set(id, dataDashboard(rows, key, date, span, opts));
    return cache.get(id);
  };
  const show = (M, v) => (v === null || v === undefined ? '–' : `${fmt(v, Number.isInteger(v) ? 0 : 1)}${M.unit || ''}`);
  // Change against the period before: coloured only where higher is better.
  const chg = (M, v) => (v === null ? '<span class="muted">–</span>'
    : M.good ? delta(v, { big: M.max === 100 ? 5 : 1 })
      : `<span class="delta">${v > 0 ? '▲+' : v < 0 ? '▼−' : ''}${fmt(Math.abs(v), Number.isInteger(v) ? 0 : 1)}</span>`);

  const render = () => {
    const { a, span } = state;
    const M = METRICS[a];
    const d = dash(a, span);
    const ord = sortRows(d.swimmers, state.sort);
    const q = (patch = {}) => new URLSearchParams({ t: span, a, b: state.b, who: state.who, sort: state.sort, ...patch });
    savePicks('history', { a, b: state.b, who: state.who, sort: state.sort });
    history.replaceState(null, '', `${location.pathname}${location.search}#data?${q()}`);
    const scale = heatScale(M, d);
    view.innerHTML = `<div id="data-tab">
    <section class="card" id="team-trends">
      <div class="card-head wrap"><h3>Team, last ${span} days</h3>
        <span class="seg">${[7, 14, 28].map((n) => `<a href="#data?${q({ t: n })}" data-span="${n}" ${span === n ? 'aria-current="true"' : ''}>${n} days</a>`).join('')}</span></div>
      <div class="tiles" role="group" aria-label="Measures">${TILES.map((k) => {
    const t = dash(k, span, { swimmers: false }).team;
    const T = METRICS[k];
    return `<button type="button" class="tile${k === a ? ' on' : ''}" data-tile="${k}">
          <span class="stat-num">${show(T, t.avg)}</span>
          <span class="tile-change">${t.avg !== null && t.prevAvg !== null ? chg(T, round1(t.avg - t.prevAvg)) : ''}</span>
          <span class="stat-label">${esc(T.label)}</span></button>`;
  }).join('')}</div>
      <p class="muted small">Team averages over the period; arrows compare with the ${span} days before. Tap one to explore it.</p>
    </section>

    <section class="card" id="charts" data-swimmers="${esc(JSON.stringify(swimmers))}">
      <h3>Chart</h3>
      <div class="picker-body">${pickerHtml(state, { swimmers, team: state.who === 'team' })}</div>
      ${refreshLine(`#data?${q()}`)}
    </section>

    <section class="card" id="by-swimmer">
      <div class="card-head"><h3>${esc(M.label)} by swimmer</h3>
        <button type="button" class="btn secondary small-btn" id="csv">Download CSV</button></div>
      <div class="table-wrap"><table class="group-table data-table">
        <thead><tr>${[['name', 'Swimmer'], ['avg', 'Avg'], ['change', `vs prev ${span} d`], ['latest', 'Latest']].map(([k, l]) => `
          <th${k === 'latest' ? ' class="col-latest"' : ''}><button type="button" class="sort${state.sort.replace('-', '') === k ? ' on' : ''}" data-sort="${k}">${l}${state.sort === k ? ' ▲' : state.sort === `-${k}` ? ' ▼' : ''}</button></th>`).join('')}<th>Trend</th></tr></thead>
        <tbody>
          <tr class="team-row"><td class="who"><button type="button" class="who-btn" data-who="team">Team average</button></td>
            <td><b>${show(M, d.team.avg)}</b></td><td>${d.team.avg !== null && d.team.prevAvg !== null ? chg(M, round1(d.team.avg - d.team.prevAvg)) : '<span class="muted">–</span>'}</td>
            <td class="col-latest">${show(M, [...d.team.values].reverse().find((v) => v !== null) ?? null)}</td><td>${sparkline(d.team.values, scale)}</td></tr>
          ${ord.map((r) => `
          <tr${r.key === state.who ? ' class="picked"' : ''}><td class="who"><button type="button" class="who-btn" data-who="${esc(r.key)}">${esc(r.name)}</button>
              <a class="profile-link" href="#swimmers/${encodeURIComponent(r.key)}" aria-label="${esc(r.name)}’s page">›</a></td>
            <td><b>${show(M, r.avg)}</b></td><td>${chg(M, r.change)}</td><td class="col-latest">${show(M, r.latest)}</td><td>${sparkline(r.values, scale)}</td></tr>`).join('')}
        </tbody></table></div>
      <p class="muted small">Tap a name to chart them against the team; › opens their page. ${M.training ? 'Training: by the day it happened.' : ''}
        ${a === 'rate' ? 'Checked in: share of days since they joined.' : ''}</p>
    </section>

    <section class="card" id="heatmap">
      <h3>Day by day</h3>
      <div class="table-wrap"><table class="heat${span === 7 ? ' wide' : ''}">
        <thead><tr><th></th>${d.days.map((day) => `<th title="${esc(prettyDate(day))}">${span === 7 ? esc(shortDate(day).replace(/^\w+ /, '')) : new Date(`${day}T12:00:00`).toLocaleDateString(undefined, { weekday: 'narrow' })}</th>`).join('')}</tr></thead>
        <tbody>${[{ key: 'team', name: 'Team', values: d.team.values }, ...ord].map((r) => `
          <tr${r.key === 'team' ? ' class="team-row"' : ''}><th scope="row">${esc(r.key === 'team' ? 'Team' : first(r.name))}</th>${r.values.map((v, i) => `
            <td style="${heatColor(scale, v)}" data-who="${esc(r.name)}" data-day="${d.days[i]}" data-v="${esc(show(M, v))}" title="${esc(`${r.name} · ${shortDate(d.days[i])}: ${show(M, v)}`)}">${span === 7 && v !== null ? esc(fmt(v, Number.isInteger(v) ? 0 : 1)) : ''}</td>`).join('')}</tr>`).join('')}
        </tbody></table></div>
      <p class="small" id="heat-readout" aria-live="polite">${esc(M.label)}: tap a square for the value.</p>
      <p class="muted small">${M.good ? 'Red = low, green = high (for them, better).' : 'Darker = more.'} Blank = nothing reported.${M.team > 1 ? ` Team needs ${MIN_TEAM}+ swimmers that day.` : ''}</p>
    </section>

    ${moreHtml(rows, date, span)}
  </div>`;
    wire(d, ord);
  };

  const wire = (d, ord) => {
    const root = view.querySelector('#data-tab');
    const charts = root.querySelector('#charts');
    const go = (patch) => {
      Object.assign(state, patch);
      const team = state.who === 'team';
      if (!team && METRICS[state.a].teamOnly) state.a = 'readiness';
      if (state.b === state.a || (team && state.b === 'team') || (!team && METRICS[state.b]?.teamOnly)) state.b = '';
      render();
    };
    charts.addEventListener('change', (ev) => { if (['a', 'b', 'who'].includes(ev.target.name)) go({ [ev.target.name]: ev.target.value }); });
    root.addEventListener('click', (ev) => {
      const t = ev.target.closest('[data-tile], .preset, [data-sort], .who-btn, [data-span], .heat td, #csv');
      if (!t) return;
      if (t.dataset.tile) go({ a: t.dataset.tile, b: t.dataset.tile === state.a ? state.b : '' });
      else if (t.classList.contains('preset')) go({ a: t.dataset.a, b: t.dataset.b });
      else if (t.dataset.sort) go({ sort: state.sort === t.dataset.sort ? `-${t.dataset.sort}` : t.dataset.sort });
      else if (t.classList.contains('who-btn')) {
        go({ who: t.dataset.who, b: t.dataset.who === 'team' ? state.b : 'team' });
        view.querySelector('#charts').scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else if (t.dataset.span) { ev.preventDefault(); go({ span: Number(t.dataset.span) }); }
      else if (t.matches('.heat td')) {
        root.querySelector('#heat-readout').textContent = `${t.dataset.who} · ${prettyDate(t.dataset.day)}: ${t.dataset.v}`;
      } else if (t.id === 'csv') downloadCsv(d, ord, state);
    });
    requestAnimationFrame(() => drawPicker(charts, athletes, state));
  };

  render();
}

const round1 = (v) => +v.toFixed(1);

// Swimmers in the table's order: by name, or by a column (`-` = descending);
// no value last.
function sortRows(list, sort) {
  const desc = sort.startsWith('-');
  const k = sort.replace('-', '');
  if (k === 'name') return [...list].sort((x, y) => (desc ? -1 : 1) * x.name.localeCompare(y.name));
  return [...list].sort((x, y) => (x[k] === null) - (y[k] === null) || (desc ? y[k] - x[k] : x[k] - y[k]) || x.name.localeCompare(y.name));
}

// The colour range for a measure: the values shown (so differences show up
// even when everyone is in the top half of the scale).
function heatScale(M, d) {
  const vals = [...d.team.values, ...d.swimmers.flatMap((r) => r.values)].filter((v) => v !== null);
  if (M.kind === 'signed') return { M, lo: 0, hi: Math.max(1, ...vals.map(Math.abs)) };
  if (!vals.length) return { M, lo: M.min ?? 0, hi: M.max ?? 1 };
  return { M, lo: Math.min(...vals), hi: Math.max(...vals) };
}
// A heatmap square's background: red, amber, green where higher is better
// (below / above usual for vs usual), otherwise light to dark blue.
function heatColor({ M, lo, hi }, v) {
  if (v === null || v === undefined) return '';
  if (M.kind === 'signed') {
    const r = Math.min(1, Math.abs(v) / hi);
    return `background:color-mix(in srgb, var(${v < 0 ? '--critical' : '--good'}) ${Math.round(12 + r * 58)}%, var(--surface))`;
  }
  const t = Math.min(1, Math.max(0, hi > lo ? (v - lo) / (hi - lo) : 0.5));
  if (M.good) {
    const hue = t < 0.5 ? `color-mix(in srgb, var(--warning) ${Math.round(t * 200)}%, var(--critical))`
      : `color-mix(in srgb, var(--good) ${Math.round((t - 0.5) * 200)}%, var(--warning))`;
    return `background:color-mix(in srgb, ${hue} 55%, var(--surface))`;
  }
  return `background:color-mix(in srgb, var(--series-1) ${Math.round(8 + t * 72)}%, var(--surface))`;
}

// What's on screen as a CSV: one row per swimmer (team first), one column per day.
function downloadCsv(d, ord, { a, span }) {
  const cell = (v) => (v === null || v === undefined ? '' : String(v));
  const quote = (s) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [
    ['Swimmer', ...d.days, 'Average'],
    ['Team average', ...d.team.values.map(cell), cell(d.team.avg)],
    ...ord.map((r) => [r.name, ...r.values.map(cell), cell(r.avg)]),
  ].map((row) => row.map(quote).join(','));
  const url = URL.createObjectURL(new Blob([`${lines.join('\n')}\n`], { type: 'text/csv' }));
  const link = Object.assign(document.createElement('a'), { href: url, download: `${a}-${span}-days-to-${todayISO()}.csv` });
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// The fixed sections under the dashboard: how sessions felt, training vs
// next-morning readiness, and the check-in record.
function moreHtml(rows, date, span) {
  // Training sits on the morning after it (see withWorkouts), so ending a day
  // later covers sessions up to and including today.
  const sess = trendSummary(teamTrend(rows, shiftDate(date, 1), span));
  const sessPrev = trendSummary(teamTrend(rows, shiftDate(date, 1 - span), span));
  const grid = checkinGrid(rows, date, 14);
  const resp = loadResponse(rows, date, { days: span });
  const change = (a, b, unit = '') => (a === null || b === null || a === b ? ''
    : ` <span class="muted small">${a > b ? '▲' : '▼'} ${+Math.abs(a - b).toFixed(1)}${unit}</span>`);
  const cell = (c) => {
    if (!c) return '<td class="grid-miss" title="No check-in">·</td>';
    const level = c.injury ? 'critical' : c.status || 'good';
    return `<td class="grid-in grid-${level}" title="${c.injury ? 'Injury reported' : 'Checked in'}">${c.injury ? '✕' : '✓'}</td>`;
  };
  return `
    <section class="card" id="sessions">
      <h3>How sessions felt</h3>
      <p class="muted small">Averages (1–10) from swimmers who went, last ${span} days including today.</p>
      <div class="stats two small-stats" id="effort-stats">
        <div><span class="stat-num">${sess.rpeAm ?? '–'}${change(sess.rpeAm, sessPrev.rpeAm)}</span><span class="stat-label">morning effort</span></div>
        <div><span class="stat-num">${sess.rpePm ?? '–'}${change(sess.rpePm, sessPrev.rpePm)}</span><span class="stat-label">doubles effort</span></div>
      </div>
      <div class="stats two small-stats" id="perf-stats">
        <div><span class="stat-num">${sess.perfAm ?? '–'}${change(sess.perfAm, sessPrev.perfAm)}</span><span class="stat-label">morning: how well</span></div>
        <div><span class="stat-num">${sess.perfPm ?? '–'}${change(sess.perfPm, sessPrev.perfPm)}</span><span class="stat-label">doubles: how well</span></div>
      </div>
      <p class="small" id="lift-meet">${sess.weights} weights session${sess.weights === 1 ? '' : 's'} · ${sess.meet} meet day${sess.meet === 1 ? '' : 's'} reported</p>
    </section>

    <section class="card" id="load-response">
      <h3>Training vs next-morning readiness</h3>
      <p class="muted small">Last ${span} days: each check-in’s training load (the day before) against how that swimmer’s
        readiness changed since their previous check-in, split into thirds two ways.</p>
      <h4>By load</h4>
      <p class="muted small">The same cut-offs for everyone.</p>
      ${responseTable(resp.absolute, (r) => `${r[0]}–${r[1]}`)}
      <h4>By load for each swimmer</h4>
      <p class="muted small">Against that swimmer’s usual (their average load over the last 28 days), so a heavy day is
        heavy for them.</p>
      ${responseTable(resp.relative, (r) => `${r[0]}–${r[1]}% of usual`, 'Needs 5 training reports from a swimmer in the last 28 days. ')}
      <p class="muted small">A pattern, not proof: sleep, school and meets move readiness too.</p>
    </section>

    <section class="card">
      <h3>Check-in record</h3>
      <p class="muted small">Last 14 days, oldest on the left. ✓ checked in (coloured by readiness) · ✕ injury reported · dot = no check-in.</p>
      ${grid.rows.length ? `<div class="table-wrap"><table class="checkin-grid">
        <thead><tr><th>Swimmer</th>${grid.dates.map((d) => `<th title="${esc(prettyDate(d))}">${new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { weekday: 'narrow' })}</th>`).join('')}</tr></thead>
        <tbody>${grid.rows.map((r) => `<tr><td class="who">${athleteLink(r.key, first(r.name))} <span class="grid-count muted small">${r.count}/14</span></td>${r.cells.map(cell).join('')}</tr>`).join('')}</tbody>
      </table></div>` : '<p class="muted">No check-ins in the last 14 days.</p>'}
    </section>`;
}

// ---------------------------------------------------------------- swimmers

// A swimmer's goals and gears (Goals tab in their app): G2–G6 per 100 for
// each stroke they have a time for, and a form to set or change the times
// from here (they reach the phone with its next send; needs sheet script 2).
function goalsCard(a) {
  const g = goalsSummary(a.entries);
  const fp = (v) => formatTime(v, { dp: 1 });
  return `
    <section class="card" id="swimmer-goals">
      <div class="card-head"><h3>Goals and gears</h3>
        <span><a class="btn secondary small-btn" href="#gearcard/${encodeURIComponent(a.key)}" ${g?.rows.length ? '' : 'hidden'}>Gear card</a>
        <button type="button" class="btn secondary small-btn" id="edit-goals">${g ? 'Edit times' : 'Enter times'}</button></span></div>
      ${g ? `<p class="muted small">Set ${esc(g.updated ? shortDate(g.updated) : '')}${g.goals.setBy === 'coach' ? ' by you' : ''}. Fatigue factor ${g.factor.factor.toFixed(3)} (${g.factor.type}${g.factor.from && g.factor.from !== 'set by hand' ? `, from their ${esc(g.factor.from)}` : ''}). Paces per 100 from their goal times${g.suit ? `, slowed ${g.suit}% for practice suits` : ''}.</p>
      ${g.rows.length ? `<div class="table-wrap"><table class="group-table gear-table">
        <thead><tr><th>Stroke<br><span class="th-sub">from</span></th>${MAIN_GEARS.map((k) => `<th>${k}</th>`).join('')}</tr></thead>
        <tbody>${g.rows.map((r) => `<tr><th scope="row"><b>${r.label}</b><br><span class="th-sub from">${r.reference.estimated ? 'est. ' : ''}${esc(r.reference.event.label)} ${fp(r.reference.seconds)}</span></th>${MAIN_GEARS.map((k) => `<td>${fp(r.paces[k])}</td>`).join('')}</tr>`).join('')}</tbody>
      </table></div>` : '<p class="muted">Goal times set, but none long enough for gears yet.</p>'}`
    : '<p class="muted">No goal times yet. They can enter them on the Goals tab, or you can here.</p>'}
      <form id="goals-form" class="stack coach-goals" hidden novalidate>
        <p class="muted small">Short course yards. No colon needed: 148.0 is 1:48.0. Saved to the sheet; ${esc(first(a.name))}’s phone picks them up with its next send.</p>
        ${timesFormHtml(g?.goals)}
        <p class="form-error" id="goals-error" role="alert" hidden></p>
        <div class="actions"><button class="btn" type="submit" id="save-goals">Save times</button><button class="btn secondary" type="button" id="cancel-goals">Cancel</button></div>
      </form>
    </section>`;
}

function wireGoalsCard(view, coach, a) {
  const card = view.querySelector('#swimmer-goals');
  const form = card.querySelector('#goals-form');
  wireTimesForm(form);
  card.querySelector('#edit-goals').addEventListener('click', () => { form.hidden = !form.hidden; if (!form.hidden) form.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  card.querySelector('#cancel-goals').addEventListener('click', () => { form.hidden = true; });
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const err = form.querySelector('#goals-error');
    err.hidden = true;
    const out = readTimesForm(form);
    if (out.bad) { err.textContent = `Please check: ${out.bad.join(', ')}.`; err.hidden = false; return; }
    const btn = form.querySelector('#save-goals');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const date = todayISO();
      const res = await callSheet(coach.url, { action: 'setGoals', coachPassword: coach.password, athlete: a.name, date, goals: out.goals });
      // Put it in the loaded rows too, so the page updates without a refetch.
      if (cache) {
        const row = cache.rows.find((r) => r.athlete.toLowerCase() === a.key && r.date === date);
        if (row) row.entry = { ...row.entry, goals: res.goals };
        else cache.rows.push({ athlete: a.name, date, entry: { date, goals: res.goals } });
      }
      route();
    } catch (e) {
      err.textContent = /Unknown action/.test(e.message)
        ? 'Your sheet script is older than this dashboard. Open Settings, copy the script into Apps Script, then Deploy → Manage deployments → Edit → New version.'
        : e.message;
      err.hidden = false;
      btn.disabled = false; btn.textContent = 'Save times';
    }
  });
}

// Everyone's pace at one gear, for writing a set: pick the stroke and gear.
function teamGearsCard(rows, query) {
  const athletes = groupByAthlete(rows);
  const strokes = ['free', 'back', 'breast', 'fly', 'im'];
  const stroke = strokes.includes(query.get('stroke')) ? query.get('stroke') : 'free';
  const gear = MAIN_GEARS.includes(query.get('gear')) ? query.get('gear') : 'G3';
  const per = [50, 100].includes(Number(query.get('per'))) ? Number(query.get('per')) : 100;
  const fp = (v) => formatTime(v, { dp: 1 });
  const list = [];
  const none = [];
  for (const a of athletes.values()) {
    const goals = latestGoals(a.entries);
    const set = goals && gearSet(goals, { use: 'goal', per });
    const g = set && (stroke === 'im' ? set.im : set.strokes[stroke]);
    if (g) list.push({ name: a.name, key: a.key, pace: g.gears.find((x) => x.key === gear).pace, ref: g.reference });
    else none.push(a.name);
  }
  list.sort((x, y) => x.pace - y.pace || x.name.localeCompare(y.name));
  const q = (patch) => `#swimmers?${new URLSearchParams({ stroke, gear, per, ...patch })}`;
  return `
    <section class="card" id="team-gears">
      <h3>Team gears</h3>
      <p class="muted small">Everyone’s pace at one gear, from their goal times${SUIT.enabled ? ' with their practice-suit adjustment' : ''}, fastest first. For writing a set.</p>
      <div class="toggles">
        <span class="seg" role="group" aria-label="Stroke">${strokes.map((s) => `<a href="${q({ stroke: s })}" ${s === stroke ? 'aria-current="true"' : ''}>${STROKES[s].short}</a>`).join('')}</span>
        <span class="seg" role="group" aria-label="Gear">${MAIN_GEARS.map((k) => `<a href="${q({ gear: k })}" ${k === gear ? 'aria-current="true"' : ''}>${k}</a>`).join('')}</span>
        <span class="seg" role="group" aria-label="Per">${[50, 100].map((p) => `<a href="${q({ per: p })}" ${p === per ? 'aria-current="true"' : ''}>/${p}</a>`).join('')}</span>
      </div>
      ${list.length ? `<div class="table-wrap"><table class="group-table gear-table team-gears">
        <thead><tr><th>Swimmer</th><th>${gear} /${per}</th><th>From</th></tr></thead>
        <tbody>${list.map((r) => `<tr><td class="who">${athleteLink(r.key, r.name)}</td><td class="pace"><b>${fp(r.pace)}</b></td><td class="small muted">${r.ref.estimated ? 'est. ' : ''}${esc(r.ref.event.label)} ${fp(r.ref.seconds)}</td></tr>`).join('')}</tbody>
      </table></div>` : '<p class="muted">Nobody has a goal time for this stroke yet.</p>'}
      ${none.length ? `<p class="muted small">No ${esc(STROKES[stroke].short.toLowerCase())} time yet: ${none.map(esc).join(', ')}.</p>` : ''}
    </section>`;
}

// A printable gear card for one swimmer: every stroke's G2–G6 per 100 and
// per 50, the IM strokes as 100s with the switches, and the speed targets.
function renderGearCard({ rows, arg }) {
  const a = groupByAthlete(rows).get(arg);
  const goals = a && latestGoals(a.entries);
  if (!goals) { view.innerHTML = '<section class="card"><p>No goal times for this swimmer.</p><a href="#swimmers">‹ Swimmers</a></section>'; return; }
  const per100 = gearSet(goals, { use: 'goal', per: 100 });
  const per50 = gearSet(goals, { use: 'goal', per: 50 });
  const fp = (v) => formatTime(v, { dp: 1 });
  const f2 = (v) => formatTime(v, { dp: 2 });
  const strokeRows = ['free', 'back', 'breast', 'fly'].filter((s) => per100.strokes[s]);
  view.innerHTML = `
    <section class="card gear-card">
      <div class="card-head no-print"><a href="#swimmers/${encodeURIComponent(a.key)}">‹ ${esc(a.name)}</a><button type="button" class="btn secondary small-btn" id="print-card">Print / save PDF</button></div>
      <h2>${esc(a.name)} <span class="muted small">gears · ${esc(shortDate(todayISO()))}</span></h2>
      <p class="muted small">Short course yards, from goal times${per100.suit ? `, slowed ${per100.suit}% for practice suits` : ''}. Fatigue factor ${per100.factor.factor.toFixed(3)}. G2 4-hour pace · G3 1-hour · G4 15-minute · G5 5-minute · G6 2-minute.</p>
      ${strokeRows.length ? `<table class="gear-table print-table">
        <thead><tr><th>Stroke</th><th>From</th>${MAIN_GEARS.map((k) => `<th>${k}</th>`).join('')}</tr></thead>
        <tbody>${strokeRows.flatMap((s) => [
    `<tr><th scope="row" rowspan="2">${STROKES[s].short}</th><td class="small" rowspan="2">${per100.strokes[s].reference.estimated ? 'est. ' : ''}${esc(per100.strokes[s].reference.event.label)} ${fp(per100.strokes[s].reference.seconds)}</td>${MAIN_GEARS.map((k) => `<td><b>${fp(per100.strokes[s].gears.find((x) => x.key === k).pace)}</b> <span class="th-sub">/100</span></td>`).join('')}</tr>`,
    `<tr class="sub">${MAIN_GEARS.map((k) => `<td>${fp(per50.strokes[s].gears.find((x) => x.key === k).pace)} <span class="th-sub">/50</span></td>`).join('')}</tr>`,
  ]).join('')}</tbody></table>` : ''}
      ${per100.im ? `<h3>IM</h3>
      <p class="muted small">${per100.im.reference.estimated ? 'Estimated 400 IM' : 'From the 400 IM'} ${fp(per100.im.reference.seconds)}. IM pace per 100, then each stroke’s 100 inside a 400 IM, and the switch 50s.</p>
      <table class="gear-table print-table">
        <thead><tr><th>Gear</th><th>IM /100</th><th>Fly</th><th>Back</th><th>Breast</th><th>Free</th><th>Fly–back 50</th><th>Back–breast 50</th><th>Breast–free 50</th></tr></thead>
        <tbody>${per100.im.gears.filter((x) => MAIN_GEARS.includes(x.key)).map((x) => { const sp = x.splits(100); return `<tr><th scope="row">${x.key}</th><td><b>${fp(x.pace)}</b></td>${['fly', 'back', 'breast', 'free'].map((st) => `<td>${fp(sp[st].time)}</td>`).join('')}<td>${fp(x.switches.flyBack.fifty)}</td><td>${fp(x.switches.backBreast.fifty)}</td><td>${fp(x.switches.breastFree.fifty)}</td></tr>`; }).join('')}</tbody>
      </table>` : ''}
      ${Object.keys(per100.speed).length ? `<h3>Speed</h3>
      <table class="gear-table print-table">
        <thead><tr><th>Stroke</th><th>50</th><th>15 m dive</th><th>25 dive</th><th>15 m push</th><th>25 push</th><th>S2 25</th><th>S3 25</th><th>S4 25</th></tr></thead>
        <tbody>${Object.entries(per100.speed).map(([st, sp]) => `<tr><th scope="row">${STROKES[st].short}</th><td>${f2(sp.fifty)}</td><td>${f2(sp.dive15.fromStart)}</td><td>${f2(sp.dive25.fromStart)}</td><td>${f2(sp.push15)}</td><td>${f2(sp.push25)}</td><td>${f2(sp.zones.S2)}</td><td>${f2(sp.zones.S3)}</td><td>${f2(sp.zones.S4)}</td></tr>`).join('')}</tbody>
      </table>
      <p class="muted small">Dives from the start signal; pushes from feet leaving the wall. S2 50 pace, S3 100 pace, S4 200 pace.</p>` : ''}
    </section>`;
  view.querySelector('#print-card').addEventListener('click', () => window.print());
}

function renderSwimmers(ctx) {
  if (ctx.arg) { renderSwimmer(ctx); return; }
  const list = roster(ctx.rows, todayISO());
  const gearsCard = teamGearsCard(ctx.rows, ctx.query);
  view.innerHTML = `
    <section class="card">
      <h2>Swimmers</h2>
      <p class="muted small">Everyone who has checked in in the last 3 weeks. Tap a name for their history.</p>
      ${list.length > 6 ? '<input type="search" class="search" id="swimmer-search" placeholder="Find a swimmer" aria-label="Find a swimmer" autocomplete="off">' : ''}
      ${list.length ? `<ul class="roster">${list.map((s) => `
        <li data-name="${esc(s.name.toLowerCase())}"><a href="#swimmers/${encodeURIComponent(s.key)}">
          <span class="roster-name">${esc(s.name)}</span>
          <span class="roster-meta">${statusBadge(s.status)}
            <span class="muted small">${s.checkins7}/7 days${s.avg7 !== null ? ` · avg ${s.avg7}` : ''} · last ${esc(shortDate(s.lastDate))}</span></span>
        </a></li>`).join('')}</ul>` : '<p class="muted">Nobody has checked in yet. Invite your swimmers from the Messages tab.</p>'}
      <p class="muted small" id="no-match" hidden>No swimmer matches.</p>
      ${refreshLine('#swimmers')}
    </section>
    ${gearsCard}`;
  view.querySelector('#swimmer-search')?.addEventListener('input', (ev) => {
    const q = ev.target.value.trim().toLowerCase();
    let shown = 0;
    view.querySelectorAll('.roster li').forEach((li) => { const hit = !q || li.dataset.name.includes(q); li.hidden = !hit; shown += hit; });
    view.querySelector('#no-match').hidden = shown > 0;
  });
}

function renderSwimmer({ coach, rows, arg, query }) {
  const athletes = groupByAthlete(rows);
  const a = athletes.get(arg);
  if (!a) {
    view.innerHTML = '<section class="card"><p>No data for this swimmer.</p><a href="#swimmers">‹ Swimmers</a></section>';
    return;
  }
  const heart = a.entries.some((e) => e.hrv); // heart columns only once they have readings
  const latest = a.entries.at(-1);
  const assessment = assessDay(a.entries, latest.date);
  const fus = followUpsFor(a.entries, todayISO());
  const ins = swimmerInsights(rows, arg);
  const r = ins?.readiness;
  const t = ins?.training;
  const today = trainingOnDay(a.entries, todayISO());
  const span = [7, 14].includes(Number(query.get('t'))) ? Number(query.get('t')) : 28;
  const chart = { ...picks(query, 'swimmer', { team: false }), who: a.key, span };
  // Who's before and after them in the Swimmers list, to go through the group.
  const order = roster(rows, todayISO()).map((r) => r.key);
  const at = order.indexOf(a.key);
  const prevSwimmer = at > 0 ? athletes.get(order[at - 1]) : null;
  const nextSwimmer = at >= 0 && at < order.length - 1 ? athletes.get(order[at + 1]) : null;
  view.innerHTML = `
    <section class="card">
      <div class="swimmer-nav"><a href="#swimmers">‹ Swimmers</a>
        <span>${[prevSwimmer && `<a href="#swimmers/${encodeURIComponent(prevSwimmer.key)}" aria-label="Previous swimmer">‹ ${esc(first(prevSwimmer.name))}</a>`,
    nextSwimmer && `<a href="#swimmers/${encodeURIComponent(nextSwimmer.key)}" aria-label="Next swimmer">${esc(first(nextSwimmer.name))} ›</a>`].filter(Boolean).join(' · ')}</span></div>
      <h2>${esc(a.name)}</h2>
      <p class="muted small">Latest check-in ${esc(prettyDate(latest.date))}</p>
      <div class="score-row">
        <div class="score"><span class="score-num">${assessment.score ?? '–'}</span><span class="score-max">/100</span></div>
        <div>${statusBadge(assessment.status)}</div>
      </div>
      ${assessment.flags.length ? `<ul class="flags">${assessment.flags.map((f) => `<li>${statusBadge({ level: f.level, label: f.level === 'critical' ? 'Important' : 'Note' })} ${esc(theirs(f.text))}</li>`).join('')}</ul>` : ''}
      ${r ? `<div class="stats small-stats" id="swimmer-change">
        <div><span class="stat-num">${delta(r.vsPrev)}</span><span class="stat-label">vs ${r.prevDate === shiftDate(ins.date, -1) ? 'yesterday' : r.prevDate ? `last check-in (${esc(shortDate(r.prevDate))})` : 'yesterday'}${r.prevScore !== null ? `<br><span class="muted">${r.prevScore}</span>` : ''}</span></div>
        <div><span class="stat-num">${delta(r.vsUsual)}</span><span class="stat-label">vs usual<br><span class="muted">${r.usualScore ?? 'needs 3 check-ins'}</span></span></div>
      </div>` : ''}
      <div class="actions"><a class="btn secondary" href="#messages?to=${encodeURIComponent(a.key)}">Message ${esc(first(a.name))}</a></div>
    </section>

    ${fus.length ? `<section class="card" id="swimmer-followup"><h3>Watchlist</h3>
      ${fus.map((c) => `<div class="fu-cat"><h4>${c.label}</h4><ul class="fu-list">${followUpItem({ ...c, key: null }, { name: false })}</ul></div>`).join('')}
      <p class="muted small">Against their own usual. Prompts for a conversation, not a diagnosis.</p></section>` : ''}

    <section class="card" id="swimmer-today">
      <h3>Today’s training</h3>
      ${today ? `<p>${practicesCell(today)} ${sessionTags(today)}</p>
      ${sessionLoad(today) ? `<p class="muted small">Load ${sessionLoad(today)} (minutes × effort)</p>` : ''}`
    : '<p class="muted">Not logged yet.</p>'}
    </section>

    ${goalsCard(a)}

    <section class="card" id="charts">
      <h3>Charts</h3>
      <p class="muted small">${esc(first(a.name))}’s days: pick what to see and what to compare it with, including the team average.</p>
      <div class="seg range">${[7, 14, 28].map((n) => `<a href="#swimmers/${encodeURIComponent(a.key)}?t=${n}" data-span="${n}" ${span === n ? 'aria-current="true"' : ''}>${n} days</a>`).join('')}</div>
      <div class="picker-body">${pickerHtml(chart, { team: false })}</div>
    </section>

    ${t ? `<section class="card" id="swimmer-training">
      <h3>Training the day before</h3>
      <p class="muted small">${esc(prettyDate(shiftDate(ins.date, -1)))}, reported ${esc(shortDate(ins.date))}.</p>
      <p>${practicesCell(t.training)} ${sessionTags(t.training)}</p>
      <div class="stats small-stats">
        <div><span class="stat-num">${t.load}</span><span class="stat-label">load</span></div>
        <div><span class="stat-num">${delta(t.vsWeekAgo, { unit: '%', big: 25 })}</span><span class="stat-label">vs a week before<br><span class="muted">${t.weekAgoLoad ?? 'not reported'}</span></span></div>
        <div><span class="stat-num">${delta(t.vsUsual, { unit: '%', big: 25 })}</span><span class="stat-label">vs their usual ${esc(new Date(`${shiftDate(ins.date, -1)}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long' }))}<br><span class="muted">${t.usualLoad ?? 'needs 2 weeks'}</span></span></div>
      </div>
    </section>` : ''}

    ${ins ? `<section class="card" id="swimmer-response">
      <h3>Training vs next-morning readiness</h3>
      <p class="muted small">Last 28 days: how ${esc(first(a.name))}’s readiness changed after their own lighter and heavier days.</p>
      ${responseTable(ins.response, (x) => `${x[0]}–${x[1]}`, '')}
      <p class="muted small">A pattern, not proof: sleep, school and meets move readiness too.</p>
    </section>` : ''}
    <section class="card"><h3>Recent days</h3>
      <div class="table-wrap"><table class="recent-table">
        <thead><tr><th>Date</th><th>Ready</th><th class="col-well">Well</th><th>Sleep</th>${heart ? '<th>HR</th><th>HRV</th>' : ''}<th>Effort<br><span class="th-sub">AM · Dbl</span></th><th>Load</th></tr></thead>
        <tbody>${[...a.entries].reverse().slice(0, 28).map((e, i) => {
    const day = assessDay(a.entries, e.date);
    return `
          <tr${i >= 7 ? ' class="more-row" hidden' : ''}>
            <td>${esc(shortDate(e.date))}</td>
            <td>${day.score !== null && day.score !== undefined ? `<span class="score-dot dot-${day.status?.level || 'none'}" aria-hidden="true"></span>${day.score}` : '–'}</td>
            <td class="col-well">${wellnessScore(e.wellness) ?? '–'}</td>
            <td>${fmt(e.wellness?.sleepHours, 1)}</td>
            ${heart ? `<td>${fmt(e.hrv?.hr)}</td><td>${fmt(e.hrv?.rmssd)}</td>` : ''}
            <td class="effort">${effortCell(e.training)}</td>
            <td>${sessionLoad(e.training) || '–'}</td>
          </tr>
          ${e.notes || e.pain?.level ? `<tr class="flag-row${i >= 7 ? ' more-row' : ''}" ${i >= 7 ? 'hidden' : ''}><td colspan="${heart ? 8 : 6}">${[
    e.pain?.level ? `Injury ${e.pain.level}/3${e.pain.location ? ` (${esc(e.pain.location)})` : ''}` : '',
    e.notes ? `“${esc(e.notes)}”` : '',
  ].filter(Boolean).join(' · ')}</td></tr>` : ''}`;
  }).join('')}
        </tbody></table></div>
      ${a.entries.length > 7 ? `<button type="button" class="btn secondary block" id="more-days">Show ${Math.min(28, a.entries.length) - 7} more days</button>` : ''}
      <p class="muted small">${heart ? 'HRV = RMSSD in ms. ' : ''}Training is reported the morning after, so each row is the day before’s
        effort (1–10) for morning practice · doubles, with Wt / Meet if they lifted or raced. Load = minutes × effort; weights count as 45 min at hard effort (5).</p>
    </section>`;
  wirePicker(view.querySelector('#charts'), athletes, chart, { where: 'swimmer', base: `#swimmers/${encodeURIComponent(a.key)}` });
  wireGoalsCard(view, coach, a);
  view.querySelector('#more-days')?.addEventListener('click', (ev) => {
    view.querySelectorAll('.more-row').forEach((r) => { r.hidden = false; });
    ev.target.remove();
  });
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
      ${link ? inviteBlock(link) : '<p class="muted small">Add your group code in Settings to get an invite link and QR code.</p>'}
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
      <p class="small" id="script-version">Checking the sheet script…</p>
      <button class="btn secondary small-btn" id="copy-script-settings" type="button">Copy the latest script</button>
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
  // Which version of the script the sheet runs; the dashboard needs 2 for goal times.
  const line = view.querySelector('#script-version');
  callSheet(coach.url, { action: 'ping', coachPassword: coach.password }).then((r) => {
    const v = r.version || 1;
    line.innerHTML = v >= SCRIPT_NEEDED ? `${statusBadge({ level: 'good', label: `Sheet script version ${v}` })} Up to date.`
      : `${statusBadge({ level: 'warning', label: `Sheet script version ${v}` })} This dashboard needs version ${SCRIPT_NEEDED} to set swimmers’ goal times. Copy the latest script below, paste it over the old one in Apps Script (keep your GROUP_CODE and COACH_PASSWORD), then Deploy → Manage deployments → Edit → New version.`;
  }).catch((e) => { line.textContent = `Couldn’t reach the sheet: ${e.message}`; });
  view.querySelector('#copy-script-settings').addEventListener('click', async (ev) => {
    const text = await (await fetch('apps-script/Code.gs')).text();
    if (await shareOrCopy(text) === 'copied') ev.target.textContent = 'Copied';
  });
}

// The sheet script version this dashboard was built for.
const SCRIPT_NEEDED = 3;

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
    </section>

    <section class="card" id="qr-only">
      <h3>Just need the invite QR code?</h3>
      <p class="muted small">No password needed: the web app URL and your group code are enough to make the code
        swimmers scan to join. (Your group code is the <code>GROUP_CODE</code> line in the sheet’s Apps Script.)</p>
      <form id="qr-form" class="stack">
        <label class="field">Web app URL <input name="url" type="url" required placeholder="https://script.google.com/macros/s/…/exec"></label>
        <label class="field">Group code <input name="group" required autocomplete="off"></label>
        <p class="form-error" id="qr-error" role="alert" hidden></p>
        <button class="btn secondary block" type="submit">Make QR code</button>
      </form>
      <div id="qr-result" hidden></div>
    </section>`;
  view.querySelector('#qr-form').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = ev.target;
    const err = view.querySelector('#qr-error');
    const out = view.querySelector('#qr-result');
    const url = f.url.value.trim();
    const group = f.group.value.trim();
    err.hidden = true;
    if (!isValidSheetUrl(url)) {
      err.textContent = 'The web app URL should start with https://script.google.com/';
      err.hidden = false;
      return;
    }
    const btn = f.querySelector('button');
    btn.disabled = true; btn.textContent = 'Checking…';
    try {
      await callSheet(url, { action: 'ping', group }); // the sheet confirms the group code
      out.innerHTML = inviteBlock(inviteLink(appUrl(), url, group));
      out.hidden = false;
      wireShare(out, '#copy-invite', '#invite');
      out.scrollIntoView({ block: 'start' });
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
    } finally {
      btn.disabled = false; btn.textContent = 'Make QR code';
    }
  });
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
