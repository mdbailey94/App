// The Goals tab: the swimmer's goal and best times, the training gears
// worked out from them (per stroke, IM with its switches, and speed), and
// the practice times they log against those gears. Goals are saved on the
// day they were set (`entry.goals`, the newest wins) and sets on the day
// they were swum (`entry.sets`), so both reach the coach like a check-in.

import {
  AGE_GROUPS, EVENTS, GEARS, IM, MAIN_GEARS, STROKES, ZONES, fatigueFactor, formatTime, gearSet, latestGoals,
  parseTime, setTrend, timesOf,
} from './gears.js';
import { loadEntries, loadSettings, saveSettings, todayISO, upsertEntry } from './storage.js';
import { lineChart } from './charts.js';
import { dayIndex, esc, shortDate } from './ui.js';

const PERS = [25, 50, 75, 100, 200];
const DISTS = [25, 50, 75, 100, 150, 200, 300, 400, 500];
const SET_GEARS = [...GEARS.map((g) => g.key), 'S1', 'S2', 'S3', 'S4', 'race', 'other'];
const PAGES = [
  { key: 'free', label: 'Freestyle' }, { key: 'back', label: 'Backstroke' }, { key: 'breast', label: 'Breaststroke' },
  { key: 'fly', label: 'Butterfly' }, { key: 'im', label: 'IM' }, { key: 'speed', label: 'Speed' },
];
const factorFrom = (f) => (f.from === 'set by hand' ? ', set by hand' : f.from ? `, from your ${esc(f.from)}` : '');

const prefs = () => {
  const s = loadSettings();
  return { use: s.gearsUse === 'best' ? 'best' : 'goal', per: PERS.includes(s.gearsPer) ? s.gearsPer : 100 };
};
const fmtPace = (sec) => formatTime(sec, { dp: 1 });
const restText = (r) => (r === null ? 'long' : `${r} s`);
const isHalf = (g) => g.key.includes('.5');

// "Goal | Best" and "per 25 | 50 | …" pills; both are remembered.
const useToggle = (use, base) => `<span class="seg use-seg" role="group" aria-label="Which times">
  ${['goal', 'best'].map((u) => `<a href="${base}?use=${u}" data-use="${u}" ${use === u ? 'aria-current="true"' : ''}>${u === 'goal' ? 'Goal times' : 'Best times'}</a>`).join('')}</span>`;
const perToggle = (per, base) => `<span class="seg per-seg" role="group" aria-label="Pace per">
  ${PERS.map((p) => `<a href="${base}?per=${p}" data-per="${p}" ${per === p ? 'aria-current="true"' : ''}>${p}</a>`).join('')}</span>`;

function readPrefs(query) {
  const p = prefs();
  const use = ['goal', 'best'].includes(query.get('use')) ? query.get('use') : p.use;
  const per = PERS.includes(Number(query.get('per'))) ? Number(query.get('per')) : p.per;
  if (use !== p.use || per !== p.per) saveSettings({ gearsUse: use, gearsPer: per });
  return { use, per };
}

const refLine = (ref, use) => (ref.estimated
  ? `Estimated 200 (${fmtPace(ref.seconds)}) from your ${use} ${esc(ref.from.label)}.`
  : `From your ${use} ${esc(ref.event.label)}: ${fmtPace(ref.seconds)}.`);

export function renderGoals(view, arg, query) {
  const entries = loadEntries();
  const goals = latestGoals(entries);
  if (arg === 'edit') { renderEdit(view, goals); return; }
  if (arg === 'log') { renderLog(view, entries, goals, query); return; }
  if (PAGES.some((p) => p.key === arg)) { renderPage(view, arg, goals, query); return; }
  renderOverview(view, entries, goals, query);
}

// ---- overview

