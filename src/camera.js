// Camera + flashlight capture for fingertip PPG.
//
// Each video frame is shrunk onto a tiny canvas and averaged per colour
// channel; the resulting brightness series is what signal.js analyses.

const SAMPLE_SIZE = 40; // px, centre crop is averaged at this resolution

export async function listCameras() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'videoinput');
}

const FRONT = /front|selfie|facetime|facing user/i;
const BACK = /back|rear|environment/i;
// Secondary lenses sit away from the flash; iPhone "Dual"/"Triple" cameras
// are virtual devices that can switch lenses mid-reading.
const AVOID = /ultra|tele|macro|depth|dual|triple|zoom|periscope/i;
// iPhone multi-lens cameras are virtual: they switch lenses on their own, so
// they are never "the lens under the finger".
const VIRTUAL = /dual|triple/i;

const PROBE_TIMEOUT_MS = 2500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Reject if `promise` takes longer than `ms`; `onTimeout` cleans up.
function withTimeout(promise, ms, onTimeout) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => { onTimeout?.(); reject(new Error('Camera took too long to start.')); }, ms);
    }),
  ]);
}

// Order rear cameras by how likely they are to be the main lens beside the
// flash. Pure, so it can be tested without a browser.
export function rankCameras(devices) {
  const score = (d) => {
    const label = d.label || '';
    let s = 0;
    if (BACK.test(label)) s += 10;
    if (AVOID.test(label)) s -= 5;
    // Android Chrome labels read "camera2 0, facing back"; 0 is the main sensor.
    const idx = label.match(/camera2?\s*(\d+)/i);
    if (idx) s -= Number(idx[1]) * 0.1;
    return s;
  };
  // Copy fields explicitly: MediaDeviceInfo keeps them on its prototype, so
  // object spread would silently drop them.
  return devices
    .filter((d) => !FRONT.test(d.label || ''))
    .map((d) => ({ deviceId: d.deviceId, label: d.label, score: score(d) }))
    .sort((a, b) => b.score - a.score);
}

// Per-frame summary: mean colour plus how textured the picture is (standard
// deviation of brightness across the frame).
export function frameStats(px) {
  let r = 0, g = 0, b = 0, sum = 0, sumSq = 0;
  const n = px.length / 4;
  for (let i = 0; i < px.length; i += 4) {
    r += px[i]; g += px[i + 1]; b += px[i + 2];
    const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
    sum += lum; sumSq += lum * lum;
  }
  const mean = sum / n;
  return { r: r / n, g: g / n, b: b / n, lum: mean, texture: Math.sqrt(Math.max(0, sumSq / n - mean * mean)) };
}

const isRedGlow = (s) => s.r > 60 && s.r > 1.5 * s.g && s.r > 1.5 * s.b;

// A lens covered by a fingertip sees a smooth red glow (lit) or near-black
// (unlit) instead of the detail of a room.
export function looksCovered(s) {
  return s.texture < 18 && (isRedGlow(s) || s.lum < 30);
}

// Lit fingertip: unmistakable, so the search can stop at this lens.
export function clearlyCovered(s) {
  return looksCovered(s) && isRedGlow(s);
}

// Given [{ deviceId, stats }] for each rear camera, return the one the
// finger is covering, or null if it can't be told apart (e.g. dark room).
export function pickCoveredCamera(results) {
  const covered = results.filter((x) => looksCovered(x.stats));
  if (covered.length === 1) return covered[0].deviceId;
  const glowing = covered.filter((x) => isRedGlow(x.stats));
  return glowing.length === 1 ? glowing[0].deviceId : null;
}

function hasTorch(track) {
  return Boolean(track?.getCapabilities?.().torch);
}

export function cameraSupported() {
  return Boolean(navigator.mediaDevices?.getUserMedia) && window.isSecureContext;
}

export class PpgCamera {
  constructor(video) {
    this.video = video;
    this.canvas = document.createElement('canvas');
    this.canvas.width = SAMPLE_SIZE;
    this.canvas.height = SAMPLE_SIZE;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.stream = null;
    this.track = null;
    this.torch = false;
    this.running = false;
    this.onSample = null;
    this.lastMediaTime = -1;
    this.lastT = -Infinity;
    this.openToken = 0;
  }

