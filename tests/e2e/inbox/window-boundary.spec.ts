/**
 * AT9 / R24 at the composer (T22; 06-design F5) against the built DEMO app and its worker, on the
 * shared test clock (web and worker read the same TestClock). The customer's message at T0 opens
 * the window until T0 + 24 h = 05:30 IST: the composer says "Free-form until 05:30 IST" and that the
 * final check happens at send. One minute before the boundary it still says so; then the clock moves
 * 1 ms past the boundary without a reload and Send is refused by the server: the draft is kept, the
 * action switches to review (no approved template is synced in DEMO, so the template action says
 * why), and nothing reads "Queued" or "Sent". After a reload the composer shows the window closed,
 * and "Save for review" stores the text as a draft waiting for approval.
 */
import { expect, test } from '@playwright/test';
import { resetAll, setClock, signIn } from '../support/panel-actions';
import { openSimulatedThread } from './inbox-steps';

const T0 = new Date('2026-10-20T00:00:00.000Z'); // 05:30 IST
const DAY = 24 * 60 * 60 * 1000;

test.beforeEach(async ({ request }) => {
  await resetAll(request);
  await setClock(request, T0);
});

test.afterAll(async ({ request }) => {
  await resetAll(request);
});

test('free-form until 05:30 IST; 1 ms past the boundary the send switches to review, never Sent', async ({ page, request }) => {
  test.setTimeout(240_000);
  await signIn(page, 'Workspace owner');
  await openSimulatedThread(page, 'Do you have a slot on Saturday?');

  const eligibility = page.locator('[data-composer-eligibility]');
  await expect(eligibility).toContainText('Free-form until 05:30 IST');
  await expect(eligibility).toContainText('Final check happens at send.');
  await expect(page.locator('[data-thread][aria-current="page"]')).toContainText('Free-form until 05:30 IST');

  // One minute before the boundary the window is still open.
  await setClock(request, new Date(T0.getTime() + DAY - 60_000));
  await page.reload();
  await expect(eligibility).toContainText('Free-form until 05:30 IST');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeVisible();

  // 1 ms past the boundary, without a reload: the server refuses at send.
  await setClock(request, new Date(T0.getTime() + DAY + 1));
  const text = 'Yes, Saturday at 11 am works for us.';
  await page.getByLabel('Message', { exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  const refusal = page.getByRole('alert').filter({ hasText: '24-hour reply window is closed' });
  await expect(refusal).toBeVisible();
  await expect(page.getByLabel('Message', { exact: true })).toHaveValue(text);
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save for review' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send approved template' })).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByText(/^Queued/)).toHaveCount(0);
  const outbound = page.locator('[data-direction="OUT"]').filter({ hasText: text });
  await expect(outbound).toHaveCount(0);

  // A fresh read agrees: the window is closed.
  await page.reload();
  await expect(eligibility).toContainText('Free-form window closed');
  await expect(page.getByRole('button', { name: 'Send', exact: true })).toHaveCount(0);

  // Review path: the text becomes a draft waiting for approval; nothing was sent.
  await page.getByLabel('Message', { exact: true }).fill(text);
  await page.getByRole('button', { name: 'Save for review' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved for review' })).toBeVisible();
  await page.reload();
  const draft = page.locator('[data-direction="OUT"][data-status="DRAFT"]').filter({ hasText: text });
  await expect(draft).toBeVisible();
  await expect(page.locator('[data-direction="OUT"]').filter({ hasText: text }).locator('[data-status-label]')).toHaveCount(0);
});
