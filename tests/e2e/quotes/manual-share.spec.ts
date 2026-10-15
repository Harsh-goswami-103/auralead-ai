/**
 * P15 (T22): "Copy link" hands an APPROVED quotation over and moves it to SENT with sentVia
 * MANUAL_LINK, against the built DEMO app and its worker. The owner creates a quotation for a
 * simulated lead, approves v1, creates a share link (shown once) and copies it: the quotation reads
 * Sent, "Sent manually (link or PDF)" and the timeline entry persist after a reload, and the copied
 * link opens the public quotation with the acceptance form (which needs SENT).
 */
import { expect, test } from '@playwright/test';
import { eventually, resetAll, signIn, simulateSheetsLead } from '../support/panel-actions';

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test.beforeEach(async ({ request }) => {
  await resetAll(request);
});

test.afterAll(async ({ request }) => {
  await resetAll(request);
});

test('copy link moves APPROVED to SENT with MANUAL_LINK', async ({ page, context }) => {
  test.setTimeout(240_000);
  await signIn(page, 'Workspace owner');
  await simulateSheetsLead(page);

  // New quotation for the simulated lead.
  await page.goto('/dashboard/user/quotations/new');
  const leadSelect = page.getByLabel('Lead', { exact: true });
  await eventually(page, async () => {
    await expect(leadSelect.locator('option')).toHaveCount(2);
  });
  await leadSelect.selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Use this lead' }).click();
  await expect(page.getByRole('heading', { name: /^Quotation for / })).toBeVisible();
  if ((await page.getByRole('button', { name: /^Remove / }).count()) === 0) {
    const add = page.getByLabel('Add a service');
    const consult = await add.locator('option', { hasText: 'Dental consultation' }).getAttribute('value');
    await add.selectOption(consult!);
    await page.getByRole('button', { name: 'Add', exact: true }).click();
  }
  const scope = page.getByLabel('Scope of work');
  if ((await scope.inputValue()).trim() === '') await scope.fill('Consultation with one digital X-ray.');
  const timeline = page.getByLabel('Timeline');
  if ((await timeline.inputValue()).trim() === '') await timeline.fill('One visit');
  await page.getByRole('button', { name: 'Create draft quotation' }).click();
  await page.waitForURL(/\/dashboard\/user\/quotations\/(?!new)[^/?]+$/);
  const quoteUrl = page.url();

  // Approve v1.
  await page.getByRole('button', { name: 'Approve v1' }).click();
  const status = page.locator('[data-quote-status]').first();
  await expect(status).toHaveAttribute('data-quote-status', 'APPROVED');

  // Create a link (shown once) and copy it: the quotation is handed over.
  await page.getByRole('button', { name: 'Create share link' }).click();
  const linkBox = page.getByLabel('Share link');
  await expect(linkBox).toHaveValue(/\/quote\/[A-Za-z0-9_-]{43}$/);
  const link = await linkBox.inputValue();
  await page.getByRole('button', { name: 'Copy link' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'marked as sent' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(link);

  await page.goto(quoteUrl);
  await expect(status).toHaveAttribute('data-quote-status', 'SENT');
  await expect(page.getByText('Sent manually (link or PDF).')).toBeVisible();
  await expect(page.getByRole('list').getByText(/^Sent \(v1\)$/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark as sent manually' })).toHaveCount(0);
  await expect(page.locator('[data-share-state="ACTIVE"]')).toHaveCount(1);

  // The copied link opens the public quotation, now open for acceptance.
  const customer = await context.newPage();
  const res = await customer.goto(link);
  expect(res?.status()).toBe(200);
  await expect(customer.getByRole('button', { name: /accept/i })).toBeVisible();
  await customer.close();
});
