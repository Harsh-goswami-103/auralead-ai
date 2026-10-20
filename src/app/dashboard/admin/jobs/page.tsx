/**
 * Platform admin: jobs and queue health (T24, R33, R40). Worker liveness ("Worker not running"
 * after 30 s without a heartbeat), AMBIGUOUS attempts awaiting an operator, due and retry-waiting
 * jobs, the global outbound pause (with its three sources) and the job list with filters. Rows
 * open the job inspector. Platform metadata only: no tenant records are shown here.
 *
 * Look (design spec §6): health facts as StatTiles whose tone comes from the real value (a dead
 * job turns its tile danger, a stale worker turns it danger, zero stays in the calm panel hue),
 * the real per-status counts as a stacked bar whose legend doubles as status filters, the outbound
 * pause as one card (state chip in its header, the three switches as cards, the Pause / Resume
 * control in its footer; Pause is a danger outline, the solid danger fill stays in the dialog),
 * and a neutral jobs table (sticky header in a scroll region that fades its bottom edge while more
 * rows are below, status chips with icon + label, mono ids) that becomes a divided list on phones.
 * Filters stay a plain GET form with the same params.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ChevronLeft, ChevronRight, CircleHelp, Clock, Cpu, HeartCrack, HeartPulse, ListChecks, Loader, OctagonX, RotateCw, Send } from 'lucide-react';
import { JOB_STATUS_OPTION_LABELS, formatAge, jobStatusEntry } from '@/components/admin/admin-vocabulary';
import { FilterForm } from '@/components/admin/FilterForm';
import { OutboundSources, OutboundStateChip, pauseSources } from '@/components/admin/OutboundState';
import { QueueBreakdown } from '@/components/admin/QueueBreakdown';
import { ScrollRegion } from '@/components/admin/ScrollRegion';
import { SectionTitle } from '@/components/admin/SectionTitle';
import { StatusChip } from '@/components/admin/StatusChip';
import { EmptyState } from '@/components/patterns/EmptyState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { SectionCard } from '@/components/patterns/SectionCard';
import { StatTile, type StatTone } from '@/components/patterns/StatTile';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { BorderBeam } from '@/components/visual/BorderBeam';
import { GlowFrame } from '@/components/visual/GlowFrame';
import { Stagger, StaggerItem } from '@/components/visual/Reveal';
import type { JobStatus } from '@/lib/domain/enums';
import { formatDateTime } from '@/lib/format/date';
import { getPageContext } from '@/server/auth/page-context';
import { getRuntime } from '@/server/boot';
import { JOB_STATUSES, listJobs } from '@/server/services/jobs-admin/inspector';
import { loadQueueHealth } from '@/server/services/jobs-admin/queue-health';
import { AdminAction } from './admin-actions';

export const metadata: Metadata = { title: 'Jobs and queue' };
export const dynamic = 'force-dynamic';

type Search = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** A stretched row link's focus ring outlines the whole row (inset, so the list's clip keeps it). */
const ROW_FOCUS = 'focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-aura';

/** A count's tile tone: the status tone when there is something to look at, the panel hue at rest. */
const whenAny = (count: number, tone: StatTone): StatTone => (count > 0 ? tone : 'panel');

