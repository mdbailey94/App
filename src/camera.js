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

  async start(deviceId) {
    const video = deviceId
      ? { deviceId: { exact: deviceId } }
      : { facingMode: { ideal: 'environment' } };
    Object.assign(video, { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 } });
    this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    this.track = this.stream.getVideoTracks()[0];
    this.video.srcObject = this.stream;
    this.video.muted = true;
    this.video.playsInline = true;
    await this.video.play();
    this.torch = await this.setTorch(true);
    this.running = true;
    this.scheduleFrame();
    return { torch: this.torch, label: this.track.label, settings: this.track.getSettings?.() };
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
