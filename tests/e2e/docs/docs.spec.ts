/**
 * T37 (plan §11 M6): the in-app documentation in a real browser, against the built app started by
 * tests/e2e/support. Runs in every project (390 px to 1920 px, reduced motion, no WebGL):
 *  - /docs and every /docs/[slug] answer 200 with one h1, the "Applies to" tags (icon plus text)
 *    and no console or page errors;
 *  - every "On this page" link and every in-page #anchor points at an element that exists, and
 *    following a TOC link scrolls its section into view and updates the URL hash;
 *  - the page never scrolls sideways (code blocks and tables scroll inside their own region);
 *  - the skip link is the first tab stop and moves focus to the main content;
 *  - an unknown page is a 404;
 *  - the landing page links to /docs from its nav (from 1024 px) and its footer.
 * The page list comes from the content index, so a new page is covered automatically.
 */
import { expect, test, type Page } from '@playwright/test';
import { DOC_PAGES } from '../../../content/docs/index';

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (/\/favicon\.ico$/.test(message.location().url)) return;
    errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

async function noHorizontalScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
}

async function danglingAnchors(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')]
      .map((a) => a.getAttribute('href')!.slice(1))
      .filter((id) => id !== '' && document.getElementById(decodeURIComponent(id)) === null),
  );
}

test('the docs index lists every page with its Applies to tags', async ({ page }) => {
  const errors = collectErrors(page);
  const response = await page.goto('/docs');
  expect(response?.status()).toBe(200);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Documentation');
  await expect(page.locator('h1')).toHaveCount(1);
  const main = page.getByRole('main');
  for (const doc of DOC_PAGES) await expect(main.getByRole('link', { name: doc.title, exact: true })).toBeVisible();
  await expect(main.locator('[data-applies-to]')).toHaveCount(DOC_PAGES.length);
  expect(await danglingAnchors(page)).toEqual([]);
  await noHorizontalScroll(page);
  expect(errors).toEqual([]);
});

for (const doc of DOC_PAGES) {
  test(`/docs/${doc.slug} renders, its anchors resolve and it has no console errors`, async ({ page }) => {
    const errors = collectErrors(page);
    const response = await page.goto(`/docs/${doc.slug}`);
    expect(response?.status()).toBe(200);

    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(doc.title);

    // Applies to: one tag per mode, each an icon plus its text.
    const applies = page.locator('[data-applies-to]').first();
    await expect(applies).toContainText('Applies to');
    for (const mode of doc.appliesTo) {
      const tag = applies.locator(`[data-mode-tag="${mode}"]`);
      await expect(tag).toHaveText(mode);
      await expect(tag.locator('svg')).toHaveCount(1);
    }

    // Every in-page anchor has its target; "On this page" lists every section.
    expect(await danglingAnchors(page)).toEqual([]);
    const toc = page.getByRole('navigation', { name: 'On this page' });
    await expect(toc.getByRole('link')).toHaveCount(doc.sections.length);

    // Following the last TOC link scrolls that section into view and sets the hash.
    const last = doc.sections[doc.sections.length - 1]!;
    await toc.getByRole('link', { name: last.title, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`#${last.id}$`));
    await expect(page.locator(`[id="${last.id}"]`)).toBeInViewport();

    await noHorizontalScroll(page);
    expect(errors).toEqual([]);
  });
}

test('the skip link is the first tab stop and moves focus to the content', async ({ page }) => {
  await page.goto(`/docs/${DOC_PAGES[0]!.slug}`);
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to content' });
  await expect(skip).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/#main$/);
  await expect(page.locator('main#main')).toBeInViewport();
});

test('the Copy button of a code block puts the code on the clipboard', async ({ page, context }) => {
  // Every project is Chromium (playwright.config.ts), where these permissions exist.
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/docs/getting-started');
  const figure = page.getByRole('figure').first();
  const code = await figure.locator('pre code').innerText();
  await figure.getByRole('button', { name: /^Copy code/ }).click();
  await expect(figure.getByRole('button', { name: /^Copy code/ })).toContainText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(code);
});

test('an unknown docs page is a 404', async ({ page }) => {
  const response = await page.goto('/docs/no-such-page');
  expect(response?.status()).toBe(404);
});

test('the landing page links to the docs from its nav and footer', async ({ page }) => {
  await page.goto('/');
  const width = page.viewportSize()?.width ?? 1280;
  const footerLink = page.getByRole('contentinfo').getByRole('link', { name: 'Documentation' });
  await expect(footerLink).toHaveAttribute('href', '/docs');
  if (width >= 1024) await expect(page.getByRole('banner').getByRole('link', { name: 'Docs', exact: true })).toHaveAttribute('href', '/docs');
  await footerLink.click();
  await expect(page).toHaveURL(/\/docs$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Documentation');
});
