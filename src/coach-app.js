// The coach dashboard (coach.html): its own page with its own tabs.
//   #group      one day: who checked in, yesterday's training, who's missing
//   #watchlist  who may need a word, by category (follow-up), and why
//   #history    the group over 7 or 28 days, and a check-in record
//   #swimmers   everyone in the group; #swimmers/<key> for one swimmer
//   #messages   notes and injuries from swimmers, reminders, invite link
//   #settings   the sheet this dashboard reads, setup help, sign out

import { loadCoach, loadTeam, saveCoach, todayISO } from './storage.js';
import { callSheet, inviteLink, isValidSheetUrl } from './team.js';
import {
  checkinGrid, groupByAthlete, groupDay, loadResponse, recentNotes, reminderText, roster, teamTrend, trainingCompare,
  swimmerInsights, trendSummary,
} from './group.js';
import { followUps, followUpsFor } from './followups.js';
import {
  assessDay, MEET_LEVELS, meetLevel, PRACTICE_KEYS, sessionLoad, sessionRpe, shiftDate, SKIP_REASONS, wellnessScore,
} from './readiness.js';
import { dayIndex, esc, fmt, prettyDate, qrSvg, renderTrends, shareOrCopy, shortDate, statusBadge } from './ui.js';
import { barChart, stackedChart } from './charts.js';

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

const SCREENS = { group: renderGroup, watchlist: renderWatchlist, history: renderHistory, swimmers: renderSwimmers, messages: renderMessages, settings: renderSettings };

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

function renderGroup({ rows, query }) {
  const date = query.get('d') || todayISO();
  const day = groupDay(rows, date);
  const fu = followUps(rows, date);
  const tr = trainingCompare(rows, date);
  const { now, weekAgo, usual } = tr.team;
  const vsDay = (a, b) => (a !== null && b !== null ? a - b : null);
  // One row of the team comparison: yesterday, a week ago, the usual.
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
  const weekday = new Date(`${tr.trainedOn}T12:00:00`).toLocaleDateString(undefined, { weekday: 'long' });

  view.innerHTML = `
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

    <section class="card" id="day-before">
      <h3>Yesterday’s training</h3>
      <p class="muted small">${esc(prettyDate(tr.trainedOn))} against the same day last week (${esc(shortDate(shiftDate(tr.trainedOn, -7)))})
        and a usual ${esc(weekday)} (average of the 4 before${usual ? '' : '; needs 2'}).</p>
      ${now.reported ? `<div class="table-wrap"><table class="group-table compare-table">
        <thead><tr><th></th><th>Yesterday</th><th>Week ago</th><th>Usual</th></tr></thead>
        <tbody>
          ${compareRow('Reported', (d) => d.reported)}
          ${compareRow('Morning practice', (d) => d.am.count)}
          ${compareRow('time', (d) => (d.am.avgMin === null ? null : shortTime(Math.round(d.am.avgMin))), { sub: true })}
          ${compareRow('effort', (d) => d.am.avgRpe, { sub: true })}
          ${compareRow('how well', (d) => d.am.avgPerf, { sub: true })}
          ${compareRow('Doubles', (d) => d.pm.count)}
          ${compareRow('time', (d) => (d.pm.avgMin === null ? null : shortTime(Math.round(d.pm.avgMin))), { sub: true })}
          ${compareRow('effort', (d) => d.pm.avgRpe, { sub: true })}
          ${compareRow('how well', (d) => d.pm.avgPerf, { sub: true })}
          ${compareRow('Lifted', (d) => d.weights)}
          ${compareRow('Raced', (d) => d.meet)}
          ${compareRow('Missed: sick', (d) => d.sick)}
          ${compareRow('Missed: other', (d) => d.missed)}
          ${compareRow('Avg load', (d) => d.avgLoad, { load: true })}
        </tbody></table></div>
      <div class="table-wrap"><table class="group-table day-table">
        <thead><tr><th>Swimmer</th><th>Practice<br><span class="th-sub">time · effort · how well</span></th><th>Load</th><th>vs<br>wk ago</th><th>vs<br>usual</th></tr></thead>
        <tbody>${tr.swimmers.map((s) => `
          <tr>
            <td class="who">${athleteLink(s.key, s.name)} ${sessionTags(s.training)}</td>
            <td class="effort">${practicesCell(s.training)}</td>
            <td><b>${s.load}</b></td>
            <td>${delta(s.vsWeekAgo, { unit: '%', big: 25 })}</td>
            <td>${delta(s.vsUsual, { unit: '%', big: 25 })}</td>
          </tr>`).join('')}
        </tbody></table></div>
      <p class="muted small">Heaviest first. Load = minutes × effort; weights count as 45 min at 5 (meets aren’t counted).
        Each swimmer is compared with their own load on those days.</p>`
    : '<p class="muted">No training reported yet.</p>'}
    </section>

    ${day.missing.length ? `<section class="card" id="not-in"><h3>Not checked in (${day.missing.length})</h3>
        <ul class="plain">${day.missing.map((m) => `<li>${athleteLink(m.key, m.name)}
          <span class="muted small">last ${esc(shortDate(m.lastSeen))}</span>${m.missedDays >= 2 ? `<span class="missed">· missed ${m.missedDays} days</span>` : ''}</li>`).join('')}
        </ul>
        ${date === todayISO() ? '<div class="actions"><a class="btn secondary" href="#messages">Send a reminder</a></div>' : ''}</section>` : ''}`;
}

