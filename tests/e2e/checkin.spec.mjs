// The morning check-in: questions, reading days, reading during the
// check-in, pre-filling and streaks.
import {
  test, expect, seed, settings, todayEntry, answerAll, pick, dayISO, weekday, WELLNESS, HEART,
} from './helpers.mjs';

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const past = (n, extra = {}) => ({ date: dayISO(n), wellness: WELLNESS(), training: { durationMin: 90, rpe: 5 }, ...extra });

test('first check-in: questions, then the heart reading, which can be skipped', async ({ page }) => {
  await seed(page, { settings: { hrvDays: EVERY_DAY }, hash: '#morning' });
  await expect(page.locator('#reading')).toHaveCount(0);
  await expect(page.locator('#combined-toggle')).toHaveCount(0);
  await expect(page.locator('#view')).toContainText('Your 1-minute heart reading comes next.');

  await answerAll(page);
  await page.click('#save');
  await page.waitForURL(/#measure\?after=checkin/);
  await expect(page.locator('#next-step')).toContainText('Answers saved');
  expect((await todayEntry(page)).wellness).toMatchObject({ scaleMax: 7, energy: 5 });

  await page.click('#skip');
  await page.waitForURL(/#today/);
  await expect(page.locator('.done-list')).toContainText('No heart reading today');
});

test('reading during the check-in, once turned on', async ({ page }) => {
  await seed(page, {
    entries: [past(1, { hrv: HEART })],
    settings: { hrvDays: EVERY_DAY, hrvDuringCheckin: true },
    hash: '#morning',
  });
  await expect(page.locator('.toggle-line')).toContainText('on');
  await page.click('#reading-start');
  await answerAll(page, { value: 6 });
  await page.click('#save');
  await expect(page.locator('#save')).toHaveText('✓ Answers saved – finishing your heart reading…');
  // Saved straight away, so closing the app mid-reading loses nothing.
  expect((await todayEntry(page)).wellness.energy).toBe(6);
  await page.waitForURL(/#today/, { timeout: 120_000 });

  const e = await todayEntry(page);
  expect(e.wellness.energy).toBe(6);
  expect(e.hrv.source).toBe('camera');
});

test('reading during the check-in: saving without starting it keeps the answers', async ({ page }) => {
  await seed(page, {
    entries: [past(1, { hrv: HEART })],
    settings: { hrvDays: EVERY_DAY, hrvDuringCheckin: true },
    hash: '#morning',
  });
  await answerAll(page, { value: 6 });
  await page.click('#save');
  await page.waitForURL(/#today/);
  const e = await todayEntry(page);
  expect(e.wellness.energy).toBe(6);
  expect(e.hrv).toBeUndefined();
  await expect(page.locator('.done-list')).toContainText('No heart reading today');
});

test('reading during the check-in can be turned off again', async ({ page }) => {
  await seed(page, {
    entries: [past(1, { hrv: HEART })],
    settings: { hrvDays: EVERY_DAY, hrvDuringCheckin: true },
    hash: '#morning',
  });
  await page.click('#combined-toggle');
  await expect(page.locator('#reading')).toHaveCount(0);
  await expect(page.locator('.offer')).toContainText('Save time');
  expect((await settings(page)).hrvDuringCheckin).toBe(false);
});

test('not a reading day: questions only, Today names the next reading day, streak grows', async ({ page }) => {
  const tomorrow = weekday(-1);
  await seed(page, { entries: [past(3), past(2), past(1)], settings: { hrvDays: [tomorrow] }, hash: '#today' });
  await expect(page.locator('.hero')).toContainText('No heart reading needed today');
  await expect(page.locator('.streak')).toContainText('3-day streak – check in today to keep it going');

  await page.click('text=Start my morning check-in');
  await expect(page.locator('#reading')).toHaveCount(0);
  await answerAll(page);
  await page.click('#save');
  await page.waitForURL(/#today/);
  await expect(page.locator('.done-list')).toContainText(`No heart reading needed today (next: ${DAY_NAMES[tomorrow]})`);
  await expect(page.locator('.streak')).toHaveText('🔥 4-day streak');
});

test('a new day starts blank: nothing is carried over, and every answer is asked for', async ({ page }) => {
  await seed(page, { entries: [past(1)], hash: '#checkin' });
  await expect(page.locator('.prefill-note')).toHaveCount(0);
  await expect(page.locator('input[name=energy]')).toHaveCount(7);
  await expect(page.locator('#checkin input[type=radio][name]:not([name=painLevel]):checked')).toHaveCount(0);
  await expect(page.locator('select[name=durationMin]')).toHaveValue('');
  await expect(page.locator('select[name=rpe]')).toHaveValue('');
  await expect(page.locator('fieldset.scale', { hasText: 'Stressed or relaxed' }).locator('.scale-ends'))
    .toHaveText(/Very stressed\s*Very relaxed/);

  // Unanswered questions, training included, are outlined; answering clears them.
  await page.click('button[type=submit]');
  await expect(page.locator('#form-error')).toContainText('Energy');
  await expect(page.locator('#form-error')).toContainText('Yesterday’s training time');
  await expect(page.locator('.missing')).toHaveCount(8);
  await expect(page.locator('.missing').first()).toBeInViewport();
  await pick(page, 'input[name=energy][value="7"]');
  await expect(page.locator('.missing')).toHaveCount(7);

  // A rest day needs no effort rating.
  await answerAll(page, { value: 3 });
  await page.selectOption('select[name=durationMin]', '0');
  await page.click('button[type=submit]');
  await page.waitForURL(/#today/);
  expect((await todayEntry(page)).training).toEqual({ durationMin: 0, rpe: 0 });
});

test('reading days: all seven fit on one row and save when ticked', async ({ page }) => {
  await seed(page, { hash: '#measure' });
  const days = page.locator('.chips.days label');
  await expect(days).toHaveCount(7);
  await expect(page.locator('.chips.days span')).toHaveText(['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']);
  const tops = await days.evaluateAll((l) => new Set(l.map((x) => Math.round(x.getBoundingClientRect().top))).size);
  expect(tops).toBe(1);
  await expect(page.locator('input[name=hrvDay]:checked')).toHaveCount(3); // Mon, Wed, Fri by default

  await page.click('input[name=hrvDay][value="2"]');
  expect((await settings(page)).hrvDays).toEqual([1, 2, 3, 5]);
});

test('an app saved on the check-in page opens on Today once today is done', async ({ page }) => {
  await seed(page, { entries: [past(0)], hash: '#morning' });
  await page.reload();
  await expect(page).toHaveURL(/#today$/);
  await expect(page.locator('.hero')).toContainText('Questions answered');
});

test('after checking in: thanks, no score or advice, then a comparison with their own usual', async ({ page }) => {
  // Two earlier check-ins: too few to compare yet.
  await seed(page, { entries: [past(2), past(1)], settings: { hrvDays: [weekday(-1)] }, hash: '#morning' });
  await answerAll(page, { value: 2 });
  await page.click('#save');
  await page.waitForURL(/#today/);
  const hero = page.locator('.hero');
  await expect(hero.locator('h2')).toHaveText('Thanks for checking in!');
  await expect(hero).toContainText('After 3 more check-ins, you’ll see how each day compares with your usual.');
  await expect(page.locator('.score-num, .advice, .flags')).toHaveCount(0);
  await expect(page.locator('#view')).not.toContainText(/light session|recovery|trimming|\/100/);

  // A low day after a handful of usual ones: neutral wording, keep to the program.
  await seed(page, { entries: [6, 5, 4, 3, 2, 1].map((n) => past(n)), settings: { hrvDays: [weekday(-1)] }, hash: '#morning' });
  await answerAll(page, { value: 2 });
  await pick(page, 'input[name=painLevel][value="3"]');
  await page.click('#save');
  await page.waitForURL(/#today/);
  await expect(hero.locator('.usual')).toHaveText('Feeling a bit below usual');
  await expect(hero).toContainText('Keep following your program');
  await expect(hero.locator('.injury-note')).toContainText('talk to your coach before practice');
});
