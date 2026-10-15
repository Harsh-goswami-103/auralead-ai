import { defineConfig, devices } from '@playwright/test';

// Built-app harness (T09, E11): globalSetup builds once (E2E_SKIP_BUILD=1 reuses the builds) and
// starts `next start` + `node dist/worker.js` on free ports against a seeded temp DB, plus a LIVE
// build for the LIVE checks. It exports E2E_BASE_URL before the test workers start; workers
// re-evaluate this config, so baseURL below picks it up.
const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const desktop = devices['Desktop Chrome'];

export default defineConfig({
  testDir: 'tests/e2e',
  globalSetup: './tests/e2e/support/global-setup.ts',
  globalTeardown: './tests/e2e/support/global-teardown.ts',
  outputDir: 'test-results',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'smoke', testMatch: /smoke\/.*\.spec\.ts/, use: { ...desktop } },
    { name: 'w390', use: { ...desktop, viewport: { width: 390, height: 844 }, isMobile: false } },
    { name: 'w768', use: { ...desktop, viewport: { width: 768, height: 1024 } } },
    { name: 'w1440', use: { ...desktop, viewport: { width: 1440, height: 900 } } },
    { name: 'w1920', use: { ...desktop, viewport: { width: 1920, height: 1080 } } },
    { name: 'reduced-motion', use: { ...desktop, viewport: { width: 1440, height: 900 }, contextOptions: { reducedMotion: 'reduce' } } },
    {
      name: 'no-webgl',
      use: { ...desktop, viewport: { width: 1440, height: 900 }, launchOptions: { args: ['--disable-webgl', '--disable-webgl2'] } },
    },
  ],
});
