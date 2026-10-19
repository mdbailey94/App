// Shared helpers for the browser tests.
import { test as base, expect } from '@playwright/test';
import { COACH_PASSWORD, GROUP_CODE, PORT } from './constants.mjs';

export { expect, COACH_PASSWORD, GROUP_CODE };

// Every test fails if the page throws.
export const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await use(page);
    expect(errors, 'page errors').toEqual([]);
  },
});

export const ENTRIES = 'athlete-readiness/entries/v1';
export const SETTINGS = 'athlete-readiness/settings/v1';

// Local YYYY-MM-DD, `n` days ago (matches the app's todayISO()).
export const dayISO = (n = 0) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toLocaleDateString('en-CA');
};
export const weekday = (n = 0) => new Date(`${dayISO(n)}T12:00:00`).getDay();

export const WELLNESS = (v = 5, sleepHours = 8) => ({
  sleepHours, scaleMax: 7, sleepQuality: v, energy: v, soreness: v, stress: v, mood: v, motivation: v,
});

// An earlier camera reading, so the app treats the athlete as experienced.
export const HEART = { hr: 55, rmssd: 90, lnRmssd: Math.log(90), source: 'camera', quality: 'good' };

// Opens the app with the given history and settings in localStorage.
export async function seed(page, { entries = [], settings, hash = '#today' } = {}) {
  await page.goto('/#history');
  await page.evaluate(([e, s, k1, k2]) => {
    localStorage.setItem(k1, JSON.stringify(e));
    if (s) localStorage.setItem(k2, JSON.stringify(s));
  }, [entries, settings, ENTRIES, SETTINGS]);
  await page.goto(`/${hash}`);
}

export const todayEntry = (page) => page.evaluate(([k, d]) =>
  JSON.parse(localStorage.getItem(k) || '[]').find((e) => e.date === d), [ENTRIES, dayISO()]);

export const settings = (page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) || '{}'), SETTINGS);

// Tick a hidden radio/checkbox the way a tap would.
export const pick = (page, selector) => page.$eval(selector, (el) => {
  el.checked = true;
  el.dispatchEvent(new Event('input', { bubbles: true }));
});

// Answer every questionnaire item (training is on the Workouts tab now).
export async function answerAll(page, { value = 5, sleep = '8' } = {}) {
  await page.locator('#checkin').waitFor();
  await pick(page, `input[name=sleepHours][value="${sleep}"]`);
  for (const k of ['sleepQuality', 'energy', 'soreness', 'stress', 'mood', 'motivation']) {
    await pick(page, `input[name=${k}][value="${value}"]`);
  }
}

// After saving today's check-in, the app asks about yesterday's training if
// it isn't logged; skip that and land on Today.
export async function finishCheckin(page, opts) {
  await page.waitForURL(/#(today|workouts\/)/, opts);
  if (/#workouts\//.test(page.url())) {
    await page.click('#skip');
    await page.waitForURL(/#today/);
  }
}

// Fill in the Workouts form for one day. A practice is [minutes, effort,
// how well] or ['no', reason]; weights and meet are 'yes' / 'no'.
export async function answerWorkout(page, { am = ['120', '5', '7'], pm = ['no', 'off'], weights = 'no', meet = 'no', meetLevel } = {}) {
  await page.locator('#workout').waitFor();
  for (const [k, v] of [['am', am], ['pm', pm]]) {
    if (!v) continue;
    if (v[0] === 'no') {
      await pick(page, `input[name=${k}Did][value=no]`);
      await pick(page, `input[name=${k}Why][value=${v[1]}]`);
    } else {
      await pick(page, `input[name=${k}Did][value=yes]`);
      await page.selectOption(`select[name=${k}Min]`, v[0]);
      await pick(page, `input[name=${k}Rpe][value="${v[1]}"]`);
      await pick(page, `input[name=${k}Perf][value="${v[2]}"]`);
    }
  }
  if (weights) await pick(page, `input[name=weights][value=${weights}]`);
  if (meet) await pick(page, `input[name=meet][value=${meet}]`);
  if (meet === 'yes' && meetLevel) await pick(page, `input[name=meetLevel][value=${meetLevel}]`);
}

// A fake group sheet of its own for each test.
export const sheetFor = (testInfo) => {
  const name = testInfo.titlePath.join('-').replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(-80);
  return { name, url: `http://localhost:${PORT}/exec/${name}` };
};
export async function sheetState(request, sheet, change) {
  const res = change
    ? await request.post(`/__sheet/${sheet.name}`, { data: change })
    : await request.get(`/__sheet/${sheet.name}`);
  return res.json();
}

// Waits for a heart reading on the HRV screen to finish.
export const readingResult = (page) => page.locator('#measure-result:not([hidden])').waitFor({ timeout: 120_000 });
