/**
 * One conversation in the operator's inbox (ADR-121, slice F3): the shared ConversationView read
 * through the assignment's context, every action naming the workspace by its slug. The `[ws]` slug
 * is resolved against the employee's active assignments (404 otherwise, A6); a conversation that
 * is not in that workspace is 404; without `leads.read` the page says so (NotInAssignment).
 *
 * Once the lead is handed over to the client (ADR-124) the thread is read-only here: the handoff
 * banner and timeline event show who handed it to whom, and the composer, AI mode and approval
 * actions are closed (the services refuse an operator with 409 HANDED_OVER anyway). The lead links
 * to the operator's lead console; quotations are listed without links (they live in the client's
 * panel).
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ConversationView } from '@/components/inbox/ConversationView';
import { NotInAssignment } from '@/components/integrations/NotInAssignment';
import { WorkspaceSectionNav } from '@/components/integrations/WorkspaceSectionNav';
import { NotFoundError } from '@/lib/errors';
import { hasCapability } from '@/server/auth/guards';
import { getRuntime } from '@/server/boot';
import { getInboxThread, inboxDepsFromConfig, listInboxThreads, type InboxList, type InboxThread } from '@/server/services/messaging/inbox';
import { readOrNull, workspacePage } from '../../integrations/_lib/workspace-page';

export const metadata: Metadata = { title: 'Conversation' };
export const dynamic = 'force-dynamic';

export default async function EmployeeConversationPage({ params }: { params: Promise<{ ws: string; conversationId: string }> }) {
  const { ws, conversationId } = await params;
  const page = await workspacePage(ws);
  let thread: InboxThread | null;
  let list: InboxList | null;
  try {
    thread = await readOrNull(() => getInboxThread(page.ctx, conversationId, inboxDepsFromConfig(getRuntime().config)));
    list = thread ? await listInboxThreads(page.ctx, {}) : null;
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  if (thread === null || list === null) {
    return (
      <div className="flex flex-col gap-6">
        <WorkspaceSectionNav slug={ws} workspaceName={ws} />
        <NotInAssignment what="The inbox" />
      </div>
    );
  }
  const basePath = `/dashboard/employee/${encodeURIComponent(ws)}/inbox`;
  return (
    <div className="flex flex-col gap-6">
      <WorkspaceSectionNav slug={ws} workspaceName={thread.workspace.name} />
      <ConversationView
        thread={thread}
        list={list}
        basePath={basePath}
        workspaceSlug={ws}
        canDecide={hasCapability(page.ctx, 'approvals.decide')}
        links={{ list: basePath, lead: `/dashboard/employee/${encodeURIComponent(ws)}/leads/${thread.lead.id}`, quote: null, newQuote: null }}
      />
    </div>
  );
}