export default async function AdminJobsPage(props: { searchParams: Promise<Search> }) {
  const page = await getPageContext();
  if (!page) redirect('/login');
  const search = await props.searchParams;
  const { config } = getRuntime();
  const statusParam = one(search.status);
  const status = JOB_STATUSES.includes(statusParam as JobStatus) ? (statusParam as JobStatus) : undefined;
  const type = one(search.type);
  const before = one(search.before);

  const health = await loadQueueHealth(page.ctx, {
    lockFile: config.paths.outboundLockFile,
    envPaused: config.outboundPaused,
  });
  const list = await listJobs(page.ctx, { status, type, before });
  const outbound = health.outbound!;
  const mode = page.ctx.mode;
  const href = (params: Record<string, string | undefined>) => {
    const query = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) query.set(k, v);
    const s = query.toString();
    return `/dashboard/admin/jobs${s ? `?${s}` : ''}`;
  };
  const query = (extra: Record<string, string | undefined>) => href({ status, type, ...extra });
  const filtered = Boolean(status || type);
  const sources = pauseSources(outbound);
  const worker = health.worker;
  const dueLagging = health.oldestDueQueued !== null && health.oldestDueQueued.ageMs > 60_000;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader eyebrow="Platform admin" title="Jobs and queue" description="Actions need a reason and a sign-in within 15 minutes, and are audited." meta={`As of ${formatDateTime(health.asOf)}`} />

      <Stagger className="grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-6">
        <StaggerItem className="flex">
          <StatTile
            className="flex-1"
            label="Worker"
            value={worker.label}
            tone={worker.running ? 'success' : 'danger'}
            icon={worker.running ? <HeartPulse /> : <HeartCrack />}
            hint={
              worker.lastBeatAt
                ? `last heartbeat ${formatAge(worker.ageMs ?? 0)} ago${worker.running ? (worker.currentJobId ? ' · processing a job' : ' · idle') : ''}`
                : 'no heartbeat recorded; start it with npm run worker'
            }
          />
        </StaggerItem>
        <StaggerItem className="flex">
          <StatTile
            className="flex-1"
            label="Delivery unknown"
            value={String(health.ambiguousAttempts)}
            tone={whenAny(health.ambiguousAttempts, 'warning')}
            icon={<CircleHelp />}
            hint="AMBIGUOUS sends awaiting an operator"
          />
        </StaggerItem>
        <StaggerItem className="flex">
          <StatTile
            className="flex-1"
            label="Due now"
            value={String(health.dueQueued)}
            tone={whenAny(health.dueQueued, dueLagging ? 'warning' : 'info')}
            icon={<Clock />}
            href={query({ status: 'QUEUED' })}
            hint={health.oldestDueQueued ? `oldest waiting ${formatAge(health.oldestDueQueued.ageMs)}` : 'nothing waiting'}
          />
        </StaggerItem>
        <StaggerItem className="flex">
          <StatTile
            className="flex-1"
            label="Retry waiting"
            value={String(health.retryWaiting)}
            tone={whenAny(health.retryWaiting, 'info')}
            icon={<RotateCw />}
            href={query({ status: 'QUEUED' })}
            hint="queued with a later run time"
          />
        </StaggerItem>
        <StaggerItem className="flex">
          <StatTile
            className="flex-1"
            label="Running"
            value={String(health.byStatus.RUNNING)}
            tone={whenAny(health.byStatus.RUNNING, 'info')}
            icon={<Loader />}
            href={query({ status: 'RUNNING' })}
            hint="held by a worker now"
          />
        </StaggerItem>
        <StaggerItem className="flex">
          <StatTile
            className="flex-1"
            label="Dead"
            value={String(health.byStatus.DEAD)}
            tone={whenAny(health.byStatus.DEAD, 'danger')}
            icon={<OctagonX />}
            href={query({ status: 'DEAD' })}
            hint="out of attempts; open one to retry"
          />
        </StaggerItem>
      </Stagger>

      <SectionCard
        title={
          <SectionTitle icon={<Send />}>
            Outbound delivery
          </SectionTitle>
        }
        meta="Any one switch holds every WhatsApp and email send at preflight."
        actions={<OutboundStateChip paused={outbound.paused} size="md" />}
        className={cn(outbound.paused && 'border-danger/45 [--grad-hairline:linear-gradient(var(--danger),var(--danger))]')}
        accent
      >
        {outbound.paused ? null : <BorderBeam duration={10} />}
        <p className="text-sm text-fg-2">
          {outbound.paused
            ? `Held by ${sources.join(', ')}. Sends already handed to a provider complete; nothing new passes preflight.`
            : 'Sends pass preflight; each still checks consent, suppression, approval and workspace pauses.'}
        </p>
        <OutboundSources state={outbound} detailed layout="grid" />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border-subtle pt-4">
          {outbound.db.paused ? (
            <GlowFrame>
              <AdminAction
                mode={mode}
                variant="default"
                size="default"
                icon="resume"
                triggerLabel="Resume outbound"
                title="Resume outbound delivery"
                description="Queued sends pass preflight again (each still checks consent, suppression, approval and pauses). A lock written by a database restore is removed too."
                confirmLabel="Resume"
                endpoint="/api/admin/system/outbound-pause"
                body={{ paused: false }}
                successMessage="Outbound delivery resumed."
              />
            </GlowFrame>
          ) : (
            <AdminAction
              mode={mode}
              destructive
              size="default"
              icon="pause"
              triggerLabel="Pause all outbound"
              title="Pause all outbound delivery"
              description="Every WhatsApp and email send in every workspace waits at preflight until you resume. Sends already handed to a provider complete."
              confirmLabel="Pause outbound"
              endpoint="/api/admin/system/outbound-pause"
              body={{ paused: true }}
              successMessage="Outbound delivery paused."
            />
          )}
          <span className="text-xs text-fg-2">
            {outbound.paused && !outbound.db.paused
              ? 'The admin switch adds a second, audited pause that stays on until a super admin resumes. Needs a reason and a recent sign-in.'
              : 'Needs a reason and a recent sign-in; audited.'}
          </span>
        </div>
      </SectionCard>

      <SectionCard
        title={
          <SectionTitle icon={<ListChecks />} hue="volt">
            Jobs
          </SectionTitle>
        }
        meta={`Counts cover every job type in all workspaces; pick a status to filter. The list is newest first${filtered ? ', filtered' : ''}, ${list.rows.length} shown${before ? ' from an older page' : ''}.`}
      >
        <QueueBreakdown
          allHref={query({ status: undefined })}
          allActive={!status}
          segments={JOB_STATUSES.map((s) => ({
            status: s,
            count: health.byStatus[s],
            href: query({ status: s }),
            active: status === s,
          }))}
        />
        <FilterForm
          className="border-t border-border-subtle pt-4"
          clearHref={filtered ? '/dashboard/admin/jobs' : null}
          fields={[
            {
              name: 'status',
              label: 'Status',
              value: status ?? '',
              options: JOB_STATUSES.map((s) => ({
                value: s,
                label: JOB_STATUS_OPTION_LABELS[s],
              })),
            },
            {
              name: 'type',
              label: 'Type',
              value: type ?? '',
              options: list.types.map((t) => ({ value: t, label: t })),
            },
          ]}
        />
        {list.rows.length === 0 ? (
          <EmptyState
            headingLevel="h3"
            title="No jobs match these filters"
            description="Try another status or type, or clear the filters to see every job."
            action={
              filtered ? (
                <Button asChild variant="secondary">
                  <Link href="/dashboard/admin/jobs">Clear filters</Link>
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <ScrollRegion label="Jobs table" wrapperClassName="-mx-4 hidden border-y border-border-subtle md:block sm:-mx-5" className="max-h-[min(80vh,52rem)] overflow-auto">
              <table className="w-full min-w-[46rem] text-left text-sm">
                <thead className="text-xs text-fg-2">
                  <tr>
                    <th scope="col" className="sticky top-0 z-10 border-b border-border-subtle bg-bg-1 py-2.5 pr-3 pl-4 font-medium sm:pl-5">
                      Type
                    </th>
                    <th scope="col" className="sticky top-0 z-10 border-b border-border-subtle bg-bg-1 px-3 py-2.5 font-medium">
                      Status
                    </th>
                    <th scope="col" className="sticky top-0 z-10 border-b border-border-subtle bg-bg-1 px-3 py-2.5 font-medium">
                      Workspace
                    </th>
                    <th scope="col" className="sticky top-0 z-10 border-b border-border-subtle bg-bg-1 px-3 py-2.5 text-right font-medium">
                      Attempts
                    </th>
                    <th scope="col" className="sticky top-0 z-10 border-b border-border-subtle bg-bg-1 px-3 py-2.5 font-medium">
                      Run at
                    </th>
                    <th scope="col" className="sticky top-0 z-10 border-b border-border-subtle bg-bg-1 py-2.5 pr-4 pl-3 font-medium sm:pr-5">
                      Last error
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {list.rows.map((j) => (
                    <tr key={j.id} className="transition-colors duration-fast hover:bg-bg-2/60">
                      <td className="py-2.5 pr-3 pl-4 sm:pl-5">
                        <Link href={`/dashboard/admin/jobs/${j.id}`} className="font-mono text-[13px] whitespace-nowrap text-cyan underline-offset-4 hover:underline">
                          {j.type}
                        </Link>
                      </td>
                      <td className="px-3 py-2.5">
                        <StatusChip entry={jobStatusEntry(j)} state={j.status} />
                      </td>
                      <td className={cn('px-3 py-2.5 whitespace-nowrap', j.workspace ? 'text-fg-1' : 'text-fg-2')}>
                        {j.workspace ? (
                          j.workspace.name
                        ) : (
                          <span className="inline-flex items-center gap-1.5">
                            <Cpu aria-hidden="true" className="size-3.5 text-fg-3" />
                            System
                          </span>
                        )}
                      </td>
                      <td className="tabular px-3 py-2.5 text-right whitespace-nowrap text-fg-2">
                        {j.attempts}/{j.maxAttempts}
                      </td>
                      <td className="tabular px-3 py-2.5 whitespace-nowrap text-fg-2">{formatDateTime(j.runAt)}</td>
                      <td className="py-2.5 pr-4 pl-3 font-mono text-xs text-fg-2 sm:pr-5">{j.lastErrorCode ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollRegion>
            <ul aria-label="Jobs" className="flex flex-col divide-y divide-border-subtle overflow-hidden rounded-lg border border-border-subtle bg-bg-0/30 md:hidden">
              {list.rows.map((j) => (
                <li key={j.id} className="relative flex flex-col gap-1 px-3 py-2.5 transition-colors duration-fast hover:bg-bg-2/60 has-[a:focus-visible]:bg-bg-2/60">
                  <div className="flex items-start justify-between gap-2">
                    <Link href={`/dashboard/admin/jobs/${j.id}`} className={cn('min-w-0 font-mono text-[13px] break-all text-cyan underline-offset-4 after:absolute after:inset-0 hover:underline', ROW_FOCUS)}>
                      {j.type}
                    </Link>
                    <StatusChip entry={jobStatusEntry(j)} state={j.status} />
                  </div>
                  <p className="text-xs text-fg-2">
                    {j.workspace?.name ?? 'System'} · attempts{' '}
                    <span className="tabular">
                      {j.attempts}/{j.maxAttempts}
                    </span>
                    {j.lastErrorCode ? <span className="font-mono"> · {j.lastErrorCode}</span> : null}
                  </p>
                  <p className="tabular text-xs text-fg-2">Run at {formatDateTime(j.runAt)}</p>
                </li>
              ))}
            </ul>
          </>
        )}
        {list.nextCursor || before ? (
          <nav aria-label="Job pages" className="flex flex-wrap items-center gap-2">
            {before ? (
              <Button asChild variant="outline" size="sm">
                <Link href={query({})}>
                  <ChevronLeft aria-hidden="true" />
                  Newest jobs
                </Link>
              </Button>
            ) : null}
            {list.nextCursor ? (
              <Button asChild variant="outline" size="sm">
                <Link href={query({ before: list.nextCursor })}>
                  Older jobs
                  <ChevronRight aria-hidden="true" />
                </Link>
              </Button>
            ) : null}
          </nav>
        ) : null}
      </SectionCard>
    </div>
  );
}