function renderOverview(view, entries, goals, query) {
  const { use, per } = readPrefs(query);
  const set = gearSet(goals, { use, per: 100 });
  const sets = entries.flatMap((e) => (e.sets || []).map((s) => ({ ...s, date: e.date }))).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 3);
  const count = Object.values(goals?.times || {}).filter((t) => t?.goal > 0).length;
  const tile = (p) => {
    let line = '';
    if (!set) line = '';
    else if (p.key === 'speed') {
      const n = Object.keys(set.speed).length;
      line = n ? `${n} stroke${n > 1 ? 's' : ''} with a 50` : 'Add a 50 time';
    } else if (p.key === 'im') {
      line = set.im ? `G3 ${fmtPace(set.im.gears.find((g) => g.key === 'G3').pace)} /100` : 'Add an IM or a 200 of a stroke';
    } else {
      const g = set.strokes[p.key];
      line = g ? `G3 ${fmtPace(g.gears.find((x) => x.key === 'G3').pace)} /100` : `Add a ${p.key === 'free' ? '200 or longer' : '200 or 100'}`;
    }
    return `<a class="tile goal-tile" href="#goals/${p.key}"><span class="stat-label">${p.label}</span><span class="tile-line ${line.startsWith('Add') ? 'muted' : ''}">${esc(line)}</span></a>`;
  };
  view.innerHTML = `
    <section class="card">
      <h2>Goals</h2>
      ${goals ? `
      <p class="muted small">${count} goal time${count === 1 ? '' : 's'} set${goals.updatedAt ? `, ${esc(shortDate(goals.updatedAt.slice(0, 10)))}` : ''}.
        Fatigue factor ${set.factor.factor.toFixed(3)} (${set.factor.type}${factorFrom(set.factor)}).</p>
      <div class="actions"><a class="btn secondary" href="#goals/edit">Edit times</a></div>`
    : `<p>Enter your goal times (and best times) and the app works out your training gears: the pace to hold for
        each gear, for every stroke, IM and the IM switches, plus your speed targets.</p>
      <div class="actions"><a class="btn block" href="#goals/edit" id="setup-goals">Set up my goals</a></div>`}
    </section>
    ${goals ? `
    <section class="card" id="gear-pages">
      <div class="card-head"><h3>Your gears</h3>${useToggle(use, '#goals')}</div>
      <p class="muted small">G2 is the pace you could hold for 4 hours, G3 for 1 hour, G4 for 15 minutes, G5 for 5 and G6 for 2.</p>
      <div class="tiles goal-tiles">${PAGES.map(tile).join('')}</div>
    </section>` : ''}
    <section class="card" id="practice-times">
      <div class="card-head"><h3>Practice times</h3><a class="btn secondary small-btn" href="#goals/log">Log a set</a></div>
      ${sets.length ? `<ul class="plain set-list">${sets.map((s) => `<li>${esc(shortDate(s.date))} · ${esc(setLabel(s))}</li>`).join('')}</ul>
      <p class="muted small"><a href="#goals/log">All sets and trends ›</a></p>`
    : '<p class="muted">Log the average time from a set and see the trend against your gears. Trends matter more than one fast day.</p>'}
    </section>`;
}

const setLabel = (s) => `${s.reps ? `${s.reps} × ` : ''}${s.dist} ${STROKES[s.stroke]?.short.toLowerCase() || s.stroke} ${s.gear && s.gear !== 'other' ? `@ ${s.gear}` : ''} avg ${fmtPace(s.avg)}`;

// ---- entering times

