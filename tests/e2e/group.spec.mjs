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
  const status = page.locator('.hero #sync-line');
  await expect(status).toContainText('Not sent yet', { timeout: 15_000 });

  await sheetState(request, sheet, { down: false });
  await status.locator('[data-send-now]').click();
  await expect(status).toContainText('Shared with coach', { timeout: 15_000 });
  await expect(status.locator('[data-send-now]')).toHaveCount(0);
  expect((await sheetState(request, sheet)).rows).toBe(1);
});

test('while a check-in is unsent, every screen says so; after a day, how to fix it', async ({ page, request, baseURL }, testInfo) => {
  const sheet = sheetFor(testInfo);
  await seed(page, { settings });
  await join(page, sheet, baseURL);
  await sheetState(request, sheet, { down: true });
  await answerAll(page);
  await page.click('#save');
  await page.waitForURL(/#today/);
  await expect(page.locator('.hero #sync-line')).toContainText('Not sent yet', { timeout: 15_000 });

  await page.click('.tabs a[data-tab=history]');
  const banner = page.locator('#send-banner');
  await expect(banner).toContainText('1 check-in hasn’t reached your coach yet.');
  await expect(banner).not.toContainText('ask them for a new QR code');

  // Failing since yesterday: probably a changed sheet link.
  await page.evaluate(() => {
    const k = 'athlete-readiness/team/v1';
    const t = JSON.parse(localStorage.getItem(k));
    localStorage.setItem(k, JSON.stringify({ ...t, failingSince: new Date(Date.now() - 30 * 3600e3).toISOString() }));
  });
  await page.click('.tabs a[data-tab=measure]');
  await expect(banner).toContainText('ask them for a new QR code');

  await sheetState(request, sheet, { down: false });
  await banner.locator('[data-send-now]').click();
  await expect(banner).toBeHidden({ timeout: 15_000 });
  expect((await sheetState(request, sheet)).rows).toBe(1);
});

test('a check-in saved while an earlier send is still going is sent straight after it', async ({ page, request, baseURL }, testInfo) => {
  const sheet = sheetFor(testInfo);
  await seed(page, { entries: history, settings });
  await sheetState(request, sheet, { delay: 3000 }); // joining sends the history slowly
  await join(page, sheet, baseURL);
  await answerAll(page);
  await page.click('#save'); // while the history is still on its way
  await page.waitForURL(/#today/);
  // No further taps or screen changes: today's check-in follows on its own.
  await expect.poll(async () => (await sheetState(request, sheet, { delay: 3000 })).rows, { timeout: 20_000 }).toBe(4);
});

test('Save and send: waits for the sheet, then shows it reached the coach', async ({ page, request, baseURL }, testInfo) => {
  const sheet = sheetFor(testInfo);
  await seed(page, { settings });
  await join(page, sheet, baseURL);
  await sheetState(request, sheet, { delay: 1500 });
  await expect(page.locator('#save')).toHaveText('Save and send');

  await answerAll(page);
  await page.click('#save');
  await expect(page.locator('#save')).toHaveText('Sending to your coach…');
  await page.waitForURL(/#today/);
  // Already in the sheet by the time Today appears.
  expect((await sheetState(request, sheet)).rows).toBe(1);
  await expect(page.locator('.hero #sync-line')).toContainText('Shared with coach');
});

test('Save and send with the sheet down: answers kept, Today says not sent yet', async ({ page, request, baseURL }, testInfo) => {
  const sheet = sheetFor(testInfo);
  await seed(page, { settings });
  await join(page, sheet, baseURL);
  await sheetState(request, sheet, { down: true });
  await answerAll(page);
  await page.click('#save');
  await page.waitForURL(/#today/, { timeout: 15_000 });
  await expect(page.locator('.hero #sync-line')).toContainText('Not sent yet');
  await expect(page.locator('.hero [data-send-now]')).toBeVisible();
});

test('a check-in is sent the moment it is saved, before the app can be closed', async ({ page, request, baseURL }, testInfo) => {
  const sheet = sheetFor(testInfo);
  await seed(page, { settings });
  await join(page, sheet, baseURL);
  await expect.poll(async () => (await page.evaluate(() => JSON.parse(localStorage.getItem('athlete-readiness/team/v1')).lastError))).toBeFalsy();

  await answerAll(page);
  await page.click('#save');
  await page.close(); // straight away, like swiping the app closed: the send has already started
  await expect.poll(async () => (await sheetState(request, sheet)).rows, { timeout: 10_000 }).toBe(1);
});

test('not in a group: Today says check-ins are not reaching a coach', async ({ page }) => {
  await seed(page, { entries: history, hash: '#today' });
  const nudge = page.locator('#join-nudge');
  await expect(nudge).toContainText('Not connected to your coach');
  await expect(nudge.locator('a[href="#team"]')).toBeVisible();
  await nudge.locator('#solo').click();
  await expect(page.locator('#join-nudge')).toHaveCount(0);
});
