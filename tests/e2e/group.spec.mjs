// Joining the coach's group from the invite link, syncing to the group
// sheet, and reconnecting a Home Screen copy of the app.
import {
  test, expect, seed, answerAll, dayISO, weekday, WELLNESS, GROUP_CODE, sheetFor, sheetState,
} from './helpers.mjs';
import { inviteLink } from '../../src/team.js';

const history = [3, 2, 1].map((n) => ({ date: dayISO(n), wellness: WELLNESS(), training: { durationMin: 90, rpe: 5 } }));
// Not a reading day, so saving the check-in goes straight to Today.
const settings = { hrvDays: [weekday(-1)] };

async function join(page, sheet, baseURL, name = 'Maya Torres') {
  await page.goto(inviteLink(baseURL, sheet.url, GROUP_CODE));
  await page.fill('#join input[name=athlete]', name);
  await page.click('#join button[type=submit]');
  await page.waitForURL(/#morning/);
}

test('joining from the invite goes straight to the check-in and shares history', async ({ page, request, baseURL }, testInfo) => {
  const sheet = sheetFor(testInfo);
  await seed(page, { entries: history, settings });
  await join(page, sheet, baseURL);

  await expect(page.locator('.welcome')).toContainText('You’re in, Maya!');
  const address = new URL(page.url());
  expect(address.searchParams.get('g')).toBe(GROUP_CODE);
  expect(address.searchParams.get('n')).toBe('Maya Torres');
  expect(address.hash).toBe('#morning'); // the welcome shows once
  await expect.poll(async () => (await sheetState(request, sheet)).rows).toBe(3);

  await answerAll(page);
  await page.click('#save');
  await page.waitForURL(/#today/);
  await expect(page.locator('#sync-line')).toContainText('Shared with coach', { timeout: 15_000 });
  expect((await sheetState(request, sheet)).rows).toBe(4);

  await page.goBack();
  await expect(page.locator('#join')).toHaveCount(0);
});

test('a fresh Home Screen copy of the app reconnects in one tap', async ({ page, browser, baseURL }, testInfo) => {
  const sheet = sheetFor(testInfo);
  await join(page, sheet, baseURL);
  await page.click('.tabs a[data-tab=history]');
  const saved = page.url(); // what "Add to Home Screen" would keep

  const homeScreen = await (await browser.newContext()).newPage(); // separate, empty storage
  await homeScreen.goto(saved);
  await expect(homeScreen).toHaveURL(/#team$/);
  await expect(homeScreen.locator('h2')).toContainText('Finish setting up, Maya');
  await expect(homeScreen.locator('#join input[name=athlete]')).toHaveValue('Maya Torres');
  await homeScreen.click('#join button[type=submit]');
  await expect(homeScreen.locator('.welcome')).toContainText('You’re in, Maya!');
  await homeScreen.context().close();
});

test('leaving the group clears the details from the address', async ({ page, baseURL }, testInfo) => {
  await join(page, sheetFor(testInfo), baseURL);
  await page.click('.tabs a[data-tab=team]');
  page.once('dialog', (d) => d.accept());
  await page.click('#leave');
  await expect(page.locator('#join')).toBeVisible();
  expect(new URL(page.url()).search).toBe('');
});

test('check-ins wait while the sheet is down, then send', async ({ page, request, baseURL }, testInfo) => {
  const sheet = sheetFor(testInfo);
  await seed(page, { settings });
  await join(page, sheet, baseURL);
  await sheetState(request, sheet, { down: true });

  await answerAll(page);
  await page.click('#save');
  await page.waitForURL(/#today/);
  await expect(page.locator('#sync-line')).toContainText('Not sent yet', { timeout: 15_000 });

  await sheetState(request, sheet, { down: false });
  await page.click('.tabs a[data-tab=history]'); // any navigation retries
  await page.click('.tabs a[data-tab=today]');
  await expect(page.locator('#sync-line')).toContainText('Shared with coach', { timeout: 15_000 });
  expect((await sheetState(request, sheet)).rows).toBe(1);
});
