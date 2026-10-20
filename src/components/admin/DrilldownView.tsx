/**
 * DrilldownView (T29): the audited, read-only view of one workspace, as the drilldown route
 * answered it. The banner comes first and stays on top: whose workspace this is, that it is
 * read-only, the reason given and the audit event the opening was recorded under. Below it only
 * aggregates and configuration (counts by stage and status, settings, integrations by status,
 * redacted activity codes), never a lead's name, contact or message. No control on it changes
 * the workspace; "Close the view" only drops it from the page.
 */
import { Activity, Boxes, ClipboardCheck, FileText, ListChecks, MessagesSquare, Plug, Settings2, ShieldAlert, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import { INTEGRATION_STATUS_VOCABULARY } from '@/components/patterns/status-vocabulary';
import { SectionCard } from '@/components/patterns/SectionCard';
import { Button } from '@/components/ui/button';
import type { IntegrationStatus, JobStatus, QuoteStatus, SalesStage } from '@/lib/domain/enums';
import { formatDateTime } from '@/lib/format/date';
import type { WorkspaceDrilldown } from '@/server/services/admin/workspaces';
import { CopyButton } from './CopyButton';
import { InlineEmpty } from './InlineEmpty';
import {
  ACTOR_KIND_LABELS,
  ADMIN_ACTION_LABELS,
  AUDIT_RESULT_VOCABULARY,
  formatBps,
  INTEGRATION_KIND_LABELS,
  JOB_STATUS_LABELS,
  QUOTE_STATUS_LABELS,
  SALES_STAGE_LABELS,
} from './people-vocabulary';
import { SectionTitle } from './SectionTitle';
import { StatusChip } from './StatusChip';

/** The JSON form of a server value: dates arrive as ISO strings. */
export type Wire<T> = T extends Date ? string : T extends Array<infer U> ? Array<Wire<U>> : T extends object ? { [K in keyof T]: Wire<T[K]> } : T;
export type DrilldownData = Wire<WorkspaceDrilldown>;

const at = (iso: string) => formatDateTime(new Date(iso));

function Fact(props: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 border-b border-border-subtle py-2 last:border-b-0">
      <dt className="text-sm text-fg-2">{props.label}</dt>
      <dd className="tabular text-right text-sm text-fg-1">{props.children}</dd>
    </div>
  );
}

function Counts<K extends string>(props: { order: readonly K[]; labels: Readonly<Record<K, string>>; counts: Partial<Record<K, number>>; empty: string; icon: ReactNode }) {
  const rows = props.order.filter((k) => (props.counts[k] ?? 0) > 0);
  if (rows.length === 0) return <InlineEmpty icon={props.icon}>{props.empty}</InlineEmpty>;
  return (
    <dl className="flex flex-col">
      {rows.map((k) => (
        <Fact key={k} label={props.labels[k]}>
          {(props.counts[k] ?? 0).toLocaleString('en-IN')}
        </Fact>
      ))}
    </dl>
  );
}

const STAGES: readonly SalesStage[] = ['NEW', 'CONTACTED', 'REPLIED', 'QUOTE_SENT', 'CONVERTED', 'LOST'];
const QUOTE_STATUSES: readonly QuoteStatus[] = ['DRAFT', 'APPROVED', 'SENT', 'VIEWED', 'ACCEPTED', 'EXPIRED', 'CANCELLED'];
const JOB_STATUSES: readonly JobStatus[] = ['QUEUED', 'RUNNING', 'SUCCEEDED', 'DEAD', 'CANCELLED'];

