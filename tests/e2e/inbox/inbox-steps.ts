/**
 * Inbox steps shared by the T22 inbox specs: a simulated Sheets lead for the owner's workspace, then
 * that lead "sends" a WhatsApp message through the DEMO simulator on the Inbox page (the same receive
 * path as the verified webhook), and the thread is opened once the worker has recorded it.
 */
import { expect, type Page } from '@playwright/test';
import { eventually, simulateSheetsLead } from '../support/panel-actions';

export async function openSimulatedThread(page: Page, text: string): Promise<string> {
  await simulateSheetsLead(page);
  await page.goto('/dashboard/user/inbox');
  const lead = page.getByLabel('From lead');
  await eventually(page, async () => {
    await expect(lead.locator('option')).not.toHaveCount(0);
    await expect(lead).not.toHaveValue('');
  });
  await page.getByLabel('Customer action').selectOption('text');
  await page.getByLabel('Customer text').fill(text);
  await page.getByRole('button', { name: 'Simulate customer message' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Simulated.' })).toBeVisible();
  // The pipeline may also have opened an email thread for the lead's first touch: take the WhatsApp one.
  const thread = page.locator('[data-thread][data-channel="WHATSAPP"]').first();
  await eventually(page, async () => {
    await expect(thread).toBeVisible();
  });
  await thread.click();
  await page.waitForURL(/\/dashboard\/user\/inbox\/[^/]+$/);
  await expect(page.locator('[data-direction="IN"]').filter({ hasText: text })).toBeVisible();
  return new URL(page.url()).pathname.split('/').at(-1)!;
}
