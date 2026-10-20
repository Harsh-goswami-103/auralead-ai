import { defineConfig } from '@playwright/test';

// AT1 (T38): the fresh-copy acceptance test builds its own copy of the repository, so it has no
// global setup (playwright.config.ts builds and starts the repository's own apps and ignores it).
export default defineConfig({
  testDir: 'tests/e2e/smoke',
  testMatch: /fresh-setup\.spec\.ts/,
  outputDir: 'test-results/fresh-setup',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  projects: [{ name: 'fresh-setup' }],
});
