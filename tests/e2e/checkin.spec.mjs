// The morning check-in: questions, reading days, reading during the
// check-in, pre-filling and streaks.
import {
  test, expect, seed, settings, todayEntry, answerAll, answerTraining, pick, dayISO, weekday, WELLNESS, HEART,
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
  // No "check in today" nudge on Sundays.
  await expect(page.locator('.streak')).toHaveText(weekday(0) === 0 ? '🔥 3-day streak' : '🔥 3-day streak – check in today to keep it going');

  await page.click('text=Start my morning check-in');
  await page.locator('#checkin').waitFor(); // the check-in screen is open
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
  await expect(page.locator('fieldset.scale', { hasText: 'Stressed or relaxed' }).locator('.scale-ends'))
    .toHaveText(/Very stressed\s*Very relaxed/);

  // Practice length starts at the usual time: 2 h in the morning, 1½ h in the afternoon.
  await expect(page.locator('select[name=amMin]')).toHaveValue('120');
  await expect(page.locator('select[name=pmMin]')).toHaveValue('90');
  // Afternoon practice is a yes/no first; Yes opens its time and effort.
  await expect(page.locator('[data-details=pm]')).toBeHidden();
  await page.click('input[name=pmDid][value=yes]');
  await expect(page.locator('[data-details=pm]')).toBeVisible();
  await expect(page.locator('select[name=pmMin] option')).toHaveCount(10); // no "No practice": that's the No button
  await page.click('input[name=pmDid][value=no]');
  await expect(page.locator('[data-details=pm]')).toBeHidden();
  await page.$$eval('input[name=pmDid]', (all) => all.forEach((r) => { r.checked = false; }));
  await expect(page.locator('select[name=amMin] option')).toHaveText([
    'No practice', '30 min', '1 h', '1 h 30 min', '2 h', '2 h 30 min', '3 h', '3 h 30 min', '4 h', '4 h 30 min', '5 h',
  ]);
  // Effort: ten small buttons on one row; nothing picked.
  const effort = page.locator('[data-effort=am] .effort-row label');
  await expect(effort).toHaveCount(10);
  const tops = await effort.evaluateAll((l) => new Set(l.map((x) => Math.round(x.getBoundingClientRect().top))).size);
  expect(tops).toBe(1);

  // Unanswered questions are outlined; answering clears them.
  await page.click('button[type=submit]');
  await expect(page.locator('#form-error')).toContainText('Energy');
  await expect(page.locator('#form-error')).toContainText('How hard morning practice was, Afternoon practice?, Weights?, Meet?');
  await expect(page.locator('.missing')).toHaveCount(11);
  await expect(page.locator('.missing').first()).toBeInViewport();
  await pick(page, 'input[name=energy][value="7"]');
  await expect(page.locator('.missing')).toHaveCount(10);

  // A rest day: no practices (no effort asked), no weights, no meet.
  await answerAll(page, { value: 3, am: ['0'], pm: ['0'] });
  await expect(page.locator('[data-effort=am]')).toBeHidden();
  await page.click('button[type=submit]');
  await page.waitForURL(/#today/);
  expect((await todayEntry(page)).training).toEqual({ am: null, pm: null, weights: false, meet: false, durationMin: 0, rpe: 0 });
});

