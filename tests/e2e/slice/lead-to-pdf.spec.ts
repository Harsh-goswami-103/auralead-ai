/**
 * T17 vertical slice in the browser (R32 console part, plan §11 M2) against the built DEMO app and
 * its worker (T09 harness): the employee opens the Smile Avenue lead console, simulates one Maps
 * extension record, opens the new lead once the worker has normalized it, sees its score and the
 * pipeline's AI draft, asks for another draft, creates a quote from the proposal, approves v1 and
 * downloads the worker-rendered PDF. Every button's effect is read back from the server after a
 * reload, so nothing is only client state.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

const WS = 'smile-avenue-dental';
const CONSOLE = `/dashboard/employee/${WS}/leads`;
const WORKER_WAIT = { timeout: 45_000 };

function control(): Record<string, string> {
  const t = process.env.E2E_TEST_CONTROL_TOKEN;
  if (!t) throw new Error('E2E_TEST_CONTROL_TOKEN is not set: run through the T09 harness');
  return { 'x-test-control-token': t };
}

async function resetAll(request: APIRequestContext) {
  expect((await request.post('/api/test/clock', { headers: control(), data: { reset: true } })).status()).toBe(200);
  expect((await request.post('/api/test/reset', { headers: control() })).status()).toBe(200);
}

async function signInAsEmployee(page: Page) {
  await page.goto('/login');
  await page.getByRole('button', { name: /^Employee/ }).first().click();
  await page.waitForURL('**/dashboard/employee');
}

test.beforeEach(async ({ request }) => {
  await resetAll(request);
});

test.afterAll(async ({ request }) => {
  await resetAll(request);
});

test('simulated Maps lead -> score -> draft -> quote from proposal -> approve -> PDF download', async ({ page }) => {
  test.setTimeout(180_000);
  await signInAsEmployee(page);
  await page.goto(CONSOLE);
  await expect(page.getByRole('heading', { level: 1, name: 'Lead console' })).toBeVisible();
  await expect(page.getByText('No leads yet')).toBeVisible();

  // Simulate one Maps extension record; the panel re-reads the page until the worker processed it.
  await page.getByLabel('Records').selectOption('1');
  await page.locator('li', { hasText: 'Maps extension batch' }).getByRole('button', { name: 'Simulate' }).click();
  const leadLink = page.getByRole('table').getByRole('link').first();
  await expect(leadLink).toBeVisible(WORKER_WAIT);
  const leadName = (await leadLink.textContent())!.trim();
  await leadLink.click();
  await page.waitForURL(new RegExp(`${CONSOLE}/[^/]+$`));
  await expect(page.getByRole('heading', { level: 1, name: leadName })).toBeVisible();

  // The pipeline scores the lead and writes the draft with the local deterministic generator (DEMO).
  await expect(page.locator('[data-field="draft-status"]')).toHaveText('Ready for review', WORKER_WAIT);
  await expect(page.locator('[data-field="score"]')).toHaveText(/^\d{1,3} \/ 100$/);
  await expect(page.locator('[data-stage="DRAFT"]')).toContainText('Done');
  await expect(page.getByText('Local template (deterministic) · Pipeline')).toBeVisible();

  // "Generate draft": the worker writes a second, requested draft.
  await page.getByRole('button', { name: 'Generate draft' }).click();
  await expect(page.getByText('1 earlier draft(s) kept for the record.')).toBeVisible(WORKER_WAIT);
  await expect(page.getByText('Local template (deterministic) · Requested')).toBeVisible();

  // "Create quote from proposal": DRAFT v1, priced by the server.
  await page.getByRole('button', { name: 'Create quote from proposal' }).click();
  const quote = page.locator('[data-quote-number]').first();
  await expect(quote).toBeVisible();
  await expect(quote.locator('[data-quote-status="DRAFT"]')).toBeVisible();
  await expect(quote).toContainText(/₹[\d,]+\.\d{2}/);
  const number = await quote.getAttribute('data-quote-number');
  expect(number).toMatch(/^Q-\d{4}$/);

  // Approve v1.
  await quote.getByRole('button', { name: 'Approve v1' }).click();
  await expect(quote.locator('[data-quote-status="APPROVED"]')).toBeVisible();

  // The worker renders the PDF; the page shows the download once the artifact exists.
  const download = quote.getByRole('link', { name: 'Download PDF' });
  await expect(download).toBeVisible(WORKER_WAIT);
  const [file] = await Promise.all([page.waitForEvent('download'), download.click()]);
  expect(file.suggestedFilename()).toContain(number!);
  const bytes = readFileSync((await file.path())!);
  expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');

  // Everything above is persisted: a fresh read shows the same state.
  await page.reload();
  const again = page.locator(`[data-quote-number="${number}"]`);
  await expect(again.locator('[data-quote-status="APPROVED"]')).toBeVisible();
  await expect(again.getByRole('link', { name: 'Download PDF' })).toBeVisible();
  await expect(page.getByText('1 earlier draft(s) kept for the record.')).toBeVisible();

  // Back in the console list the lead shows its score and links to the same detail page.
  await page.getByRole('link', { name: 'Lead console', exact: true }).click();
  await page.waitForURL(`**${CONSOLE}`);
  const row = page.getByRole('row', { name: new RegExp(leadName) });
  await expect(row).toContainText(/\d{1,3} \/ 100/);
});
