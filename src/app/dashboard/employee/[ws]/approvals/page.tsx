/**
 * Employee approval queue for one workspace (T22; 06-design §11.2 "Approvals", §11.3 "Approvals
 * queue"). The `[ws]` slug is resolved against the employee's active assignments (404 otherwise);
 * the queue needs `leads.read` and is read-only without `approvals.decide`. Pending items are oldest
 * first; recently decided ones show their dispatch outcome. The page re-reads itself every 10 s.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ClipboardCheck, Lock } from 'lucide-react';
import { QueueList } from '@/components/approvals/QueueList';
import { AutoRefresh } from '@/components/inbox/AutoRefresh';
import { EmptyState } from '@/components/patterns/EmptyState';
import { NotFoundError, PermissionDeniedError } from '@/lib/errors';
import { getPageContext } from '@/server/auth/page-context';
import { listApprovalQueue, type ApprovalQueue } from '@/server/services/approvals/queue';

export const metadata: Metadata = { title: 'Approvals' };
export const dynamic = 'force-dynamic';

export default async function WorkspaceApprovalsPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  let page;
  try {
    page = await getPageContext({ workspaceSlug: ws });
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  if (!page) redirect('/login');
  if (page.session.user.globalRole !== 'EMPLOYEE') notFound();
  let queue: ApprovalQueue | null = null;
  try {
    queue = await listApprovalQueue(page.ctx);
  } catch (error) {
    if (!(error instanceof PermissionDeniedError)) throw error;
  }
  const now = page.ctx.clock.now();

  return (
    <div className="flex flex-col gap-6">
      <AutoRefresh intervalMs={10_000} />
      <header className="flex flex-col gap-1">
        <p className="text-sm text-fg-2">
          <Link href="/dashboard/employee/approvals" className="hover:text-fg-1">
            Approvals
          </Link>{' '}
          / {queue?.workspace.name ?? ws}
        </p>
        <h1 className="font-display text-2xl font-semibold text-fg-1 sm:text-3xl">Approval queue</h1>
        <p className="max-w-prose text-fg-2">Quotations and messages wait here until a person approves them. Nothing is sent before that, and every send is checked again at dispatch.</p>
      </header>

      {queue === null ? (
        <EmptyState icon={<Lock aria-hidden="true" className="size-5" />} title="Approvals are not part of your assignment" description="Your assignment in this workspace does not include reading leads. A super admin can change it from the people page." />
      ) : (
        <>
          {!queue.permissions.canDecide ? <p className="rounded-lg border border-border-strong bg-bg-2 px-3 py-2 text-sm text-fg-2">Read-only: your assignment here does not include approving.</p> : null}
          <section aria-labelledby="pending-heading" className="flex flex-col gap-3">
            <h2 id="pending-heading" className="font-display text-lg font-semibold text-fg-1">
              Waiting ({queue.pending.length})
            </h2>
            {queue.pending.length === 0 ? (
              <EmptyState icon={<ClipboardCheck aria-hidden="true" className="size-5" />} title="Nothing waiting" description="New quotation versions, AI reply suggestions and drafts saved for review appear here." />
            ) : (
              <QueueList items={queue.pending} href={(i) => `/dashboard/employee/${ws}/approvals/${i.id}`} now={now} timeZone={queue.workspace.timezone} />
            )}
          </section>
          {queue.recent.length > 0 ? (
            <section aria-labelledby="recent-heading" className="flex flex-col gap-3">
              <h2 id="recent-heading" className="font-display text-lg font-semibold text-fg-1">
                Recently decided
              </h2>
              <QueueList items={queue.recent} href={(i) => `/dashboard/employee/${ws}/approvals/${i.id}`} now={now} timeZone={queue.workspace.timezone} decided />
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
