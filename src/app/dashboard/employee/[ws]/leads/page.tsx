/**
 * Employee lead console (T11: source simulations and what they produced; T17: the lead list links
 * to each lead's detail page, where drafts, quotes, approval and the PDF live, and shows the
 * score; T26: the full Leads area: search on the normalized columns, filters, sort, keyset pages
 * of 50 with a capped count, the Kanban board with its "Move to stage" menu and drag, and the CSV
 * export, plus the Scoring tab). The `[ws]` slug is resolved against the employee's
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
import { LeadsTabs } from '@/components/leads/LeadsTabs';
import { LeadsWorkspace } from '@/components/leads/LeadsWorkspace';
import { ChipTitle } from '@/components/patterns/IconChip';
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
import { parseLeadPageParams } from '@/lib/schemas/leads';
import { getPageContext } from '@/server/auth/page-context';
import { loadLeadConsole, type ConsoleEvent } from '@/server/services/webhooks/console';
import { loadLeadsArea } from '../../../user/leads/leads-data';
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

export default async function EmployeeLeadConsolePage({
  params,
  searchParams,
}: {
  params: Promise<{ ws: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { ws } = await params;
  const query = parseLeadPageParams((await searchParams) ?? {});
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
  const base = `/dashboard/employee/${data.workspace.slug}/leads`;
  const area = data.canReadLeads
    ? await loadLeadsArea(page.ctx, query, {
        basePath: base,
        rowHref: (row) => `${base}/${encodeURIComponent(row.id)}`,
        workspaceSlug: data.workspace.slug,
        gates: {
          move: 'Your assignment does not include leads.write, which moving leads needs. A super admin can grant it from the people page.',
          export: 'Your assignment does not include leads.export. A super admin can grant it from the people page.',
        },
      })
    : null;

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
      <LeadsTabs current="leads" leadsHref={base} scoringHref={`${base}/scoring`} />

      {!data.canReadLeads || area?.workspace == null ? (
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

          <LeadsWorkspace
            {...area.workspace}
            emptyWorkspace={
              area.access.empty ? (
                <EmptyState
                  headingLevel="h3"
                  icon={<Users aria-hidden="true" className="size-5" />}
                  title="No leads yet"
                  description="Connect a source or, in DEMO, run a simulation above. Each new lead shows its source and sales stage."
                />
              ) : null
            }
          />
        </>
      )}
    </div>
  );
}
