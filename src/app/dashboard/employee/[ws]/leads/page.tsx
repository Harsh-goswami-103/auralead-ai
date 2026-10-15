/**
 * Employee lead console (T11: source simulations and what they produced; T17: the lead list links
 * to each lead's detail page, where drafts, quotes, approval and the PDF live, and shows the
 * score). The `[ws]` slug is resolved against the employee's
 * active assignments (404 otherwise); data is read through the tenant-scoped context. Simulations
 * post to /api/demo/simulate/[source] and are gated by mode (DEMO only) and permission
 * (leads.write), both decided on the server.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { CheckCircle2, Clock3, HelpCircle, Inbox, Users, XCircle } from 'lucide-react';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ModeChip } from '@/components/patterns/StatusBadge';
import { NotFoundError } from '@/lib/errors';
import { formatDateTime } from '@/lib/format/date';
import { getPageContext } from '@/server/auth/page-context';
import { loadLeadConsole, type ConsoleEvent } from '@/server/services/webhooks/console';
import { SimulationPanel } from './simulation-panel';

export const metadata: Metadata = { title: 'Lead console' };
export const dynamic = 'force-dynamic';

const SOURCE_LABELS: Record<string, string> = {
  GOOGLE_SHEETS: 'Google Sheets',
  META_ADS: 'Meta Lead Ads',
  GMAPS_EXTENSION: 'Maps extension',
  WHATSAPP_INBOUND: 'WhatsApp',
  EMAIL_INBOUND: 'Email',
  MANUAL: 'Manual',
};

const STAGE_LABELS: Record<string, string> = {
  NEW: 'New',
  CONTACTED: 'Contacted',
  REPLIED: 'Replied',
  QUOTE_SENT: 'Quote sent',
  CONVERTED: 'Converted',
  LOST: 'Lost',
};

const EVENT_STATUS: Record<ConsoleEvent['status'], { label: string; Icon: typeof CheckCircle2; tone: string }> = {
  RECEIVED: { label: 'Queued for processing', Icon: Clock3, tone: 'text-info' },
  PROCESSED: { label: 'Processed', Icon: CheckCircle2, tone: 'text-success' },
  FAILED: { label: 'Failed', Icon: XCircle, tone: 'text-danger' },
  UNROUTED: { label: 'Unrouted', Icon: HelpCircle, tone: 'text-warning' },
  PENDING_CORRELATION: { label: 'Waiting for a match', Icon: Clock3, tone: 'text-warning' },
  ORPHAN: { label: 'No match', Icon: HelpCircle, tone: 'text-warning' },
};

function countsLine(e: ConsoleEvent): string {
  if (e.failureCode) return `Not ingested: ${e.failureCode}`;
  if (!e.counts) return 'Waiting for the worker';
  const c = e.counts;
  const parts = [`${c.accepted} new`];
  if (c.duplicate > 0) parts.push(`${c.duplicate} duplicate`);
  if (c.review > 0) parts.push(`${c.review} to review`);
  if (c.rejected > 0) parts.push(`${c.rejected} rejected`);
  return parts.join(', ');
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
      <header className="flex flex-col gap-1">
        <p className="text-sm text-fg-2">{data.workspace.name}</p>
        <h1 className="font-display text-2xl font-semibold text-fg-1 sm:text-3xl">Lead console</h1>
        <p className="max-w-prose text-fg-2">New leads from every source land here after normalization and duplicate checks.</p>
      </header>

      {!data.canReadLeads ? (
        <EmptyState
          icon={<Users aria-hidden="true" className="size-5" />}
          title="Leads are not part of your assignment"
          description="Your assignment in this workspace does not include leads.read. A super admin can grant it from the people page."
        />
      ) : (
        <>
          <SimulationPanel workspaceSlug={data.workspace.slug} gate={data.simulation} pending={pending} />

          <section aria-labelledby="events-heading" className="flex flex-col gap-3">
            <h2 id="events-heading" className="font-display text-lg font-semibold text-fg-1">
              Recent source events
            </h2>
            {data.events.length === 0 ? (
              <EmptyState
                icon={<Inbox aria-hidden="true" className="size-5" />}
                title="No source events yet"
                description="Events from Google Sheets, Meta Lead Ads and the Maps extension appear here with what each one produced."
              />
            ) : (
              <ul className="flex flex-col divide-y divide-border-subtle rounded-xl border border-border-subtle bg-bg-1">
                {data.events.map((e) => {
                  const status = EVENT_STATUS[e.status];
                  return (
                    <li key={e.id} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                      <div className="flex flex-col gap-0.5">
                        <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-fg-1">
                          {SOURCE_LABELS[e.provider] ?? e.provider}
                          <ModeChip simulated={e.simulated} />
                        </span>
                        <span className="text-xs text-fg-2">Received {formatDateTime(e.receivedAt, tz)}</span>
                      </div>
                      <div className="flex flex-col gap-0.5 sm:items-end">
                        <span className={`inline-flex items-center gap-1.5 text-sm ${status.tone}`}>
                          <status.Icon aria-hidden="true" className="size-4" />
                          {status.label}
                        </span>
                        <span className="tabular text-xs text-fg-2">{countsLine(e)}</span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section aria-labelledby="leads-heading" className="flex flex-col gap-3">
            <h2 id="leads-heading" className="font-display text-lg font-semibold text-fg-1">
              Latest leads
            </h2>
            {data.leads.length === 0 ? (
              <EmptyState
                icon={<Users aria-hidden="true" className="size-5" />}
                title="No leads yet"
                description="Connect a source or, in DEMO, run a simulation above. Each new lead shows its source and sales stage."
              />
            ) : (
              <div className="overflow-x-auto rounded-xl border border-border-subtle bg-bg-1">
                <table className="w-full min-w-[40rem] text-left text-sm">
                  <thead className="border-b border-border-subtle text-xs text-fg-2">
                    <tr>
                      <th scope="col" className="px-4 py-2 font-medium">Lead</th>
                      <th scope="col" className="px-4 py-2 font-medium">Source</th>
                      <th scope="col" className="px-4 py-2 font-medium">Score</th>
                      <th scope="col" className="px-4 py-2 font-medium">Stage</th>
                      <th scope="col" className="px-4 py-2 font-medium">City</th>
                      <th scope="col" className="px-4 py-2 font-medium">Added</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border-subtle">
                    {data.leads.map((l) => (
                      <tr key={l.id}>
                        <td className="px-4 py-2 text-fg-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <Link href={`/dashboard/employee/${data.workspace.slug}/leads/${l.id}`} className="font-medium text-primary underline-offset-4 hover:underline">
                              {l.displayName}
                            </Link>
                            {l.simulated ? <ModeChip simulated /> : null}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-fg-2">{SOURCE_LABELS[l.firstSource] ?? l.firstSource}</td>
                        <td className="tabular px-4 py-2 text-fg-2">{l.score === null ? 'Not scored' : `${l.score} / 100`}</td>
                        <td className="px-4 py-2 text-fg-2">{STAGE_LABELS[l.salesStage] ?? l.salesStage}</td>
                        <td className="px-4 py-2 text-fg-2">{l.city ?? 'Unknown'}</td>
                        <td className="tabular px-4 py-2 text-fg-2">{formatDateTime(l.createdAt, tz)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
