/**
 * M1 smoke (T09; R35, P19, E11) against the built app started by tests/e2e/support:
 *  - /api/health is 200 on the DEMO build;
 *  - the DEMO role switcher is on every route and opens each panel, which shows seeded,
 *    DB-derived identity and workspace data;
 *  - the LIVE build ships no switcher (absent from the DOM and from every client chunk) and
 *    answers 404 on the DEMO persona route.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const MARKER = 'data-demo-role-switcher';

function liveBaseURL(): string {
  const url = process.env.E2E_LIVE_BASE_URL;
  if (!url) throw new Error('E2E_LIVE_BASE_URL is not set: run through the T09 harness (playwright.config.ts globalSetup)');
  return url;
}

function chunkFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...chunkFiles(full));
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

const repoRoot = () => process.env.E2E_REPO_ROOT ?? process.cwd();

async function switchTo(page: Page, persona: 'Workspace owner' | 'Employee' | 'Super admin') {
  await page.getByRole('button', { name: /^Demo role/ }).click();
  await page.getByRole('button', { name: new RegExp(`^${persona}`) }).click();
}

test('GET /api/health is 200 on the DEMO build', async ({ request }) => {
  const res = await request.get('/api/health');
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ status: 'ok', mode: 'demo' });
  expect(res.headers()['x-request-id']).toBeTruthy();
});

test('the role switcher opens each panel with seeded data', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Open the demo' })).toBeVisible();
  await expect(page.locator(`[${MARKER}]`).first()).toBeAttached();

  // Seeded-identity sign-in on /login.
  await page.getByRole('button', { name: /^Workspace owner/ }).first().click();
  await page.waitForURL('**/dashboard/user');
  await expect(page.getByRole('heading', { level: 1, name: 'Smile Avenue Dental Clinic' })).toBeVisible();
  // The command center (T25): DB-derived KPIs with O6 labels, and the "As of" time.
  await expect(page.getByText('Pipeline value', { exact: true })).toBeVisible();
  await expect(page.getByText('Accepted quote value', { exact: true })).toBeVisible();
  await expect(page.getByText('Confirmed revenue', { exact: true })).toBeVisible();
  await expect(page.getByText(/^As of /)).toBeVisible();

  // The floating switcher is on panel routes too.
  await switchTo(page, 'Employee');
  await page.waitForURL('**/dashboard/employee');
  await expect(page.getByRole('heading', { level: 1, name: 'Assignments' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Kesari Crafts Online' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Smile Avenue Dental Clinic' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'NestKey Realty Advisors' })).toHaveCount(0);

  await switchTo(page, 'Super admin');
  await page.waitForURL('**/dashboard/admin');
  await expect(page.getByRole('heading', { level: 1, name: 'Global metrics' })).toBeVisible();
  const workspaces = page.locator('dl > div').filter({ has: page.getByText('Workspaces', { exact: true }) });
  // Six DEMO workspaces: the five base tenants and the presentation workspace (ADR-126).
  await expect(workspaces.getByText('6', { exact: true })).toBeVisible();
  // The harness worker is heartbeating against the same DB.
  await expect(page.getByText('Running', { exact: true })).toBeVisible();

  await switchTo(page, 'Workspace owner');
  await page.waitForURL('**/dashboard/user');
  await expect(page.getByRole('heading', { level: 1, name: 'Smile Avenue Dental Clinic' })).toBeVisible();
});

test('a role cannot open another panel', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: /^Employee/ }).first().click();
  await page.waitForURL('**/dashboard/employee');
  const res = await page.goto('/dashboard/admin');
  expect(res?.status()).toBe(404);
});

test('the LIVE build has no role switcher and no DEMO persona route', async ({ browser, request }) => {
  const live = liveBaseURL();
  const context = await browser.newContext({ baseURL: live });
  const page = await context.newPage();
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByLabel('Email')).toBeVisible();
  await expect(page.locator(`[${MARKER}]`)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Demo role/ })).toHaveCount(0);
  await context.close();

  const persona = await request.post(`${live}/api/demo/session`, { data: { persona: 'user' }, headers: { origin: live } });
  expect(persona.status()).toBe(404);
  expect((await request.get(`${live}/api/health`)).status()).toBe(200);

  // Bundle evidence: the marker ships in the DEMO client chunks and in none of the LIVE ones.
  const has = (dir: string) => chunkFiles(path.join(repoRoot(), dir, 'static')).some((f) => readFileSync(f, 'utf8').includes(MARKER));
  expect(has('.next')).toBe(true);
  expect(has('.next-live')).toBe(false);
});
