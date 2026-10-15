/**
 * Employee approval queue (T22; R32, AT12 at the UI, 06-design F18) against the built DEMO app and
 * its worker. Setup through real routes: a simulated Sheets lead in Smile Avenue, a quotation from
 * its AI proposal (lead console), and an email opt-in recorded with evidence (consent route).
 *  - A stale tab: v1 is edited to v2 in one tab; approving v1 in the other tab answers "This item
 *    changed since you opened it" and approves nothing.
 *  - An edit above the employee's own discount cap (10 % here, the workspace allows 15 % on clear
 *    aligners) is refused with the server's 403 message and creates no version.
 *  - Approve and send by email on a double click plus a programmatic retry of the same request makes
 *    one dispatch: the same attempt id twice and exactly one attempt, sent by the DEMO transport.
 */
import { expect, test, type Page } from '@playwright/test';
import { eventually, panelPost, resetAll, signIn, simulateSheetsLead, WORKER_WAIT } from '../support/panel-actions';

const WS = 'smile-avenue-dental';
const QUEUE = `/dashboard/employee/${WS}/approvals`;

test.beforeEach(async ({ request }) => {
  await resetAll(request);
});

test.afterAll(async ({ request }) => {
  await resetAll(request);
});

/** Lead console: the simulated lead, its pipeline draft, then "Create quote from proposal". Returns the lead id and quote number. */
async function quoteForSimulatedLead(page: Page): Promise<{ leadId: string; number: string }> {
  await simulateSheetsLead(page, WS);
  await page.goto(`/dashboard/employee/${WS}/leads`);
  const leadLink = page.getByRole('table').getByRole('link').first();
  await eventually(page, async () => {
    await expect(leadLink).toBeVisible();
  });
  await leadLink.click();
  await page.waitForURL(new RegExp(`/dashboard/employee/${WS}/leads/[^/]+$`));
  const leadId = new URL(page.url()).pathname.split('/').at(-1)!;
  await expect(page.locator('[data-field="draft-status"]')).toHaveText('Ready for review', WORKER_WAIT);
  await page.getByRole('button', { name: 'Create quote from proposal' }).click();
  const quote = page.locator('[data-quote-number]').first();
  await expect(quote).toBeVisible();
  return { leadId, number: (await quote.getAttribute('data-quote-number'))! };
}

test('stale tab, over-cap edit 403, and one dispatch under double click and retry', async ({ page, context }) => {
  test.setTimeout(300_000);
  await signIn(page, 'Employee');
  const { leadId, number } = await quoteForSimulatedLead(page);

  // Email opt-in with evidence (D4: Maps and Sheets leads have no email basis by default).
  const consent = await panelPost(page, '/api/app/consent/grants', {
    workspaceSlug: WS,
    leadId,
    channel: 'EMAIL',
    purpose: 'MARKETING',
    source: 'MANUAL_EVIDENCE',
    collectedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    evidence: { note: 'Signed the clinic consent form for email updates at the front desk.' },
  });
  expect(consent.status()).toBe(200);

  // The queue lists the new version; open it and wait for the worker's PDF.
  await page.goto(QUEUE);
  const item = page.locator('[data-approval-queue="pending"] [data-approval-item]').filter({ hasText: `${number} v1` });
  await expect(item).toBeVisible();
  await item.click();
  await expect(page.locator('[data-approval-title]')).toHaveText(`${number} v1`);
  await expect(page.locator('[data-field="pdf"]')).toHaveText('PDF ready.', WORKER_WAIT);
  await expect(page.locator('[data-channel-eligibility="EMAIL"]')).toContainText('can be sent');
  await expect(page.locator('[data-channel-eligibility="WHATSAPP"]')).toContainText('No approved WhatsApp template');
  const v1Url = page.url();

  // Stale tab: tab B keeps v1 open while tab A saves v2.
  const tabB = await context.newPage();
  await tabB.goto(v1Url);
  await expect(tabB.getByRole('button', { name: 'Approve v1' })).toBeVisible();

  await page.getByRole('button', { name: 'Edit quotation (new version)' }).click();
  await page.getByLabel('Timeline').fill('Two visits within one week');
  await page.getByRole('button', { name: 'Save as v2' }).click();
  const openV2 = page.getByRole('link', { name: 'Open v2' });
  await expect(openV2).toBeVisible();

  await tabB.getByRole('button', { name: 'Approve v1' }).click();
  await expect(tabB.getByRole('alert').filter({ hasText: 'This item changed since you opened it' })).toBeVisible();
  await tabB.reload();
  await expect(tabB.locator('[data-approval-status]')).toHaveAttribute('data-approval-status', 'INVALIDATED');
  await tabB.close();

  // v2: an edit above the employee's own 10 % cap (clear aligners allow 15 %) is refused, 403.
  await openV2.click();
  await expect(page.locator('[data-approval-title]')).toHaveText(`${number} v2`);
  const v2Url = page.url();
  await page.getByRole('button', { name: 'Edit quotation (new version)' }).click();
  const removes = page.getByRole('button', { name: /^Remove / });
  while ((await removes.count()) > 0) await removes.first().click();
  const addService = page.getByLabel('Add a service');
  const aligner = await addService.locator('option', { hasText: 'Clear aligner plan' }).getAttribute('value');
  await addService.selectOption(aligner!);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByLabel('Discount', { exact: true }).selectOption('PERCENT_BPS');
  await page.getByLabel('Discount (%)').fill('12');
  await page.getByRole('button', { name: 'Save as v3' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Your discount limit is 10%' })).toBeVisible();
  await page.goto(v2Url);
  await expect(page.locator('[data-approval-title]')).toHaveText(`${number} v2`);
  await expect(page.getByRole('link', { name: /^Open v3/ })).toHaveCount(0);

  // Approve and send by email: a double click, then a programmatic retry of the same request.
  await expect(page.locator('[data-field="pdf"]')).toHaveText('PDF ready.', WORKER_WAIT);
  const approvalId = new URL(page.url()).pathname.split('/').at(-1)!;
  const first = page.waitForResponse((r) => r.url().endsWith(`/api/app/approvals/${approvalId}/send`) && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Approve and send by email' }).dblclick();
  const firstBody = (await (await first).json()) as { attemptId: string; created: boolean };
  expect(firstBody.created).toBe(true);
  const retry = await panelPost(page, `/api/app/approvals/${approvalId}/send`, { workspaceSlug: WS, expectedVersion: 2, channel: 'EMAIL' });
  expect(retry.status()).toBe(200);
  const retryBody = (await retry.json()) as { attemptId: string; created: boolean };
  expect(retryBody).toMatchObject({ attemptId: firstBody.attemptId, created: false });

  await eventually(page, async () => {
    await expect(page.locator('[data-dispatch-attempts]')).toHaveAttribute('data-dispatch-attempts', '1');
    await expect(page.locator('[data-attempt-state="SENT"]')).toHaveCount(1);
  });
  await expect(page.locator('[data-attempt-state="SENT"]')).toContainText('Simulated');
  await page.goto(QUEUE);
  await expect(page.locator('[data-approval-queue="recent"] [data-approval-item]').filter({ hasText: `${number} v2` }).locator('[data-dispatch-state="SENT"]')).toBeVisible();
});
