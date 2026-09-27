// Small UI helpers shared by the athlete screens and the coach dashboard.

import { assessDay, baseline, sessionLoad, wellnessScore } from './readiness.js';
import { barChart, lineChart } from './charts.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
export const fmt = (v, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : '–');
export const prettyDate = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
export const shortDate = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

const STATUS_ICON = { good: '✓', warning: '!', serious: '▼', critical: '✕' };

// Status is always shown as icon + label, never colour alone.
export function statusBadge(status) {
  if (!status) return '';
  return `<span class="status status-${status.level}"><span class="status-icon" aria-hidden="true">${STATUS_ICON[status.level]}</span>${esc(status.label)}</span>`;
}

// Five trend cards (readiness, HRV, resting HR, wellness, load) for one
// athlete's entries. `who` personalises the HRV caption.
export function renderTrends(container, entries, { who = 'your' } = {}) {
  const recent = entries.slice(-42);
  const dayIndex = (iso) => Math.round(new Date(`${iso}T12:00:00Z`) / 86400000);
  container.innerHTML = `
    <section class="card"><h3>Readiness</h3><div data-c="ready"></div></section>
    <section class="card"><h3>HRV (ln RMSSD)</h3><p class="muted small">Shaded band = ${esc(who)} normal range (mean ± 1 SD of recent readings).</p><div data-c="hrv"></div></section>
    <section class="card"><h3>Resting heart rate</h3><div data-c="hr"></div></section>
    <section class="card"><h3>Wellness</h3><div data-c="well"></div></section>
    <section class="card"><h3>Daily training load</h3><div data-c="load"></div></section>`;
  const $ = (k) => container.querySelector(`[data-c="${k}"]`);
  const series = (fn) => recent.map((e) => ({ x: dayIndex(e.date), y: fn(e), label: shortDate(e.date) }));

  requestAnimationFrame(() => {
    lineChart($('ready'), series((e) => assessDay(entries, e.date).score ?? NaN), { yMin: 0, yMax: 100 });
    const hrvBase = baseline(entries.map((e) => e.hrv?.lnRmssd));
    lineChart($('hrv'), series((e) => e.hrv?.lnRmssd ?? NaN), {
      yFormat: (v) => v.toFixed(1),
      band: hrvBase ? { lo: hrvBase.mean - hrvBase.sd, hi: hrvBase.mean + hrvBase.sd } : null,
      tip: (d) => `${d.label}: <b>${fmt(d.y, 2)}</b>`,
    });
    lineChart($('hr'), series((e) => e.hrv?.hr ?? NaN), { yFormat: (v) => `${Math.round(v)}`, tip: (d) => `${d.label}: <b>${fmt(d.y)} bpm</b>` });
    lineChart($('well'), series((e) => wellnessScore(e.wellness) ?? NaN), { yMin: 0, yMax: 100 });
    barChart($('load'), series((e) => sessionLoad(e.training)), { tip: (d) => `${d.label}: <b>${d.y} AU</b>` });
  });
}
