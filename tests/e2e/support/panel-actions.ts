/**
 * Shared steps for the M3 panel specs (T22) against the built DEMO app and its worker (T09
 * harness): test control (clock, reset), persona sign-in through the DEMO login page, and API calls
 * made with the signed-in page's own session cookie, Origin and CSRF token (exactly what the panel's
 * buttons send). Every setup step goes through a real route; nothing writes the database directly.
 */
import { expect, type APIRequestContext, type APIResponse, type Page } from '@playwright/test';

export const WORKER_WAIT = { timeout: 60_000 };

export function control(): Record<string, string> {
  const t = process.env.E2E_TEST_CONTROL_TOKEN;
  if (!t) throw new Error('E2E_TEST_CONTROL_TOKEN is not set: run through the T09 harness');
  return { 'x-test-control-token': t };
}

export async function resetAll(request: APIRequestContext): Promise<void> {
  expect((await request.post('/api/test/clock', { headers: control(), data: { reset: true } })).status()).toBe(200);
  expect((await request.post('/api/test/reset', { headers: control() })).status()).toBe(200);
}

export async function setClock(request: APIRequestContext, frozenAt: Date): Promise<void> {
  expect((await request.post('/api/test/clock', { headers: control(), data: { frozenAt: frozenAt.toISOString() } })).status()).toBe(200);
}

/** DEMO persona sign-in on /login ("Workspace owner" or "Employee"). */
export async function signIn(page: Page, persona: 'Workspace owner' | 'Employee'): Promise<void> {
  await page.goto('/login');
  await page.getByRole('button', { name: new RegExp(`^${persona}`) }).first().click();
  await page.waitForURL(persona === 'Employee' ? '**/dashboard/employee' : '**/dashboard/user');
}

/** POST as the signed-in page (cookie + Origin + CSRF), like a panel button. */
export async function panelPost(page: Page, url: string, data: unknown): Promise<APIResponse> {
  const session = await page.request.get('/api/app/auth/session');
  expect(session.status()).toBe(200);
  const { csrfToken } = (await session.json()) as { csrfToken: string };
  const origin = new URL(page.url()).origin;
  return page.request.post(url, { headers: { 'x-csrf-token': csrfToken, origin }, data });
}

/** One simulated Google Sheets lead (phone, email, WhatsApp opt-in on the first row) in the given or active workspace. */
export async function simulateSheetsLead(page: Page, workspaceSlug?: string): Promise<void> {
  const res = await panelPost(page, '/api/demo/simulate/sheets', { count: 1, ...(workspaceSlug ? { workspaceSlug } : {}) });
  expect(res.status()).toBe(200);
}

/** Reloads until `check` passes (worker results arrive asynchronously). */
export async function eventually(page: Page, check: () => Promise<void>, timeout = WORKER_WAIT.timeout): Promise<void> {
  await expect(async () => {
    await page.reload();
    await check();
  }).toPass({ timeout, intervals: [1_000, 2_000, 3_000] });
}
