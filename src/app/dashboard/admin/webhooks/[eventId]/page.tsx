/**
 * Webhook event detail (T24, R33): routing, status, attempts, the redacted inspector payload and
 * stored result, whether the encrypted processing payload is still held (it is never decrypted
 * here), and links to the jobs that processed the event.
 *
 * Look (design spec §6): the provider by name (never the raw enum) in the h1 with its provider,
 * status and Simulated chips, the delivery's fields (ids mono with copy buttons, dates in the UI
 * font), the payload and result in bordered JsonView wells (they used to sit on the page color
 * with no edge; side by side on wide screens the shorter well fills its card like blank editor
 * lines), and the processing jobs as a timeline rail with status chips.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft, Building2, CircleDashed, FileCheck2, Inbox, Lock, Package, Trash2, Workflow } from 'lucide-react';
import { WEBHOOK_STATUS_VOCABULARY, jobStatusEntry, providerStyle } from '@/components/admin/admin-vocabulary';
import { DetailField } from '@/components/admin/DetailField';
import { InlineEmpty } from '@/components/admin/InlineEmpty';
import { JsonView } from '@/components/admin/JsonView';
import { ProviderChip } from '@/components/admin/ProviderChip';
import { SectionTitle } from '@/components/admin/SectionTitle';
import { StatusChip } from '@/components/admin/StatusChip';
import { Timeline } from '@/components/admin/Timeline';
import { PageHeader } from '@/components/patterns/PageHeader';
import { SectionCard } from '@/components/patterns/SectionCard';
import { ModeChip } from '@/components/patterns/StatusBadge';
import { touchTarget } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import type { JobStatus } from '@/lib/domain/enums';
import { NotFoundError } from '@/lib/errors';
import { formatDateTime } from '@/lib/format/date';
import { getPageContext } from '@/server/auth/page-context';
import { getWebhookEventDetail, type WebhookDetail } from '@/server/services/admin/webhook-inspector';
import { JOB_STATUSES } from '@/server/services/jobs-admin/inspector';

export const metadata: Metadata = { title: 'Webhook event' };
export const dynamic = 'force-dynamic';

/** Long identifiers take the full row on phones (two short facts share a row there). */
const WIDE = 'col-span-2 sm:col-span-1';

export default async function WebhookEventPage(props: { params: Promise<{ eventId: string }> }) {
  const page = await getPageContext();
  if (!page) redirect('/login');
  const { eventId } = await props.params;
  let e: WebhookDetail;
  try {
    e = await getWebhookEventDetail(page.ctx, eventId);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const status = WEBHOOK_STATUS_VOCABULARY[e.status];

  return (
    <div className="flex flex-col gap-6">
      <Link href="/dashboard/admin/webhooks" className={cn('relative inline-flex w-fit items-center gap-1.5 text-sm text-cyan underline-offset-4 hover:underline', touchTarget)}>
        <ArrowLeft aria-hidden="true" className="size-4" />
        Webhooks
      </Link>
      <PageHeader
        className="-mt-3"
        eyebrow="Webhook event"
        title={`${providerStyle(e.provider).label} delivery`}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <ProviderChip provider={e.provider} />
            <StatusChip entry={status} state={e.status} />
            {e.simulated ? <ModeChip simulated /> : null}
            <span className="inline-flex items-center gap-1.5 text-sm text-fg-2">
              <Building2 aria-hidden="true" className="size-4" />
              {e.workspace?.name ?? 'Unrouted'}
            </span>
          </span>
        }
        meta={`Received ${formatDateTime(e.receivedAt)}`}
      />

      <SectionCard
        title={
          <SectionTitle icon={<Inbox />}>
            Delivery
          </SectionTitle>
        }
        accent
      >
        <dl className="grid grid-cols-2 gap-x-4 gap-y-4 sm:gap-x-6 lg:grid-cols-3">
          <DetailField label="Event id" value={e.id} mono copy={e.id} className={WIDE} />
          <DetailField label="External key" value={e.externalKey} mono copy={e.externalKey} className={WIDE} />
          <DetailField label="Scope key" value={e.scopeKey} mono className={WIDE} />
          <DetailField label="Body sha256" value={e.bodySha256} mono copy={e.bodySha256} className={WIDE} />
          <DetailField label="Received" value={formatDateTime(e.receivedAt)} />
          <DetailField label="Processed" value={e.processedAt ? formatDateTime(e.processedAt) : null} />
          <DetailField label="Attempts" value={String(e.attempts)} />
          <DetailField
            label="Processing payload"
            value={
              e.payloadHeld ? (
                <span className="inline-flex items-start gap-1.5">
                  <Lock aria-hidden="true" className="mt-[3px] size-3.5 shrink-0 text-fg-2" />
                  Held, encrypted (not shown)
                </span>
              ) : (
                <span className="inline-flex items-start gap-1.5">
                  <Trash2 aria-hidden="true" className="mt-[3px] size-3.5 shrink-0 text-fg-2" />
                  {`Purged${e.processingPurgedAt ? ` ${formatDateTime(e.processingPurgedAt)}` : ''}`}
                </span>
              )
            }
          />
        </dl>
      </SectionCard>

      <div className="grid min-w-0 gap-4 xl:grid-cols-2">
        <SectionCard
          title={
            <SectionTitle icon={<Package />} hue="ice">
              Redacted payload
            </SectionTitle>
          }
          meta="What the inspector may show; secrets and contact details are replaced."
        >
          <JsonView value={e.payloadRedacted} label="payload.redacted.json" redacted className="xl:flex-1" />
        </SectionCard>
        <SectionCard
          title={
            <SectionTitle icon={<FileCheck2 />} hue="ice">
              Result
            </SectionTitle>
          }
          meta="What processing produced, as stored."
        >
          {e.result === null ? <InlineEmpty icon={<CircleDashed />}>Not processed yet.</InlineEmpty> : <JsonView value={e.result} label="result.json" className="xl:flex-1" />}
        </SectionCard>
      </div>

      <SectionCard
        title={
          <SectionTitle icon={<Workflow />} hue="volt">
            Processing jobs
          </SectionTitle>
        }
        meta={e.jobs.length > 0 ? 'Open a job to see its attempts, or to retry or cancel it.' : undefined}
      >
        {e.jobs.length === 0 ? (
          <InlineEmpty icon={<CircleDashed />}>No job processed this event (unrouted events are stored only).</InlineEmpty>
        ) : (
          <Timeline
            items={e.jobs.map((j) => {
              const jobStatus = JOB_STATUSES.includes(j.status as JobStatus) ? (j.status as JobStatus) : null;
              const entry = jobStatus ? jobStatusEntry({ status: jobStatus, label: j.label, attempts: j.attempts }) : null;
              return {
                key: j.id,
                icon: <Workflow />,
                tone: entry?.tone ?? 'panel',
                time: `Enqueued ${formatDateTime(j.createdAt)}`,
                title: (
                  <Link href={`/dashboard/admin/jobs/${j.id}`} className="font-mono text-[13px] break-all text-cyan underline-offset-4 hover:underline">
                    {j.type}
                  </Link>
                ),
                aside: entry ? <StatusChip entry={entry} state={j.status} /> : <span className="text-xs text-fg-2">{j.label}</span>,
              };
            })}
          />
        )}
      </SectionCard>
    </div>
  );
}
