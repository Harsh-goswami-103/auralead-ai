/**
 * R33 / R46 (T29) end to end against the built apps of the T09 harness.
 *
 * LIVE (the harness's empty LIVE app: no seed, no test control). The first project to run does the
 * whole onboarding once: the operator runs `npm run admin:bootstrap` (ADR-68) against the LIVE data
 * dir and opens the printed link; the first administrator creates a workspace in the browser and
 * copies the owner's single-use invite link; the owner joins through it and lands in the Client
 * panel on the new, empty workspace, and the used link no longer works. The administrator creates
 * a password reset link for the owner (shown once); the owner sets a new password through it and
 * signs in with it. The audit log finds the creation without either link, and the workspace's
 * audited view opens with its banner after a reason.
 *   The credential routes (invite accept, reset, login) are rate limited per client address, and
 * every project shares this one LIVE app and address, so the onboarding runs once per harness run:
 * it leaves the administrator's browser state in the LIVE data dir, and every later project signs
 * in with that state and re-checks the same installation's admin pages at its own viewport.
 *
 * DEMO: the Super admin persona sees the seeded people and workspaces and cannot change the role
 * of a role-switcher persona (gated with its reason).
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { parse } from 'dotenv';
import { HARNESS_STATE_FILE } from '../support/state';
import { baseEnv } from '../support/start-app';

const REPO_ROOT = process.env.E2E_REPO_ROOT ?? process.cwd();
const ADMIN_EMAIL = 'founder@e2e-live.example';
const ADMIN_PASSWORD = 'founder long passphrase 2026';
const OWNER_NAME = 'Meera Iyer';

type LiveApp = { baseURL: string; dataDir: string };
type Onboarded = { name: string; slug: string; ownerEmail: string; storageState: Awaited<ReturnType<BrowserContext['storageState']>> };

function liveApp(): LiveApp {
  if (!existsSync(HARNESS_STATE_FILE)) throw new Error('harness state file missing: run through the T09 harness');
  const state = JSON.parse(readFileSync(HARNESS_STATE_FILE, 'utf8')) as { apps: Array<{ mode: string; baseURL: string; dataDir: string }> };
  const app = state.apps.find((a) => a.mode === 'live');
  if (!app) throw new Error('no LIVE app in the harness state');
  return { baseURL: app.baseURL, dataDir: app.dataDir };
}

const onboardedFile = (app: LiveApp) => path.join(app.dataDir, 'e2e-admin-onboarded.json');

function readOnboarded(app: LiveApp): Onboarded | null {
  const file = onboardedFile(app);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Onboarded) : null;
}

/** `npm run admin:bootstrap -- <args>` against the LIVE app's data dir, the way an operator runs it. */
function bootstrap(app: LiveApp, args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  const generated = parse(readFileSync(path.join(app.dataDir, '.env'), 'utf8'));
  const env: Record<string, string> = {
    ...baseEnv(),
    ...generated,
    APP_MODE: 'live',
    NEXT_PUBLIC_APP_MODE: 'live',
    APP_ORIGIN: app.baseURL,
    AURALEAD_DATA_DIR: path.join(app.dataDir, 'data'),
    DATABASE_URL: '',
    AURALEAD_TEST_CONTROL: '0',
    LOG_LEVEL: 'warn',
  };
  const loader = pathToFileURL(path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', loader, path.join(REPO_ROOT, 'scripts', 'admin-bootstrap.ts'), ...args], {
      cwd: REPO_ROOT,
      env: env as NodeJS.ProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')));
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, out, err }));
  });
}

const linkIn = (text: string, kind: 'invite' | 'reset') => {
  const m = new RegExp(`(https?://\\S+/${kind}/[A-Za-z0-9_-]{43})`).exec(text);
  if (!m) throw new Error(`no ${kind} link in: ${text}`);
  return m[1]!;
};

async function signInWithPassword(page: Page, email: string, password: string, landing: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`**${landing}`);
}

