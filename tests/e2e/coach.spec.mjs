// The coach dashboard, against a group sheet with 40 days of made-up data.
import { test, expect, dayISO, GROUP_CODE, COACH_PASSWORD, sheetFor } from './helpers.mjs';
import { buildItems } from '../../src/team.js';

const W = (v, sleep) => ({ sleepHours: sleep, scaleMax: 7, sleepQuality: v, energy: v, soreness: v, stress: v, mood: v, motivation: v });
const practice = { durationMin: 120, rpe: 6 };
// n = days ago; returning null skips that day.
const SWIMMERS = {
  'Maya Torres': () => ({ wellness: W(6, 8), training: practice }),
  'Sam Lee': (n) => ({ wellness: W(n < 4 ? 3 : 6, n < 4 ? 6 : 8), training: practice }),
  'Kai Moana': (n) => ({ wellness: W(5, 7.5), training: practice, pain: n === 0 ? { level: 3, location: 'right shoulder' } : { level: 0 } }),
  'Ana Ruiz': (n) => ({ wellness: W(5, n < 4 ? 6 : 8), training: n < 7 ? { durationMin: 240, rpe: 8 } : { durationMin: 90, rpe: 5 } }),
  'Leo Park': (n) => (n < 3 ? null : { wellness: W(6, 8), training: practice }),
  'Zoe Chen': (n) => (n === 0 ? null : { wellness: W(6, 8), training: practice }),
  'Eli Brooks': (n) => ({ wellness: W(n < 6 ? 4 : 7, 8), training: practice }),
};

async function fillSheet(request, sheet) {
  for (const [athlete, day] of Object.entries(SWIMMERS)) {
    const entries = [];
    for (let n = 40; n >= 0; n--) { const e = day(n); if (e) entries.push({ date: dayISO(n), ...e }); }
    const res = await request.post(sheet.url, {
      headers: { 'Content-Type': 'text/plain' },
      data: JSON.stringify({ action: 'submit', group: GROUP_CODE, athlete, items: buildItems(entries, entries) }),
    });
    expect((await res.json()).ok).toBe(true);
  }
}

test.beforeEach(async ({ request }, testInfo) => fillSheet(request, sheetFor(testInfo)));

test('coach sign-in checks the password', async ({ page }, testInfo) => {
  await page.goto('/#coach');
  await page.fill('input[name=url]', sheetFor(testInfo).url);
  await page.fill('input[name=password]', 'wrong');
  await page.click('#coach-login button[type=submit]');
  await expect(page.locator('#login-error')).toBeVisible();

  await page.fill('input[name=password]', COACH_PASSWORD);
  await page.fill('input[name=group]', GROUP_CODE);
  await page.click('#coach-login button[type=submit]');
  await expect(page.locator('.stats').first()).toContainText('5/7');
  await expect(page.locator('.qr svg')).toBeVisible();
});

test('dashboard: watch list, reminder, team trends and athlete detail', async ({ page }, testInfo) => {
  await page.goto('/#today');
  await page.evaluate((c) => localStorage.setItem('athlete-readiness/coach/v1', JSON.stringify(c)),
    { url: sheetFor(testInfo).url, password: COACH_PASSWORD, group: GROUP_CODE });
  await page.goto('/#coach');

  const watch = page.locator('.watch > li');
  await expect(watch.locator('.watch-head a')).toHaveText(['Kai Moana', 'Ana Ruiz', 'Sam Lee', 'Eli Brooks']);
  await expect(watch.first()).toContainText('Talk today');
  await expect(watch.first()).toContainText('Injury stopping certain strokes or movements (right shoulder), reported today.');
  await expect(watch.nth(1)).toContainText('Training load spike');

  await expect(page.locator('.plain li', { hasText: 'Leo Park' })).toContainText('missed 3 days');
  await expect(page.locator('#reminder')).toHaveValue(/Still waiting on Leo Park and Zoe Chen\. It takes about a minute: http/);
  await page.click('#send-reminder');
  await expect(page.locator('#send-reminder')).toHaveText('Copied – paste it in your group chat');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('Leo Park and Zoe Chen');

  await expect(page.locator('[data-t="rate"] .series-bar')).toHaveCount(7);
  await page.click('.seg a:has-text("28 days")');
  await expect(page).toHaveURL(/t=28/);
  await expect(page.locator('[data-t="rate"] .series-bar')).toHaveCount(28);

  await page.click('.watch-head a:has-text("Kai Moana")');
  await expect(page.locator('h2')).toHaveText('Kai Moana');
  await expect(page.locator('.flags')).toContainText('Injury stopping certain strokes or movements (right shoulder)');
});
