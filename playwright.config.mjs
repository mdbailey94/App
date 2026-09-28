// Browser tests: `npm run test:e2e`. They drive the real app in Chromium with
// a fake camera (a generated fingertip video) and fake group sheets.
import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { PORT } from './tests/e2e/constants.mjs';

export const FINGER_VIDEO = fileURLToPath(new URL('./tests/e2e/.cache/finger.y4m', import.meta.url));

// Chrome's fake camera: `video` is a .y4m file, or omitted for Chrome's own
// moving test pattern (which looks nothing like a fingertip).
export const fakeCamera = (video) => ({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    ...(video ? [`--use-file-for-fake-video-capture=${video}`] : [])],
});

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: '*.spec.mjs',
  globalSetup: './tests/e2e/global-setup.mjs',
  timeout: 150_000, // a heart reading alone takes about 65 s
  expect: { timeout: 10_000 },
  workers: process.env.CI ? 2 : 3,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}/`,
    viewport: { width: 390, height: 844 },
    permissions: ['camera', 'clipboard-read', 'clipboard-write'],
    launchOptions: fakeCamera(FINGER_VIDEO),
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `node tests/e2e/server.mjs`,
    env: { PORT: String(PORT) },
    url: `http://localhost:${PORT}/index.html`,
    reuseExistingServer: !process.env.CI,
  },
});