function renderEdit(view, goals) {
  const g = goals || { sex: 'girls', age: '15-16', factor: null, times: {} };
  const fact = fatigueFactor(timesOf(g, 'best'), g.factor);
  const row = (e) => {
    const t = g.times?.[e.key] || {};
    return `<tr><th scope="row">${esc(e.label)}</th>
      <td><input type="text" name="best-${e.key}" inputmode="decimal" placeholder="m:ss.s" value="${t.best ? fmtPace(t.best) : ''}" aria-label="${esc(e.label)} best"></td>
      <td><input type="text" name="goal-${e.key}" inputmode="decimal" placeholder="m:ss.s" value="${t.goal ? fmtPace(t.goal) : ''}" aria-label="${esc(e.label)} goal"></td></tr>`;
  };
  const group = (stroke) => `<tr class="stroke-row"><th colspan="3">${STROKES[stroke].label}</th></tr>${EVENTS.filter((e) => e.stroke === stroke).map(row).join('')}`;
  view.innerHTML = `
    <form id="goals-form" class="stack" novalidate>
      <section class="card"><p><a href="#goals">‹ Goals</a></p>
        <h2>Your times</h2>
        <p class="muted small">Short course yards. Fill in what you have; the gears use the longest race you give for each stroke.</p>
        <div class="row">
          <label class="field">Group <select name="sex"><option value="girls" ${g.sex !== 'boys' ? 'selected' : ''}>Girls</option><option value="boys" ${g.sex === 'boys' ? 'selected' : ''}>Boys</option></select></label>
          <label class="field">Age group <select name="age">${AGE_GROUPS.map((a) => `<option ${a === (g.age || '15-16') ? 'selected' : ''}>${a}</option>`).join('')}</select></label>
        </div>
        <label class="field">Fatigue factor <span class="muted small">(leave blank to work it out from your best 200+ frees; now ${fact.factor.toFixed(3)}${fact.from ? `, from your ${esc(fact.from)}` : ', the usual starting point'})</span>
          <input type="text" name="factor" inputmode="decimal" placeholder="e.g. 1.040" value="${g.factor ? g.factor : ''}"></label>
      </section>
      <section class="card">
        <div class="table-wrap"><table class="times-table">
          <thead><tr><th>Event</th><th>Best</th><th>Goal</th></tr></thead>
          <tbody>${['free', 'back', 'breast', 'fly', 'im'].map(group).join('')}</tbody>
        </table></div>
        <p class="form-error" id="form-error" role="alert" hidden></p>
        <div class="save-bar"><button class="btn block" type="submit" id="save-goals">Save</button></div>
      </section>
    </form>`;
  view.querySelector('#goals-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const bad = [];
    const times = {};
    for (const e of EVENTS) {
      const t = {};
      for (const k of ['best', 'goal']) {
        const raw = String(fd.get(`${k}-${e.key}`) || '').trim();
        if (!raw) continue;
        const sec = parseTime(raw);
        if (sec === null) bad.push(`${e.label} ${k}`); else t[k] = sec;
      }
      if (Object.keys(t).length) times[e.key] = t;
    }
    const factorRaw = String(fd.get('factor') || '').trim();
    const factor = factorRaw ? Number(factorRaw) : null;
    if (factorRaw && !(factor >= 1 && factor <= 1.12)) bad.push('fatigue factor (1.00 to 1.12)');
    const err = view.querySelector('#form-error');
    if (bad.length) { err.textContent = `Please check: ${bad.join(', ')}. Times look like 1:52.3 or 52.3.`; err.hidden = false; return; }
    upsertEntry(todayISO(), { goals: { sex: fd.get('sex'), age: fd.get('age'), factor, times, course: 'SCY', updatedAt: new Date().toISOString() } });
    location.hash = '#goals';
  });
}

// ---- a gear page