/** The first administrator of the fresh LIVE install (or, after an earlier failed run, the same one through the break-glass reset). */
async function signInFirstAdmin(page: Page, app: LiveApp) {
  const first = await bootstrap(app, ['--email', ADMIN_EMAIL]);
  if (first.code === 0) {
    await page.goto(linkIn(first.out, 'invite'));
    await page.getByLabel('Your name').fill('Founder Admin');
    await page.getByLabel('Password').fill(ADMIN_PASSWORD);
    await page.getByRole('button', { name: 'Join' }).click();
    await page.waitForURL('**/dashboard/admin');
    return;
  }
  expect(first.err).toMatch(/administrator already exists/);
  const recover = await bootstrap(app, ['--email', ADMIN_EMAIL, '--recover']);
  expect(recover.code, recover.err).toBe(0);
  await page.goto(linkIn(recover.out, 'reset'));
  await page.getByLabel('New password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Set password' }).click();
  await page.waitForURL('**/login');
  await signInWithPassword(page, ADMIN_EMAIL, ADMIN_PASSWORD, '/dashboard/admin');
}

async function onboard(browser: Browser, app: LiveApp, run: string): Promise<Onboarded> {
  const slug = `e2e-${run}`.slice(0, 48).replace(/-+$/, '');
  const name = `Kaveri Yoga ${run}`;
  const ownerEmail = `owner-${run}@kaveri.example`;

  const context = await browser.newContext({ baseURL: app.baseURL, permissions: ['clipboard-read', 'clipboard-write'] });
  const admin = await context.newPage();
  await signInFirstAdmin(admin, app);

  // Create the workspace; the owner's invite link is shown once.
  await admin.goto('/dashboard/admin/workspaces');
  await expect(admin.getByRole('heading', { level: 1, name: 'Workspaces' })).toBeVisible();
  await admin.getByLabel('Business name').fill(name);
  await admin.getByLabel('Slug').fill(slug);
  await admin.getByLabel('Plan label').fill('Starter');
  await admin.getByLabel("Owner's email address").fill(ownerEmail);
  await admin.getByLabel('Reason (stored on the audit record)').first().fill('E2E onboarding of a new customer');
  await admin.getByRole('button', { name: 'Create workspace' }).click();
  const inviteBox = admin.getByLabel('Owner invite link');
  await expect(inviteBox).toHaveValue(/\/invite\/[A-Za-z0-9_-]{43}$/);
  const inviteLink = await inviteBox.inputValue();
  await admin.getByRole('button', { name: 'Copy owner invite link' }).click();
  expect(await admin.evaluate(() => navigator.clipboard.readText())).toBe(inviteLink);
  await expect(admin.getByRole('link', { name, exact: true })).toBeVisible();

  // The owner joins through the link and lands on the new, empty workspace.
  const ownerContext = await browser.newContext({ baseURL: app.baseURL });
  const owner = await ownerContext.newPage();
  await owner.goto(inviteLink);
  await owner.getByLabel('Your name').fill(OWNER_NAME);
  await owner.getByLabel('Password').fill('meera first long passphrase');
  await owner.getByRole('button', { name: 'Join' }).click();
  await owner.waitForURL('**/dashboard/user');
  await expect(owner.getByRole('heading', { level: 1, name })).toBeVisible();
  await expect(owner.getByText('No services yet')).toBeVisible();

  // The used link no longer works.
  const reused = await ownerContext.newPage();
  await reused.goto(inviteLink);
  await reused.getByLabel('Your name').fill('Someone Else');
  await reused.getByLabel('Password').fill('another long passphrase here');
  await reused.getByRole('button', { name: 'Join' }).click();
  await expect(reused.getByRole('alert')).toBeVisible();
  await reused.close();

  // A reset link for the owner, shown once; the owner sets a new password and signs in with it.
  await admin.goto('/dashboard/admin/people');
  await admin.getByLabel('Name or email').fill(ownerEmail);
  await admin.getByRole('button', { name: 'Search' }).click();
  await admin.getByRole('link', { name: OWNER_NAME }).first().click();
  await expect(admin.getByRole('heading', { level: 1, name: OWNER_NAME })).toBeVisible();
  await admin.getByRole('button', { name: 'Create password reset link' }).click();
  const dialog = admin.getByRole('alertdialog');
  await dialog.getByLabel('Reason (stored on the audit record)').fill('Owner forgot the password on the onboarding call');
  await dialog.getByRole('button', { name: 'Create link' }).click();
  const resetBox = admin.getByLabel('Password reset link');
  await expect(resetBox).toHaveValue(/\/reset\/[A-Za-z0-9_-]{43}$/);
  const resetLink = await resetBox.inputValue();

  await owner.goto(resetLink);
  await owner.getByLabel('New password').fill('meera second long passphrase');
  await owner.getByRole('button', { name: 'Set password' }).click();
  await owner.waitForURL('**/login');
  await signInWithPassword(owner, ownerEmail, 'meera second long passphrase', '/dashboard/user');
  await expect(owner.getByRole('heading', { level: 1, name })).toBeVisible();
  await ownerContext.close();

  // The audit log finds the creation, without the address or either link.
  await admin.goto(`/dashboard/admin/audit?action=workspace.create&workspace=${slug}`);
  await expect(admin.locator('[data-audit-row="workspace.create"]')).toHaveCount(1);
  await expect(admin.locator('body')).not.toContainText(inviteLink);
  await expect(admin.locator('body')).not.toContainText(resetLink);
  await expect(admin.locator('body')).not.toContainText(ownerEmail);

  // The audited view needs a reason and opens with its banner.
  await admin.goto('/dashboard/admin/workspaces');
  await admin.getByRole('link', { name, exact: true }).first().click();
  await expect(admin.getByRole('heading', { level: 1, name })).toBeVisible();
  await admin.getByLabel('Reason for opening (stored on the audit record)').fill('E2E check of the onboarding defaults');
  await admin.getByRole('button', { name: 'Open audited view' }).click();
  const banner = admin.getByRole('note', { name: 'Audited view' });
  await expect(banner).toContainText(`Audited view of ${name}: read-only`);
  await expect(banner).toContainText('E2E check of the onboarding defaults');
  await expect(admin.getByText('No leads yet.')).toBeVisible();

  const onboarded: Onboarded = { name, slug, ownerEmail, storageState: await context.storageState() };
  await context.close();
  return onboarded;
}

