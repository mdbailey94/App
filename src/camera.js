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

const FRONT = /front|user|selfie|facetime/i;
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

const TELE = /tele/i; // "Back Telephoto Camera", "Teleobjektiv", …
const TELE_MIN_FOCUS_M = 0.25;

// Pick the telephoto lens from rear cameras ({ deviceId, label, minFocus }).
// Uses the lens name when the browser provides one (iPhone). Android names
// lenses generically, so there the telephoto is recognised as the lens that
// can't focus close: its minimum focus distance (metres) is far longer.
export function chooseTelephoto(cams) {
  const named = cams.find((c) => TELE.test(c.label || ''));
  if (named) return named.deviceId;
  const byFocus = cams.filter((c) => c.minFocus > 0).sort((a, b) => b.minFocus - a.minFocus);
  if (byFocus.length < 2) return null;
  const [far, next] = byFocus;
  return far.minFocus >= TELE_MIN_FOCUS_M && far.minFocus >= 1.5 * next.minFocus ? far.deviceId : null;
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

  // Open the telephoto lens. Returns false if the phone doesn't have (or the
  // browser doesn't expose) one. `preferredId` is the last telephoto found.
  async openTelephoto(preferredId) {
    if (preferredId) {
      try {
        await this.open(preferredId);
        return true;
      } catch { /* camera gone or renamed; search again */ }
    }
    await this.open(); // camera names are only visible after permission
    const rear = rankCameras(await listCameras());
    let pick = chooseTelephoto(rear);
    if (!pick && rear.length > 1) {
      const probed = [];
      for (const cam of rear.slice(0, 5)) {
        try {
          const track = await this.open(cam.deviceId);
          probed.push({ ...cam, minFocus: track.getCapabilities?.().focusDistance?.min });
        } catch { /* skip cameras that won't open */ }
      }
      pick = chooseTelephoto(probed);
    }
    if (!pick) return false;
    if (pick !== this.track?.getSettings?.().deviceId) await this.open(pick);
    return true;
  }

  // Fallback when there's no telephoto: find the rear camera that sits next to the flashlight. Browsers don't
  // expose lens positions, but the flashlight is controlled through the
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

  // Always prefers the telephoto lens; `telephotoId` is the one found last time.
  async start(telephotoId) {
    const telephoto = await this.openTelephoto(telephotoId);
    if (!telephoto) await this.openFlashCamera();
    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.playsInline = true;
    await this.video.play();
    this.torch = await this.setTorch(true);
    this.running = true;
    this.scheduleFrame();
    return { torch: this.torch, telephoto, label: this.track.label, deviceId: this.track.getSettings?.().deviceId };
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