function renderPage(view, key, goals, query) {
  const { use, per } = readPrefs(query);
  const page = PAGES.find((p) => p.key === key);
  const base = `#goals/${key}`;
  const nav = `<p class="goal-nav"><a href="#goals">‹ Goals</a> ${PAGES.filter((p) => p.key !== key).map((p) => `<a href="#goals/${p.key}">${p.label}</a>`).join(' · ')}</p>`;
  if (!goals) {
    view.innerHTML = `<section class="card">${nav}<h2>${page.label}</h2><p class="muted">Set up your goals first.</p><div class="actions"><a class="btn" href="#goals/edit">Set up my goals</a></div></section>`;
    return;
  }
  const set = gearSet(goals, { use, per });
  const head = `${nav}<div class="card-head"><h2>${page.label}</h2>${useToggle(use, base)}</div>`;
  if (key === 'speed') { view.innerHTML = speedPage(set, head, use); wire(view, base); return; }
  if (key === 'im') { view.innerHTML = imPage(set, head, use, per, base); wire(view, base); return; }
  const g = set.strokes[key];
  view.innerHTML = `
    <section class="card gear-page">
      ${head}
      ${g ? `<p class="muted small">${refLine(g.reference, use)} Fatigue factor ${set.factor.factor.toFixed(3)}.</p>
      <div class="card-head"><h3>Pace per</h3>${perToggle(per, base)}</div>
      <div class="table-wrap"><table class="gear-table">
        <thead><tr><th>Gear</th><th>Pace /${per}</th><th>Rest</th><th>Effort</th></tr></thead>
        <tbody>${g.gears.map((x) => `<tr class="${isHalf(x) ? 'half' : ''}" data-gear="${x.key}">
          <th scope="row"><b>${x.key}</b><br><span class="th-sub">${x.name}</span></th>
          <td class="pace"><b>${fmtPace(x.pace)}</b></td><td>${restText(x.rest)}</td><td>${x.rpe}</td></tr>`).join('')}
        </tbody></table></div>
      <p class="muted small">Rest is for one repeat of ${per} at that gear (longer repeats earn more). Effort is the 1–10 it should feel like.</p>`
    : `<p class="muted">Add a ${key === 'free' ? '200, 500, 1000 or 1650' : '200 or 100'} ${STROKES[key].short.toLowerCase()} ${use} time to see these gears.</p>
      <div class="actions"><a class="btn secondary" href="#goals/edit">Edit times</a></div>`}
    </section>`;
  wire(view, base);
}

function imPage(set, head, use, per, base) {
  const im = set.im;
  if (!im) {
    return `<section class="card gear-page">${head}<p class="muted">Add a 400 IM, a 200 IM, or a 200 back, breast or fly ${use} time to see your IM gears.</p>
      <div class="actions"><a class="btn secondary" href="#goals/edit">Edit times</a></div></section>`;
  }
  const r = im.reference;
  const from = r.estimated ? `Estimated 400 IM (${fmtPace(r.seconds)}) from your ${use} ${esc(r.from.label)}` : `From your ${use} 400 IM: ${fmtPace(r.seconds)}`;
  return `
    <section class="card gear-page">
      ${head}
      <p class="muted small">${from}; 200 IM about ${fmtPace(im.im200)}. Fatigue factor ${set.factor.factor.toFixed(3)}.</p>
      <div class="card-head"><h3>IM pace per</h3>${perToggle(per, base)}</div>
      <div class="table-wrap"><table class="gear-table">
        <thead><tr><th>Gear</th><th>IM /${per}</th><th>200 IM</th><th>Rest</th></tr></thead>
        <tbody>${im.gears.map((x) => `<tr class="${isHalf(x) ? 'half' : ''}" data-gear="${x.key}">
          <th scope="row"><b>${x.key}</b><br><span class="th-sub">${x.name}</span></th>
          <td class="pace"><b>${fmtPace(x.pace)}</b></td><td>${fmtPace(x.im200)}</td><td>${restText(x.rest)}</td></tr>`).join('')}
        </tbody></table></div>
    </section>
    <section class="card">
      <h3>Each stroke in a 200 IM</h3>
      <p class="muted small">The 50 of each stroke inside a 200 IM at that gear (elite stroke shares; your own 400 IM splits may differ).</p>
      <div class="table-wrap"><table class="gear-table im-strokes">
        <thead><tr><th>Gear</th><th>Fly</th><th>Back</th><th>Breast</th><th>Free</th></tr></thead>
        <tbody>${im.gears.filter((x) => !isHalf(x)).map((x) => `<tr data-gear="${x.key}"><th scope="row"><b>${x.key}</b></th>
          ${['fly', 'back', 'breast', 'free'].map((s) => `<td>${fmtPace(x.strokes[s])}</td>`).join('')}</tr>`).join('')}
        </tbody></table></div>
    </section>
    <section class="card" id="im-switches">
      <h3>IM switches</h3>
      <p class="muted small">Switch 50s (25 + 25) and 100s (50 + 50): the two strokes at that gear, back to back.</p>
      <div class="table-wrap"><table class="gear-table im-switches">
        <thead><tr><th>Gear</th>${IM.switches.map((sw) => `<th>${sw.label}<br><span class="th-sub">50</span></th>`).join('')}</tr></thead>
        <tbody>${im.gears.filter((x) => !isHalf(x)).map((x) => `<tr data-gear="${x.key}"><th scope="row"><b>${x.key}</b></th>
          ${IM.switches.map((sw) => `<td><b>${fmtPace(x.switches[sw.key].fifty)}</b><br><span class="th-sub">100: ${fmtPace(x.switches[sw.key].hundred)}</span></td>`).join('')}</tr>`).join('')}
        </tbody></table></div>
    </section>`;
}

