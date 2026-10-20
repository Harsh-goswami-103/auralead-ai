/**
 * T29 admin pages render from the database in LIVE, for the super admin, to the HTML a browser
 * gets (server render of the page and its client islands): the workspace list and page, People
 * and a person, and the audit log. They show this mode's data only (no demo account in LIVE), gate
 * the self-change controls with their reason, never print a credential (token hashes, or a reset
 * link that was shown once), and the audit log reports filters it could not read.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import AuditPage from '@/app/dashboard/admin/audit/page';
import PersonPage from '@/app/dashboard/admin/people/[userId]/page';
import PeoplePage from '@/app/dashboard/admin/people/page';
import WorkspacePage from '@/app/dashboard/admin/workspaces/[workspaceId]/page';
import WorkspacesPage from '@/app/dashboard/admin/workspaces/page';
import { issueResetLink } from '@/server/services/admin/people';
import { createLiveAdminHarness, liveCtx, liveSession, type LiveAdminHarness } from './live-support';
import { testEnv } from '../auth/support';

const pageHeaders = vi.hoisted(() => ({ current: new Headers() }));
vi.mock('next/headers', () => ({ headers: async () => pageHeaders.current }));
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()),
  useRouter: () => ({ refresh: () => undefined, push: () => undefined, replace: () => undefined, prefetch: () => undefined, back: () => undefined, forward: () => undefined }),
  usePathname: () => '/dashboard/admin',
}));

let h: LiveAdminHarness;
const savedEnv = { ...process.env };

beforeAll(async () => {
  h = await createLiveAdminHarness('admin-pages');
  Object.assign(process.env, testEnv('live'), { NEXT_PUBLIC_APP_MODE: 'live' });
  const admin = await liveSession(h, h.ids.adminId);
  pageHeaders.current = new Headers({ cookie: admin.cookie });
}, 120_000);
afterAll(async () => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  await h?.destroy();
});

const PAGES = {
  workspaces: WorkspacesPage,
  workspace: WorkspacePage,
  people: PeoplePage,
  person: PersonPage,
  audit: AuditPage,
} as unknown as Record<string, (props: unknown) => Promise<ReactElement>>;

async function html(page: keyof typeof PAGES | string, props: { params?: Record<string, string>; searchParams?: Record<string, string> } = {}): Promise<string> {
  const element = await PAGES[page]!({ params: Promise.resolve(props.params ?? {}), searchParams: Promise.resolve(props.searchParams ?? {}) });
  return renderToStaticMarkup(element);
}

describe('admin pages (LIVE)', () => {
  it('Workspaces lists this mode with owners, and offers the create form', async () => {
    const out = await html('workspaces');
    expect(out).toContain('Create a workspace');
    expect(out).toContain('Alpha Dental');
    expect(out).toContain('Beta Interiors');
    expect(out).toContain('owner');
    expect(out).toContain('No owner yet');
    expect(out).not.toMatch(/tokenHash|passwordHash/);
  });

  it('a workspace page shows access and invites, and keeps tenant data behind the audited view', async () => {
    const out = await html('workspace', { params: { workspaceId: h.ids.workspaceAId } });
    expect(out).toContain('People with access');
    expect(out).toContain('owner@alpha.test');
    expect(out).not.toContain('demo-owner@alpha.test');
    expect(out).toContain('Open audited view');
    expect(out).not.toContain('data-audited-banner');
    await expect(html('workspace', { params: { workspaceId: 'nosuchworkspace0000000000' } })).rejects.toMatchObject({ digest: expect.stringContaining('404') });
  });

  it('People lists everyone in LIVE but no demo account, with role and status as icon + label', async () => {
    const out = await html('people');
    expect(out).toContain('owner@alpha.test');
    expect(out).toContain('employee@example.test');
    expect(out).not.toContain('demo-owner@alpha.test');
    expect(out).toContain('data-role-chip="EMPLOYEE"');
    expect(out).toContain('data-status-chip="ACTIVE"');
    expect(out).toContain('Invite someone');
    const filtered = await html('people', { searchParams: { globalRole: 'SUPER_ADMIN' } });
    expect(filtered).toContain('admin@example.test');
    expect(filtered).not.toContain('owner@alpha.test');
  });

  it('a person page offers the access actions, gates your own role and status, and never prints a reset link again', async () => {
    const { token } = await issueResetLink(await liveCtx(h, h.ids.adminId), { userId: h.ids.memberId, reason: 'Forgot password on a call' });
    const member = await html('person', { params: { userId: h.ids.memberId } });
    expect(member).toContain('Change role');
    expect(member).toContain('Disable account');
    expect(member).toContain('Create password reset link');
    expect(member).toContain('Alpha Dental');
    expect(member).toContain('Unused reset links');
    expect(member).not.toContain(token);
    expect(member).toContain('password.reset_issue');

    const self = await html('person', { params: { userId: h.ids.adminId } });
    expect(self).toContain('You cannot change your own role or status. Ask another administrator.');
    expect(self).toContain('aria-disabled="true"');

    await expect(html('person', { params: { userId: h.ids.demoOwnerId } })).rejects.toMatchObject({ digest: expect.stringContaining('404') });
  });

  it('the audit log renders filtered rows and says when a filter could not be read', async () => {
    const out = await html('audit', { searchParams: { action: 'password.' } });
    expect(out).toContain('data-audit-row="password.reset_issue"');
    expect(out).toContain('Forgot password on a call');
    const bad = await html('audit', { searchParams: { from: '15-10-2026' } });
    expect(bad).toContain('Some filters were not understood');
  });
});
