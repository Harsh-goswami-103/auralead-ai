/**
 * T28 Integration center in the browser (R32; PRD "Unavailable integration shows Not configured /
 * Verification required with a working setup action"; plan §9 "masked reads"), against the built
 * DEMO app (T09 harness):
 *  - a Not configured card offers "Set up", which opens that integration's setup page;
 *  - "Test connection" in DEMO says "Simulated, no provider contacted", leaves the status as it was,
 *    and the check is listed in the integration's activity after a reload (persisted, audited);
 *  - no secret ever reaches the HTML: no credential envelope, no provider key shape, and none of the
 *    app's own secrets from its setup-generated `.env`;
 *  - Sync templates (DEMO) adds the approved and rejected demo templates, shown with their raw
 *    status, and they survive a reload.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'dotenv';
import { expect, test, type Page } from '@playwright/test';
import { resetAll, signIn } from '../support/panel-actions';
import { HARNESS_STATE_FILE } from '../support/state';

const WS = 'smile-avenue-dental';
const CENTER = `/dashboard/employee/${WS}/integrations`;

test.beforeEach(async ({ request }) => {
  await resetAll(request);
});

test.afterAll(async ({ request }) => {
  await resetAll(request);
});

/** The DEMO app's own secrets, from the `.env` the harness wrote for it. */
function appSecrets(): string[] {
  if (!existsSync(HARNESS_STATE_FILE)) return [];
  const state = JSON.parse(readFileSync(HARNESS_STATE_FILE, 'utf8')) as { apps: Array<{ mode: string; dataDir: string }> };
  const demo = state.apps.find((a) => a.mode === 'demo');
  if (!demo) return [];
  const env = parse(readFileSync(path.join(demo.dataDir, '.env'), 'utf8'));
  const values = ['SESSION_SECRET', 'SHARE_NONCE_KEY', 'SUPPRESSION_PEPPER', 'TEST_CONTROL_TOKEN', 'META_APP_SECRET', 'META_VERIFY_TOKEN'].map((k) => env[k] ?? '');
  const ring = env.CREDENTIALS_KEYRING ? (JSON.parse(env.CREDENTIALS_KEYRING) as Record<string, string>) : {};
  return [...values, ...Object.values(ring)].filter((v) => v.length >= 12);
}

async function expectNoSecrets(page: Page, url: string) {
  const res = await page.request.get(url);
  expect(res.status()).toBe(200);
  const html = await res.text();
  expect(html).not.toMatch(/\bv1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  expect(html).not.toMatch(/\bsk-ant-[A-Za-z0-9_-]{8,}|\bEAA[A-Za-z0-9]{20,}|\bre_[A-Za-z0-9_]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/);
  for (const secret of appSecrets()) expect(html.includes(secret), `an app secret appeared in ${url}`).toBe(false);
}

test('Not configured shows a working setup action; the DEMO test is labelled simulated and persisted', async ({ page }) => {
  await signIn(page, 'Employee');
  await page.goto(CENTER);
  await expect(page.getByRole('heading', { level: 1, name: 'Integrations' })).toBeVisible();

  const smtp = page.locator('[data-integration="EMAIL_SMTP"]');
  await expect(smtp.getByRole('img', { name: 'Not configured, Simulated' })).toBeVisible();
  await expect(smtp.getByText('Internal cap, not a provider limit')).toBeVisible();
  await smtp.getByRole('link', { name: /^Set up/ }).click();
  await page.waitForURL(`**${CENTER}/email-smtp`);
  await expect(page.getByRole('heading', { level: 1, name: 'SMTP email setup' })).toBeVisible();
  await expect(page.getByText('Before you connect')).toBeVisible();
  await expect(page.getByText('SMTP has no inbound replies and no bounce tracking', { exact: false })).toBeVisible();

  await page.getByRole('button', { name: 'Test connection' }).click();
  const result = page.locator('[data-test-result="demo"]');
  await expect(result).toContainText('Simulated, no provider contacted');
  await expect(result).toContainText('Status unchanged: Not configured.');
  await expect(page.getByText('Connected', { exact: true })).toHaveCount(0);

  await page.reload();
  await expect(page.getByText('Connection tested')).toBeVisible();
});

test('secrets never reach the HTML of the Integration center or a setup page', async ({ page }) => {
  await signIn(page, 'Employee');
  await page.goto(CENTER);
  await expect(page.getByRole('heading', { level: 1, name: 'Integrations' })).toBeVisible();
  for (const url of [CENTER, `${CENTER}/whatsapp`, `${CENTER}/ai-anthropic`, `${CENTER}/google-sheets`]) await expectNoSecrets(page, url);
});

test('DEMO template sync adds approved and rejected templates that survive a reload', async ({ page }) => {
  await signIn(page, 'Employee');
  await page.goto(`${CENTER}/whatsapp`);
  await expect(page.getByText('No templates synced')).toBeVisible();
  await page.getByRole('button', { name: 'Sync templates' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Simulated, no provider contacted' })).toBeVisible();
  await page.reload();
  await expect(page.locator('[data-template="quote_ready_v1"]')).toContainText('APPROVED');
  await expect(page.locator('[data-template="festive_offer_blast"]')).toContainText('REJECTED');
  await expect(page.getByText('Templates synced')).toBeVisible();
});
