// Tiny dependency-free SVG charts: a line chart and a bar chart, each with a
// hover/touch tooltip. Colours come from CSS custom properties so light and
// dark themes are handled in styles.css.

const NS = 'http://www.w3.org/2000/svg';
const BASE_PAD = { top: 12, right: 12, bottom: 22, left: 40 };
let PAD = BASE_PAD;

function el(name, attrs = {}, parent) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  parent?.appendChild(node);
  return node;
}

function niceTicks(lo, hi, count = 4) {
  if (lo === hi) { lo -= 1; hi += 1; }
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const start = Math.floor(lo / step) * step;
  const ticks = [];
  for (let v = start; v <= hi + step * 0.5; v += step) ticks.push(+v.toFixed(10));
  return ticks;
}

function frame(container, { data, height, yMin, yMax, yFormat, xLabel, band, zeroBased, xInset = 0, minSpan = 0 }) {
  container.innerHTML = '';
  container.classList.add('chart');
  const width = Math.max(260, container.clientWidth || 320);
  const ys = data.map((d) => d.y).filter(Number.isFinite);
  if (band) ys.push(band.lo, band.hi);
  let lo = yMin ?? Math.min(...ys);
  let hi = yMax ?? Math.max(...ys);
  if (zeroBased) { lo = Math.min(0, lo); hi = Math.max(0, hi); }
  // All but identical values (a flat week): give the axis a unit either side
  // rather than ticks a millionth apart.
  if (hi - lo < Math.max(1e-9, Math.abs(hi) * 1e-6)) { lo -= 1; hi += 1; }
  // A measure that barely moves (resting HR within a beat) gets at least
  // `minSpan` of axis, so small wobbles don't look like big swings.
  if (hi - lo < minSpan) { const mid = (hi + lo) / 2; lo = mid - minSpan / 2; hi = mid + minSpan / 2; }
  const ticks = niceTicks(lo, hi);
  lo = Math.min(lo, ticks[0]);
  hi = Math.max(hi, ticks[ticks.length - 1]);
  // A formatter that rounds can print the same label twice on a tight axis
  // (flat HRV, say); then show one decimal, and never the same label twice.
  const labels = ticks.map(yFormat);
  if (new Set(labels).size < labels.length) {
    const fine = (t) => String(+t.toFixed(2));
    const seen = new Set();
    ticks.forEach((t, i) => { const l = fine(t); labels[i] = seen.has(l) ? '' : l; seen.add(l); });
  }
  // Make room for the widest y-axis label (~6.5 px per character at 11 px).
  const widest = Math.max(...labels.map((l) => l.length));
  PAD = { ...BASE_PAD, left: Math.max(28, Math.ceil(widest * 6.5) + 10) };

  const xs = data.map((d) => d.x);
  const xLo = Math.min(...xs);
  const xHi = Math.max(...xs);
  const iw = width - PAD.left - PAD.right;
  const ih = height - PAD.top - PAD.bottom;
  // xInset keeps the first and last bars clear of the axis labels.
  const sx = (x) => PAD.left + xInset + (xHi === xLo ? (iw - 2 * xInset) / 2 : ((x - xLo) / (xHi - xLo)) * (iw - 2 * xInset));
  const sy = (y) => PAD.top + ih - ((y - lo) / (hi - lo)) * ih;

  const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'img' }, container);
  ticks.forEach((t, i) => {
    el('line', { x1: PAD.left, x2: width - PAD.right, y1: sy(t), y2: sy(t), class: 'grid' }, svg);
    const label = el('text', { x: PAD.left - 6, y: sy(t) + 4, class: 'tick', 'text-anchor': 'end' }, svg);
    label.textContent = labels[i];
  });
  if (band) {
    el('rect', {
      x: PAD.left, width: iw, y: sy(band.hi), height: Math.max(1, sy(band.lo) - sy(band.hi)), class: 'band',
    }, svg);
  }
  if (data.length) {
    const first = el('text', { x: PAD.left, y: height - 6, class: 'tick' }, svg);
    first.textContent = xLabel(data[0]);
    if (data.length > 1) {
      const last = el('text', { x: width - PAD.right, y: height - 6, class: 'tick', 'text-anchor': 'end' }, svg);
      last.textContent = xLabel(data[data.length - 1]);
    }
  }
  return { svg, sx, sy, width, height, iw, ih };
}

