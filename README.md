# Athlete Readiness

A phone web app that tracks an athlete's daily state from two sources:

1. **A short daily questionnaire** (~1 minute) — sleep, fatigue, soreness, stress, mood,
   motivation, injury (kept separate from normal training soreness), and yesterday’s training (rest day or 1–5 h in half-hour steps × session RPE).
2. **Camera heart rate & HRV** — the rear camera and flashlight read the pulse through a fingertip
   (photoplethysmography, the same principle as a pulse oximeter), giving resting HR, RMSSD,
   ln RMSSD, SDNN and pNN50.

These are combined into a 0–100 **readiness score** with plain-language advice and flags
(short sleep, injury, HRV below normal, elevated resting HR, training-load spikes).

No install and no accounts: it's an installable PWA. Data stays on the device unless the athlete joins
a **practice group**, in which case each day's check-in is also sent to a Google Sheet the coach owns.

## Using it

- **Today** — one button: **Start my morning check-in**. Afterwards: a readiness score from the athlete's
  own answers, and ✓ for questions answered / heart reading saved.
- **Check-in (morning)** — the questions (about a minute), then straight on to the 1-minute heart
  reading on the HRV screen (or *Skip for today*). After their first reading, athletes can turn on
  **heart reading during check-in**: the reading then runs in a bar pinned at the top while they answer
  with their other hand; saving early waits for it to finish.
  A new day opens **pre-filled with the last check-in's answers** (not notes), so most mornings are a
  quick review before saving.
- **HRV** — a heart reading on its own (1–3 min), ending in "Reading saved ✓". Manual entry for chest
  straps.
- **Team** — athletes join their group (name + group code, usually via the coach's invite link); new and
  edited days are sent automatically and retried if offline. The coach opens the **coach dashboard** here.
- **History** — trend charts (readiness, ln RMSSD with your normal band, resting HR, wellness,
  daily load), the entry table, export/import.

### How the score works

| Component | Weight | How |
|---|---|---|
| Wellness | 60 % | Six 1–7 scales + sleep hours, scaled 0–100 |
| HRV | 25 % | Today's ln RMSSD vs your personal baseline (mean ± SD of up to 30 prior readings; needs 5) |
| Resting HR | 15 % | Today's HR vs your baseline (higher = worse) |

Components without data are left out and the rest re-weighted, so the score works from day one
with the questionnaire alone. A major injury (unable to perform certain strokes or movements) overrides the score with
"talk to your coach/medical staff". Acute:chronic workload ratio appears after 3 weeks of data.

This is training guidance, **not a medical device**.

### What athletes see about HRV

Single HRV readings swing a lot from day to day, so athletes aren't shown them: no numbers after a
reading, no HRV flags, and their readiness score uses their answers only. History shows **7-day
averages** of HRV and resting heart rate. The coach dashboard and group sheet get the full picture,
including each day's HRV and the score that combines everything.

## Camera HRV — what to expect

- **Android + Chrome**: full support, including automatic flashlight control.
- **iPhone (Safari and all iOS browsers)**: works, but Apple doesn't let web pages turn on the torch,
  so measure with a bright lamp or window shining through the fingertip. A native iOS wrapper
  would be needed for torch control.
- Camera choice is automatic (no selector): cover **both the flashlight and the camera closest to it** before tapping
  Start. Browsers don't reveal where lenses sit, so the app briefly looks through each rear camera and
  uses the one that sees a fingertip (smooth red glow or darkness) instead of the room. The lens is
  remembered and re-checked each time. If it can't tell (e.g. in a dark room), it uses the lens found
  last time, or the camera beside the flash. Some Android phones only allow the flashlight from the
  main camera; if the covered lens isn't that one, measure next to a bright light.
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

## Practice groups (coach setup)

The group's data lives in a Google Sheet the coach owns, via a small Apps Script
([`apps-script/Code.gs`](apps-script/Code.gs)). One-time setup (also shown in the app under Team → coach dashboard):

1. Create a Google Sheet, open **Extensions → Apps Script**, paste `Code.gs`.
2. Set `GROUP_CODE` (athletes type it) and `COACH_PASSWORD` (dashboard access) at the top. Save.
3. **Deploy → New deployment → Web app**, *Execute as: Me*, *Who has access: Anyone*. Authorize.
4. In the app, open Team → coach dashboard, paste the web app URL, password and group code.
5. Athletes scan the **QR code** on the dashboard (or you send them the invite link).

What the coach gets:

- **Coach dashboard**: per day, who checked in (worst readiness first, with flags for injury,
  short sleep, low HRV, elevated resting HR, load spikes), who hasn't, group averages, and each
  athlete's trends and notes.
- **Entries** tab: one row per athlete per day (readiness, status, flags, every answer, HR/HRV, notes),
  colour-coded. Editing a day updates its row. **Today** tab: today's check-ins, lowest readiness first.

Security notes: the web app URL plus group code allows sending data; reading it needs the coach
password. Data sits in the coach's Google account. Treat it as health data: tell athletes what is
shared (the app does), and use anonymous names if your organisation requires it. Text that looks like a
spreadsheet formula is stored as plain text.

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

### Hosting on Firebase instead (optional)

The same files can be published to Firebase Hosting (free Spark plan is plenty). The workflow's
`deploy-firebase` job turns on once the deploy key is saved in the GitHub repo:

1. **Firebase project**: console.firebase.google.com → *Add project* (Analytics not needed) → open
   *Build → Hosting → Get started* and click through (skip the CLI steps). Note the **project ID**.
2. **Deploy key**: Google Cloud console → *IAM & Admin → Service accounts* (same project) → *Create
   service account* `github-deploy` with roles **Firebase Hosting Admin**, **API Keys Viewer** and
   **Cloud Run Viewer** → *Keys → Add key → JSON*. Keep this file private.
3. **GitHub** → *Settings → Secrets and variables → Actions*:
   - *Secrets* → `FIREBASE_SERVICE_ACCOUNT` = the whole JSON file's contents (the project ID is read
     from it; a `FIREBASE_PROJECT_ID` variable overrides it if you ever need to)
4. *Actions → CI → Run workflow* (or merge any change). The app is then at
   `https://<project-id>.web.app`.

Data stored on phones is tied to the web address, so move hosts before athletes build up history
(anything already sent to the group sheet is unaffected).

## Layout

```
index.html, styles.css, sw.js, manifest.webmanifest
src/signal.js     PPG processing (pure, tested)
src/readiness.js  questionnaire definition, scoring, baselines, workload (pure, tested)
src/camera.js     camera + torch capture, per-frame brightness
src/storage.js    localStorage, CSV/JSON export & import
src/charts.js     small SVG charts with tooltips
src/team.js       sending entries to the group sheet (retries, invite links)
src/group.js      coach-side group summary (pure, tested)
src/coach.js      Team tab and coach dashboard
src/ui.js         shared UI helpers and trend charts
src/app.js        UI and routing
apps-script/      Google Apps Script for the group sheet (tested against a simulated Sheet)
tests/            node:test suites
```
