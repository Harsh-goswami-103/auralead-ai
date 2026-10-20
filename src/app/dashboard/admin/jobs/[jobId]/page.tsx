/**
 * Job inspector (T24, R33): one job's state, its redacted payload (ids and versions only), the
 * attempt log, its dispatch attempts and the correlation timeline (audit rows and related jobs).
 * Actions: cancel (QUEUED / RUNNING), safe retry (DEAD; blocked with the reason when not safe),
 * and for each AMBIGUOUS ("Delivery unknown") attempt: Mark delivered, Verified not delivered, or
 * Verified not delivered and resend (typed RESEND). Every action is audited with its reason.
 *
 * Look (design spec §6): PageHeader with the job type, its status chip and the actions (only
 * when one applies, so no empty Actions group), a lifecycle rail, the job's fields (ids mono with
 * copy buttons, dates in the UI font, started and finished apart), the payload in a JsonView,
 * send attempts as cards whose "Delivery unknown" resolutions sit in a warning-tinted footer, the
 * attempt log with outcome chips, and the correlation timeline as a rail.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft, Building2, CircleDashed, CircleHelp, Cpu, Fingerprint, GitCommitVertical, History, Package, Route, Send, ShieldCheck, Workflow, Zap } from 'lucide-react';
import { DISPATCH_STATE_VOCABULARY, SEND_INTENT_LABELS, attemptOutcomeEntry, jobStatusEntry } from '@/components/admin/admin-vocabulary';
import { DetailField } from '@/components/admin/DetailField';
import { InlineEmpty } from '@/components/admin/InlineEmpty';
import { JobLifecycle } from '@/components/admin/JobLifecycle';
import { JsonView } from '@/components/admin/JsonView';
import { SectionTitle } from '@/components/admin/SectionTitle';
import { StatusChip } from '@/components/admin/StatusChip';
import { Timeline, type TimelineEntry } from '@/components/admin/Timeline';
import { GatedAction } from '@/components/patterns/GatedAction';
import { PageHeader } from '@/components/patterns/PageHeader';
import { SectionCard } from '@/components/patterns/SectionCard';
import { SourceChip } from '@/components/patterns/SourceChip';
import { cn } from '@/components/ui/cn';
import type { JobAttemptOutcome } from '@/lib/domain/enums';
import { formatDateTime } from '@/lib/format/date';
import { NotFoundError } from '@/lib/errors';
import { getPageContext } from '@/server/auth/page-context';
import { getJobDetail, type JobDetail, type TimelineItem } from '@/server/services/jobs-admin/inspector';
import { DELIVERY_UNKNOWN_LABEL } from '@/server/services/messaging/delivery-state';
import { AdminAction, RESEND_CONFIRM_TEXT } from '../admin-actions';

export const metadata: Metadata = { title: 'Job inspector' };
export const dynamic = 'force-dynamic';

const when = (d: Date | null) => (d ? formatDateTime(d) : null);

/** Long identifiers take the full row on phones (two short facts, or an empty one, share a row there). */
const WIDE = 'col-span-2 sm:col-span-1';

const OUTCOMES: ReadonlySet<string> = new Set<JobAttemptOutcome>(['SUCCEEDED', 'RETRYABLE', 'FATAL', 'AMBIGUOUS', 'LEASE_LOST', 'DEFERRED']);

function timelineEntry(t: TimelineItem, i: number, jobId: string): TimelineEntry {
  const key = `${t.kind}-${t.ref}-${i}`;
  const time = formatDateTime(t.at);
  if (t.kind === 'job') {
    return {
      key,
      icon: <Workflow />,
      tone: 'panel',
      time,
      title: (
        <Link href={`/dashboard/admin/jobs/${t.ref}`} className="font-mono text-[13px] break-all text-cyan underline-offset-4 hover:underline">
          {t.label}
        </Link>
      ),
      aside: t.ref === jobId ? <span className="rounded-full border border-panel/40 bg-panel/12 px-2 py-0.5 text-xs font-medium text-fg-1">This job</span> : undefined,
      detail: t.detail,
    };
  }
  if (t.kind === 'attempt') {
    const [first, ...rest] = t.detail.split(' ');
    const outcome = first && OUTCOMES.has(first) ? (first as JobAttemptOutcome) : null;
    const entry = attemptOutcomeEntry(outcome);
    return {
      key,
      icon: <Zap />,
      tone: entry.tone,
      time,
      title: <span className="font-medium">Attempt {t.label.replace(/^attempt\s*/, '')}</span>,
      aside: <StatusChip entry={entry} state={outcome ?? 'IN_FLIGHT'} />,
      detail: rest.length > 0 ? <span className="font-mono">{rest.join(' ')}</span> : undefined,
    };
  }
  return {
    key,
    icon: <ShieldCheck />,
    tone: 'neutral',
    time,
    title: <span className="font-mono text-[13px] break-all">{t.label}</span>,
    detail: t.detail,
  };
}