test('training: morning and afternoon practice, weights and meet, each on its own row', async ({ page }) => {
  await seed(page, { hash: '#checkin' });
  await answerAll(page, { am: ['90', '4'], pm: ['120', '8'], weights: 'yes', meet: 'no' });
  await expect(page.locator('[data-label-for=amRpe]')).toHaveText('4 – Somewhat hard');
  await expect(page.locator('[data-load-preview=""]')).toHaveText('Practice load: 1320 AU (minutes × effort)');
  for (const q of ['Weights?', 'Meet?']) {
    const row = page.locator('.yes-no', { hasText: q });
    // The question and both buttons share a row: the question's middle is
    // within the buttons' height, and the buttons line up with each other.
    const [text, yes, no] = await row.locator('.q, label').evaluateAll((l) => l.map((x) => x.getBoundingClientRect()).map((r) => ({ top: r.top, bottom: r.bottom, mid: (r.top + r.bottom) / 2 })));
    expect(text.mid, `${q} on one row`).toBeGreaterThan(yes.top);
    expect(text.mid, `${q} on one row`).toBeLessThan(yes.bottom);
    expect(Math.abs(yes.top - no.top)).toBeLessThan(2);
  }
  await page.click('button[type=submit]');
  await page.waitForURL(/#today/);
  expect((await todayEntry(page)).training).toEqual({
    am: { durationMin: 90, rpe: 4 }, pm: { durationMin: 120, rpe: 8 }, weights: true, meet: false, durationMin: 210, rpe: 6,
  });

  // Editing today's check-in shows the saved answers.
  await page.goto('/#checkin');
  await expect(page.locator('select[name=amMin]')).toHaveValue('90');
  await expect(page.locator('input[name=pmDid]:checked')).toHaveValue('yes');
  await expect(page.locator('[data-details=pm]')).toBeVisible();
  await expect(page.locator('input[name=pmRpe]:checked')).toHaveValue('8');
  await expect(page.locator('input[name=weights]:checked')).toHaveValue('yes');
  await expect(page.locator('input[name=meet]:checked')).toHaveValue('no');
});

test.describe('on a Monday', () => {
  const MONDAY = '2026-10-12', SUNDAY = '2026-10-11', SATURDAY_CHECKIN = '2026-10-10';
  const entry = (date) => ({ date, wellness: WELLNESS(), training: { durationMin: 90, rpe: 5 } });
  test.beforeEach(async ({ page }) => { await page.clock.setFixedTime(new Date(`${MONDAY}T07:00:00`)); });

  test('no Sunday check-in: after checking in, they are asked about Saturday once', async ({ page }) => {
    await seed(page, { entries: [entry(SATURDAY_CHECKIN)], settings: { hrvDays: [3] }, hash: '#morning' });
    await answerAll(page);
    await page.click('#save');
    await page.waitForURL(/#saturday/);
    await expect(page.locator('.welcome')).toContainText('how was Sat, Oct 10’s training');
    await expect(page.locator('.training h3')).toHaveText('Saturday’s training');

    await page.click('#save');
    await expect(page.locator('#form-error')).toContainText('Weights?, Meet?');
    await answerTraining(page, { prefix: 'sat', am: ['180', '7'], pm: ['0'], meet: 'yes' });
    await page.click('#save');
    await page.waitForURL(/#today$/);

    const saved = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)), 'athlete-readiness/entries/v1');
    const sunday = saved.find((e) => e.date === SUNDAY);
    expect(sunday.training).toEqual({ am: { durationMin: 180, rpe: 7 }, pm: null, weights: false, meet: true, durationMin: 180, rpe: 7 });
    expect(sunday.wellness).toBeUndefined(); // training only: not a Sunday check-in
    expect(saved.find((e) => e.date === MONDAY).wellness.energy).toBe(5);
    // Making up Saturday keeps the streak going through Sunday: Sat, Sun, Mon.
    await expect(page.locator('.streak')).toHaveText('🔥 3-day streak');

    // Not asked again.
    await page.goto('/#checkin');
    await page.click('button[type=submit]');
    await page.waitForURL(/#today$/);
  });

  test('before Monday’s check-in the streak waits; skipping Saturday ends it; not asked again', async ({ page }) => {
    await seed(page, { entries: [entry('2026-10-09'), entry(SATURDAY_CHECKIN)], settings: { hrvDays: [3] }, hash: '#today' });
    await expect(page.locator('.streak')).toHaveText('🔥 2-day streak – check in today to keep it going');
    await page.goto('/#morning');
    await answerAll(page);
    await page.click('#save');
    await page.waitForURL(/#saturday/);
    await page.click('#skip-saturday');
    await page.waitForURL(/#today$/);
    await expect(page.locator('.streak')).toHaveCount(0); // Sunday wasn't made up: a new streak of 1
    await page.goto('/#checkin');
    await page.click('button[type=submit]');
    await page.waitForURL(/#today$/);
  });

  test('with a Sunday check-in, Saturday is already reported: no question', async ({ page }) => {
    await seed(page, { entries: [entry(SUNDAY)], settings: { hrvDays: [3] }, hash: '#morning' });
    await answerAll(page);
    await page.click('#save');
    await page.waitForURL(/#today$/);
  });
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
