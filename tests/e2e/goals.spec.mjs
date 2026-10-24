// The Goals tab: times in, gears out (checked against the coach's Gears
// sheet), practice times logged against them, and what the coach sees.
import { test, expect, seed, dayISO, GROUP_CODE, COACH_PASSWORD, sheetFor, ENTRIES } from './helpers.mjs';
import { buildItems } from '../../src/team.js';

const fill = async (page, name, value) => page.fill(`[name="${name}"]`, value);

async function setUpGoals(page) {
  await seed(page, { hash: '#goals' });
  await page.click('#setup-goals');
  await expect(page).toHaveURL(/#goals\/edit/);
  await page.selectOption('[name=sex]', 'boys');
  await fill(page, 'factor', '1.050'); // the 200 Chart's factor, so the numbers match the sheet
  await fill(page, 'best-free-50', '23.5');
  await fill(page, 'goal-free-50', '22.49');
  await fill(page, 'goal-free-200', '200.0'); // no colon on a phone keypad: 2:00.0
  await expect(page.locator('[name="goal-free-200"] + .read-as')).toHaveText('= 2:00.0');
  await fill(page, 'best-free-100', '175');
  await expect(page.locator('[name="best-free-100"] + .read-as')).toHaveText('?'); // 1:75 isn't a time
  await fill(page, 'best-free-100', '');
  await fill(page, 'best-free-500', '5:30.0');
  await fill(page, 'goal-im-400', '4:00');
  await fill(page, 'goal-back-200', '2:00');
  await page.click('#save-goals');
  await expect(page).toHaveURL(/#goals$/);
}

test('goal presets: every goal with a best becomes 1, 2 or 3% faster; the stroke strip moves between pages', async ({ page }) => {
  await seed(page, { hash: '#goals/edit' });
  await fill(page, 'best-free-50', '23.50');
  await fill(page, 'best-free-200', '2:00.0');
  await page.click('[data-faster="2"]');
  await expect(page.locator('[name="goal-free-50"]')).toHaveValue('23.03');
  await expect(page.locator('[name="goal-free-200"]')).toHaveValue('1:57.6');
  await expect(page.locator('[name="goal-free-100"]')).toHaveValue('');
  await expect(page.locator('#preset-note')).toHaveText('2 goals set 2% faster than your best. Change any of them.');
  await page.click('[data-faster="3"]');
  await expect(page.locator('[name="goal-free-200"]')).toHaveValue('1:56.4');
  await page.click('#save-goals');
  await page.goto('/#goals/free');
  await expect(page.locator('.stroke-strip a[aria-current]')).toHaveText('Free');
  await expect(page.locator('.stroke-strip a')).toHaveText(['Free', 'Back', 'Breast', 'Fly', 'IM', 'Speed']);
  await page.click('.stroke-strip a:has-text("Speed")');
  await expect(page).toHaveURL(/#goals\/speed/);
  await expect(page.locator('.page-title h2')).toHaveText('Speed');
});

test('goals: times in, then the freestyle gears per 100 and per 50 match the 200 Chart', async ({ page }) => {
  await setUpGoals(page);
  await expect(page.locator('.goal-tile', { hasText: 'Freestyle' })).toContainText('G3 1:10.5 /100');
  await expect(page.locator('.goal-tile', { hasText: 'Breaststroke' })).toContainText('Add a 200 or 100');
  await page.click('.goal-tile:has-text("Freestyle")');
  await expect(page).toHaveURL(/#goals\/free/);
  await expect(page.locator('.gear-page')).toContainText('From your goal 200 free: 2:00.0');
  const pace = (gear) => page.locator(`tr[data-gear="${gear}"] td.pace`);
  await expect(pace('G2')).toHaveText('1:15.4');
  await expect(pace('G3')).toHaveText('1:10.5');
  await expect(pace('G4')).toHaveText('1:06.0');
  await expect(pace('G5')).toHaveText('1:02.7');
  await expect(pace('G6')).toHaveText('1:00.0');
  await expect(page.locator('tr[data-gear="G3"] td').nth(1)).toHaveText('9 s'); // rest per 100 at G3
  // Per 50, and the best times instead (from the 500: slower gears).
  await page.click('.per-seg a:has-text("50")');
  await expect(pace('G3')).toHaveText('35.3');
  await page.click('.use-seg a:has-text("Best times")');
  await expect(page.locator('.gear-page')).toContainText('From your best 500 free: 5:30.0');
  await expect(page.locator('.use-seg a[aria-current]')).toHaveText('Best times');
  // Saved goals are on today's entry, so they reach the coach.
  const entry = await page.evaluate(([k, d]) => JSON.parse(localStorage.getItem(k)).find((e) => e.date === d), [ENTRIES, dayISO()]);
  expect(entry.goals.times['free-200'].goal).toBe(120);
  expect(entry.goals.sex).toBe('boys');
});

test('goals: IM gears with each stroke and the switches; speed targets from the 50 (Speed Table row)', async ({ page }) => {
  await setUpGoals(page);
  await page.goto('/#goals/im');
  await expect(page.locator('.gear-page')).toContainText('From your goal 400 IM: 4:00.0');
  const pace = (gear) => page.locator(`.gear-page tr[data-gear="${gear}"] td.pace`);
  await expect(pace('G2')).toHaveText('1:12.9');
  await expect(pace('G3')).toHaveText('1:08.3');
  // Each stroke as 100s (its share of a 400 IM at G3, boys' shares) with rest; then as single lengths.
  const g3 = page.locator('.im-strokes tr[data-gear="G3"] td');
  await expect(page.locator('.split-seg a[aria-current]')).toHaveText('100s');
  await expect(g3).toHaveText(['1:03.3', '1:08.3', '1:16.4', '1:05.0', '10 s']);
  await page.click('.split-seg a:has-text("25s")');
  await expect(page).toHaveURL(/split=25/);
  await expect(g3).toHaveText(['15.8', '17.1', '19.1', '16.2', '1 s']);
  await page.click('.split-seg a:has-text("50s")');
  await expect(g3).toHaveText(['31.7', '34.1', '38.2', '32.5', '4 s']);
  await expect(page.locator('.im-switches thead th')).toHaveText(['Gear', /Fly–back/, /Back–breast/, /Breast–free/, 'Rest']);
  const flyBack = page.locator('.im-switches tr[data-gear="G3"] td').first();
  await expect(flyBack).toContainText('32.9');
  await expect(flyBack).toContainText('1:05.8');
  await expect(page.locator('.im-switches tr[data-gear="G3"] td').last()).toHaveText('3 s · 8 s');

  await page.goto('/#goals/speed');
  const free = page.locator('.speed-card[data-stroke=free]');
  await expect(free.locator('h3')).toContainText('2.06 yd/s');
  await expect(free.locator('tr', { hasText: '15 m dive' }).first().locator('td b')).toHaveText('6.36');
  await expect(free.locator('tr', { hasText: '25 push' }).locator('td b')).toHaveText('10.62');
  await expect(free.locator('tr', { hasText: 'Predicted 100' }).locator('td b')).toHaveText('49.12');
  await expect(free.locator('tr[data-zone=S3] td.pace')).toContainText('12.07');
  await expect(free.locator('tr[data-zone=S2] td.pace')).toContainText('rest 44 s');
  await expect(page.locator('.speed-card')).toHaveCount(1); // only the free has a 50
  // Backstroke has its own model: starts in the water.
  await page.goto('/#goals/edit');
  await fill(page, 'goal-back-50', '24.5');
  await page.click('#save-goals');
  await page.goto('/#goals/speed');
  const back = page.locator('.speed-card[data-stroke=back]');
  await expect(back.locator('tr').first()).toContainText('15 m start');
  await expect(back.locator('tr').first()).toContainText('from the signal');
  await expect(back.locator('tr', { hasText: 'Predicted 100' }).locator('td b')).toHaveText('53.54');
});

test('practice times: log sets, see the trend against the gear, delete one', async ({ page }) => {
  await setUpGoals(page);
  await page.goto('/#goals/log');
  await fill(page, 'date', dayISO(2));
  await page.selectOption('[name=stroke]', 'free');
  await page.selectOption('[name=dist]', '100');
  await page.selectOption('[name=gear]', 'G3');
  await fill(page, 'reps', '10');
  await fill(page, 'avg', '1:12.0');
  await fill(page, 'rest', '10');
  await page.click('#save-set');
  await expect(page).toHaveURL(/#goals\/log\?stroke=free&dist=100/);
  await expect(page.locator('#trend-line')).toContainText('Last 1 sets average 1:12.0 · G3 target 1:10.5 (+1.5 s)');
  await fill(page, 'date', dayISO(0));
  await fill(page, 'reps', '10');
  await fill(page, 'avg', '1:10.0');
  await page.click('#save-set');
  await expect(page.locator('#trend-line')).toContainText('Last 2 sets average 1:11.0 · G3 target 1:10.5 (+0.5 s)');
  await expect(page.locator('[data-c="trend"] .series-dot:not(.alt)')).toHaveCount(2);
  await expect(page.locator('.targets .target.on')).toHaveText('G3 1:10.5');
  await expect(page.locator('#recent-sets li')).toHaveCount(2);
  await expect(page.locator('#recent-sets li').first()).toContainText('10 × 100 free @ G3 avg 1:10.0');
  // The set is on its day's entry.
  const entry = await page.evaluate(([k, d]) => JSON.parse(localStorage.getItem(k)).find((e) => e.date === d), [ENTRIES, dayISO(2)]);
  expect(entry.sets[0]).toMatchObject({ stroke: 'free', dist: 100, gear: 'G3', reps: 10, avg: 72, rest: 10 });
  await page.locator('#recent-sets li').first().locator('[data-del]').click();
  await expect(page.locator('#recent-sets li')).toHaveCount(1);
  await expect(page.locator('#trend-line')).toContainText('Last 1 sets average 1:12.0');
  // The overview lists recent sets.
  await page.goto('/#goals');
  await expect(page.locator('#practice-times')).toContainText('10 × 100 free @ G3 avg 1:12.0');
});

test('coach: a swimmer’s goals, gears and practice-time trend on their page', async ({ page, request }, testInfo) => {
  const W = (v) => ({ sleepHours: 8, scaleMax: 7, sleepQuality: v, energy: v, soreness: v, stress: v, mood: v, motivation: v });
  const entries = [
    { date: dayISO(3), wellness: W(5), goals: { sex: 'girls', age: '15-16', factor: 1.05, course: 'SCY', updatedAt: `${dayISO(3)}T12:00:00Z`, times: { 'free-200': { goal: 120 }, 'fly-100': { goal: 60 } } },
      sets: [{ id: 'a', stroke: 'free', dist: 100, gear: 'G3', reps: 10, avg: 72 }] },
    { date: dayISO(1), wellness: W(5), sets: [{ id: 'b', stroke: 'free', dist: 100, gear: 'G3', reps: 10, avg: 71 }] },
    { date: dayISO(0), wellness: W(5) },
  ];
  const res = await request.post(sheetFor(testInfo).url, {
    headers: { 'Content-Type': 'text/plain' },
    data: JSON.stringify({ action: 'submit', group: GROUP_CODE, athlete: 'Pia Novak', items: buildItems(entries, entries) }),
  });
  expect((await res.json()).ok).toBe(true);
  await page.goto('/coach.html');
  await page.evaluate((c) => localStorage.setItem('athlete-readiness/coach/v1', JSON.stringify(c)), { url: sheetFor(testInfo).url, password: COACH_PASSWORD, group: GROUP_CODE });
  await page.goto('/coach.html#swimmers/pia%20novak');
  const card = page.locator('#swimmer-goals');
  await expect(card).toContainText('Fatigue factor 1.050');
  const free = card.locator('tbody tr', { hasText: 'Free' });
  await expect(free.locator('td')).toHaveText(['200 free 2:00.0', '1:15.4', '1:10.5', '1:06.0', '1:02.7', '1:00.0']);
  await expect(card.locator('tbody tr', { hasText: 'Fly' }).locator('td').first()).toContainText('est. 200 fly');
  await expect(card).toContainText('2 sets logged; last 3 average 1:11.5 vs G3 target 1:10.5');
  await expect(card.locator('[data-c="goal-trend"] svg')).toBeVisible();
});