function addTooltip(container, svg, data, points, tipText, guideTop, guideBottom) {
  const tip = document.createElement('div');
  tip.className = 'chart-tip';
  tip.hidden = true;
  container.appendChild(tip);
  const guide = el('line', { class: 'guide', y1: guideTop, y2: guideBottom, visibility: 'hidden' }, svg);
  const dot = el('circle', { r: 5, class: 'hover-dot', visibility: 'hidden' }, svg);

  const show = (evt) => {
    const rect = svg.getBoundingClientRect();
    const scale = svg.viewBox.baseVal.width / rect.width;
    const x = (evt.clientX - rect.left) * scale;
    let best = 0;
    for (let i = 1; i < points.length; i++) {
      if (Math.abs(points[i][0] - x) < Math.abs(points[best][0] - x)) best = i;
    }
    const [px, py] = points[best];
    guide.setAttribute('x1', px); guide.setAttribute('x2', px);
    guide.setAttribute('visibility', 'visible');
    if (Number.isFinite(py)) {
      dot.setAttribute('cx', px); dot.setAttribute('cy', py);
      dot.setAttribute('visibility', 'visible');
    }
    tip.innerHTML = tipText(data[best]);
    tip.hidden = false;
    const left = px / scale;
    tip.style.left = `${Math.min(Math.max(left, 60), rect.width - 60)}px`;
  };
  const hide = () => {
    tip.hidden = true;
    guide.setAttribute('visibility', 'hidden');
    dot.setAttribute('visibility', 'hidden');
  };
  svg.addEventListener('pointermove', show);
  svg.addEventListener('pointerdown', show);
  svg.addEventListener('pointerleave', hide);
}

// data: [{ x:number, y:number, label:string }]
export function lineChart(container, data, opts = {}) {
  const o = {
    height: 160, yFormat: (v) => String(v), xLabel: (d) => d.label, tip: (d) => `${d.label}: <b>${o.yFormat(d.y)}</b>`,
    showDots: true, ...opts,
  };
  if (!data.some((d) => Number.isFinite(d.y))) { container.innerHTML = '<p class="muted small">Not enough readings yet.</p>'; return; }
  // `y2` (optional): a second series on the same scale, drawn dashed
  // behind the first (e.g. the team average under one swimmer).
  const both = data.some((d) => Number.isFinite(d.y2));
  const { svg, sx, sy, height } = frame(container, { ...o, data: both ? data.concat(data.map((d) => ({ ...d, y: d.y2 }))) : data });
  if (both) drawLine(svg, data.map((d) => [sx(d.x), Number.isFinite(d.y2) ? sy(d.y2) : NaN]), o.showDots && data.length <= 60, 'series-line alt');
  // Break the line at missing values rather than bridging them.
  const pts = data.map((d) => [sx(d.x), Number.isFinite(d.y) ? sy(d.y) : NaN]);
  drawLine(svg, pts, o.showDots && data.length <= 60);
  addTooltip(container, svg, data, pts, o.tip, PAD.top, height - PAD.bottom);
}

// Bar slots across the axis: one per step between points (a day, or a week
// for a one-weekday chart), so weekly bars are as wide as daily ones.
const slotsOf = (xs) => {
  const sorted = [...xs].sort((a, b) => a - b);
  let step = Infinity;
  for (let i = 1; i < sorted.length; i++) if (sorted[i] > sorted[i - 1]) step = Math.min(step, sorted[i] - sorted[i - 1]);
  if (!Number.isFinite(step)) step = 1;
  return Math.max(1, Math.round((sorted[sorted.length - 1] - sorted[0]) / step) + 1);
};

