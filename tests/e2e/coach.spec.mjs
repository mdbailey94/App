// The coach dashboard, against a group sheet with 40 days of made-up data.
import { test, expect, dayISO, GROUP_CODE, COACH_PASSWORD, sheetFor } from './helpers.mjs';
import { buildItems } from '../../src/team.js';

const W = (v, sleep) => ({ sleepHours: sleep, scaleMax: 7, sleepQuality: v, energy: v, soreness: v, stress: v, mood: v, motivation: v });
const practice = { durationMin: 120, rpe: 6 };
// n = days ago; returning null skips that day.
const SWIMMERS = {
  'Maya Torres': (n) => ({
    wellness: W(6, 8),
    training: { am: { durationMin: 90, rpe: 4 }, pm: n % 2 ? null : { durationMin: 120, rpe: 8 }, weights: true, meet: n === 0, durationMin: n % 2 ? 90 : 210, rpe: n % 2 ? 4 : 6 },
    notes: n === 1 ? 'Shoulder a bit tight after drills' : '',
  }),
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

const signIn = (page, testInfo) => page.evaluate((c) => localStorage.setItem('athlete-readiness/coach/v1', JSON.stringify(c)),
  { url: sheetFor(testInfo).url, password: COACH_PASSWORD, group: GROUP_CODE });

test('the dashboard is its own page; the swimmer app links to it and #coach redirects', async ({ page }) => {
  await page.goto('/#team');
  await page.click('a:has-text("Open coach dashboard")');
  await expect(page).toHaveURL(/coach\.html/);
  await expect(page.locator('#coach-login')).toBeVisible();
  await expect(page.locator('#coach-tabs')).toBeHidden(); // no tabs until signed in

  await page.goto('/#coach');
  await expect(page).toHaveURL(/coach\.html/);
});

test('invite QR code without the password: just the sheet link and group code', async ({ page }, testInfo) => {
  await page.goto('/coach.html');
  const form = page.locator('#qr-form');
  await form.locator('input[name=url]').fill(sheetFor(testInfo).url);
  await form.locator('input[name=group]').fill('WRONG');
  await form.locator('button').click();
  await expect(page.locator('#qr-error')).toBeVisible();
  await expect(page.locator('#qr-result')).toBeHidden();

  await form.locator('input[name=group]').fill(GROUP_CODE);
  await form.locator('button').click();
  await expect(page.locator('#qr-result .qr svg')).toBeVisible();
  await expect(page.locator('#qr-result #invite')).toHaveValue(new RegExp(`/\\?u=.*&g=${GROUP_CODE}#team$`));
  expect(await page.inputValue('#qr-result #invite')).not.toContain('coach.html');
});

test('coach sign-in checks the password, then shows the Group tab', async ({ page }, testInfo) => {
  await page.goto('/coach.html');
  await page.fill('input[name=url]', sheetFor(testInfo).url);
  await page.fill('input[name=password]', 'wrong');
  await page.click('#coach-login button[type=submit]');
  await expect(page.locator('#login-error')).toBeVisible();

  await page.fill('input[name=password]', COACH_PASSWORD);
  await page.fill('input[name=group]', GROUP_CODE);
  await page.click('#coach-login button[type=submit]');
  await expect(page.locator('.stats').first()).toContainText('5/7');
  await expect(page.locator('#coach-tabs a')).toHaveText(['Group', 'History', 'Swimmers', 'Messages', 'Settings']);
  await expect(page.locator('#coach-tabs a[aria-current]')).toHaveText('Group');
});

test('Group tab: follow-up categories, check-ins and who is missing', async ({ page }, testInfo) => {
  await page.goto('/coach.html');
  await signIn(page, testInfo);
  await page.goto('/coach.html#group');

  // Follow-up: counts per category, then who and why.
  await expect(page.locator('.fu-tile .fu-label')).toHaveText([
    'Illness / injury', 'Recovery / fatigue', 'Stress / mood', 'Training response', 'Missing data', 'Ready for planned training',
  ]);
  await expect(page.locator('.fu-tile-health .fu-count')).toHaveText('1');
  const health = page.locator('#fu-health .fu-list > li');
  await expect(health.locator('.fu-head a')).toHaveText(['Kai Moana']);
  await expect(health.first()).toContainText('Talk today');
  await expect(health.first()).toContainText('Injury stopping certain strokes or movements (right shoulder), reported today.');
  await expect(health.first().locator('.fu-ask')).toContainText('right shoulder');
  const recovery = page.locator('#fu-recovery .fu-list > li');
  await expect(recovery.filter({ hasText: 'Ana Ruiz' })).toContainText('Training load: the last 7 days are');
  // Sam and Eli dipped against their own usual this week: it has been building, not new.
  await expect(recovery.filter({ hasText: 'Sam Lee' }).locator('.fu-since')).toHaveText(/\d days|7\+ days/);
  await expect(page.locator('#fu-stress .fu-list > li .fu-head a')).toContainText(['Eli Brooks', 'Sam Lee']); // most reasons first
  // Missing data and ready are folded away; a tile opens them.
  await expect(page.locator('#fu-missing')).not.toHaveAttribute('open');
  await page.click('.fu-tile-missing');
  await expect(page.locator('#fu-missing')).toHaveAttribute('open');
  await expect(page.locator('#fu-missing .fu-head a')).toHaveText(['Leo Park', 'Zoe Chen']);
  await expect(page.locator('#fu-ready')).toContainText('Maya Torres');
  await expect(page.locator('#not-in li', { hasText: 'Leo Park' })).toContainText('missed 3 days');

  // Check-ins: readiness, and its change since yesterday and against their usual.
  await expect(page.locator('.checkin-table thead th')).toHaveText(['Swimmer', 'Ready', 'vs yesterday', 'vs usual']);
  await expect(page.locator('.checkin-table tbody tr:not(.flag-row)')).toHaveCount(5);
  // Sam gave the same answers as yesterday.
  const sam = page.locator('.checkin-table tr', { hasText: 'Sam Lee' });
  await expect(sam.locator('td').nth(2)).toHaveText('0');
  await expect(page.locator('#checkins .stats .stat-label')).toHaveText([/checked in/, /avg readiness/, /vs yesterday/, /vs usual/]);

  // Yesterday's training against the same day last week and the usual.
  const compare = page.locator('#day-before .compare-table');
  await expect(compare.locator('tbody th')).toHaveText([
    'Reported', 'Morning practice', 'time', 'effort', 'how well', 'Doubles', 'time', 'effort', 'how well',
    'Lifted', 'Raced', 'Missed: sick', 'Missed: other', 'Avg load',
  ]);
  await expect(compare.locator('tr', { hasText: 'Raced' }).locator('td')).toHaveText(['1', '0', '0']);
  // The five who checked in today, heaviest load first.
  const trainedRows = page.locator('#day-before .day-table tbody tr');
  await expect(trainedRows).toHaveCount(5);
  const ana = trainedRows.first();
  await expect(ana).toContainText('Ana Ruiz');
  // 4 h at 8 yesterday against 1½ h at 5 on the same day last week and the 3 weeks before.
  await expect(ana.locator('td').nth(3)).toHaveText('▲+327%');
  await expect(ana.locator('td').nth(4)).toHaveText('▲+327%');
  const mayaDay = trainedRows.filter({ hasText: 'Maya Torres' });
  await expect(mayaDay.locator('td.effort')).toContainText('AM 1½h · 4');
  await expect(mayaDay.locator('td.effort')).toContainText('Dbl 2h · 8');
  await expect(mayaDay.locator('.tag')).toHaveText(['Wt', 'Meet · moderate']); // meets from before the question count as moderate

  await page.click('a:has-text("Send a reminder")');
  await expect(page).toHaveURL(/#messages/);
});

test('History tab: 7/14/28-day trends and the check-in record', async ({ page }, testInfo) => {
  await page.goto('/coach.html');
  await signIn(page, testInfo);
  await page.goto('/coach.html#history');

  await expect(page.locator('[data-t="rate"] .series-bar')).toHaveCount(7);
  // Readiness with the day before's load under it, one bar per day with 6+
  // swimmers (only 5 checked in today, so today has none).
  await expect(page.locator('[data-t="readyLoad"] .series-line')).toHaveCount(1);
  await expect(page.locator('[data-t="readyLoad"] .series-bar')).toHaveCount(6);
  await expect(page.locator('[data-t="readyLoad"] .panel-title')).toHaveText(['Readiness', 'Load the day before']);
  // The team against its own usual: bars either side of a zero line.
  await expect(page.locator('[data-t="vsUsual"] .zero')).toHaveCount(1);
  expect(await page.locator('[data-t="vsUsual"] .series-bar').count()).toBeGreaterThan(0);
  await page.click('.seg a:has-text("14 days")');
  await expect(page).toHaveURL(/t=14/);
  await expect(page.locator('[data-t="rate"] .series-bar')).toHaveCount(14);
  await page.click('.seg a:has-text("28 days")');
  await expect(page).toHaveURL(/t=28/);
  await expect(page.locator('[data-t="rate"] .series-bar')).toHaveCount(28);

  // Training vs next-morning readiness: light / moderate / heavy thirds, by
  // load and by load against each swimmer's usual.
  const tables = page.locator('#load-response table');
  await expect(tables).toHaveCount(2);
  for (const i of [0, 1]) await expect(tables.nth(i).locator('tbody tr')).toHaveText([/^Light/, /^Moderate/, /^Heavy/]);
  await expect(tables.nth(1).locator('tbody tr').last()).toContainText('% of usual');

  const grid = page.locator('.checkin-grid tbody tr');
  await expect(grid).toHaveCount(7);
  const leo = grid.filter({ hasText: 'Leo' });
  await expect(leo.locator('.grid-count')).toHaveText('11/14'); // missed the last 3 days
  await expect(leo.locator('td.grid-miss')).toHaveCount(3);
  await expect(grid.filter({ hasText: 'Kai' }).locator('td.grid-critical')).toHaveText('✕'); // injury today

  // Only Maya split her training: morning 4 every day, afternoon 8 on the days she went.
  const effort = page.locator('#effort-stats .stat-num');
  await expect(effort.nth(0)).toHaveText(/^4/);
  await expect(effort.nth(1)).toHaveText(/^8/);
  await expect(page.locator('#lift-meet')).toHaveText('28 weights sessions · 1 meet day reported');
  await expect(page.locator('#load-response')).toContainText('Last 28 days');
  await expect(page.locator('[data-t="rpePm"] svg')).toBeVisible();
});

test('Swimmers tab: the roster, then one swimmer’s history', async ({ page }, testInfo) => {
  await page.goto('/coach.html');
  await signIn(page, testInfo);
  await page.goto('/coach.html#swimmers');

  const names = page.locator('.roster .roster-name');
  await expect(names).toHaveCount(7);
  await expect(names.first()).toHaveText('Ana Ruiz');
  await expect(page.locator('.roster li', { hasText: 'Leo Park' })).toContainText('4/7 days');

  await page.click('.roster a:has-text("Kai Moana")');
  await expect(page).toHaveURL(/#swimmers\/kai%20moana/);
  await expect(page.locator('h2')).toHaveText('Kai Moana');
  await expect(page.locator('.flags')).toContainText('Injury stopping certain strokes or movements (right shoulder)');
  await expect(page.locator('#coach-tabs a[aria-current]')).toHaveText('Swimmers');
  await expect(page.locator('#trends')).toContainText('HRV (ms)');
  // Coach-only insights: change in readiness, the day before's training, watch list, own pattern.
  await expect(page.locator('#swimmer-change .stat-label')).toHaveText([/vs yesterday/, /vs usual/]);
  await expect(page.locator('#swimmer-followup')).toContainText('Injury stopping certain strokes or movements (right shoulder)');
  await expect(page.locator('#swimmer-followup h4')).toContainText(['Illness / injury']);
  await expect(page.locator('#swimmer-training')).toContainText('2h · 6');
  await expect(page.locator('#swimmer-training .stat-num').first()).toHaveText('720');
  await expect(page.locator('#swimmer-response tbody tr')).toHaveText([/^Light/, /^Moderate/, /^Heavy/]);

  await page.click('a:has-text("Message Kai")');
  await expect(page.locator('#direct-text')).toHaveValue(/^Hi Kai, just checking in\./);
});

test('Messages tab: swimmers’ notes and injuries, reminder, direct message, invite', async ({ page }, testInfo) => {
  await page.goto('/coach.html');
  await signIn(page, testInfo);
  await page.goto('/coach.html#messages');

  const feed = page.locator('.notes-feed > li');
  await expect(feed.first()).toContainText('Kai Moana');
  await expect(feed.first()).toContainText('Major – stopping some strokes – right shoulder');
  await expect(page.locator('.notes-feed')).toContainText('“Shoulder a bit tight after drills”');

  await expect(page.locator('#reminder')).toHaveValue(/Still waiting on Leo Park and Zoe Chen\. It takes about a minute: http/);
  await page.click('#send-reminder');
  await expect(page.locator('#send-reminder')).toHaveText('Copied – paste it in your group chat');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('Leo Park and Zoe Chen');

  await feed.filter({ hasText: 'Maya Torres' }).locator('a:has-text("Reply to Maya")').click();
  await expect(page.locator('#direct h3')).toHaveText('Message Maya Torres');
  await page.click('#send-direct');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^Hi Maya/);

  await expect(page.locator('.qr svg')).toBeVisible();
  // The invite opens the swimmer app, not the coach page.
  await expect(page.locator('#invite')).toHaveValue(/\/\?u=.*#team$/);
  expect(await page.inputValue('#invite')).not.toContain('coach.html');
});

test('Settings tab: group code and sign out', async ({ page }, testInfo) => {
  await page.goto('/coach.html');
  await signIn(page, testInfo);
  await page.goto('/coach.html#settings');
  await expect(page.locator('.settings-list')).toContainText(GROUP_CODE);

  await page.fill('#group-form input[name=group]', 'WRONG');
  await page.click('#group-form button[type=submit]');
  await expect(page.locator('#group-error')).toBeVisible();

  await page.click('#signout');
  await expect(page.locator('#coach-login')).toBeVisible();
  await expect(page.locator('#coach-tabs')).toBeHidden();
});

test('workouts logged on the Workouts tab: how well it went, why practices were missed, off sick in follow-up', async ({ page, request }, testInfo) => {
  // Nia logs yesterday's training: morning practice missed sick, and doubles.
  const entries = [2, 1, 0].map((n) => ({ date: dayISO(n), wellness: W(5, 8) }));
  entries[1].workouts = { am: { none: 'sick' }, pm: { durationMin: 90, rpe: 6, perf: 8 }, weights: false, meet: false, loggedAt: new Date().toISOString() };
  const res = await request.post(sheetFor(testInfo).url, {
    headers: { 'Content-Type': 'text/plain' },
    data: JSON.stringify({ action: 'submit', group: GROUP_CODE, athlete: 'Nia Lopez', items: buildItems(entries, entries) }),
  });
  expect((await res.json()).ok).toBe(true);
  await page.goto('/coach.html');
  await signIn(page, testInfo);
  await page.goto('/coach.html#group');

  const nia = page.locator('#day-before .day-table tr', { hasText: 'Nia Lopez' });
  await expect(nia.locator('td.effort')).toContainText('AM sick');
  await expect(nia.locator('td.effort')).toContainText('Dbl 1½h · 6 · 8');
  await expect(page.locator('#day-before .compare-table tr', { hasText: 'Missed: sick' }).locator('td').first()).toHaveText('1');
  await expect(page.locator('#fu-health .fu-list > li', { hasText: 'Nia Lopez' })).toContainText('Missed practice sick: yesterday.');
});
