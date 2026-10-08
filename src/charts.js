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

function frame(container, { data, height, yMin, yMax, yFormat, xLabel, band, zeroBased, xInset = 0 }) {
  container.innerHTML = '';
  container.classList.add('chart');
  const width = Math.max(260, container.clientWidth || 320);
  const ys = data.map((d) => d.y).filter(Number.isFinite);
  if (band) ys.push(band.lo, band.hi);
  let lo = yMin ?? Math.min(...ys);
  let hi = yMax ?? Math.max(...ys);
  if (zeroBased) lo = Math.min(0, lo);
  const ticks = niceTicks(lo, hi);
  lo = Math.min(lo, ticks[0]);
  hi = Math.max(hi, ticks[ticks.length - 1]);
  // Make room for the widest y-axis label (~6.5 px per character at 11 px).
  const widest = Math.max(...ticks.map((t) => yFormat(t).length));
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
  for (const t of ticks) {
    el('line', { x1: PAD.left, x2: width - PAD.right, y1: sy(t), y2: sy(t), class: 'grid' }, svg);
    const label = el('text', { x: PAD.left - 6, y: sy(t) + 4, class: 'tick', 'text-anchor': 'end' }, svg);
    label.textContent = yFormat(t);
  }
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
  const { svg, sx, sy, height } = frame(container, { ...o, data });
  const pts = data.map((d) => [sx(d.x), Number.isFinite(d.y) ? sy(d.y) : NaN]);
  // Break the line at missing values rather than bridging them.
  let path = '';
  let pen = false;
  for (const [x, y] of pts) {
    if (!Number.isFinite(y)) { pen = false; continue; }
    path += `${pen ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`;
    pen = true;
  }
  el('path', { d: path, class: 'series-line' }, svg);
  if (o.showDots && data.length <= 60) {
    for (const [x, y] of pts) if (Number.isFinite(y)) el('circle', { cx: x, cy: y, r: 3, class: 'series-dot' }, svg);
  }
  addTooltip(container, svg, data, pts, o.tip, PAD.top, height - PAD.bottom);
}

export function barChart(container, data, opts = {}) {
  const o = {
    height: 140, yFormat: (v) => String(v), xLabel: (d) => d.label, tip: (d) => `${d.label}: <b>${o.yFormat(d.y)}</b>`, ...opts,
  };
  if (!data.length) { container.innerHTML = '<p class="muted">No data yet.</p>'; return; }
  const { svg, sx, sy, iw } = frame(container, { ...o, data, zeroBased: true, xInset: 13 }); // half the widest bar
  const span = Math.max(1, data[data.length - 1].x - data[0].x + 1);
  const bw = Math.max(2, Math.min(24, iw / span - 2));
  const base = sy(0);
  const pts = [];
  for (const d of data) {
    const cx = sx(d.x);
    const top = sy(d.y || 0);
    const h = Math.max(0, base - top);
    if (h > 0) {
      // Rounded top, square base.
      const r = Math.min(4, bw / 2, h);
      const x0 = cx - bw / 2;
      el('path', {
        d: `M${x0},${base}V${top + r}Q${x0},${top} ${x0 + r},${top}H${x0 + bw - r}Q${x0 + bw},${top} ${x0 + bw},${top + r}V${base}Z`,
        class: 'series-bar',
      }, svg);
    }
    pts.push([cx, top]);
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