function speedPage(set, head, use) {
  const strokes = Object.entries(set.speed);
  const f2 = (v) => formatTime(v, { dp: 2 });
  return `
    <section class="card gear-page">
      ${head}
      ${strokes.length ? `<p class="muted small">From your ${use} 50 of each stroke: your clean mid-pool speed, and what the start, a push and a 25 should take at it.
        The factors are calibrated to freestyle; for the other strokes they are a starting point.</p>`
    : `<p class="muted">Add a 50 ${use} time for a stroke to see your speed targets.</p><div class="actions"><a class="btn secondary" href="#goals/edit">Edit times</a></div>`}
    </section>
    ${strokes.map(([s, sp]) => `
    <section class="card speed-card" data-stroke="${s}">
      <h3>${STROKES[s].label} <span class="muted small">50 ${f2(sp.fifty)} · ${sp.cleanSpeed.toFixed(2)} yd/s</span></h3>
      <table class="gear-table speed-table">
        <tbody>
          ${[
    ['15 m dive', 'from the start', sp.dive15.fromStart], ['', 'from feet leaving the block', sp.dive15.fromFeet],
    ['25 dive', 'from the start', sp.dive25.fromStart], ['', 'from feet leaving the block', sp.dive25.fromFeet],
    ['15 m push', 'from feet leaving the wall', sp.push15], ['25 push', 'from feet leaving the wall', sp.push25],
    ['Flag to flag', '15 yd at clean speed', sp.flagToFlag15], ['Start to far flags', '20 yd', sp.toFarFlags20],
    ['Predicted 100', 'at this speed', sp.hundred],
  ].map(([name, sub, v]) => `<tr${name ? '' : ' class="cont"'}><th scope="row">${name}<br><span class="th-sub">${sub}</span></th><td class="pace"><b>${f2(v)}</b></td></tr>`).join('')}
        </tbody></table>
      <h4>Speed zones: 25 push</h4>
      <table class="gear-table zone-table">
        <tbody>${ZONES.map((z) => `<tr data-zone="${z.key}"><th scope="row"><b>${z.key}</b> ${z.label}<br><span class="th-sub">${z.pct} of clean speed</span></th>
          <td class="pace"><b>${f2(sp.zones[z.key])}</b></td></tr>
          <tr class="flag-row"><td colspan="2">${z.trains}: ${z.work}. Rest ${z.rest}.</td></tr>`).join('')}
        </tbody></table>
    </section>`).join('')}`;
}

// The pills change the address, which re-renders; keep it on one history entry.
function wire(view, base) {
  view.querySelectorAll('.use-seg a, .per-seg a').forEach((a) => a.addEventListener('click', (ev) => {
    ev.preventDefault();
    const q = new URLSearchParams(location.hash.split('?')[1] || '');
    if (a.dataset.use) q.set('use', a.dataset.use);
    if (a.dataset.per) q.set('per', a.dataset.per);
    location.hash = `${base}?${q}`;
  }));
}

// ---- practice times

