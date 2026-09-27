# Athlete Readiness

A phone web app that tracks an athlete's daily state from two sources:

1. **A short daily questionnaire** (~1 minute) — sleep, fatigue, soreness, stress, mood,
   motivation, pain/injury, illness symptoms, and the last 24 h of training (minutes × session RPE).
2. **Camera heart rate & HRV** — the rear camera and flashlight read the pulse through a fingertip
   (photoplethysmography, the same principle as a pulse oximeter), giving resting HR, RMSSD,
   ln RMSSD, SDNN and pNN50.

These are combined into a 0–100 **readiness score** with plain-language advice and flags
(short sleep, pain, illness, HRV below normal, elevated resting HR, training-load spikes).

No install, no account, no backend: it's an installable PWA and all data stays on the device
(export to CSV for a coach, or JSON for backup/restore).

## Using it

- **Today** — readiness score, breakdown, flags, training load.
- **Check-in** — the questionnaire. Past days can be edited from History.
- **HRV** — 1–3 minute camera measurement. Best done every morning right after waking, in the same
  position. Rest the hand on something, cover the lens *and* flash lightly with a fingertip, stay still.
  If you own a chest strap, you can type its HR/RMSSD in instead.
- **History** — trend charts (readiness, ln RMSSD with your normal band, resting HR, wellness,
  daily load), the entry table, export/import.

### How the score works

| Component | Weight | How |
|---|---|---|
| Wellness | 60 % | Six 1–5 scales + sleep hours, scaled 0–100 |
| HRV | 25 % | Today's ln RMSSD vs your personal baseline (mean ± SD of up to 30 prior readings; needs 5) |
| Resting HR | 15 % | Today's HR vs your baseline (higher = worse) |

Components without data are left out and the rest re-weighted, so the score works from day one
with the questionnaire alone. Illness symptoms or severe pain override the score with
"talk to your coach/medical staff". Acute:chronic workload ratio appears after 3 weeks of data.

This is training guidance, **not a medical device**.

## Camera HRV — what to expect

- **Android + Chrome**: full support, including automatic flashlight control.
- **iPhone (Safari and all iOS browsers)**: works, but Apple doesn't let web pages turn on the torch,
  so measure with a bright lamp or window shining through the fingertip. A native iOS wrapper
  would be needed for torch control.
- Camera choice is automatic (no selector): the app always uses the **telephoto** lens. On iPhone it is
  found by name; on Android, where lenses have generic names, it is recognised by its long minimum focus
  distance. The choice is remembered. If a phone has no telephoto (or doesn't expose one to the
  browser), the camera beside the flash is used instead. Some Android phones only allow the flashlight
  from the main camera, in which case measure next to a bright light.
- Accuracy: validated against synthetic signals (see tests) to within ~1 ms RMSSD at typical athlete
  HRV. At ~30 fps, very low HRV (RMSSD < ~15 ms) reads a few ms high due to frame-timing jitter.
  Movement is the main error source — the app rejects artifact beats and grades the signal
  good / fair / poor. A chest strap remains the gold standard.

### Signal pipeline (`src/signal.js`)

Per-frame mean red & green brightness → resample to 50 Hz → invert → zero-phase Butterworth
band-pass 0.7–3.5 Hz → autocorrelation for the dominant beat period → peak detection with
parabolic sub-sample refinement → inter-beat intervals → artifact rejection (out of 40–200 bpm, or
>25 % from local median) → HRV metrics from successive clean pairs only. Both channels are analysed
and the cleaner one is kept.

## Running it

Camera access requires HTTPS (or `localhost`).

```sh
npm start          # serves on http://localhost:8080
npm test           # unit tests (Node 20+, no dependencies)
```

To use it on a phone, deploy the folder to any static HTTPS host. The included workflow publishes
to **GitHub Pages** on every push to `main` — enable it once under
*Settings → Pages → Source: GitHub Actions*. Then open the URL on the phone and
"Add to Home Screen".

## Layout

```
index.html, styles.css, sw.js, manifest.webmanifest
src/signal.js     PPG processing (pure, tested)
src/readiness.js  questionnaire definition, scoring, baselines, workload (pure, tested)
src/camera.js     camera + torch capture, per-frame brightness
src/storage.js    localStorage, CSV/JSON export & import
src/charts.js     small SVG charts with tooltips
src/app.js        UI and routing
tests/            node:test suites
```
