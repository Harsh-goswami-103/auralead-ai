/**
 * T26, R31 (plan §11 M4): the client panel's Leads area in the browser, against the built DEMO app
 * and its worker (T09 harness). Leads are ingested through the test-control route, which runs the
 * real ingestion service (MANUAL source), because no source simulator produces a Devanagari name
 * or an exact count. Every effect is read back after a reload, so nothing is only client state.
 *  - keyset pages of 50: 51 leads give a full first page and a one-row second page; exactly 50
 *    give one page; the page and the search survive a reload;
 *  - search on the normalized name finds a Devanagari lead;
 *  - the Kanban keyboard path: focus the card's "Move to stage", Enter, arrows, Enter; the move is
 *    stored, and a request with the old stageVersion answers 409;
 *  - the detail sheet opens from the table and from the URL, with score, consent and source;
 *  - the CSV export: requested, written by the worker, downloaded with the formula cells escaped.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { control, panelPost, resetAll, signIn, WORKER_WAIT } from '../support/panel-actions';

const WS = 'smile-avenue-dental';
const LEADS = '/dashboard/user/leads';

type Ingested = { records: Array<{ status: string; leadId: string | null }> };

/** A valid Indian mobile number per index (98 + 8 digits). */
const phone = (i: number) => `+9198${String(20_000_000 + i).padStart(8, '0')}`;

async function ingest(request: APIRequestContext, batchId: string, records: Array<{ name: string; phone: string; city?: string }>): Promise<string[]> {
  const res = await request.post('/api/test/leads', { headers: control(), data: { workspaceSlug: WS, batchId, records } });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as Ingested;
  expect(body.records.every((r) => r.status === 'ACCEPTED')).toBe(true);
  return body.records.map((r) => r.leadId!);
}

function rows(page: Page) {
  return page.getByRole('table').locator('tbody tr');
}

test.beforeEach(async ({ request }) => {
  await resetAll(request);
});

test.afterAll(async ({ request }) => {
  await resetAll(request);
});

test('keyset pages of 50: the 50/51 boundary, and the page survives a reload', async ({ page, request }) => {
  test.setTimeout(120_000);
  await ingest(
    request,
    'boundary',
    Array.from({ length: 51 }, (_, i) => ({ name: i === 50 ? 'Boundary Extra' : `Boundary Fifty ${String(i).padStart(2, '0')}`, phone: phone(i) })),
  );
  await signIn(page, 'Workspace owner');
  await page.goto(LEADS);
  await expect(page.getByRole('heading', { level: 1, name: 'Leads' })).toBeVisible();

  await expect(rows(page)).toHaveCount(50);
  const pager = page.getByRole('navigation', { name: 'Lead pages' });
  await expect(pager).toContainText('51 leads match');
  await pager.getByRole('link', { name: 'Next page' }).click();
  await expect(rows(page)).toHaveCount(1);
  await expect(pager.getByRole('link', { name: 'Next page' })).toHaveCount(0);
  await page.reload();
  await expect(rows(page)).toHaveCount(1);
  await pager.getByRole('link', { name: 'Previous page' }).click();
  await expect(rows(page)).toHaveCount(50);

  // Exactly 50 matches: one page, no next.
  await page.getByLabel('Search leads').fill('boundary fifty');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(pager).toContainText('50 leads match');
  await expect(rows(page)).toHaveCount(50);
  await expect(pager.getByRole('link', { name: 'Next page' })).toHaveCount(0);
});

test('search on the normalized name finds a Devanagari lead, and the search survives a reload', async ({ page, request }) => {
  await ingest(request, 'devanagari', [
    { name: 'राहुल शर्मा', phone: phone(100), city: 'नोएडा' },
    { name: 'Rahul Sharma', phone: phone(101) },
    { name: 'प्रिया अय्यर', phone: phone(102) },
  ]);
  await signIn(page, 'Workspace owner');
  await page.goto(LEADS);
  await page.getByLabel('Search leads').fill('शर्मा');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page).toHaveURL(/[?&]q=/);
  await expect(rows(page)).toHaveCount(1);
  await expect(page.getByRole('table').getByRole('link', { name: 'राहुल शर्मा' })).toBeVisible();
  await page.reload();
  await expect(rows(page)).toHaveCount(1);
  await expect(page.getByLabel('Search leads')).toHaveValue('शर्मा');
});