  releaseStream() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.track = null;
  }

  async open(deviceId) {
    const hadStream = Boolean(this.stream);
    this.releaseStream();
    // Phones often refuse a camera requested the instant another closed.
    if (hadStream) await sleep(150);
    const token = ++this.openToken;
    const video = deviceId
      ? { deviceId: { exact: deviceId } }
      : { facingMode: { ideal: 'environment' } };
    Object.assign(video, { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } });
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    } catch (err) {
      if (err.name === 'NotAllowedError' || token !== this.openToken) throw err;
      await sleep(400); // camera still busy: one retry
      stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    }
    // A timed-out attempt that finishes late must not leave a camera running.
    if (token !== this.openToken) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error('Camera request was cancelled.');
    }
    this.stream = stream;
    this.track = stream.getVideoTracks()[0];
    return this.track;
  }

  // Abandon whatever camera request is in flight.
  cancelOpen() {
    this.openToken++;
    this.releaseStream();
  }

  // Look through one camera briefly (flashlight on if it has one) and
  // summarise what it sees once the picture has settled.
  async probe(deviceId) {
    await this.open(deviceId);
    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.playsInline = true;
    await this.video.play();
    await this.setTorch(true);
    const read = () => {
      const { videoWidth: w, videoHeight: h } = this.video;
      if (!w || !h) return null;
      this.ctx.drawImage(this.video, 0, 0, w, h, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
      return frameStats(this.ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data);
    };
    await sleep(300);
    let stats = read();
    // Auto-exposure settles quickly; stop once brightness stops changing.
    for (let waited = 300; waited < 1200; waited += 150) {
      await sleep(150);
      const next = read();
      if (stats && next && Math.abs(next.lum - stats.lum) < 4) return next;
      stats = next;
    }
    if (!stats) throw new Error('Camera showed no picture.');
    return stats;
  }

  // probe() with a time limit, so one stuck camera can't stall the search.
  probeWithin(deviceId) {
    return withTimeout(this.probe(deviceId), PROBE_TIMEOUT_MS, () => this.cancelOpen());
  }

  // Find the rear lens the fingertip is covering. Browsers don't reveal where
  // each lens sits, so rather than guess, check what each camera sees.
  // `rememberedId` (the lens found last time) is checked first; the search
  // stops as soon as a lens clearly shows a fingertip.
  async findCoveredCamera(rememberedId, onProgress) {
    if (rememberedId) {
      try {
        if (looksCovered(await this.probeWithin(rememberedId))) return rememberedId;
      } catch { /* camera gone or busy; search */ }
    }
    const results = [];
    // The default rear camera first: it also unlocks camera names, and is
    // often the right lens.
    let firstId = null;
    try {
      onProgress?.(1, null);
      const stats = await this.probeWithin(undefined);
      firstId = this.track?.getSettings?.().deviceId ?? null;
      if (firstId && !VIRTUAL.test(this.track.label)) {
        if (clearlyCovered(stats)) return firstId;
        results.push({ deviceId: firstId, stats });
      }
    } catch (err) {
      if (err.name === 'NotAllowedError') throw err;
    }
    const others = rankCameras(await listCameras())
      .filter((c) => c.deviceId !== firstId && !VIRTUAL.test(c.label || ''))
      .slice(0, 5);
    for (let i = 0; i < others.length; i++) {
      onProgress?.(i + 2, others.length + 1);
      try {
        const stats = await this.probeWithin(others[i].deviceId);
        if (clearlyCovered(stats)) return others[i].deviceId;
        results.push({ deviceId: others[i].deviceId, stats });
      } catch { /* skip cameras that won't open in time */ }
    }
    return pickCoveredCamera(results);
  }

  // Fallback when the covered lens can't be identified: the rear camera that
  // sits next to the flashlight. Browsers don't expose lens positions, but the flashlight is controlled through the
  // camera module beside it, so the camera reporting torch support is the
  // one to use.
  async openFlashCamera() {
    const openWithin = (id) => withTimeout(this.open(id), PROBE_TIMEOUT_MS, () => this.cancelOpen());
    const first = await openWithin();
    if (hasTorch(first) && !AVOID.test(first.label)) return;
    const firstId = first.getSettings?.().deviceId;
    // A flashlight camera with an unexpected label still beats one without.
    const torchFallback = hasTorch(first) ? firstId : null;

    // Labels are only available after permission, i.e. after the first open.
    const ranked = rankCameras(await listCameras());
    for (const cam of ranked.filter((c) => !VIRTUAL.test(c.label || '')).slice(0, 5)) {
      if (cam.deviceId === firstId) continue;
      try {
        const track = await openWithin(cam.deviceId);
        if (hasTorch(track)) return;
      } catch { /* try the next one */ }
    }
    // No other camera offers flashlight control (e.g. iPhone browsers): use
    // the most likely main rear lens.
    const best = torchFallback || ranked.find((c) => !VIRTUAL.test(c.label || ''))?.deviceId || ranked[0]?.deviceId;
    if (best && best !== this.track?.getSettings?.().deviceId) await openWithin(best);
    if (!this.track) await openWithin();
  }

  // Uses the lens the fingertip is covering; `rememberedId` is the lens
  // found last time, used as the fallback if no covered lens is detected.
  async start(rememberedId, onProgress) {
    const found = await this.findCoveredCamera(rememberedId, onProgress);
    const fallback = found ? null : rememberedId;
    const target = found || fallback;
    if (target) {
      if (!this.track || target !== this.track.getSettings?.().deviceId) {
        try {
          await withTimeout(this.open(target), PROBE_TIMEOUT_MS, () => this.cancelOpen());
        } catch {
          await this.openFlashCamera();
        }
      }
    } else {
      await this.openFlashCamera();
    }
    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.playsInline = true;
    await this.video.play();
    this.torch = await this.setTorch(true);
    this.running = true;
    this.scheduleFrame();
    return { torch: this.torch, identified: Boolean(found), label: this.track.label, deviceId: this.track.getSettings?.().deviceId };
  }

  async setTorch(on) {
    const caps = this.track?.getCapabilities?.() || {};
    if (!caps.torch) return false;
    try {
      await this.track.applyConstraints({ advanced: [{ torch: on }] });
      return on;
    } catch {
      return false;
    }
  }

  scheduleFrame() {
    if (!this.running) return;
    if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) {
      this.video.requestVideoFrameCallback((now, meta) => {
        // Prefer the sensor capture time, then the presentation timestamp:
        // both are more accurate than when JS happens to run.
        let t = Number.isFinite(meta.captureTime) ? meta.captureTime : meta.mediaTime * 1000;
        if (!Number.isFinite(t)) t = now;
        if (t > this.lastT) { // skip duplicate frames
          this.lastT = t;
          this.handleFrame(t);
        }
        this.scheduleFrame();
      });
    } else {
      requestAnimationFrame(() => {
        const t = this.video.currentTime;
        if (t !== this.lastMediaTime) {
          this.lastMediaTime = t;
          this.handleFrame(performance.now());
        }
        this.scheduleFrame();
      });
    }
  }

  handleFrame(t) {
    const { videoWidth: w, videoHeight: h } = this.video;
    if (!w || !h) return;
    const side = Math.min(w, h) * 0.6;
    this.ctx.drawImage(this.video, (w - side) / 2, (h - side) / 2, side, side, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    const px = this.ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < px.length; i += 4) { r += px[i]; g += px[i + 1]; b += px[i + 2]; }
    const n = px.length / 4;
    this.onSample?.({ t, r: r / n, g: g / n, b: b / n });
  }

  async stop() {
    this.running = false;
    this.openToken++; // abandon any camera request still in flight
    if (this.torch) await this.setTorch(false);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.video.srcObject = null;
    this.stream = null;
    this.track = null;
    this.torch = false;
  }
}
