/**
 * R30 / AT15 (T30; 06-design §11.10 item 7, design spec §0.7): the landing hero mounts WebGL only
 * when the visual budget allows it, and is its SSR poster and nothing else otherwise.
 *  - `reduced-motion` (prefers-reduced-motion: reduce), `no-webgl` (Chromium with --disable-webgl
 *    --disable-webgl2) and viewports narrower than 768px: "/" renders the poster, no <canvas> ever
 *    appears (even after idle, scrolling the whole page and coming back), and the console stays
 *    clean (no error loop from a scene that keeps failing to start).
 *  - Every other project: the scene mounts after idle (a <canvas> and data-visual-state="webgl"),
 *    with a clean console.
 * The page claims 8 cores first, so the outcome comes from the project's condition and not from a
 * small CI machine (the budget also turns WebGL off at 4 cores or fewer).
 */
import { expect, test, type Page } from '@playwright/test';

const FALLBACK_PROJECTS: readonly string[] = ['reduced-motion', 'no-webgl'];
/** The hero preset's minimum width (src/components/visual/aura/aura-layout.ts). */
const HERO_MIN_WIDTH = 768;

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', { configurable: true, get: () => 8 });
  });
});

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    // The browser's own favicon probe is not the page's doing.
    if (/\/favicon\.ico$/.test(message.location().url)) return;
    errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

test('the landing hero mounts WebGL only when the visual budget allows it, and logs no errors', async ({ page }, testInfo) => {
  const errors = collectErrors(page);
  const width = page.viewportSize()?.width ?? 1280;
  const posterOnly = FALLBACK_PROJECTS.includes(testInfo.project.name) || width < HERO_MIN_WIDTH;

  const response = await page.goto('/');
  expect(response?.status()).toBe(200);

  const hero = page.locator('[data-aura="hero"]');
  await expect(hero).toHaveAttribute('aria-hidden', 'true');
  // The SSR poster is always there first (it is the LCP-safe fallback).
  await expect(hero.locator('[data-aura-poster="hero"]')).toHaveCount(1);

  if (posterOnly) {
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
  } else {
    // After idle and the in-view check the scene mounts and takes over from the poster.
    await expect(hero.locator('canvas')).toHaveCount(1, { timeout: 15_000 });
    await expect(hero.locator('[data-visual-state="webgl"]')).toHaveCount(1, { timeout: 15_000 });
  }

  // The page itself is complete either way.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Leads in\.\s*Quotes out\./);
  await expect(page.getByRole('main').getByRole('link', { name: /^(Open live demo|Sign in)/ }).first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);

  expect(errors).toEqual([]);
});