function renderLog(view, entries, goals, query) {
  const all = entries.flatMap((e) => (e.sets || []).map((s) => ({ ...s, date: e.date }))).sort((a, b) => b.date.localeCompare(a.date) || (b.id || '').localeCompare(a.id || ''));
  const last = all[0];
  const stroke = query.get('stroke') || last?.stroke || 'free';
  const dist = Number(query.get('dist')) || last?.dist || 100;
  const set = gearSet(goals, { use: prefs().use, per: 100 });
  const gearsFor = stroke === 'im' ? set?.im : set?.strokes[stroke];
  const trend = setTrend(entries, { stroke, dist }, gearsFor && !(stroke === 'im') ? gearsFor : null);
  if (stroke === 'im' && set?.im) trend.targets = Object.fromEntries(set.im.gears.map((g) => [g.key, +((g.pace / 100) * dist).toFixed(1)]));
  const today = todayISO();
  const recent = all.slice(0, 12);
  const latest = trend.points.at(-1);
  const target = latest && latest.gear && trend.targets[latest.gear];
  view.innerHTML = `
    <section class="card"><p><a href="#goals">‹ Goals</a></p>
      <h2>Practice times</h2>
      <form id="set-form" class="stack" novalidate>
        <div class="row">
          <label class="field">Date <input type="date" name="date" value="${today}" max="${today}" required></label>
          <label class="field">Stroke <select name="stroke">${Object.entries(STROKES).map(([k, s]) => `<option value="${k}" ${k === stroke ? 'selected' : ''}>${s.label}</option>`).join('')}</select></label>
        </div>
        <div class="row">
          <label class="field">Distance <select name="dist">${DISTS.map((d) => `<option ${d === dist ? 'selected' : ''}>${d}</option>`).join('')}</select></label>
          <label class="field">Gear <select name="gear">${SET_GEARS.map((g) => `<option value="${g}" ${g === (last?.gear || 'G3') ? 'selected' : ''}>${g === 'race' ? 'Race pace' : g === 'other' ? 'Other' : g}</option>`).join('')}</select></label>
        </div>
        <div class="row">
          <label class="field">Reps <input type="number" name="reps" inputmode="numeric" min="1" max="100" placeholder="10"></label>
          <label class="field">Average time <input type="text" name="avg" inputmode="decimal" placeholder="1:10.5" required></label>
          <label class="field">Rest (s) <input type="number" name="rest" inputmode="numeric" min="0" max="600" placeholder="10"></label>
        </div>
        <label class="field">Note <span class="muted small">(optional)</span><input type="text" name="note" maxlength="80" placeholder="e.g. held it, last two faded"></label>
        <p class="form-error" id="form-error" role="alert" hidden></p>
        <button class="btn block" type="submit" id="save-set">Save set</button>
      </form>
    </section>
    <section class="card" id="trend">
      <div class="card-head"><h3>Trend</h3>
        <form id="trend-pick" class="row compact">
          <select name="stroke" aria-label="Stroke">${Object.entries(STROKES).map(([k, s]) => `<option value="${k}" ${k === stroke ? 'selected' : ''}>${s.short}</option>`).join('')}</select>
          <select name="dist" aria-label="Distance">${DISTS.map((d) => `<option ${d === dist ? 'selected' : ''}>${d}</option>`).join('')}</select>
        </form></div>
      ${trend.points.length ? `
      <p class="small" id="trend-line">Last ${Math.min(3, trend.points.length)} sets average <b>${fmtPace(latest.rolling)}</b>${target ? ` · ${latest.gear} target ${fmtPace(target)} (${latest.rolling - target > 0 ? '+' : ''}${(latest.rolling - target).toFixed(1)} s)` : ''}</p>
      <div data-c="trend"></div>
      <p class="muted small">Dots = each set’s average; dashed = the average of the last 3. Look at the line, not the best dot.</p>`
    : '<p class="muted">No sets logged for this stroke and distance yet.</p>'}
      ${Object.keys(trend.targets).length ? `<p class="small targets">Targets for ${dist} ${STROKES[stroke].short.toLowerCase()}: ${MAIN_GEARS.map((k) => `<span class="target ${latest?.gear === k ? 'on' : ''}">${k} ${fmtPace(trend.targets[k])}</span>`).join(' ')}</p>` : ''}
    </section>
    <section class="card" id="recent-sets">
      <h3>Recent sets</h3>
      ${recent.length ? `<ul class="plain set-list">${recent.map((s) => `<li><span>${esc(shortDate(s.date))} · ${esc(setLabel(s))}${s.note ? ` <span class="muted">– ${esc(s.note)}</span>` : ''}</span>
        <button type="button" class="link small" data-del="${esc(s.id)}" data-date="${s.date}" aria-label="Delete this set">Delete</button></li>`).join('')}</ul>` : '<p class="muted">Nothing yet.</p>'}
    </section>`;

  view.querySelector('#set-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    const avg = parseTime(fd.get('avg'));
    const date = String(fd.get('date'));
    const err = view.querySelector('#form-error');
    if (!avg || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today) { err.textContent = 'Please give the date and the average time (like 1:10.5).'; err.hidden = false; return; }
    const s = {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      stroke: fd.get('stroke'), dist: Number(fd.get('dist')), gear: fd.get('gear'), avg,
      ...(Number(fd.get('reps')) > 0 ? { reps: Number(fd.get('reps')) } : {}),
      ...(fd.get('rest') !== '' ? { rest: Number(fd.get('rest')) } : {}),
      ...(String(fd.get('note')).trim() ? { note: String(fd.get('note')).trim().slice(0, 80) } : {}),
    };
    const e = loadEntries().find((x) => x.date === date);
    upsertEntry(date, { sets: [...(e?.sets || []), s] });
    const to = `#goals/log?stroke=${s.stroke}&dist=${s.dist}`;
    if (location.hash === to) renderGoals(view, 'log', new URLSearchParams({ stroke: s.stroke, dist: s.dist }));
    else location.hash = to;
  });
  view.querySelector('#trend-pick').addEventListener('change', (ev) => {
    const f = ev.target.form;
    location.hash = `#goals/log?stroke=${f.stroke.value}&dist=${f.dist.value}`;
  });
  view.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
    const e = loadEntries().find((x) => x.date === b.dataset.date);
    if (!e) return;
    upsertEntry(e.date, { sets: (e.sets || []).filter((s) => s.id !== b.dataset.del) });
    renderGoals(view, 'log', query);
  }));
  if (trend.points.length) {
    requestAnimationFrame(() => {
      const el = view.querySelector('[data-c="trend"]');
      if (!el) return;
      const data = trend.points.map((p) => ({ x: dayIndex(p.date), y: p.avg, y2: p.rolling, label: `${shortDate(p.date)}${p.gear ? ` · ${p.gear}` : ''}` }));
      lineChart(el, data, { yFormat: (v) => fmtPace(v), tip: (d) => `${esc(d.label)}: <b>${fmtPace(d.y)}</b> (avg of last 3: ${fmtPace(d.y2)})` });
    });
  }
}

