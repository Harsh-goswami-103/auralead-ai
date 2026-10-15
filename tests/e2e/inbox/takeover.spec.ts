/**
 * Takeover and resume (T22 over T21; R21, AT10 at the UI, 06-design F7, §11.3 "Takeover/resume")
 * against the built DEMO app and its worker. A customer asks for a person; the reply guard prepares
 * a suggestion for approval (the thread is in "Draft for approval" mode). The owner takes the thread
 * over through a confirmation: the banner "You are handling this thread. AI replies paused." and the
 * event row persist after a reload, the thread list marks it, and the next customer message gets no
 * AI suggestion. "Resume AI" restores the mode, also persisted.
 */
import { expect, test } from '@playwright/test';
import { resetAll, signIn, WORKER_WAIT } from '../support/panel-actions';
import { openSimulatedThread } from './inbox-steps';

test.beforeEach(async ({ request }) => {
  await resetAll(request);
});

test.afterAll(async ({ request }) => {
  await resetAll(request);
});

test('take over, no AI suggestion while handled, resume', async ({ page }) => {
  test.setTimeout(240_000);
  await signIn(page, 'Workspace owner');
  await openSimulatedThread(page, 'Can I talk to someone about the price?');
  await expect(page.locator('[data-ai-mode="DRAFT"]')).toHaveText('Draft for approval');

  // The guard's suggestion waits for approval (the page re-reads itself while a reply is prepared).
  const suggestions = page.getByText('AI suggestion · not sent');
  await expect(suggestions).toHaveCount(1, WORKER_WAIT);

  // Take over (confirmation names the workspace).
  await page.getByRole('button', { name: 'Take over' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('Workspace: Smile Avenue Dental Clinic');
  await dialog.getByRole('button', { name: 'Take over' }).click();
  const banner = page.locator('[data-takeover-banner]');
  await expect(banner).toContainText('You are handling this thread. AI replies paused.');
  await page.reload();
  await expect(banner).toContainText('You are handling this thread. AI replies paused.');
  await expect(page.locator('[data-thread-event="MODE"]').filter({ hasText: 'You took over this conversation' })).toBeVisible();
  await expect(page.locator('[data-thread][aria-current="page"]')).toContainText('You are handling');

  // The customer writes again: the message arrives, and no AI suggestion is prepared for it.
  const second = 'Hello? Are you there?';
  await page.getByLabel('Customer text').fill(second);
  await page.getByRole('button', { name: 'Simulate customer message' }).click();
  await expect(page.locator('[data-direction="IN"]').filter({ hasText: second })).toBeVisible(WORKER_WAIT);
  // Several refresh cycles later there is still exactly the first suggestion.
  await page.waitForTimeout(8_000);
  await page.reload();
  await expect(suggestions).toHaveCount(1);

  // Resume AI.
  await banner.getByRole('button', { name: 'Resume AI' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Resume AI' }).click();
  await expect(banner).toHaveCount(0);
  await page.reload();
  await expect(banner).toHaveCount(0);
  await expect(page.locator('[data-thread-event="MODE"]').filter({ hasText: 'AI resumed on this conversation' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Take over' })).toBeVisible();
});
