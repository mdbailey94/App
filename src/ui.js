// Small UI helpers shared by the athlete screens and the coach dashboard.

import { assessDay, baseline, rollingMean, sessionLoad, wellnessScore } from './readiness.js';
import { barChart, lineChart } from './charts.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
export const fmt = (v, d = 0) => (Number.isFinite(v) ? v.toFixed(d) : '–');
export const prettyDate = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
export const shortDate = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

const STATUS_ICON = { good: '✓', warning: '!', serious: '▼', critical: '✕', note: 'i' };

// Status is always shown as icon + label, never colour alone.
export function statusBadge(status) {
  if (!status) return '';
  return `<span class="status status-${status.level}"><span class="status-icon" aria-hidden="true">${STATUS_ICON[status.level]}</span>${esc(status.label)}</span>`;
}

// Five trend cards (readiness, HRV, resting HR, wellness, load) for one
// athlete's entries. The athlete's own view (`athlete: true`) shows readiness
// from their answers only and 7-day averages for HRV and resting HR, so a
// single noisy morning doesn't stand out; the coach sees daily values.
export function renderTrends(container, entries, { who = 'your', athlete = false } = {}) {
  const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date));
  const hrvAvg = rollingMean(sorted, (e) => e.hrv?.lnRmssd);
  const hrAvg = rollingMean(sorted, (e) => e.hrv?.hr);
  const smooth = new Map(sorted.map((e, i) => [e.date, { hrv: hrvAvg[i], hr: hrAvg[i] }]));
  const recent = sorted.slice(-42);
  container.innerHTML = `
    <section class="card"><h3>Readiness</h3><div data-c="ready"></div></section>
    <section class="card"><h3>HRV (ms)${athlete ? ' – 7-day average' : ''}</h3><p class="muted small">${athlete
    ? 'Averaged over a week, because single readings vary a lot from day to day. Shaded band = your normal range.'
    : `Shaded band = ${esc(who)} normal range (mean ± 1 SD of recent readings).`}</p><div data-c="hrv"></div></section>
    <section class="card"><h3>Resting heart rate${athlete ? ' – 7-day average' : ''}</h3><div data-c="hr"></div></section>
    <section class="card"><h3>Wellness</h3><div data-c="well"></div></section>
    <section class="card"><h3>Daily training load</h3><div data-c="load"></div></section>`;
  const $ = (k) => container.querySelector(`[data-c="${k}"]`);
  const series = (fn) => recent.map((e) => ({ x: dayIndex(e.date), y: fn(e), label: shortDate(e.date) }));

  requestAnimationFrame(() => {
    lineChart($('ready'), series((e) => assessDay(sorted, e.date, { heart: !athlete }).score ?? NaN), { yMin: 0, yMax: 100 });
    // Shown in milliseconds. The normal band and the weekly average are worked
    // out on the log scale (day-to-day HRV is skewed), then converted back.
    const hrvBase = baseline(entries.map((e) => e.hrv?.lnRmssd));
    lineChart($('hrv'), series((e) => Math.exp(athlete ? smooth.get(e.date).hrv : e.hrv?.lnRmssd ?? NaN)), {
      yFormat: (v) => `${Math.round(v)}`,
      band: hrvBase ? { lo: Math.exp(hrvBase.mean - hrvBase.sd), hi: Math.exp(hrvBase.mean + hrvBase.sd) } : null,
      tip: (d) => `${d.label}: <b>${fmt(d.y)} ms</b>`,
    });
    lineChart($('hr'), series((e) => (athlete ? smooth.get(e.date).hr : e.hrv?.hr ?? NaN)), { yFormat: (v) => `${Math.round(v)}`, tip: (d) => `${d.label}: <b>${fmt(d.y)} bpm</b>` });
    lineChart($('well'), series((e) => wellnessScore(e.wellness) ?? NaN), { yMin: 0, yMax: 100 });
    barChart($('load'), series((e) => sessionLoad(e.training)), { tip: (d) => `${d.label}: <b>${d.y} AU</b>` });
  });
}

// Whole days since the epoch, for chart x-axes.
export const dayIndex = (iso) => Math.round(new Date(`${iso}T12:00:00Z`) / 86400000);

// Send text on: the share sheet on phones (when `share` is set and
// available), otherwise the clipboard, otherwise select `field` so it can be
// copied by hand. Resolves to 'shared', 'copied' or 'selected'.
export async function shareOrCopy(text, { share = false, field } = {}) {
  if (share && navigator.share) {
    try { await navigator.share({ text }); } catch { /* cancelled */ }
    return 'shared';
  }
  try {
    await navigator.clipboard.writeText(text);
    return 'copied';
  } catch {
    field?.select();
    return 'selected';
  }
}
