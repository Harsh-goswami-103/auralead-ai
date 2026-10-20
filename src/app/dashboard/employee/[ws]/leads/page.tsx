/**
 * Employee lead console (T11: source simulations and what they produced; T17: the lead list links
 * to each lead's detail page, where drafts, quotes, approval and the PDF live, and shows the
 * score). The `[ws]` slug is resolved against the employee's
 * active assignments (404 otherwise); data is read through the tenant-scoped context. Simulations
 * post to /api/demo/simulate/[source] and are gated by mode (DEMO only) and permission
 * (leads.write), both decided on the server.
 *
 * Look (design spec §6): PageHeader in the operator hue, the three source cards, source events as
 * small tiles with the shared source chip, outcome chip and per-record counts, and the leads table
 * (neutral, one table) with source chips, the score as "NN / 100" beside a fit meter, and a stage
 * chip.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { Activity, CheckCircle2, ClipboardCheck, Clock3, HelpCircle, Inbox, Users, XCircle } from 'lucide-react';
import { ChipTitle } from '@/components/patterns/IconChip';
import { ScoreMeter } from '@/components/leads/ScoreMeter';
import { StageChip } from '@/components/leads/StageChip';
import { ToneChip } from '@/components/leads/ToneChip';
import { EmptyState } from '@/components/patterns/EmptyState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { SectionCard } from '@/components/patterns/SectionCard';
import { SourceChip } from '@/components/patterns/SourceChip';
import { ModeChip } from '@/components/patterns/StatusBadge';
import type { StatusTone } from '@/components/patterns/status-vocabulary';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Reveal, Stagger, StaggerItem } from '@/components/visual/Reveal';
import { NotFoundError } from '@/lib/errors';
import { formatDateTime } from '@/lib/format/date';
import { getPageContext } from '@/server/auth/page-context';
import { loadLeadConsole, type ConsoleEvent } from '@/server/services/webhooks/console';
import { SimulationPanel } from './simulation-panel';

export const metadata: Metadata = { title: 'Lead console' };
export const dynamic = 'force-dynamic';

/** Webhook providers as the lead source they deliver (the shared source chip palette). */
const PROVIDER_SOURCE: Readonly<Record<string, string>> = {
  WHATSAPP: 'WHATSAPP_INBOUND',
  RESEND: 'EMAIL_INBOUND',
  DEMO: 'Demo simulator',
};

const EVENT_STATUS: Record<ConsoleEvent['status'], { label: string; Icon: typeof CheckCircle2; tone: StatusTone }> = {
  RECEIVED: { label: 'Queued for processing', Icon: Clock3, tone: 'info' },
  PROCESSED: { label: 'Processed', Icon: CheckCircle2, tone: 'success' },
  FAILED: { label: 'Failed', Icon: XCircle, tone: 'danger' },
  UNROUTED: { label: 'Unrouted', Icon: HelpCircle, tone: 'warning' },
  PENDING_CORRELATION: { label: 'Waiting for a match', Icon: Clock3, tone: 'warning' },
  ORPHAN: { label: 'No match', Icon: HelpCircle, tone: 'warning' },
};

const COUNT_CHIP: Readonly<Record<'accepted' | 'duplicate' | 'review' | 'rejected', { word: string; tone: string }>> = {
  accepted: { word: 'new', tone: 'border-success/35 bg-success/12 text-success' },
  duplicate: { word: 'duplicate', tone: 'border-border-strong bg-bg-2 text-fg-2' },
  review: { word: 'to review', tone: 'border-warning/35 bg-warning/12 text-warning' },
  rejected: { word: 'rejected', tone: 'border-danger/35 bg-danger/12 text-danger' },
};

/** What an event produced, as small count chips (same words as before: "3 new, 1 duplicate"). */
function EventCounts({ event }: { event: ConsoleEvent }) {
  if (event.failureCode) {
    return (
      <span className="text-xs text-fg-2">
        Not ingested <span className="font-mono text-fg-3">({event.failureCode})</span>
      </span>
    );
  }
  if (!event.counts) return <span className="text-xs text-fg-2">Waiting for the worker</span>;
  const c = event.counts;
  const parts = (['accepted', 'duplicate', 'review', 'rejected'] as const).filter((k) => k === 'accepted' || c[k] > 0);
  return (
    <span className="flex flex-wrap gap-1">
      {parts.map((k) => (
        <span key={k} className={cn('tabular rounded-full border px-1.5 text-[11px] leading-4 font-medium', c[k] === 0 ? COUNT_CHIP.duplicate.tone : COUNT_CHIP[k].tone)}>
          {c[k]} {COUNT_CHIP[k].word}
        </span>
      ))}
    </span>
  );
}

