// Heart readings on the HRV screen, with the fake fingertip video.
import { test, expect, seed, settings, todayEntry, readingResult } from './helpers.mjs';

test('back-camera reading saves heart rate and HRV', async ({ page }) => {
  await seed(page, { hash: '#measure' });
  await page.click('#start');
  await expect(page.locator('#finger')).toContainText(/Hold still|Reading/, { timeout: 20_000 });
  await readingResult(page);
  await expect(page.locator('#measure-result h3')).toHaveText('✓ Thanks – reading saved');

  const { hrv } = await todayEntry(page);
  expect(hrv.source).toBe('camera');
  expect(hrv.hr).toBeGreaterThan(50);
  expect(hrv.hr).toBeLessThan(70);
  expect(hrv.quality).not.toBe('poor');
  // After a first reading the normal way, reading during the check-in is offered.
  await expect(page.locator('#measure-result .offer')).toContainText('Save time');
});

test('front camera: the whole screen lights the fingertip', async ({ page }) => {
  await seed(page, { hash: '#measure' });
  await page.click('#front-mode');
  await expect(page.locator('#measure-intro .steps')).toContainText('front camera');
  expect((await settings(page)).frontCamera).toBe(true);

  await page.click('#start');
  const live = page.locator('#measure-live');
  await expect(live).toHaveClass(/front-light/);
  await expect(live).toHaveCSS('position', 'fixed');
  await expect(live).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(page.locator('.tabs')).toHaveCSS('visibility', 'hidden');

  await readingResult(page);
  await expect(page.locator('#measure-result h3')).toHaveText('✓ Thanks – reading saved');
  await expect(page.locator('.tabs')).toHaveCSS('visibility', 'visible');
  // The screen is the light, so reading during the check-in isn't offered.
  await expect(page.locator('#measure-result .offer')).toHaveCount(0);
});