export default async function JobInspectorPage(props: { params: Promise<{ jobId: string }> }) {
  const page = await getPageContext();
  if (!page) redirect('/login');
  const { jobId } = await props.params;
  let detail: JobDetail;
  try {
    detail = await getJobDetail(page.ctx, jobId);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  const { job, actions } = detail;
  const mode = page.ctx.mode;
  const workspaceName = job.workspace?.name;
  const base = `/api/admin/jobs/${job.id}`;
  const entry = jobStatusEntry(job);
  const hasActions = actions.cancel || job.status === 'DEAD';

  return (
    <div className="flex flex-col gap-6">
      <Link href="/dashboard/admin/jobs" className="inline-flex w-fit items-center gap-1.5 text-sm text-cyan underline-offset-4 hover:underline">
        <ArrowLeft aria-hidden="true" className="size-4" />
        Jobs and queue
      </Link>
      <PageHeader
        className="-mt-3"
        eyebrow="Job inspector"
        title={job.type}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StatusChip entry={entry} state={job.status} size="md" />
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border-strong bg-bg-2 px-2.5 py-1 text-sm text-fg-1">
              {workspaceName ? <Building2 aria-hidden="true" className="size-4 text-fg-2" /> : <Cpu aria-hidden="true" className="size-4 text-fg-2" />}
              {workspaceName ?? 'System job'}
            </span>
            <span className="tabular text-sm text-fg-2">
              attempts {job.attempts}/{job.maxAttempts}
            </span>
          </span>
        }
        actions={
          hasActions ? (
            <div role="group" aria-label="Job actions" className="flex flex-wrap items-start gap-2">
              {actions.cancel ? (
                <AdminAction
                  mode={mode}
                  destructive
                  size="default"
                  icon="cancel"
                  workspaceName={workspaceName}
                  triggerLabel={job.status === 'RUNNING' ? 'Request cancel' : 'Cancel job'}
                  title={job.status === 'RUNNING' ? 'Request cancel' : 'Cancel this job'}
                  description={
                    job.status === 'RUNNING'
                      ? 'The worker stops the job before its next step; a send already handed to the provider is not recalled.'
                      : 'The job will not run. A queued send is cancelled and its message marked not sent.'
                  }
                  confirmLabel="Cancel job"
                  endpoint={`${base}/cancel`}
                  body={{}}
                  successMessage="Job cancelled."
                />
              ) : null}
              {job.status === 'DEAD' ? (
                actions.retry.allowed ? (
                  <AdminAction
                    mode={mode}
                    variant="default"
                    size="default"
                    icon="retry"
                    workspaceName={workspaceName}
                    triggerLabel="Retry"
                    title="Retry this job"
                    description={actions.retry.reason}
                    confirmLabel="Retry"
                    endpoint={`${base}/retry`}
                    body={{}}
                    successMessage="Retry queued."
                  />
                ) : (
                  <GatedAction label="Retry" variant="outline" gate={{ category: 'eligibility', reason: actions.retry.reason }} href={`/dashboard/admin/jobs/${job.id}`} className="max-w-xs" />
                )
              ) : null}
            </div>
          ) : undefined
        }
      />

      <SectionCard
        title={
          <SectionTitle icon={<Route />} hue="volt">
            Lifecycle
          </SectionTitle>
        }
        meta={`Created ${formatDateTime(job.createdAt)}`}
        accent
      >
        <JobLifecycle job={{ status: job.status, entry, createdAt: job.createdAt, runAt: job.runAt, startedAt: job.startedAt, finishedAt: job.finishedAt }} />
      </SectionCard>

      <SectionCard
        title={
          <SectionTitle icon={<Fingerprint />} hue="ice">
            Job
          </SectionTitle>
        }
      >
        <dl className="grid grid-cols-2 gap-x-4 gap-y-4 sm:gap-x-6 lg:grid-cols-3">
          <DetailField label="Job id" value={job.id} mono copy={job.id} className={WIDE} />
          <DetailField label="Correlation" value={job.correlationId} mono copy={job.correlationId} className={WIDE} />
          <DetailField label="Idempotency key" value={job.idempotencyKey} mono copy={job.idempotencyKey} className={WIDE} />
          <DetailField label="Status" value={<StatusChip entry={entry} state={job.status} />} />
          <DetailField label="Retry safe" value={job.retrySafe ? 'Yes' : 'No'} />
          <DetailField label="Dead reason" value={job.deadReason} mono />
          <DetailField label="Run at" value={when(job.runAt)} />
          <DetailField label="Started" value={when(job.startedAt)} />
          <DetailField label="Finished" value={when(job.finishedAt)} />
          <DetailField label="Lease until" value={when(job.leaseUntil)} />
          <DetailField label="Serial key" value={job.serialKey} mono className={job.serialKey ? WIDE : undefined} />
          <DetailField label="Caused by" value={job.causationId} mono className={job.causationId ? WIDE : undefined} />
          <DetailField label="Last error" value={job.lastErrorCode ? `${job.lastErrorCode}: ${job.lastErrorRedacted ?? ''}` : null} mono className="col-span-2 lg:col-span-3" />
        </dl>
      </SectionCard>

      <SectionCard
        title={
          <SectionTitle icon={<Package />} hue="ice">
            Payload
          </SectionTitle>
        }
        meta="Ids and versions only; passed through redaction again for this view."
      >
        <JsonView value={job.payload} label={`payload.v${job.payloadVersion}.json`} redacted />
      </SectionCard>

      {detail.dispatchAttempts.length > 0 ? (
        <SectionCard
          title={
            <SectionTitle icon={<Send />}>
              Send attempts
            </SectionTitle>
          }
          meta="Each provider hand-off for this job's message, oldest first."
        >
          <ul className="flex flex-col gap-3">
            {detail.dispatchAttempts.map((a) => {
              const state = DISPATCH_STATE_VOCABULARY[a.state];
              const resolvable = actions.resolvableAttemptIds.includes(a.id);
              return (
                <li key={a.id} data-dispatch-state={a.state} className={cn('flex flex-col overflow-hidden rounded-lg border bg-bg-1/70', resolvable ? 'border-warning/40' : 'border-border-subtle')}>
                  <div className="flex flex-col gap-2 p-3 sm:p-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-fg-1">Attempt {a.attemptNo}</span>
                      <SourceChip source={a.channel === 'WHATSAPP' ? 'WHATSAPP_INBOUND' : 'EMAIL_INBOUND'} withIcon />
                      <StatusChip entry={a.state === 'AMBIGUOUS' ? { ...state, label: DELIVERY_UNKNOWN_LABEL } : state} state={a.state} />
                      {a.reasonCode ? <span className="rounded-md bg-bg-2 px-1.5 py-0.5 font-mono text-xs text-fg-2">{a.reasonCode}</span> : null}
                      <span className="text-xs text-fg-2">{SEND_INTENT_LABELS[a.sendIntent]}</span>
                    </div>
                    <p className="tabular text-xs text-fg-2">
                      Created {formatDateTime(a.createdAt)}
                      {a.resolvedBy ? ` · resolved by ${a.resolvedBy} at ${a.resolvedAt ? formatDateTime(a.resolvedAt) : ''}: ${a.resolutionNote ?? ''}` : ''}
                    </p>
                  </div>
                  {resolvable ? (
                    <div className="flex flex-col gap-2 border-t border-warning/30 bg-warning/8 p-3 sm:p-4">
                      <p className="flex items-start gap-2 text-sm text-fg-1">
                        <CircleHelp aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
                        The provider did not confirm this send. Record what happened before anything else is sent.
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <AdminAction
                          mode={mode}
                          icon="delivered"
                          workspaceName={workspaceName}
                          triggerLabel="Mark delivered"
                          title="Mark this send as delivered"
                          description="Use this only with positive evidence (the customer or the provider confirms receipt). Nothing is sent."
                          confirmLabel="Mark delivered"
                          endpoint={`${base}/resolve`}
                          body={{ attemptId: a.id, resolution: 'DELIVERED' }}
                          successMessage="Attempt marked delivered."
                        />
                        <AdminAction
                          mode={mode}
                          icon="not-delivered"
                          workspaceName={workspaceName}
                          triggerLabel="Verified not delivered"
                          title="Record that this send was not delivered"
                          description="The attempt and its message become failed. Nothing is sent."
                          confirmLabel="Record not delivered"
                          endpoint={`${base}/resolve`}
                          body={{ attemptId: a.id, resolution: 'NOT_DELIVERED', requeue: false }}
                          successMessage="Attempt recorded as not delivered."
                        />
                        <AdminAction
                          mode={mode}
                          destructive
                          icon="resend"
                          workspaceName={workspaceName}
                          triggerLabel="Not delivered: resend"
                          title="Resend after verifying it was not delivered"
                          description="A new attempt runs the full preflight (consent, suppression, approval, pauses) before anything is sent. If the first send did arrive, the customer gets it twice."
                          confirmLabel="Resend"
                          confirmText={RESEND_CONFIRM_TEXT}
                          endpoint={`${base}/resolve`}
                          body={{ attemptId: a.id, resolution: 'NOT_DELIVERED', requeue: true }}
                          successMessage="Resend queued."
                        />
                      </div>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </SectionCard>
      ) : null}

      <SectionCard
        title={
          <SectionTitle icon={<History />} hue="volt">
            Attempt log
          </SectionTitle>
        }
        meta={detail.attempts.length > 0 ? `${detail.attempts.length} ${detail.attempts.length === 1 ? 'run' : 'runs'} by the worker.` : undefined}
      >
        {detail.attempts.length === 0 ? (
          <InlineEmpty icon={<CircleDashed />}>The job has not run yet.</InlineEmpty>
        ) : (
          <>
            <ol aria-label="Attempt log" className="flex flex-col divide-y divide-border-subtle overflow-hidden rounded-lg border border-border-subtle bg-bg-0/30 md:hidden">
              {detail.attempts.map((a) => (
                <li key={a.id} className="flex flex-col gap-1 px-3 py-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-fg-1">Attempt {a.attemptNo}</span>
                    <StatusChip entry={attemptOutcomeEntry(a.outcome)} state={a.outcome ?? 'IN_FLIGHT'} />
                  </div>
                  <p className="tabular text-xs text-fg-2">
                    Started {formatDateTime(a.startedAt)}
                    {a.durationMs === null ? '' : ` · ${a.durationMs} ms`}
                  </p>
                  {a.errorCode ? <p className="font-mono text-xs break-all text-fg-2">{`${a.errorCode} ${a.errorRedacted ?? ''}`}</p> : null}
                </li>
              ))}
            </ol>
            <div role="region" aria-label="Attempt log table" tabIndex={0} className="relative -mx-4 hidden overflow-x-auto border-y border-border-subtle md:block sm:-mx-5">
              <table className="w-full min-w-[36rem] text-left text-sm">
                <thead className="bg-bg-2/40 text-xs text-fg-2">
                  <tr>
                    <th scope="col" className="py-2.5 pr-3 pl-4 font-medium sm:pl-5">
                      #
                    </th>
                    <th scope="col" className="px-3 py-2.5 font-medium">
                      Started
                    </th>
                    <th scope="col" className="px-3 py-2.5 font-medium">
                      Outcome
                    </th>
                    <th scope="col" className="px-3 py-2.5 font-medium">
                      Error
                    </th>
                    <th scope="col" className="py-2.5 pr-4 pl-3 text-right font-medium sm:pr-5">
                      Duration
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {detail.attempts.map((a) => (
                    <tr key={a.id} className="transition-colors duration-fast hover:bg-bg-2/60">
                      <td className="tabular py-2.5 pr-3 pl-4 text-fg-1 sm:pl-5">{a.attemptNo}</td>
                      <td className="tabular px-3 py-2.5 whitespace-nowrap text-fg-2">{formatDateTime(a.startedAt)}</td>
                      <td className="px-3 py-2.5">
                        <StatusChip entry={attemptOutcomeEntry(a.outcome)} state={a.outcome ?? 'IN_FLIGHT'} />
                      </td>
                      <td className="px-3 py-2.5 font-mono text-xs text-fg-2">{a.errorCode ? `${a.errorCode} ${a.errorRedacted ?? ''}` : ''}</td>
                      <td className="tabular py-2.5 pr-4 pl-3 text-right whitespace-nowrap text-fg-2 sm:pr-5">{a.durationMs === null ? '' : `${a.durationMs} ms`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </SectionCard>

      <SectionCard
        title={
          <SectionTitle icon={<GitCommitVertical />} hue="aura">
            Correlation timeline
          </SectionTitle>
        }
        meta="Audit rows, related jobs and attempts that share this job's correlation id, oldest first."
      >
        {detail.timeline.length === 0 ? (
          <InlineEmpty icon={<CircleDashed />}>Nothing else shares this correlation id.</InlineEmpty>
        ) : (
          <Timeline inView items={detail.timeline.map((t, i) => timelineEntry(t, i, job.id))} />
        )}
      </SectionCard>
    </div>
  );
}
