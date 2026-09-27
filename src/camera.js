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
  }

  async open(deviceId) {
    this.stream?.getTracks().forEach((t) => t.stop());
    const video = deviceId
      ? { deviceId: { exact: deviceId } }
      : { facingMode: { ideal: 'environment' } };
    Object.assign(video, { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } });
    this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    this.track = this.stream.getVideoTracks()[0];
    return this.track;
  }

  // Look through one camera briefly (flashlight on if it has one) and
  // summarise what it sees.
  async probe(deviceId) {
    await this.open(deviceId);
    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.playsInline = true;
    await this.video.play();
    await this.setTorch(true);
    await new Promise((r) => setTimeout(r, 700)); // let exposure settle
    const { videoWidth: w, videoHeight: h } = this.video;
    this.ctx.drawImage(this.video, 0, 0, w, h, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    return frameStats(this.ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data);
  }

  // Find the rear lens the fingertip is covering. Browsers don't reveal where
  // each lens sits, so rather than guess, check what each camera sees.
  // `rememberedId` (the lens found last time) is checked first.
  async findCoveredCamera(rememberedId) {
    if (rememberedId) {
      try {
        if (looksCovered(await this.probe(rememberedId))) return rememberedId;
      } catch { /* camera gone; search all */ }
    }
    if (!this.track) await this.open(); // camera names are only visible after permission
    const results = [];
    for (const cam of rankCameras(await listCameras()).slice(0, 6)) {
      try {
        results.push({ deviceId: cam.deviceId, stats: await this.probe(cam.deviceId) });
      } catch { /* skip cameras that won't open */ }
    }
    return pickCoveredCamera(results);
  }

  // Fallback when the covered lens can't be identified: the rear camera that
  // sits next to the flashlight. Browsers don't expose lens positions, but the flashlight is controlled through the
  // camera module beside it, so the camera reporting torch support is the
  // one to use.
  async openFlashCamera() {
    const first = await this.open();
    if (hasTorch(first) && !AVOID.test(first.label)) return;
    const firstId = first.getSettings?.().deviceId;
    // A flashlight camera with an unexpected label still beats one without.
    const torchFallback = hasTorch(first) ? firstId : null;

    // Labels are only available after permission, i.e. after the first open.
    const ranked = rankCameras(await listCameras());
    for (const cam of ranked.slice(0, 5)) {
      if (cam.deviceId === firstId) continue;
      try {
        const track = await this.open(cam.deviceId);
        if (hasTorch(track)) return;
      } catch { /* try the next one */ }
    }
    // No other camera offers flashlight control (e.g. iPhone browsers): use
    // the most likely main rear lens.
    const best = torchFallback || ranked[0]?.deviceId;
    if (best && best !== this.track?.getSettings?.().deviceId) await this.open(best);
  }

  // Uses the lens the fingertip is covering; `rememberedId` is the lens
  // found last time, used as the fallback if no covered lens is detected.
  async start(rememberedId) {
    const found = await this.findCoveredCamera(rememberedId);
    const fallback = found ? null : rememberedId;
    const target = found || fallback;
    if (target) {
      if (target !== this.track?.getSettings?.().deviceId) {
        try { await this.open(target); } catch { await this.openFlashCamera(); }
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
    if (this.torch) await this.setTorch(false);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.video.srcObject = null;
    this.stream = null;
    this.track = null;
    this.torch = false;
  }
}
