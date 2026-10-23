/**
 * ADR-120 (slice F2): the operator's import page renders in-process (next/headers returns the
 * persona's session cookie; markup checked as text). Without leads.import the upload is gated with
 * the reason; the sample workbook link and the file instructions are always there. With
 * leads.import, `?import=<id>` reopens the viewer's own preview at the mapping step and lists it
 * under recent imports; another person's import id shows the upload step.
 */
import { createElement, type FC, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import EmployeeLeadImportPage from '@/app/dashboard/employee/[ws]/leads/import/page';
import { CsrfProvider } from '@/components/patterns/csrf';
import { createSession, sessionCookieName } from '@/server/auth/session';
import { seedId } from '../../../prisma/seed/ids';
import { businessRows, createImportHarness, csvUpload, ownerOf, upload, userCtx, WS_A, type ImportHarness } from './support';

const pageHeaders = vi.hoisted(() => ({ current: new Headers() }));
vi.mock('next/headers', () => ({ headers: async () => pageHeaders.current }));
vi.mock('next/navigation', async (orig) => ({ ...(await orig<typeof import('next/navigation')>()), useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }) }));

let h: ImportHarness;

beforeAll(async () => {
  h = await createImportHarness('import-page');
}, 120_000);

afterAll(async () => {
  await h?.cleanup();
});

async function signInAs(key: string) {
  const user = await h.db.user.findUniqueOrThrow({ where: { id: seedId('user', key) } });
  const { token } = await createSession(h.db, { userId: user.id, globalRole: user.globalRole, mode: 'DEMO', activeWorkspaceId: null, ipHash: 'x', userAgent: 'vitest', now: h.clock.now() });
  pageHeaders.current = new Headers({ cookie: `${sessionCookieName(h.config)}=${token}` });
}

const html = (el: unknown) => renderToStaticMarkup(createElement(CsrfProvider as unknown as FC<{ token: string }>, { token: 'csrf' }, el as ReactElement)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const render = async (query: Record<string, string> = {}) => html(await EmployeeLeadImportPage({ params: Promise.resolve({ ws: 'smile-avenue-dental' }), searchParams: Promise.resolve(query) }));

describe('the import page', () => {
  it('without leads.import: the upload is gated with the reason; the sample and the instructions are shown', async () => {
    await signInAs('employee');
    const text = await render();
    expect(text).toContain('Import leads');
    expect(text).toContain('Choose a file');
    expect(text).toContain('Your assignment does not include leads.import');
    expect(text).toContain('Download sample workbook');
    expect(text).toContain('Keep the column names in the first row');
    expect(text).not.toContain('Your recent imports');
    expect(text).not.toContain('WhatsApp opt-ins in this file');
  });

  it('with leads.import, ?import= reopens the viewer’s own preview at the mapping step', async () => {
    await h.db.employeeAssignment.updateMany({
      where: { employeeUserId: seedId('user', 'employee'), workspaceId: WS_A },
      data: { capabilities: ['leads.read', 'leads.write', 'leads.export', 'leads.import'] },
    });
    const operator = await userCtx(h.db, h.clock, 'employee', 'smile-avenue-dental');
    const { import: created } = await upload(h, operator, csvUpload([['Shop name', 'Mobile', 'Town'], ...businessRows(2, 'Page Shop', 300)], 'page-key-0001'));
    const owner = await ownerOf(h);
    const { import: foreign } = await upload(h, owner, csvUpload([['Name', 'Phone'], ['Owner Only Cafe', '98260 77777']], 'page-key-0002'));

    await signInAs('employee');
    const text = await render({ import: created.id });
    expect(text).toContain('Which column holds what');
    expect(text).toContain('Page Shop 1');
    expect(text).toContain('Your recent imports');
    expect(text).toContain('Continue');
    // Not an owner: no opt-in section.
    expect(text).not.toContain('WhatsApp opt-ins in this file');

    const other = await render({ import: foreign.id });
    expect(other).not.toContain('Owner Only Cafe');
    expect(other).toContain('Choose a file');
  });
});
