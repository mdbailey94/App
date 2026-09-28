// A camera that never sees a fingertip (Chrome's moving test pattern).
import { test, expect, seed, readingResult } from './helpers.mjs';
import { fakeCamera } from '../../playwright.config.mjs';

test.use({ launchOptions: fakeCamera() });

test('no fingertip: the reading ends with advice and a diagnostics report', async ({ page }) => {
  await seed(page, { hash: '#measure' });
  await page.click('#start');
  await readingResult(page);
  await expect(page.locator('#measure-result h3')).toHaveText('Reading didn’t work');
  await expect(page.locator('#measure-result')).toContainText('couldn’t see a fingertip');
  await expect(page.locator('#try-front')).toBeVisible();

  await page.click('.diag summary');
  const report = JSON.parse((await page.inputValue('#diag-text')).replace(/^[^{]*/, ''));
  expect(report.fingerOnPct).toBe(0);
  expect(report.frames).toBeGreaterThan(100);
  expect(report.camera.label).toBeTruthy();
});
