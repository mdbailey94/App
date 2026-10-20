// The morning check-in (questions only), then the Workouts tab: logging each
// day's training, backfilling, and streaks.
import {
  test, expect, seed, settings, todayEntry, answerAll, answerWorkout, finishCheckin, pick, dayISO, weekday, WELLNESS, ENTRIES,
} from './helpers.mjs';

const past = (n, extra = {}) => ({ date: dayISO(n), wellness: WELLNESS(), training: { durationMin: 90, rpe: 5 }, ...extra });
const entryOn = (page, date) => page.evaluate(([k, d]) => JSON.parse(localStorage.getItem(k) || '[]').find((e) => e.date === d), [ENTRIES, date]);
const LOGGED = { am: { durationMin: 120, rpe: 5, perf: 7 }, pm: { none: null }, weights: false, meet: false, loggedAt: new Date().toISOString() };
// Today at a given local time (doubles are asked about from 4:30 pm).
const at = (h, m = 0) => { const d = new Date(); d.setHours(h, m, 0, 0); return d; };
// A fixed week, for flows that depend on the weekday (Sundays are assumed off).
const WEEK = { sat: '2026-10-10', sun: '2026-10-11', mon: '2026-10-12', tue: '2026-10-13', wed: '2026-10-14' };
const atDay = (date, h = 7) => new Date(`${date}T${String(h).padStart(2, '0')}:00:00`);

