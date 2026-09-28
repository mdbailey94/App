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
- **Check-in (morning)** — the heart reading runs in a bar pinned at the top while the athlete answers
  the questions with their other hand (about a minute in total). Saving early waits for the reading to
  finish; if the reading fails they can retry or save the answers without it.
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
| Wellness | 60 % | Six 1–5 scales + sleep hours, scaled 0–100 |
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

## Pool Tracker (`pool/`)

A second app in the same repo, for the coach on deck: one phone or tablet watching the pool gives
**split times, stroke rate and stroke count for every lane**. Open it at `…/pool/` (or from Team → Pool tracker).

1. **Camera up high at one end of the pool** (stand, balcony, tall tripod), both walls and every lane in view, kept still.
   A recorded video file works too.
2. **Line up the pool**: drag four dots onto the corners of the water (start wall ×2, turn wall ×2), set the pool
   length (m or yd), lanes in view and first lane number. Untick empty lanes, name swimmers, and optionally set the
   stroke or up to 4 swimmers per lane (circle swimming).
3. **Start tracking** before swimmers push off: it learns the empty water for 4 s. *Start race clock* times the first
   length from the start signal; otherwise it's estimated from the push-off.
4. **Finish** saves the session on the device; results export as CSV.

What each lane shows: current length and time, live stroke rate, and a table of lengths (split wall-to-wall,
running total, strokes, stroke rate) with pace per 100.

### How it works

- **Top-down grid** (`grid.js`): the four corners give a homography (`homography.js`), so every frame is sampled
  into cells of 0.25 m along each lane × 6 across, in metres rather than pixels. A per-cell background (median of
  the first 4 s, then a slow approximate median) with its normal flicker learns what water looks like; cells that
  differ in two frames running are "swimmer or splash" (one-frame sun sparkles are dropped).
- **Tracking** (`tracker.js`): per lane, strong stretches of foreground are swimmers; each is followed with an
  alpha-beta filter. Out-of-sight swimmers (underwater glide) coast at their last speed and bounce off walls; two
  swimmers passing in a lane both coast through the overlap so they don't swap.
- **Walls and lengths** (`laps.js`): a length ends when the swimmer reaches a wall and comes back (turn) or stays
  (finish, >3 s). The touch time is the first moment at the wall, corrected for approach speed; the same rule at
  every wall keeps split times consistent.
- **Strokes** (`strokes.js`): each hand entry throws up splash, so splash energy around the swimmer pulses once per
  arm stroke; autocorrelation gives the period. In free/back the splash also swaps sides every stroke, which tells
  alternating strokes (Free/Back) from simultaneous ones (Fly/Breast) and so turns pulses into **cycles per minute**.
  Stroke count = hand entries (free/back) or cycles (fly/breast) from breakout to touch.

Tested end to end on a synthetic pool video (perspective, ripples, glare, lane ropes, glides, turns, splashes):
splits within ~0.3 s, stroke rate within ~1 cycle/min, stroke count ±1–2, in 25 m and 50 m pools, 15–30 fps, and two
swimmers sharing a lane. Real footage adds things the simulator can't (people on deck, heavy waves, camera shake),
so check a session against a stopwatch before relying on it. Limits: freestyle vs backstroke (and fly vs breast)
can't be told apart automatically; set the stroke per lane for exact labels. Keep crowded lanes to 1–2 swimmers
for reliable identities.

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
pool/             Pool Tracker: camera lap & stroke timing (src/ modules are pure and tested, except app/capture)
apps-script/      Google Apps Script for the group sheet (tested against a simulated Sheet)
tests/            node:test suites
```
