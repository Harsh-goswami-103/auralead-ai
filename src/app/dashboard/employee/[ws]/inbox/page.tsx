/**
 * The operator's inbox for one assigned workspace (ADR-121, slice F3): the same WhatsApp-like thread
 * list as the client's inbox, read through the assignment's context. The `[ws]` slug is resolved
 * against the employee's active assignments (no session: /login; another role or a workspace outside
 * the assignments: 404); reading needs `leads.read`, and without it the page says so
 * (NotInAssignment) instead of failing.
 *
 * Filters All / Needs you / Handed over (a handed-over lead belongs to the client: its thread is
 * read-only here, ADR-124). The header carries the workspace's Automatic sending switch
 * (`automation.manage`). In DEMO the operator can make a lead "send" a WhatsApp message through the
 * same receive path (Simulated). The list re-reads itself every 10 s so worker results appear.
 */
import type { Metadata } from 'next';
import { Inbox } from 'lucide-react';
import { AutoRefresh } from '@/components/inbox/AutoRefresh';
import { AutoSendToggle } from '@/components/inbox/AutoSendToggle';
import { DemoSimulator } from '@/components/inbox/DemoSimulator';
import { INBOX_EMPTY, inboxFilterOf } from '@/components/inbox/filters';
import { InboxFilter } from '@/components/inbox/InboxFilter';
import { ThreadList } from '@/components/inbox/ThreadList';
import { NotInAssignment } from '@/components/integrations/NotInAssignment';
import { WorkspaceSectionNav } from '@/components/integrations/WorkspaceSectionNav';
import { EmptyState } from '@/components/patterns/EmptyState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { hasCapability } from '@/server/auth/guards';
import { getWorkspaceAutoSend } from '@/server/services/messaging/conversations';
import { listInboxThreads, listSimulationLeads } from '@/server/services/messaging/inbox';
import { readOrNull, workspacePage } from '../integrations/_lib/workspace-page';

export const metadata: Metadata = { title: 'Inbox' };
export const dynamic = 'force-dynamic';

export default async function EmployeeInboxPage({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { ws } = await params;
  const page = await workspacePage(ws);
  const filter = inboxFilterOf((await searchParams).filter);
  const list = await readOrNull(() => listInboxThreads(page.ctx, { filter }));
  const autoSend = await readOrNull(() => getWorkspaceAutoSend(page.ctx));
  const name = autoSend?.workspaceName ?? ws;
  const basePath = `/dashboard/employee/${encodeURIComponent(ws)}/inbox`;
  const demo = page.ctx.mode === 'demo';
  const simLeads = demo && list ? await listSimulationLeads(page.ctx) : [];

  return (
    <div className="flex flex-col gap-6">
      <AutoRefresh intervalMs={10_000} />
      <PageHeader
        eyebrow={name}
        title="Inbox"
        description="WhatsApp and email threads with this workspace's leads. Every reply is checked for consent, opt-outs and the 24-hour window when it is sent."
        actions={autoSend ? <AutoSendToggle enabled={autoSend.enabled} canManage={hasCapability(page.ctx, 'automation.manage')} workspaceName={name} workspaceSlug={ws} /> : undefined}
      />
      <WorkspaceSectionNav slug={ws} workspaceName={name} />
      {list === null ? (
        <NotInAssignment what="The inbox" />
      ) : (
        <>
          <InboxFilter current={filter} counts={list.counts} basePath={basePath} />
          <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
            {list.rows.length === 0 ? (
              <EmptyState icon={<Inbox aria-hidden="true" className="size-5" />} title={INBOX_EMPTY[filter].title} description={INBOX_EMPTY[filter].description} />
            ) : (
              <ThreadList rows={list.rows} timeZone={list.timezone} now={list.serverNow} basePath={basePath} />
            )}
            {demo ? (
              <aside aria-label="Demo tools" className="min-w-0 xl:sticky xl:top-20">
                <DemoSimulator leads={simLeads} canSimulate={hasCapability(page.ctx, 'leads.write')} workspaceSlug={ws} />
              </aside>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