export default async function EmployeeLeadConsolePage({ params }: { params: Promise<{ ws: string }> }) {
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
  const data = await loadLeadConsole(page.ctx);
  const tz = data.workspace.timezone;
  const pending = data.events.some((e) => e.status === 'RECEIVED');

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={data.workspace.name}
        title="Lead console"
        description="New leads from every source land here after normalization and duplicate checks."
        actions={
          <Link href={`/dashboard/employee/${data.workspace.slug}/approvals`} className={buttonVariants({ variant: 'secondary' })}>
            <ClipboardCheck aria-hidden="true" />
            Approval queue
          </Link>
        }
      />

      {!data.canReadLeads ? (
        <EmptyState
          icon={<Users aria-hidden="true" className="size-5" />}
          title="Leads are not part of your assignment"
          description="Your assignment in this workspace does not include leads.read. A super admin can grant it from the people page."
        />
      ) : (
        <>
          <Reveal delay={0.06}>
            <SimulationPanel workspaceSlug={data.workspace.slug} gate={data.simulation} pending={pending} />
          </Reveal>

          <SectionCard title={<ChipTitle icon={<Activity aria-hidden="true" />} hue="volt">Recent source events</ChipTitle>} meta={data.events.length > 0 ? `The ${data.events.length} most recent deliveries and what each produced.` : undefined}>
            {data.events.length === 0 ? (
              <EmptyState
                headingLevel="h3"
                icon={<Inbox aria-hidden="true" className="size-5" />}
                title="No source events yet"
                description="Events from Google Sheets, Meta Lead Ads and the Maps extension appear here with what each one produced."
              />
            ) : (
              <Stagger as="ul" step="list" className="grid gap-2 md:grid-cols-2">
                {data.events.map((e) => {
                  const status = EVENT_STATUS[e.status];
                  return (
                    <StaggerItem
                      as="li"
                      key={e.id}
                      className="flex min-w-0 flex-col gap-2 rounded-lg border border-border-subtle bg-bg-2/60 px-3 py-2.5 transition-colors duration-fast hover:border-border-strong"
                    >
                      <span className="flex flex-wrap items-center justify-between gap-2">
                        <span className="flex flex-wrap items-center gap-1.5">
                          <SourceChip source={PROVIDER_SOURCE[e.provider] ?? e.provider} withIcon />
                          <ModeChip simulated={e.simulated} />
                        </span>
                        <ToneChip tone={status.tone} icon={status.Icon} label={status.label} />
                      </span>
                      <span className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs text-fg-2">Received {formatDateTime(e.receivedAt, tz)}</span>
                        <EventCounts event={e} />
                      </span>
                    </StaggerItem>
                  );
                })}
              </Stagger>
            )}
          </SectionCard>

          <SectionCard title={<ChipTitle icon={<Users aria-hidden="true" />}>Latest leads</ChipTitle>} meta={data.leads.length > 0 ? 'Newest first. Open a lead for its score, pipeline, drafts and quotations.' : undefined}>
            {data.leads.length === 0 ? (
              <EmptyState
                headingLevel="h3"
                icon={<Users aria-hidden="true" className="size-5" />}
                title="No leads yet"
                description="Connect a source or, in DEMO, run a simulation above. Each new lead shows its source and sales stage."
              />
            ) : (
              <div className="relative -mx-4 overflow-x-auto sm:-mx-5">
                <table className="w-full min-w-[46rem] text-left text-sm">
                  <thead className="border-y border-border-subtle bg-bg-2/40 text-xs text-fg-2">
                    <tr>
                      <th scope="col" className="py-2 pr-3 pl-4 font-medium sm:pl-5">Lead</th>
                      <th scope="col" className="px-3 py-2 font-medium">Source</th>
                      <th scope="col" className="px-3 py-2 font-medium">Score</th>
                      <th scope="col" className="px-3 py-2 font-medium">Stage</th>
                      <th scope="col" className="px-3 py-2 font-medium">City</th>
                      <th scope="col" className="py-2 pr-4 pl-3 font-medium sm:pr-5">Added</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border-subtle">
                    {data.leads.map((l) => (
                      <tr key={l.id} className="transition-colors duration-fast hover:bg-bg-2/60">
                        <td className="min-w-[11rem] py-2.5 pr-3 pl-4 text-fg-1 sm:pl-5">
                          <span className="flex flex-wrap items-center gap-2">
                            <Link href={`/dashboard/employee/${data.workspace.slug}/leads/${l.id}`} className="inline-flex items-center font-medium text-cyan underline-offset-4 hover:underline max-lg:min-h-11">
                              {l.displayName}
                            </Link>
                            {l.simulated ? <ModeChip simulated /> : null}
                          </span>
                        </td>
                        <td className="px-3 py-2.5">
                          <SourceChip source={l.firstSource} />
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          {l.score === null ? (
                            <span className="text-fg-2">Not scored</span>
                          ) : (
                            <span className="flex items-center gap-2.5">
                              <span className="tabular w-[4.25rem] text-fg-1">{`${l.score} / 100`}</span>
                              <ScoreMeter value={l.score} animate={false} />
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2.5">
                          <StageChip stage={l.salesStage} />
                        </td>
                        <td className="px-3 py-2.5 text-fg-2">{l.city ?? 'Unknown'}</td>
                        <td className="tabular py-2.5 pr-4 pl-3 whitespace-nowrap text-fg-2 sm:pr-5">{formatDateTime(l.createdAt, tz)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>
        </>
      )}
    </div>
  );
}