export function barChart(container, data, opts = {}) {
  const o = {
    height: 140, yFormat: (v) => String(v), xLabel: (d) => d.label, tip: (d) => `${d.label}: <b>${o.yFormat(d.y)}</b>`, ...opts,
  };
  if (!data.length) { container.innerHTML = '<p class="muted">No data yet.</p>'; return; }
  const { svg, sx, sy, iw } = frame(container, { ...o, data, zeroBased: true, xInset: 13 }); // half the widest bar
  const bw = Math.max(2, Math.min(24, iw / slotsOf(data.map((d) => d.x)) - 2));
  const base = sy(0);
  // `signed`: values either side of zero (e.g. above/below usual), with a
  // zero line and up / down colours.
  if (o.signed) el('line', { x1: PAD.left, x2: sx(data[data.length - 1].x) + 13, y1: base, y2: base, class: 'zero' }, svg);
  const pts = [];
  for (const d of data) {
    const cx = sx(d.x);
    const end = sy(Number.isFinite(d.y) ? d.y : 0);
    const h = Math.abs(base - end);
    if (h > 0) {
      // Rounded at the value end, square at zero: up from the baseline for
      // positive values, down from it for negative ones.
      const r = Math.min(4, bw / 2, h);
      const x0 = cx - bw / 2;
      const dir = end < base ? 1 : -1; // 1 = bar goes up
      el('path', {
        d: `M${x0},${base}V${end + dir * r}Q${x0},${end} ${x0 + r},${end}H${x0 + bw - r}Q${x0 + bw},${end} ${x0 + bw},${end + dir * r}V${base}Z`,
        class: `series-bar${o.signed ? (dir > 0 ? ' pos' : ' neg') : ''}`,
      }, svg);
    }
    pts.push([cx, end]);
  }
  addTooltip(container, svg, data, pts, o.tip, PAD.top, base);
}

// Live scrolling waveform on a <canvas>, used while measuring.
export function drawWaveform(canvas, values, peaks = []) {
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  if (values.length < 2) return;
  let lo = Infinity, hi = -Infinity;
  for (const v of values) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const range = hi - lo || 1;
  const style = getComputedStyle(canvas);
  ctx.strokeStyle = style.getPropertyValue('--series-1').trim() || '#2a78d6';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  values.forEach((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h - 6 - ((v - lo) / range) * (h - 12);
    if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
  });
  ctx.stroke();
  ctx.fillStyle = ctx.strokeStyle;
  for (const i of peaks) {
    const x = (i / (values.length - 1)) * w;
    const y = h - 6 - ((values[Math.round(i)] - lo) / range) * (h - 12);
    ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
  }
}

// Two panels on one shared day axis, for reading one measure against
// another without two scales on one plot (e.g. readiness on top, the day
// before's load below), each day's values in line. One crosshair and
// tooltip cover both.
// data: [{ x, label, top: number|NaN|null, bottom: number|NaN|null }]
// top / bottom: { kind: 'line' | 'bar' | 'signed', min, max, title }
export function pairChart(container, data, opts = {}) {
  const o = { panelHeight: 110, gap: 30, tip: (d) => d.label, ...opts };
  const panels = [{ ...o.top, key: 'top' }, { ...o.bottom, key: 'bottom' }];
  container.innerHTML = '';
  container.classList.add('chart');
  const has = (p) => data.some((d) => Number.isFinite(d[p.key]) && (p.kind === 'line' || d[p.key] !== 0));
  if (!data.length || !panels.some(has)) {
    container.innerHTML = '<p class="muted small">Not enough data yet.</p>';
    return;
  }
  // Each panel's scale: its fixed range, else from the data (bars from 0,
  // signed bars symmetric around 0).
  for (const p of panels) {
    const vals = data.map((d) => d[p.key]).filter(Number.isFinite);
    let lo = p.min ?? (vals.length ? Math.min(...vals) : 0);
    let hi = p.max ?? (vals.length ? Math.max(...vals) : 1);
    if (p.kind === 'bar') lo = Math.min(0, lo);
    if (p.kind === 'signed') { const r = Math.max(1, ...vals.map(Math.abs)); lo = -r; hi = r; }
    if (p.kind === 'line' && p.min === undefined && p.max === undefined) { const pad = Math.max(1, (hi - lo) * 0.15); lo -= pad; hi += pad; }
    p.ticks = niceTicks(lo, hi, 3);
    p.lo = Math.min(lo, p.ticks[0]);
    p.hi = Math.max(hi, p.ticks.at(-1));
  }
  const fmtTick = (t) => String(+t.toFixed(2));
  const width = Math.max(260, container.clientWidth || 320);
  const widest = Math.max(...panels.flatMap((p) => p.ticks.map((t) => fmtTick(t).length)));
  const pad = { top: 16, right: 12, bottom: 22, left: Math.max(28, Math.ceil(widest * 6.5) + 10) };
  const height = pad.top + 2 * o.panelHeight + o.gap + pad.bottom;
  const iw = width - pad.left - pad.right;
  const inset = 13;
  const xs = data.map((d) => d.x);
  const xLo = Math.min(...xs);
  const xHi = Math.max(...xs);
  const sx = (x) => pad.left + inset + (xHi === xLo ? (iw - 2 * inset) / 2 : ((x - xLo) / (xHi - xLo)) * (iw - 2 * inset));
  panels[0].y0 = pad.top;
  panels[1].y0 = pad.top + o.panelHeight + o.gap;
  for (const p of panels) p.sy = (v) => p.y0 + o.panelHeight - ((v - p.lo) / (p.hi - p.lo)) * o.panelHeight;

  const svg = el('svg', { viewBox: `0 0 ${width} ${height}`, width, height, role: 'img', 'aria-label': `${panels[0].title} and ${panels[1].title}` }, container);
  const bw = Math.max(2, Math.min(24, iw / slotsOf(xs) - 2));
  let pts = null;
  for (const p of panels) {
    for (const t of p.ticks) {
      el('line', { x1: pad.left, x2: width - pad.right, y1: p.sy(t), y2: p.sy(t), class: t === 0 && p.kind === 'signed' ? 'zero' : 'grid' }, svg);
      el('text', { x: pad.left - 6, y: p.sy(t) + 4, class: 'tick', 'text-anchor': 'end' }, svg).textContent = fmtTick(t);
    }
    el('text', { x: pad.left, y: p.y0 - 5, class: 'panel-title' }, svg).textContent = p.title;
    if (p.kind === 'line') {
      const line = data.map((d) => [sx(d.x), Number.isFinite(d[p.key]) ? p.sy(d[p.key]) : NaN]);
      drawLine(svg, line, data.length <= 60);
      pts ||= line;
    } else {
      const base = p.sy(0);
      for (const d of data) {
        const v = d[p.key];
        if (!Number.isFinite(v) || v === 0) continue;
        const end = p.sy(v);
        const dir = end < base ? 1 : -1;
        const r = Math.min(4, bw / 2, Math.abs(base - end));
        const x0 = sx(d.x) - bw / 2;
        el('path', {
          d: `M${x0},${base}V${end + dir * r}Q${x0},${end} ${x0 + r},${end}H${x0 + bw - r}Q${x0 + bw},${end} ${x0 + bw},${end + dir * r}V${base}Z`,
          class: `series-bar${p.key === 'bottom' && p.kind === 'bar' ? ' muted-bar' : ''}${p.kind === 'signed' ? (dir > 0 ? ' pos' : ' neg') : ''}`,
        }, svg);
      }
    }
  }
  el('text', { x: pad.left, y: height - 6, class: 'tick' }, svg).textContent = data[0].label;
  if (data.length > 1) el('text', { x: width - pad.right, y: height - 6, class: 'tick', 'text-anchor': 'end' }, svg).textContent = data.at(-1).label;
  pts ||= data.map((d) => [sx(d.x), NaN]);
  addTooltip(container, svg, data, pts, o.tip, pad.top, height - pad.bottom);
}