export function DrilldownView(props: { data: DrilldownData; onClose: () => void }) {
  const { data } = props;
  const ws = data.workspace;
  const s = data.settings;
  const c = data.configuration;
  return (
    <div data-drilldown-view="" className="flex flex-col gap-4">
      <div role="note" aria-label="Audited view" data-audited-banner="" className="flex flex-col gap-3 rounded-xl border border-warning/45 bg-warning/10 p-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 gap-3">
          <ShieldAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-warning" />
          <div className="flex min-w-0 flex-col gap-1">
            <p className="font-semibold text-fg-1">Audited view of {ws.name}: read-only</p>
            <p className="text-sm text-fg-2">
              Opened <span className="tabular">{at(data.audit.openedAt)}</span> (IST) for: <q className="text-fg-1">{data.audit.reason}</q>. This opening is on the audit record; nothing here changes the
              workspace.
            </p>
            <p className="flex flex-wrap items-center gap-1 text-xs text-fg-2">
              Audit event <span className="font-mono break-all text-fg-1">{data.audit.eventId}</span>
              <CopyButton value={data.audit.eventId} label="audit event id" />
            </p>
          </div>
        </div>
        <Button type="button" variant="outline" size="sm" className="w-fit shrink-0" onClick={props.onClose}>
          Close the view
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <SectionCard titleAs="h3" title={<SectionTitle icon={<Settings2 />}>Configuration</SectionTitle>}>
          <dl className="flex flex-col">
            <Fact label="Plan label">{ws.planLabel}</Fact>
            <Fact label="Time zone">{ws.timezone}</Fact>
            <Fact label="Automation">{ws.automationPaused ? 'Paused' : 'Running'}</Fact>
            <Fact label="Price list">{c.pricingVersion === null ? 'None yet' : `v${c.pricingVersion} · ${c.pricedServices} of ${c.services} services priced`}</Fact>
            <Fact label="Scoring">{c.scoringVersion === null ? 'None' : `v${c.scoringVersion}`}</Fact>
            <Fact label="Pipeline">{c.pipelineVersion === null ? 'None' : `v${c.pipelineVersion} · ${c.approvalMode === 'POLICY_AUTO' ? 'policy approval' : 'human approval'}`}</Fact>
            {s ? (
              <>
                <Fact label="Tax">{s.taxMode === 'NONE' ? 'No tax line' : `${s.taxLabel ?? 'Tax'} ${formatBps(s.taxBps ?? 0)}`}</Fact>
                <Fact label="Discount limit">{formatBps(s.maxDiscountBps)}</Fact>
                <Fact label="Quote validity">{s.quoteValidityDays} days</Fact>
                <Fact label="Auto-send">{s.autoSendEnabled ? 'On' : 'Off'}</Fact>
                <Fact label="Email fallback">{s.emailFallbackEnabled ? 'On' : 'Off'}</Fact>
                <Fact label="Booking link">{s.bookingLinkSet ? 'Set' : 'Not set'}</Fact>
                <Fact label="GSTIN">{s.gstinSet ? 'Set' : 'Not set'}</Fact>
              </>
            ) : (
              <Fact label="Settings">Missing</Fact>
            )}
          </dl>
        </SectionCard>

        <div className="flex flex-col gap-4">
          <SectionCard titleAs="h3" title={<SectionTitle icon={<Users />} hue="aura">Leads</SectionTitle>} meta={`${data.leads.total.toLocaleString('en-IN')} in total`}>
            <Counts order={STAGES} labels={SALES_STAGE_LABELS} counts={data.leads.byStage} empty="No leads yet." icon={<Users />} />
          </SectionCard>
          <SectionCard titleAs="h3" title={<SectionTitle icon={<FileText />} hue="aura">Quotations</SectionTitle>} meta={`${data.quotes.total.toLocaleString('en-IN')} in total`}>
            <Counts order={QUOTE_STATUSES} labels={QUOTE_STATUS_LABELS} counts={data.quotes.byStatus} empty="No quotations yet." icon={<FileText />} />
          </SectionCard>
        </div>

        <SectionCard titleAs="h3" title={<SectionTitle icon={<MessagesSquare />}>Messaging</SectionTitle>}>
          <dl className="flex flex-col">
            <Fact label="Approvals waiting">{data.approvalsPending.toLocaleString('en-IN')}</Fact>
            <Fact label="Open conversations">{data.openConversations.toLocaleString('en-IN')}</Fact>
            <Fact label="Active suppressions">{data.activeSuppressions.toLocaleString('en-IN')}</Fact>
          </dl>
        </SectionCard>

        <SectionCard titleAs="h3" title={<SectionTitle icon={<Plug />} hue="ice">Integrations</SectionTitle>}>
          {data.integrations.length === 0 ? (
            <InlineEmpty icon={<Plug />}>No integration has been set up.</InlineEmpty>
          ) : (
            <ul className="flex flex-col divide-y divide-border-subtle">
              {data.integrations.map((i) => (
                <li key={i.kind} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="text-sm text-fg-1">{INTEGRATION_KIND_LABELS[i.kind]}</span>
                  <StatusChip entry={INTEGRATION_STATUS_VOCABULARY[i.status as IntegrationStatus]} state={i.status} />
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        <SectionCard titleAs="h3" title={<SectionTitle icon={<ListChecks />} hue="volt">Jobs</SectionTitle>}>
          <Counts order={JOB_STATUSES} labels={JOB_STATUS_LABELS} counts={data.jobs} empty="No jobs for this workspace." icon={<Boxes />} />
        </SectionCard>

        <SectionCard titleAs="h3" title={<SectionTitle icon={<Activity />} hue="aura">Recent activity</SectionTitle>} meta="Audit codes only; summaries stay in Audit log.">
          <ul className="flex flex-col divide-y divide-border-subtle">
            {data.recentActivity.map((a) => {
              const actor = ACTOR_KIND_LABELS[a.actorKind] ?? { label: a.actorKind };
              return (
                <li key={a.id} className="flex flex-col gap-1 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="min-w-0 text-sm text-fg-1">
                      {ADMIN_ACTION_LABELS[a.action] ? `${ADMIN_ACTION_LABELS[a.action]} ` : null}
                      <span className="font-mono text-xs break-all text-fg-2">{a.action}</span>
                    </span>
                    <StatusChip entry={AUDIT_RESULT_VOCABULARY[a.result as keyof typeof AUDIT_RESULT_VOCABULARY]} state={a.result} />
                  </div>
                  <p className="tabular text-xs text-fg-2">
                    {actor.label} · {at(a.createdAt)}
                    {a.crossWorkspace ? ' · by an administrator' : ''}
                  </p>
                </li>
              );
            })}
          </ul>
        </SectionCard>
      </div>
      <p className="flex items-center gap-2 text-xs text-fg-2">
        <ClipboardCheck aria-hidden="true" className="size-3.5 shrink-0" />
        Counts are read from the database at {at(data.audit.openedAt)} (IST); open the view again for newer figures.
      </p>
    </div>
  );
}
