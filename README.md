# Athlete Readiness

A phone web app that tracks an athlete's daily state from two sources:

1. **A short daily questionnaire** (~1 minute) — sleep, fatigue, soreness, stress, mood,
   motivation, injury (kept separate from normal training soreness), and yesterday’s training: morning and afternoon practice (time and effort 1–10), weights, and a meet
   (light, moderate or hard). Load = minutes × effort; weights count as 45 min at 5; meets aren't counted in load.
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
- **Check-in (morning)** — the questions (about a minute). A new day starts blank. Right after, the app
  asks about yesterday's training if it isn't logged yet (skippable).
- **Workouts** — training logged for the day it happened: morning practice (how long, how hard 1–10, how well they
  did 1–10, or why not: off day, sick, missed, other), doubles (asked after 4:30 pm or the next morning;
  no reason asked if they didn't go), weights, and a meet. Today and yesterday first, then
  earlier days with their status; any day can be filled in or corrected later (when it was logged is kept).
- **Heart reading** (optional, from Today) — 1–3 min camera reading. Past readings are kept.
- **Team** — athletes join their group (name + group code, usually via the coach's invite link); new and
  edited days are sent automatically and retried if offline. The coach opens the **coach dashboard** here.
- **Goals** — goal and best times per event (SCY), and the training gears worked out from them, following
  the coach's Gears sheet: for each stroke, the pace per 25/50/75/100/200 at G2 (4-hour pace), G2.5, G3
  (1-hour), G3.5, G4 (15-minute), G5 (5-minute) and G6 (2-minute), with recommended rest; for IM, the IM
  pace, the 200 IM at each gear with its four 50s (elite stroke shares) and the switch 50s/100s (fly–back,
  back–breast, breast–free); and from a 50, the speed targets (15 m dive and push, 25 dive and push, flag to
  flag, predicted 100, and the S1–S4 zone 25s from the clean-speed model). The fatigue factor is worked out
  from two best 200+ freestyles or set by hand. Practice times: log a set's average and see the trend (last
  3 sets) against the gear target. Goals and sets are stored on the day and sent to the coach like a check-in.
- **History** — trend charts (readiness, HRV in ms with your normal band, resting HR, wellness,
  daily load), the entry table, export/import.

### How the score works

| Component | Weight | How |
|---|---|---|
| Wellness | 60 % | Six 1–7 scales + sleep hours, scaled 0–100 |
| HRV | 25 % | The 7-day average of ln RMSSD vs your personal baseline (mean ± SD of up to 30 prior readings; needs 5). Single readings are too noisy to judge a day on (Plews et al. 2013) |
| Resting HR | 15 % | Today's HR vs your baseline (higher = worse) |

Components without data are left out and the rest re-weighted, so the score works from day one
with the questionnaire alone.

**Your own usual.** Subjective wellness is most informative against the athlete's own history, not
a fixed scale (Saw, Main & Gastin 2016; Gallo et al. 2017). Once a swimmer has 5 check-ins in the
last 28 days, each answer, sleep hours and the wellness score are compared with that history as
z-scores (`personalBaseline`). The 0–100 score is unchanged; the status can only get worse: the
score 1 SD under their usual, or any one answer 2 SD under, makes the day at least *Moderate*;
1.5 SD under makes it *Low*. A major injury (unable to perform certain strokes or movements)
overrides everything with "talk to your coach/medical staff".

**Training load.** Load is session RPE × minutes (Foster 2001). After 3 weeks of logged training:
- *acute:chronic* — the last 7 days against the last 28, as exponentially weighted averages
  (Williams et al. 2017); over 1.5 is flagged as a spike. The coupled 7:28 ratio is kept as a
  reference. The ratio is a prompt to look, not a prediction (Impellizzeri et al. 2020).
- *monotony and strain* (Foster 1998) — monotony is the mean ÷ SD of the last 7 daily loads;
  2 or more with a week above their usual is noted. Strain is the weekly load × monotony.

The questionnaire stays short on purpose: compliance falls as daily questionnaires grow (Saw et
al. 2015), and the six items plus sleep cover the dimensions that respond to training (fatigue,
sleep, soreness, stress, mood) in the McLean et al. 2010 and Hooper & Mackinnon 1995 forms.

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
5. Athletes scan the **QR code** on the dashboard (or you send them the invite link). The coach sign-in
   screen can also make the QR code from just the web app URL and group code (no password), and swimmers
   already in the group can show teammates an invite QR on their Team tab.

What the coach gets:

- **Watchlist** (its own coach tab): six categories – illness / injury, recovery / fatigue, stress / mood, training
  response, missing data, ready – each with the swimmers in it, the evidence (against each swimmer's own usual
  where there's enough history), whether it's new today or has lasted for days, and a question to start with.
  Thresholds are in `src/followups.js` (`FOLLOW_UP`). Coaching prompts, not diagnoses or training changes.
- **Coach dashboard**: per day, who checked in (worst readiness first, with flags for injury,
  short sleep, low HRV, elevated resting HR, load spikes), who hasn't, group averages, and each
  athlete's trends and notes (with their readiness change, the day before's training against a week before
  and their usual, watch-list reasons and their own training-vs-readiness pattern). The **Group** tab is one day at a glance: check-ins with each swimmer's
  readiness against yesterday and their usual, the watch list, and **yesterday's training** against the
  same day last week and a usual week (practices, effort, weights, meets, each swimmer's load). **History**
  (7, 14 or 28 days) adds **training vs next-morning readiness**: how readiness moved after light,
  moderate and heavy days, by load and by load relative to each swimmer's own usual.
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
npm run test:e2e   # browser tests (after `npm ci` and `npx playwright install chromium`)
```

The browser tests (`tests/e2e/`) drive the real app in Chromium. The camera is Chrome's fake camera
playing a generated fingertip video, and group sheets are the Apps Script running on a simulated
Sheet, so readings, check-ins, joining a group and the coach dashboard are all covered without a
phone or Google account. They take about 2–3 minutes (each heart reading is a real minute), and CI
runs them before every deploy.

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
index.html, styles.css, sw.js, manifest.webmanifest, coach.webmanifest
src/signal.js     PPG processing (pure, tested)
src/readiness.js  questionnaire definition, scoring, baselines, workload (pure, tested)
src/camera.js     camera + torch capture, per-frame brightness
src/storage.js    localStorage, CSV/JSON export & import
src/charts.js     small SVG charts with tooltips
src/team.js       sending entries to the group sheet (retries, invite links)
src/group.js      coach-side group summary (pure, tested)
src/team-tab.js   swimmer's Team tab (joining the coach's group)
coach.html, src/coach-app.js  coach dashboard: Group, History, Swimmers, Messages, Settings tabs
src/ui.js         shared UI helpers and trend charts
src/checkin-form.js  the daily questionnaire form
src/reading.js    one heart reading: lens search, recording, analysis, diagnostics
src/app.js        screens and routing
apps-script/      Google Apps Script for the group sheet (tested against a simulated Sheet)
tests/            node:test suites
tests/e2e/        browser tests (Playwright), fake camera video and test server
```