// A line broken where a value is missing, with dots.
function drawLine(svg, pts, dots, cls = 'series-line') {
  let path = '';
  let pen = false;
  for (const [x, y] of pts) {
    if (!Number.isFinite(y)) { pen = false; continue; }
    path += `${pen ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
    pen = true;
  }
  el('path', { d: path, class: cls }, svg);
  if (dots) for (const [x, y] of pts) if (Number.isFinite(y)) el('circle', { cx: x, cy: y, r: 3, class: cls === 'series-line' ? 'series-dot' : 'series-dot alt' }, svg);
}

// A small trend line for a table cell, as SVG markup; gaps where a value is
// missing. scale: { lo, hi } (signed measures: ±hi).
export function sparkline(values, { M, lo, hi }, { width = 72, height = 22 } = {}) {
  const [a, b] = M?.kind === 'signed' ? [-hi, hi] : [lo, hi];
  const x = (i) => (values.length > 1 ? 2 + (i / (values.length - 1)) * (width - 4) : width / 2);
  const y = (v) => 2 + (height - 4) * (1 - (b > a ? (Math.min(b, Math.max(a, v)) - a) / (b - a) : 0.5));
  let path = '';
  let pen = false;
  values.forEach((v, i) => {
    if (v === null || v === undefined) { pen = false; return; }
    path += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  });
  const lastI = values.map((v, i) => (v === null || v === undefined ? -1 : i)).filter((i) => i >= 0).at(-1);
  if (lastI === undefined) return '<span class="muted">–</span>';
  return `<svg class="spark" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-hidden="true"><path d="${path}"/><circle cx="${x(lastI).toFixed(1)}" cy="${y(values[lastI]).toFixed(1)}" r="2"/></svg>`;
}
