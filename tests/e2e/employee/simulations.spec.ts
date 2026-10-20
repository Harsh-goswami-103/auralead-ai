/**
 * AT2 through the employee source pages (T28; R11, R32), against the built DEMO app and its worker
 * (T09 harness): on the Sheets, Meta and Extension pages, "Simulate" sends one simulated delivery
 * through the same webhook path and ingestion as the live source; the worker processes it; the
 * page shows it as Processed (an extension batch as Completed) and Simulated with its per-record
 * counts, and it is still there after a reload (durable records, not client state). The Sheets
 * push also installs the demo column mapping with its WhatsApp consent column (P1).
 */
import { expect, test, type Page } from '@playwright/test';
import { eventually, resetAll, signIn, WORKER_WAIT } from '../support/panel-actions';

const WS = 'smile-avenue-dental';

test.beforeEach(async ({ request }) => {
  await resetAll(request);
});

test.afterAll(async ({ request }) => {
  await resetAll(request);
});

async function simulateOne(page: Page, path: string, simulator: string, done = 'Processed') {
  await page.goto(`/dashboard/employee/${WS}/${path}`);
  const box = page.locator(`[data-simulator="${simulator}"]`);
  await box.getByLabel('Records').selectOption('1');
  await box.getByRole('button', { name: 'Simulate' }).click();
  const row = page.locator('[data-delivery]').first();
  await eventually(page, async () => {
    await expect(row).toContainText(done);
  }, WORKER_WAIT.timeout);
  await expect(row).toContainText('Simulated');
  await expect(row).toContainText('1 received');
  await page.reload();
  await expect(page.locator('[data-delivery]').first()).toContainText(done);
}

test('Sheets: a simulated push is processed, shown with counts and the consent mapping, and persists', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, 'Employee');
  await simulateOne(page, 'sheets', 'sheets');
  await expect(page.getByText('WhatsApp consent column')).toBeVisible();
  await expect(page.locator('[data-mapped-field="phone"]')).toContainText('Phone number');
  await expect(page.getByRole('img', { name: 'Demo simulation, Simulated' }).first()).toBeVisible();
});

test('Meta: a simulated Instant Form lead is processed and persists', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, 'Employee');
  await simulateOne(page, 'meta', 'meta');
  await expect(page.locator('[data-form]')).toHaveCount(1);
});

test('Extension: a simulated batch is processed into a batch row and persists', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, 'Employee');
  await simulateOne(page, 'extension', 'gmaps', 'Completed');
});
