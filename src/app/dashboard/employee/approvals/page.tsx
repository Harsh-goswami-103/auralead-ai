/**
 * Cross-workspace approval view for an employee (T22; 06-design §11.2 route map "also cross-ws view
 * at /dashboard/employee/approvals", F8). One section per active assignment, each read through that
 * workspace's own tenant-scoped context (the same resolution as a `[ws]` page), so an item is only
 * ever shown and decided inside its workspace. A workspace where the assignment lacks `leads.read`
 * is listed as not readable instead of hidden. Every item opens in its workspace's queue. The
 * workspaces are read in parallel; their order is kept.
 *
 * Look (design spec §6): PageHeader in the operator hue, fact tiles counted from the queues on
 * screen (static numbers), then one section per workspace with its waiting count and queue link.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowRight, Building2, ClipboardCheck, FileText, Lock, MessagesSquare } from 'lucide-react';
import { KIND_TILE } from '@/components/approvals/approval-vocabulary';
import { QueueList } from '@/components/approvals/QueueList';
import { AutoRefresh } from '@/components/inbox/AutoRefresh';
import { EmptyState } from '@/components/patterns/EmptyState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatTile } from '@/components/patterns/StatTile';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Reveal, Stagger, StaggerItem } from '@/components/visual/Reveal';
import { PermissionDeniedError } from '@/lib/errors';
import { getPageContext } from '@/server/auth/page-context';
import { getRuntime } from '@/server/boot';
import { listApprovalQueue, type ApprovalQueue } from '@/server/services/approvals/queue';
import { loadPanelChrome } from '@/server/services/shell/panel-chrome';

export const metadata: Metadata = { title: 'Approvals' };
export const dynamic = 'force-dynamic';

type Section = { slug: string; name: string; queue: ApprovalQueue | null };

async function loadSection(ws: { slug: string; name: string }): Promise<Section> {
  const scoped = await getPageContext({ workspaceSlug: ws.slug });
  if (!scoped) redirect('/login');
  try {
    return { slug: ws.slug, name: ws.name, queue: await listApprovalQueue(scoped.ctx) };
  } catch (error) {
    if (!(error instanceof PermissionDeniedError)) throw error;
    return { slug: ws.slug, name: ws.name, queue: null };
  }
}

export default async function EmployeeApprovalsPage() {
  const page = await getPageContext();
  if (!page) redirect('/login');
  if (page.session.user.globalRole !== 'EMPLOYEE') notFound();
  const chrome = await loadPanelChrome(page.ctx, page.session, { envOutboundPaused: getRuntime().config.outboundPaused, outboundLockFile: getRuntime().config.paths.outboundLockFile });
  const sections: Section[] = await Promise.all(chrome.switchable.map((ws) => loadSection(ws)));
  const now = page.ctx.clock.now();
  const waiting = sections.reduce((n, s) => n + (s.queue?.pending.length ?? 0), 0);
  const quotes = sections.reduce((n, s) => n + (s.queue?.pending.filter((i) => i.quote !== null).length ?? 0), 0);
  const messages = waiting - quotes;

  return (
    <div className="flex flex-col gap-6">
      <AutoRefresh intervalMs={10_000} />
      <PageHeader
        eyebrow="Approvals"
        title="All assigned workspaces"
        description={
          sections.length === 0
            ? 'You have no active workspace assignment.'
            : `${waiting} item${waiting === 1 ? '' : 's'} waiting across ${sections.length} workspace${sections.length === 1 ? '' : 's'}. Each item is decided inside its own workspace.`
        }
      />

      {sections.length === 0 ? (
        <EmptyState icon={<Building2 aria-hidden="true" className="size-5" />} title="No assigned workspaces" description="A super admin assigns workspaces to employees. Their approval queues appear here once assigned." />
      ) : (
        <>
          <Stagger className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <StaggerItem className="col-span-2 sm:col-span-1">
              <StatTile label="Waiting" value={waiting} icon={<ClipboardCheck />} hint={`Across ${sections.length} ${sections.length === 1 ? 'workspace' : 'workspaces'}`} />
            </StaggerItem>
            <StaggerItem>
              <StatTile label="Quotations waiting" value={quotes} icon={<FileText />} className={KIND_TILE.quote} hint="Versions to approve or send" />
            </StaggerItem>
            <StaggerItem>
              <StatTile label="Messages waiting" value={messages} icon={<MessagesSquare />} className={KIND_TILE.message} hint="Drafts and reply suggestions" />
            </StaggerItem>
          </Stagger>

          {sections.map((s, index) => (
            <section key={s.slug} aria-labelledby={`ws-${s.slug}`} data-workspace-queue={s.slug}>
              <Reveal delay={0.08 + index * 0.05} className="flex flex-col gap-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-panel/30 bg-panel/12 text-panel">
                      <Building2 className="size-4" />
                    </span>
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
                      <h2 id={`ws-${s.slug}`} className="min-w-0 font-display text-lg leading-tight font-semibold text-fg-1">
                        {s.name}
                      </h2>
                      {s.queue ? (
                        <span className="tabular inline-flex shrink-0 items-center rounded-full border border-border-strong bg-bg-2 px-2 text-xs leading-5 font-medium whitespace-nowrap text-fg-1">
                          {s.queue.pending.length} waiting
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <Link href={`/dashboard/employee/${s.slug}/approvals`} className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'group/link shrink-0 text-cyan')}>
                    Open queue<span className="sr-only"> for {s.name}</span>
                    <ArrowRight aria-hidden="true" className="transition-transform duration-fast motion-safe:group-hover/link:translate-x-0.5" />
                  </Link>
                </div>
                {s.queue === null ? (
                  <p className="flex items-center gap-2 rounded-lg border border-border-subtle bg-bg-1/80 px-4 py-3 text-sm text-fg-2">
                    <Lock aria-hidden="true" className="size-4 shrink-0" />
                    Not readable: your assignment here does not include leads.
                  </p>
                ) : s.queue.pending.length === 0 ? (
                  <p className="flex items-center gap-2 rounded-lg border border-border-subtle bg-bg-1/80 px-4 py-3 text-sm text-fg-2">
                    <ClipboardCheck aria-hidden="true" className="size-4 shrink-0 text-success" />
                    Nothing waiting.
                  </p>
                ) : (
                  <QueueList items={s.queue.pending} href={(i) => `/dashboard/employee/${s.slug}/approvals/${i.id}`} now={now} timeZone={s.queue.workspace.timezone} />
                )}
              </Reveal>
            </section>
          ))}
        </>
      )}
    </div>
  );
}
