/**
 * Employee approval queue for one workspace (T22; 06-design §11.2 "Approvals", §11.3 "Approvals
 * queue"). The `[ws]` slug is resolved against the employee's active assignments (404 otherwise);
 * the queue needs `leads.read` and is read-only without `approvals.decide`. Pending items are oldest
 * first; recently decided ones show their dispatch outcome. The page re-reads itself every 10 s.
 *
 * Look (design spec §6): PageHeader in the operator hue, a row of fact tiles computed from the
 * queue on screen (waiting split into quotations and messages, the oldest wait, recent decisions;
 * static numbers), then the waiting and decided lists.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft, ClipboardCheck, Hourglass, ListChecks, Lock, Users } from 'lucide-react';
import { QueueList } from '@/components/approvals/QueueList';
import { waitingTier } from '@/components/approvals/approval-vocabulary';
import { AutoRefresh } from '@/components/inbox/AutoRefresh';
import { ageHint, formatShortDateTime } from '@/components/inbox/format';
import { EmptyState } from '@/components/patterns/EmptyState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatTile } from '@/components/patterns/StatTile';
import { buttonVariants, touchTarget } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Reveal, Stagger, StaggerItem } from '@/components/visual/Reveal';
import { NotFoundError, PermissionDeniedError } from '@/lib/errors';
import { getPageContext } from '@/server/auth/page-context';
import { listApprovalQueue, type ApprovalQueue } from '@/server/services/approvals/queue';

export const metadata: Metadata = { title: 'Approvals' };
export const dynamic = 'force-dynamic';

function CountPill({ value }: { value: number }) {
  return <span className="tabular inline-flex min-w-6 justify-center rounded-full border border-border-strong bg-bg-2 px-2 text-sm font-medium text-fg-1">{value}</span>;
}

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
  const quotes = queue?.pending.filter((i) => i.quote !== null).length ?? 0;
  const messages = (queue?.pending.length ?? 0) - quotes;
  const oldest = queue?.pending[0] ?? null;
  const oldestMs = oldest ? now.getTime() - oldest.requestedAt.getTime() : 0;
  const approved = queue?.recent.filter((i) => i.status === 'APPROVED').length ?? 0;
  const rejected = (queue?.recent.length ?? 0) - approved;

  return (
    <div className="flex flex-col gap-6">
      <AutoRefresh intervalMs={10_000} />
      <Link href="/dashboard/employee/approvals" className={cn('group relative inline-flex w-fit items-center gap-1.5 text-sm text-fg-2 hover:text-fg-1', touchTarget)}>
        <ArrowLeft aria-hidden="true" className="size-4 transition-transform duration-fast motion-safe:group-hover:-translate-x-0.5" />
        All approvals
      </Link>
      <PageHeader
        className="-mt-3"
        eyebrow={queue?.workspace.name ?? ws}
        title="Approval queue"
        description="Quotations and messages wait here until a person approves them. Nothing is sent before that, and every send is checked again at dispatch."
        actions={
          <Link href={`/dashboard/employee/${ws}/leads`} className={buttonVariants({ variant: 'secondary' })}>
            <Users aria-hidden="true" />
            Lead console
          </Link>
        }
      />

      {queue === null ? (
        <EmptyState
          icon={<Lock aria-hidden="true" className="size-5" />}
          title="Approvals are not part of your assignment"
          description="Your assignment in this workspace does not include reading leads. A super admin can change it from the people page."
        />
      ) : (
        <>
          <Stagger className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <StaggerItem className="col-span-2 sm:col-span-1">
              <StatTile
                label="Waiting"
                value={queue.pending.length}
                icon={<ClipboardCheck />}
                hint={`${quotes} ${quotes === 1 ? 'quotation' : 'quotations'} · ${messages} ${messages === 1 ? 'message' : 'messages'}`}
              />
            </StaggerItem>
            <StaggerItem>
              <StatTile
                label="Oldest wait"
                value={oldest ? ageHint(oldestMs).replace(' ago', '') : 'None'}
                icon={<Hourglass />}
                tone={oldest ? waitingTier(oldestMs).tone : 'neutral'}
                hint={oldest ? `Requested ${formatShortDateTime(oldest.requestedAt, queue.workspace.timezone)}` : 'Nothing is waiting.'}
              />
            </StaggerItem>
            <StaggerItem>
              <StatTile label="Recently decided" value={queue.recent.length} icon={<ListChecks />} tone="neutral" hint={`${approved} approved · ${rejected} rejected`} />
            </StaggerItem>
          </Stagger>

          {!queue.permissions.canDecide ? (
            <p className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-fg-1">
              <Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
              Read-only: your assignment here does not include approving.
            </p>
          ) : null}
          <section aria-labelledby="pending-heading">
            <Reveal delay={0.1} className="flex flex-col gap-3">
              <h2 id="pending-heading" className="flex items-center gap-2 font-display text-lg font-semibold text-fg-1">
                Waiting <CountPill value={queue.pending.length} />
              </h2>
              {queue.pending.length === 0 ? (
                <EmptyState
                  headingLevel="h3"
                  icon={<ClipboardCheck aria-hidden="true" className="size-5" />}
                  title="Nothing waiting"
                  description="New quotation versions, reply suggestions and drafts saved for review appear here."
                />
              ) : (
                <QueueList items={queue.pending} href={(i) => `/dashboard/employee/${ws}/approvals/${i.id}`} now={now} timeZone={queue.workspace.timezone} />
              )}
            </Reveal>
          </section>
          {queue.recent.length > 0 ? (
            <section aria-labelledby="recent-heading">
              <Reveal delay={0.16} className="flex flex-col gap-3">
                <h2 id="recent-heading" className="flex items-center gap-2 font-display text-lg font-semibold text-fg-1">
                  Recently decided <CountPill value={queue.recent.length} />
                </h2>
                <QueueList items={queue.recent} href={(i) => `/dashboard/employee/${ws}/approvals/${i.id}`} now={now} timeZone={queue.workspace.timezone} decided />
              </Reveal>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