test('the check-in is just the questions; then yesterday’s training, which can be skipped', async ({ page }) => {
  await page.clock.setFixedTime(atDay(WEEK.wed));
  await seed(page, { hash: '#morning' });
  await expect(page.locator('#reading')).toHaveCount(0);
  await expect(page.locator('#checkin select, #checkin [name=amDid], #checkin [name=weights]')).toHaveCount(0); // no training here
  await expect(page.locator('[data-progress]')).toHaveText('7 questions left');

  await answerAll(page);
  await expect(page.locator('[data-progress]')).toHaveText('All answered ✓');
  await page.click('#save');
  await page.waitForURL(new RegExp(`#workouts/${WEEK.tue}\\?after=checkin`));
  await expect(page.locator('.welcome')).toContainText('Check-in saved');
  await expect(page.locator('h2')).toHaveText('Yesterday’s training');
  await expect(page.locator('#log-today')).toHaveAttribute('href', `#workouts/${WEEK.wed}`);
  const e = await entryOn(page, WEEK.wed);
  expect(e.wellness).toMatchObject({ scaleMax: 7, energy: 5 });
  expect(e.training).toBeUndefined();

  await page.click('#skip');
  await page.waitForURL(/#today/);
  await expect(page.locator('#yesterday-line')).toContainText('Yesterday’s training not logged');
  await expect(page.locator('.heart-link')).toContainText('Add a heart reading');
});

test('a new day starts blank: nothing is carried over, and every answer is asked for', async ({ page }) => {
  await seed(page, { entries: [past(1)], hash: '#checkin' });
  await expect(page.locator('input[name=energy]')).toHaveCount(7);
  await expect(page.locator('#checkin input[type=radio][name]:not([name=painLevel]):checked')).toHaveCount(0);
  await expect(page.locator('fieldset.scale', { hasText: 'Stressed or relaxed' }).locator('.scale-ends'))
    .toHaveText(/Very stressed\s*Very relaxed/);
  // Unanswered questions are outlined; answering clears them.
  await page.click('button[type=submit]');
  await expect(page.locator('#form-error')).toContainText('Energy');
  await expect(page.locator('.missing')).toHaveCount(7);
  await expect(page.locator('.missing').first()).toBeInViewport();
  await pick(page, 'input[name=energy][value="7"]');
  await expect(page.locator('.missing')).toHaveCount(6);
});

test('logging yesterday right after the check-in, and the streak grows', async ({ page }) => {
  await page.clock.setFixedTime(atDay(WEEK.wed));
  // Up to Tuesday: training for Saturday–Monday came from older check-ins.
  const before = [WEEK.sun, WEEK.mon, WEEK.tue].map((date) => ({ date, wellness: WELLNESS(), training: { durationMin: 90, rpe: 5 } }));
  await seed(page, { entries: before, hash: '#today' });
  await expect(page.locator('.streak')).toHaveText('🔥 3-day streak – check in today to keep it going');
  await page.click('text=Start my morning check-in');
  await answerAll(page);
  await page.click('#save');
  await page.waitForURL(/#workouts\//);
  await answerWorkout(page, { am: ['120', '5', '7'], pm: ['no'] });
  await page.click('#save-workout');
  await page.waitForURL(/#today$/);
  await expect(page.locator('#yesterday-line')).toHaveText('✓ Yesterday’s training logged');
  await expect(page.locator('.streak')).toHaveText('🔥 4-day streak');
  const y = await entryOn(page, WEEK.tue);
  expect(y.workouts).toMatchObject({ am: { durationMin: 120, rpe: 5, perf: 7 }, pm: { none: null }, weights: false, meet: false });
  expect(y.wellness.energy).toBe(5); // the day's own check-in is kept
});

test('Workouts tab: today and yesterday first, then earlier days with their status', async ({ page }) => {
  await page.clock.setFixedTime(atDay(WEEK.wed));
  await seed(page, { entries: [{ date: WEEK.sun, wellness: WELLNESS(), training: { durationMin: 90, rpe: 5 } }, { date: WEEK.tue, workouts: LOGGED }], hash: '#workouts' });
  await expect(page.locator('.tabs a')).toHaveText(['Today', 'Check-in', 'Workouts', 'History', 'Team']);
  await expect(page.locator('.tabs a[aria-current]')).toHaveText('Workouts');

  const days = page.locator('.workout-day');
  await expect(days.locator('h3')).toHaveText([/^Today/, /^Yesterday/]);
  await expect(days.first().locator('.wk-status')).toHaveText('Not logged');
  await expect(days.first().locator('.btn')).toHaveText('Log today’s training');
  await expect(days.nth(1).locator('.wk-status')).toHaveText('Logged');
  await expect(days.nth(1)).toContainText('AM 2 h · effort 5 · how well 7/10');
  await expect(days.nth(1).locator('.btn')).toHaveText('Edit');
  // An older check-in reported the day before it (day 4): shown as such.
  const rows = page.locator('.workout-list li');
  await expect(rows).toHaveCount(19);
  await expect(rows.nth(0).locator('.wk-status')).toHaveText('Not logged'); // Monday
  await expect(rows.nth(1).locator('.wk-status')).toHaveText('Off (Sunday)');
  await expect(rows.nth(2).locator('.wk-status')).toHaveText('From check-in'); // Saturday, reported Sunday
});

test('logging a day: morning practice (how hard, how well, or why not), doubles, weights, a meet', async ({ page }) => {
  await page.clock.setFixedTime(at(17)); // after 4:30 pm: doubles are asked
  await seed(page, { hash: `#workouts/${dayISO(0)}` });
  await expect(page.locator('h2')).toHaveText('Today’s training');
  await expect(page.locator('.session-card .yes-no .q')).toHaveText(['Morning practice?', 'Doubles?']);
  // Doubles, weights and meet start on No; morning practice is unanswered.
  for (const name of ['pmDid', 'weights', 'meet']) await expect(page.locator(`input[name=${name}][value=no]`)).toBeChecked();
  await expect(page.locator('input[name=amDid]:checked')).toHaveCount(0);
  // …and must be answered: the starting answers alone don't save.
  await page.click('#save-workout');
  await expect(page.locator('#form-error')).toContainText('Morning practice?');
  expect((await todayEntry(page))?.workouts).toBeUndefined();

  // Missing morning practice asks why.
  await page.click('input[name=amDid][value=no]');
  await expect(page.locator('[data-skipped=am] .chips.reasons label')).toHaveText(['Off day', 'Sick', 'Missed', 'Other']);
  await pick(page, 'input[name=amWhy][value=other]');
  await expect(page.locator('[data-note=am]')).toBeVisible();
  // Missing doubles doesn't.
  await page.click('input[name=pmDid][value=no]');
  await expect(page.locator('[data-skipped=pm]')).toHaveCount(0);

  // Went to morning practice after all: time, how hard, how well.
  await page.click('input[name=amDid][value=yes]');
  await expect(page.locator('[data-went=am]')).toBeVisible();
  await expect(page.locator('[data-skipped=am]')).toBeHidden();
  await expect(page.locator('select[name=amMin]')).toHaveValue('120'); // the usual 2 h
  await expect(page.locator('[data-went=am] .q')).toHaveText(['How long?', 'How hard was it?', 'How well did you do?']);
  await expect(page.locator('[data-went=am] .effort-row').nth(1).locator('label')).toHaveCount(10);
  await expect(page.locator('[data-went=am] .scale-ends')).toHaveText(/Not well\s*Very well/);
  // Half an answer is pointed out.
  await page.click('#save-workout');
  await expect(page.locator('#form-error')).toContainText('How hard morning practice was, How well you did at morning practice');

  await answerWorkout(page, { am: ['90', '6', '8'], pm: ['no'], weights: 'yes', meet: 'yes', meetLevel: 'hard' });
  await expect(page.locator('[data-meet] label')).toHaveText(['Light', 'Moderate', 'Hard']);
  // 90 × 6 + weights (45 min at 5); meets aren't counted.
  await expect(page.locator('[data-load-preview]')).toHaveText('Training load: 765 (minutes × effort; weights count as 45 min, hard)');
  await page.click('#save-workout');
  await page.waitForURL(/#workouts$/);
  expect((await todayEntry(page)).workouts).toMatchObject({
    am: { durationMin: 90, rpe: 6, perf: 8 }, pm: { none: null }, weights: true, meet: true, meetLevel: 'hard',
  });
  await expect(page.locator('.workout-day').first().locator('.wk-status')).toHaveText('Logged');

  // Editing shows the saved answers.
  await page.goto(`/#workouts/${dayISO(0)}`);
  await expect(page.locator('input[name=amPerf]:checked')).toHaveValue('8');
  await expect(page.locator('input[name=pmDid]:checked')).toHaveValue('no');
  await expect(page.locator('input[name=meetLevel]:checked')).toHaveValue('hard');
});

test('doubles: not asked about today before 4:30 pm; asked for yesterday', async ({ page }) => {
  await page.clock.setFixedTime(at(9, 30));
  await seed(page, { hash: `#workouts/${dayISO(0)}` });
  await expect(page.locator('[name=pmDid]')).toHaveCount(0);
  await expect(page.locator('.doubles-later')).toContainText('after 4:30 pm');
  await answerWorkout(page);
  await page.click('#save-workout');
  await page.waitForURL(/#workouts$/);
  // Morning practice, weights and meet answered: logged for now.
  await expect(page.locator('.workout-day').first().locator('.wk-status')).toHaveText('Logged');
  expect((await todayEntry(page)).workouts.pm).toBeUndefined();

  await page.goto(`/#workouts/${dayISO(1)}`);
  await expect(page.locator('.session-card .yes-no .q')).toHaveText(['Morning practice?', 'Doubles?']);
});

test('filling in an earlier day: saved under that day, with when it was logged', async ({ page }) => {
  await seed(page, { hash: '#workouts' });
  await page.fill('#other-day input[name=d]', dayISO(30));
  await page.click('#other-day button');
  await page.waitForURL(new RegExp(`#workouts/${dayISO(30)}`));
  await answerWorkout(page, { am: ['no', 'sick'], pm: ['no'] });
  await page.click('#save-workout');
  await page.waitForURL(/#workouts$/);
  const e = await entryOn(page, dayISO(30));
  expect(e.workouts).toMatchObject({ am: { none: 'sick' }, pm: { none: null } });
  expect(e.workouts.loggedAt.slice(0, 10)).toBe(new Date().toISOString().slice(0, 10));
  expect(e.wellness).toBeUndefined(); // training only: not a check-in
  await page.goto(`/#workouts/${dayISO(30)}`);
  await expect(page.locator('#workout')).toContainText('Filled in later');
});

test.describe('on a Monday', () => {
  const MONDAY = '2026-10-12';
  test.beforeEach(async ({ page }) => { await page.clock.setFixedTime(new Date(`${MONDAY}T07:00:00`)); });

  test('Saturday’s training logged later keeps the streak going through Sunday', async ({ page }) => {
    await seed(page, { entries: [{ date: '2026-10-10', wellness: WELLNESS() }], hash: '#today' });
    // Until Monday is done, Sunday can still be made up.
    await expect(page.locator('.streak')).toHaveCount(0);
    await page.goto('/#workouts/2026-10-10');
    await answerWorkout(page);
    await page.click('#save-workout');
    await page.waitForURL(/#workouts$/);
    await page.goto('/#morning');
    await answerAll(page);
    await page.click('#save');
    await finishCheckin(page); // asked about Sunday: skipped
    await expect(page.locator('.streak')).toHaveText('🔥 3-day streak'); // Sat, Sun (made up), Mon
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
  await seed(page, { entries: [past(2), past(1)], hash: '#morning' });
  await answerAll(page, { value: 2 });
  await page.click('#save');
  await finishCheckin(page);
  const hero = page.locator('.hero');
  await expect(hero.locator('h2')).toHaveText('Thanks for checking in!');
  await expect(hero).toContainText('After 3 more check-ins, you’ll see how each day compares with your usual.');
  await expect(page.locator('.score-num, .advice, .flags')).toHaveCount(0);
  await expect(page.locator('#view')).not.toContainText(/light session|recovery|trimming|\/100/);

  // A low day after a handful of usual ones: neutral wording, keep to the program.
  await seed(page, { entries: [6, 5, 4, 3, 2, 1].map((n) => past(n)), hash: '#morning' });
  await answerAll(page, { value: 2 });
  await pick(page, 'input[name=painLevel][value="3"]');
  await page.click('#save');
  await finishCheckin(page);
  await expect(hero.locator('.usual')).toHaveText('Feeling a bit below usual');
  await expect(hero).toContainText('Keep following your program');
  await expect(hero.locator('.injury-note')).toContainText('talk to your coach before practice');
});

test('Sunday counts as a day off; after the check-in, each unlogged day this week is asked for in turn', async ({ page }) => {
  await page.clock.setFixedTime(atDay(WEEK.mon));
  await seed(page, {
    entries: [
      { date: '2026-10-08', wellness: WELLNESS(), workouts: LOGGED },
      { date: '2026-10-09', wellness: WELLNESS() }, // Friday: not logged
      { date: WEEK.sat, wellness: WELLNESS() }, // Saturday: not logged
    ],
    hash: '#morning',
  });
  await answerAll(page);
  await page.click('#save');
  // Sunday is skipped (assumed off): Saturday first, then Friday.
  await page.waitForURL(new RegExp(`#workouts/${WEEK.sat}\\?after=checkin`));
  await expect(page.locator('.welcome')).toContainText('Saturday’s training isn’t logged yet');
  await answerWorkout(page);
  await page.click('#save-workout');
  await page.waitForURL(/#workouts\/2026-10-09\?after=checkin/);
  await answerWorkout(page, { am: ['no', 'sick'], pm: ['no'] });
  await page.click('#save-workout');
  await page.waitForURL(/#today$/);
  await expect(page.locator('#yesterday-line')).toHaveText('✓ Yesterday: day off (Sunday)');
  await expect(page.locator('#gaps-line')).toHaveCount(0);
  expect((await entryOn(page, '2026-10-09')).workouts.am).toEqual({ none: 'sick' });

  await page.goto('/#workouts');
  await expect(page.locator(`[data-day="${WEEK.sun}"] .wk-status`)).toHaveText('Off (Sunday)');
});

test('Today lists earlier unlogged days to fill in', async ({ page }) => {
  await page.clock.setFixedTime(atDay(WEEK.wed));
  await seed(page, {
    entries: [
      { date: WEEK.mon, wellness: WELLNESS() }, // Monday: not logged
      { date: WEEK.tue, wellness: WELLNESS(), workouts: LOGGED },
      { date: WEEK.wed, wellness: WELLNESS() },
    ],
    hash: '#today',
  });
  await expect(page.locator('#yesterday-line')).toHaveText('✓ Yesterday’s training logged');
  await expect(page.locator('#gaps-line')).toContainText('Monday’s training not logged');
  await expect(page.locator('#gaps-line a')).toHaveAttribute('href', `#workouts/${WEEK.mon}`);
});