// For the coach's swimmer page: the goal times set and G2–G6 per 100 for
// each stroke with a reference, plus the most-logged set's trend.
export function goalsSummary(entries) {
  const goals = latestGoals(entries);
  if (!goals) return null;
  const set = gearSet(goals, { use: 'goal', per: 100 });
  const rows = [...['free', 'back', 'breast', 'fly'].map((s) => [STROKES[s].short, set.strokes[s]]), ['IM', set.im]]
    .filter(([, g]) => g)
    .map(([label, g]) => ({ label, reference: g.reference, paces: Object.fromEntries(MAIN_GEARS.map((k) => [k, g.gears.find((x) => x.key === k).pace])) }));
  const counts = new Map();
  for (const e of entries) for (const s of e.sets || []) counts.set(`${s.stroke}|${s.dist}`, (counts.get(`${s.stroke}|${s.dist}`) || 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  let trend = null;
  if (top) {
    const [stroke, dist] = top[0].split('|');
    const gearsFor = stroke === 'im' ? null : set.strokes[stroke];
    trend = { stroke, dist: Number(dist), ...setTrend(entries, { stroke, dist: Number(dist) }, gearsFor) };
  }
  return { goals, factor: set.factor, rows, trend, updated: goals.updatedAt?.slice(0, 10) };
}

