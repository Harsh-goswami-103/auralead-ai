/**
 * R30 / AT15 (T30; 06-design §11.10 item 7, design spec §0.7): when WebGL must not run, the landing
 * hero is its SSR poster and nothing else. In the `reduced-motion` project (prefers-reduced-motion:
 * reduce) and the `no-webgl` project (Chromium with --disable-webgl --disable-webgl2):
 *  - "/" renders the poster ([data-visual-state="poster"] with the hero's SVG poster);
 *  - no <canvas> ever appears, even after idle, scrolling the whole page and coming back;
 *  - the console stays clean (no error loop from a scene that keeps failing to start).
 * The page claims 8 cores first, so the fallback is caused by the project's condition and not by a
 * small CI machine (the budget also turns WebGL off at 4 cores or fewer). Other projects may mount
 * the canvas, so the spec skips itself there.
 */
import { expect, test } from '@playwright/test';

const FALLBACK_PROJECTS: readonly string[] = ['reduced-motion', 'no-webgl'];

test.beforeEach(async ({ context }, testInfo) => {
  test.skip(
    !FALLBACK_PROJECTS.includes(testInfo.project.name),
    `WebGL fallback runs only in the ${FALLBACK_PROJECTS.join(' and ')} projects; "${testInfo.project.name}" may legitimately mount the canvas`,
  );
  await context.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { configurable: true, get: () => 8 });
  });
});

test('the landing hero shows the poster, never a canvas, and logs no errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    // The browser's own favicon probe is not the page's doing.
    if (/\/favicon\.ico$/.test(message.location().url)) return;
    errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));

  const response = await page.goto('/');
  expect(response?.status()).toBe(200);

  const hero = page.locator('[data-aura="hero"]');
  await expect(hero).toHaveAttribute('aria-hidden', 'true');
  await expect(hero.locator('[data-visual-state="poster"]')).toHaveCount(1);
  await expect(hero.locator('[data-aura-poster="hero"]')).toBeVisible();

  // Past the shell's idle callback (<= 1.5 s) and in-view check: nothing may mount.
  await page.waitForTimeout(3000);
  await expect(page.locator('canvas')).toHaveCount(0);

  // Scroll the whole page (in-view reveals, beams) and come back to the hero.
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < height; y += 600) {
    await page.evaluate((top) => window.scrollTo(0, top), y);
    await page.waitForTimeout(100);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(1500);

  await expect(page.locator('canvas')).toHaveCount(0);
  await expect(page.locator('[data-visual-state="webgl"]')).toHaveCount(0);
  await expect(hero.locator('[data-visual-state="poster"]')).toHaveCount(1);

  // The page itself is complete without WebGL.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Leads in\.\s*Quotes out\./);
  await expect(page.getByRole('main').getByRole('link', { name: /^(Open live demo|Sign in)/ }).first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

  expect(errors).toEqual([]);
});