// ----------------------------------------------------------------- history

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

function renderHistory({ rows, query }) {
  const date = todayISO();
  const span = [14, 28].includes(Number(query.get('t'))) ? Number(query.get('t')) : 7;
  const trend = teamTrend(rows, date, span);
  const now = trendSummary(trend);
  const prev = trendSummary(teamTrend(rows, shiftDate(date, -span), span));
  const grid = checkinGrid(rows, date, 14);
  const resp = loadResponse(rows, date, { days: span });
  const change = (a, b, unit = '') => (a === null || b === null || a === b ? ''
    : ` <span class="muted small">${a > b ? '▲' : '▼'} ${+Math.abs(a - b).toFixed(1)}${unit}</span>`);
  const cell = (c) => {
    if (!c) return '<td class="grid-miss" title="No check-in">·</td>';
    const level = c.injury ? 'critical' : c.status || 'good';
    return `<td class="grid-in grid-${level}" title="${c.injury ? 'Injury reported' : 'Checked in'}">${c.injury ? '✕' : '✓'}</td>`;
  };

  view.innerHTML = `
    <section class="card">
      <div class="card-head"><h3>Team trends</h3>
        <span class="seg">${[7, 14, 28].map((n) => `<a href="#history?t=${n}" ${span === n ? 'aria-current="true"' : ''}>${n} days</a>`).join('')}</span></div>
      <div class="stats small-stats">
        <div><span class="stat-num">${now.avgReadiness ?? '–'}${change(now.avgReadiness, prev.avgReadiness)}</span><span class="stat-label">avg readiness</span></div>
        <div><span class="stat-num">${now.rate ?? '–'}%${change(now.rate, prev.rate, '%')}</span><span class="stat-label">check-in rate</span></div>
        <div><span class="stat-num">${now.avgLoad ?? '–'}${change(now.avgLoad, prev.avgLoad)}</span><span class="stat-label">avg daily load</span></div>
      </div>
      <p class="muted small">Last ${span} days; arrows compare with the ${span} days before.</p>
      <div class="trend-block" id="ready-load"><h4>Readiness and the day before’s training</h4>
        <p class="muted small">Each morning’s average readiness, and under it the average load swimmers reported that
          morning for the day before (rest days count as 0). Days with fewer than 6 swimmers are left out.</p>
        <div data-t="readyLoad"></div></div>
      <div class="trend-block" id="vs-usual"><h4>Readiness vs usual</h4>
        <p class="muted small">Each morning, every swimmer’s readiness minus their own usual (their average over the 7 days
          before), averaged over the team. Above 0 = the team is fresher than normal for them, below 0 = more tired.
          Days with fewer than 6 swimmers are left out.</p>
        <div data-t="vsUsual"></div></div>
      <div class="trend-block"><h4>Checked in (%)</h4><div data-t="rate"></div></div>
      ${refreshLine(`#history?t=${span}`)}
    </section>

    <section class="card">
      <h3>How sessions felt</h3>
      <p class="muted small">Averages (1–10) from swimmers who went to each practice, last ${span} days: how hard it was,
        and how well it went (logged on the Workouts tab).</p>
      <div class="stats two small-stats" id="effort-stats">
        <div><span class="stat-num">${now.rpeAm ?? '–'}${change(now.rpeAm, prev.rpeAm)}</span><span class="stat-label">morning effort</span></div>
        <div><span class="stat-num">${now.rpePm ?? '–'}${change(now.rpePm, prev.rpePm)}</span><span class="stat-label">doubles effort</span></div>
      </div>
      <div class="stats two small-stats" id="perf-stats">
        <div><span class="stat-num">${now.perfAm ?? '–'}${change(now.perfAm, prev.perfAm)}</span><span class="stat-label">morning: how well</span></div>
        <div><span class="stat-num">${now.perfPm ?? '–'}${change(now.perfPm, prev.perfPm)}</span><span class="stat-label">doubles: how well</span></div>
      </div>
      <p class="small" id="lift-meet">${now.weights} weights session${now.weights === 1 ? '' : 's'} · ${now.meet} meet day${now.meet === 1 ? '' : 's'} reported</p>
      <div class="trend-block"><h4>Morning practice</h4><div data-t="rpeAm"></div></div>
      <div class="trend-block"><h4>Doubles</h4><div data-t="rpePm"></div></div>
      <p class="muted small">Effort; each bar is the day the session happened.</p>
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

  const series = (k, none = NaN) => trend.map((d) => ({ x: dayIndex(d.date), y: d[k] ?? none, label: shortDate(d.date) }));
  const $t = (k) => view.querySelector(`[data-t="${k}"]`);
  requestAnimationFrame(() => {
    // Readiness axis from a round number below the lowest day, so changes show.
    const lows = trend.map((d) => d.avgReadiness).filter(Number.isFinite);
    const lineMin = lows.length ? Math.max(0, Math.floor((Math.min(...lows) - 10) / 25) * 25) : 0;
    stackedChart($t('readyLoad'), trend.map((d) => ({
      x: dayIndex(d.date),
      label: shortDate(d.date),
      before: shortDate(shiftDate(d.date, -1)),
      line: d.avgReadiness ?? NaN,
      bar: d.loadReported,
    })), {
      lineMin,
      lineTitle: 'Readiness',
      barTitle: 'Load the day before',
      tip: (d) => `${d.label}: readiness <b>${Number.isFinite(d.line) ? d.line : '–'}</b><br>${d.before} load <b>${d.bar ?? '–'}</b>`,
    });
    // Symmetric around 0 in whole tens (at least ±10) so up and down read at the same scale.
    const reach = Math.max(10, Math.ceil(Math.max(...trend.map((d) => Math.abs(d.vsUsual ?? 0))) / 10) * 10);
    barChart($t('vsUsual'), series('vsUsual'), {
      signed: true,
      yMin: -reach,
      yMax: reach,
      yFormat: (v) => (v > 0 ? `+${v}` : String(v)),
      tip: (d) => `${d.label}: <b>${Number.isFinite(d.y) ? `${d.y > 0 ? '+' : ''}${d.y} points` : 'fewer than 6 swimmers'}</b>`,
    });
    barChart($t('rate'), series('rate', 0), { yMax: 100, tip: (d) => `${d.label}: <b>${d.y}%</b>` });
    // Effort is reported the morning after, so each bar sits on the day the
    // session happened. No bar = nobody reported that session.
    const trained = (k) => trend.map((d) => {
      const day = shiftDate(d.date, -1);
      return { x: dayIndex(day), y: d[k] ?? 0, label: shortDate(day) };
    });
    for (const k of ['rpeAm', 'rpePm']) {
      barChart($t(k), trained(k), { yMax: 10, height: 120, tip: (d) => `${d.label}: <b>${d.y ? fmt(d.y, 1) : 'no sessions reported'}</b>` });
    }
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
  const fus = followUpsFor(a.entries, todayISO());
  const ins = swimmerInsights(rows, arg);
  const r = ins?.readiness;
  const t = ins?.training;
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
      ${r ? `<div class="stats small-stats" id="swimmer-change">
        <div><span class="stat-num">${delta(r.vsPrev)}</span><span class="stat-label">vs ${r.prevDate === shiftDate(ins.date, -1) ? 'yesterday' : r.prevDate ? `last check-in (${esc(shortDate(r.prevDate))})` : 'yesterday'}${r.prevScore !== null ? `<br><span class="muted">${r.prevScore}</span>` : ''}</span></div>
        <div><span class="stat-num">${delta(r.vsUsual)}</span><span class="stat-label">vs usual<br><span class="muted">${r.usualScore ?? 'needs 3 check-ins'}</span></span></div>
      </div>` : ''}
      <div class="actions"><a class="btn secondary" href="#messages?to=${encodeURIComponent(a.key)}">Message ${esc(first(a.name))}</a></div>
    </section>

    ${fus.length ? `<section class="card" id="swimmer-followup"><h3>Watchlist</h3>
      ${fus.map((c) => `<div class="fu-cat"><h4>${c.label}</h4><ul class="fu-list">${followUpItem({ ...c, key: null }, { name: false })}</ul></div>`).join('')}
      <p class="muted small">Against their own usual. Prompts for a conversation, not a diagnosis.</p></section>` : ''}

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
    <div id="trends"></div>
    <section class="card"><h3>Recent days</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Date</th><th>Ready</th><th>Well</th><th>Sleep</th><th>HR</th><th>HRV</th><th>Effort<br><span class="th-sub">AM · Dbl</span></th><th>Load</th></tr></thead>
        <tbody>${[...a.entries].reverse().slice(0, 28).map((e) => `
          <tr>
            <td>${esc(shortDate(e.date))}</td>
            <td>${assessDay(a.entries, e.date).score ?? '–'}</td>
            <td>${wellnessScore(e.wellness) ?? '–'}</td>
            <td>${fmt(e.wellness?.sleepHours, 1)}</td>
            <td>${fmt(e.hrv?.hr)}</td>
            <td>${fmt(e.hrv?.rmssd)}</td>
            <td class="effort">${effortCell(e.training)}</td>
            <td>${sessionLoad(e.training) || '–'}</td>
          </tr>
          ${e.notes || e.pain?.level ? `<tr class="flag-row"><td colspan="8">${[
    e.pain?.level ? `Injury ${e.pain.level}/3${e.pain.location ? ` (${esc(e.pain.location)})` : ''}` : '',
    e.notes ? `“${esc(e.notes)}”` : '',
  ].filter(Boolean).join(' · ')}</td></tr>` : ''}`).join('')}
        </tbody></table></div>
      <p class="muted small">HRV = RMSSD in ms. Training is reported the morning after, so each row is the day before’s
        effort (1–10) for morning practice · doubles, with Wt / Meet if they lifted or raced. Load = minutes × effort; weights count as 45 min at hard effort (5).</p>
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