test('Kanban keyboard path: Move to stage, Enter, arrows, Enter; stored after reload; a stale version is 409', async ({ page, request }) => {
  const [leadId] = await ingest(request, 'kanban', [{ name: 'Kanban Keyboard Lead', phone: phone(200) }]);
  await signIn(page, 'Workspace owner');
  await page.goto(`${LEADS}?view=board`);
  const newColumn = page.locator('[data-board-column="NEW"]');
  const card = newColumn.locator('[data-lead-card]', { hasText: 'Kanban Keyboard Lead' });
  await expect(card).toBeVisible();

  const trigger = card.getByRole('button', { name: 'Move to stage: Kanban Keyboard Lead' });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  // The first item (Contacted) has focus; one arrow down moves to Replied.
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem', { name: 'Replied' })).toBeFocused();
  await page.keyboard.press('Enter');
  const replied = page.locator('[data-board-column="REPLIED"]');
  await expect(replied.locator('[data-lead-card]', { hasText: 'Kanban Keyboard Lead' })).toBeVisible();

  await page.reload();
  await expect(replied.locator('[data-lead-card]', { hasText: 'Kanban Keyboard Lead' })).toBeVisible();
  await expect(newColumn.locator('[data-lead-card]', { hasText: 'Kanban Keyboard Lead' })).toHaveCount(0);

  // The board held stageVersion 0 before the move: the same request now is stale.
  const stale = await panelPost(page, `/api/app/leads/${leadId}/stage`, { toStage: 'CONTACTED', expectedStageVersion: 0 });
  expect(stale.status()).toBe(409);
  expect(((await stale.json()) as { code: string }).code).toBe('STAGE_VERSION_CONFLICT');

  // LOST from the keyboard needs a reason.
  await replied.locator('[data-lead-card]', { hasText: 'Kanban Keyboard Lead' }).getByRole('button', { name: /^Move to stage/ }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menu').getByRole('menuitem', { name: 'Lost' }).focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Mark Kanban Keyboard Lead as lost' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Reason').fill('Chose another clinic');
  await dialog.getByRole('button', { name: 'Mark as lost' }).click();
  await expect(page.locator('[data-board-column="LOST"]').locator('[data-lead-card]', { hasText: 'Kanban Keyboard Lead' })).toBeVisible();
  await page.reload();
  await expect(page.locator('[data-board-column="LOST"]').locator('[data-lead-card]', { hasText: 'Kanban Keyboard Lead' })).toBeVisible();
});

test('the detail sheet opens from the table and from the URL', async ({ page, request }) => {
  const [leadId] = await ingest(request, 'sheet', [{ name: 'Sheet Detail Lead', phone: phone(300), city: 'Gurugram' }]);
  await signIn(page, 'Workspace owner');
  await page.goto(LEADS);
  await page.getByRole('table').getByRole('link', { name: 'Sheet Detail Lead' }).click();
  const sheet = page.getByRole('dialog', { name: 'Sheet Detail Lead' });
  await expect(sheet).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`lead=${leadId}`));
  await expect(sheet).toContainText('Consent is separate from the sales stage');
  await expect(sheet).toContainText('Source');
  await expect(sheet.locator('[data-consent-channel="WHATSAPP"]')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('dialog', { name: 'Sheet Detail Lead' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Sheet Detail Lead' })).toHaveCount(0);
  await expect(page).not.toHaveURL(/lead=/);
});

test('CSV export: written by the worker, downloaded with formula cells escaped', async ({ page, request }) => {
  test.setTimeout(120_000);
  await ingest(request, 'export', [
    { name: '=HYPERLINK("http://evil.example","Click")', phone: phone(400) },
    { name: 'राहुल शर्मा', phone: phone(401) },
  ]);
  await signIn(page, 'Workspace owner');
  await page.goto(LEADS);
  await page.getByRole('button', { name: 'Export all leads (CSV)' }).click();
  const download = page.getByRole('link', { name: 'Download CSV' }).first();
  await expect(download).toBeVisible(WORKER_WAIT);
  const [file] = await Promise.all([page.waitForEvent('download'), download.click()]);
  expect(file.suggestedFilename()).toMatch(/^leads-smile-avenue-dental-\d{8}-\d{4}\.csv$/);
  const bytes = readFileSync((await file.path())!);
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const text = bytes.subarray(3).toString('utf8');
  expect(text.startsWith('Name,Stage,Score,Source,Phone,Email')).toBe(true);
  expect(text).toContain('"\'=HYPERLINK(""http://evil.example"",""Click"")"');
  expect(text).toContain('राहुल शर्मा');
});

test('the scoring tab is read-only for the owner', async ({ page }) => {
  await signIn(page, 'Workspace owner');
  await page.goto(`${LEADS}/scoring`);
  await expect(page.getByRole('heading', { level: 1, name: 'Lead scoring' })).toBeVisible();
  const change = page.getByRole('button', { name: 'Change weights' });
  await expect(change).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByText('Workspace owners can read the scoring configuration')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Preview on 20 leads' })).toHaveCount(0);
});