/** A later project: the administrator's saved browser state, and the same installation's admin pages at this viewport. */
async function recheck(browser: Browser, app: LiveApp, done: Onboarded) {
  const context = await browser.newContext({ baseURL: app.baseURL, storageState: done.storageState });
  const admin = await context.newPage();
  await admin.goto('/dashboard/admin/workspaces');
  await expect(admin.getByRole('heading', { level: 1, name: 'Workspaces' })).toBeVisible();
  await admin.getByRole('link', { name: done.name, exact: true }).first().click();
  await expect(admin.getByRole('heading', { level: 1, name: done.name })).toBeVisible();
  await expect(admin.getByRole('link', { name: OWNER_NAME }).first()).toBeVisible();
  await expect(admin.getByRole('button', { name: 'Open audited view' })).toBeVisible();

  await admin.goto(`/dashboard/admin/people?q=${encodeURIComponent(done.ownerEmail)}`);
  await expect(admin.getByRole('link', { name: OWNER_NAME }).first()).toBeVisible();
  await admin.goto(`/dashboard/admin/audit?action=workspace.create&workspace=${done.slug}`);
  await expect(admin.locator('[data-audit-row="workspace.create"]')).toHaveCount(1);
  await context.close();
}

test('LIVE: the first administrator onboards a workspace owner by link and resets their password', async ({ browser }, testInfo) => {
  test.setTimeout(240_000);
  const app = liveApp();
  const done = readOnboarded(app);
  if (done) {
    await recheck(browser, app, done);
    return;
  }
  const run = `${testInfo.project.name.replace(/[^a-z0-9]/gi, '').toLowerCase()}-${Date.now().toString(36)}`;
  const onboarded = await onboard(browser, app, run);
  writeFileSync(onboardedFile(app), JSON.stringify(onboarded));
});

test('DEMO: the Super admin sees seeded people and workspaces; a role-switcher persona keeps its role', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('button', { name: /^Super admin/ }).first().click();
  await page.waitForURL('**/dashboard/admin');

  await page.goto('/dashboard/admin/workspaces');
  await expect(page.getByRole('link', { name: 'Smile Avenue Dental Clinic', exact: true }).first()).toBeVisible();

  await page.goto('/dashboard/admin/people');
  await page.getByLabel('Name or email').fill('owner@demo.auralead.test');
  await page.getByRole('button', { name: 'Search' }).click();
  await page.getByRole('link', { name: 'Ananya Sharma' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Ananya Sharma' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Change role' })).toHaveAttribute('aria-disabled', 'true');
  await expect(page.getByText('The DEMO role switcher signs in as this person, so their role and status stay as seeded.').first()).toBeVisible();
});
