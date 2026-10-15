/**
 * Job inspector (T24, R33): one job's state, its redacted payload (ids and versions only), the
 * attempt log, its dispatch attempts and the correlation timeline (audit rows and related jobs).
 * Actions: cancel (QUEUED / RUNNING), safe retry (DEAD; blocked with the reason when not safe),
 * and for each AMBIGUOUS ("Delivery unknown") attempt: Mark delivered, Verified not delivered, or
 * Verified not delivered and resend (typed RESEND). Every action is audited with its reason.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { GatedAction } from '@/components/patterns/GatedAction';
import { formatDateTime } from '@/lib/format/date';
import { NotFoundError } from '@/lib/errors';
import { getPageContext } from '@/server/auth/page-context';
import { getJobDetail, type JobDetail } from '@/server/services/jobs-admin/inspector';
import { DELIVERY_UNKNOWN_LABEL } from '@/server/services/messaging/delivery-state';
import { AdminAction, RESEND_CONFIRM_TEXT } from '../admin-actions';

export const metadata: Metadata = { title: 'Job inspector' };
export const dynamic = 'force-dynamic';

function Field(props: { label: string; value: string | number | null }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-fg-2">{props.label}</dt>
      <dd className="break-all font-mono text-sm text-fg-1">{props.value === null || props.value === '' ? '-' : String(props.value)}</dd>
    </div>
  );
}

const when = (d: Date | null) => (d ? formatDateTime(d) : null);

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

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link href="/dashboard/admin/jobs" className="text-sm text-cyan underline-offset-4 hover:underline">
          Jobs and queue
        </Link>
        <h1 className="break-all font-display text-2xl font-semibold text-fg-1">{job.type}</h1>
        <p className="text-fg-2">
          {job.label} · {workspaceName ?? 'System job'} · attempts {job.attempts}/{job.maxAttempts}
        </p>
      </header>

      <section aria-label="Actions" className="flex flex-wrap items-start gap-3">
        {actions.cancel ? (
          <AdminAction
            mode={mode}
            destructive
            workspaceName={workspaceName}
            triggerLabel={job.status === 'RUNNING' ? 'Request cancel' : 'Cancel job'}
            title={job.status === 'RUNNING' ? 'Request cancel' : 'Cancel this job'}
            description={job.status === 'RUNNING' ? 'The worker stops the job before its next step; a send already handed to the provider is not recalled.' : 'The job will not run. A queued send is cancelled and its message marked not sent.'}
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
            <GatedAction label="Retry" variant="outline" size="sm" gate={{ category: 'eligibility', reason: actions.retry.reason }} href={`/dashboard/admin/jobs/${job.id}`} />
          )
        ) : null}
      </section>

      <section aria-labelledby="job-fields" className="flex flex-col gap-3 rounded-xl border border-border-subtle bg-bg-1 p-5">
        <h2 id="job-fields" className="font-display text-lg font-semibold text-fg-1">
          Job
        </h2>
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Job id" value={job.id} />
          <Field label="Status" value={job.status} />
          <Field label="Dead reason" value={job.deadReason} />
          <Field label="Run at" value={when(job.runAt)} />
          <Field label="Started / finished" value={`${when(job.startedAt) ?? '-'} / ${when(job.finishedAt) ?? '-'}`} />
          <Field label="Lease until" value={when(job.leaseUntil)} />
          <Field label="Last error" value={job.lastErrorCode ? `${job.lastErrorCode}: ${job.lastErrorRedacted ?? ''}` : null} />
          <Field label="Retry safe" value={job.retrySafe ? 'yes' : 'no'} />
          <Field label="Serial key" value={job.serialKey} />
          <Field label="Correlation" value={job.correlationId} />
          <Field label="Caused by" value={job.causationId} />
          <Field label="Idempotency key" value={job.idempotencyKey} />
        </dl>
        <div className="flex flex-col gap-1">
          <h3 className="text-sm text-fg-2">Payload v{job.payloadVersion} (redacted)</h3>
          <pre className="overflow-x-auto rounded-md bg-bg-0 p-3 font-mono text-xs text-fg-1">{JSON.stringify(job.payload, null, 2)}</pre>
        </div>
      </section>

      {detail.dispatchAttempts.length > 0 ? (
        <section aria-labelledby="dispatch-heading" className="flex flex-col gap-3">
          <h2 id="dispatch-heading" className="font-display text-lg font-semibold text-fg-1">
            Send attempts
          </h2>
          <ul className="flex flex-col gap-3">
            {detail.dispatchAttempts.map((a) => (
              <li key={a.id} className="flex flex-col gap-2 rounded-xl border border-border-subtle bg-bg-1 p-4">
                <p className="text-sm text-fg-1">
                  Attempt {a.attemptNo} · {a.channel} · {a.state === 'AMBIGUOUS' ? DELIVERY_UNKNOWN_LABEL : a.state}
                  {a.reasonCode ? ` · ${a.reasonCode}` : ''} · {a.sendIntent}
                </p>
                <p className="text-xs text-fg-2">
                  Created {formatDateTime(a.createdAt)}
                  {a.resolvedBy ? ` · resolved by ${a.resolvedBy} at ${a.resolvedAt ? formatDateTime(a.resolvedAt) : ''}: ${a.resolutionNote ?? ''}` : ''}
                </p>
                {actions.resolvableAttemptIds.includes(a.id) ? (
                  <div className="flex flex-wrap gap-2">
                    <AdminAction
                      mode={mode}
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
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="attempts-heading" className="flex flex-col gap-3">
        <h2 id="attempts-heading" className="font-display text-lg font-semibold text-fg-1">
          Attempt log
        </h2>
        {detail.attempts.length === 0 ? (
          <p className="text-fg-2">The job has not run yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border-subtle">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="bg-bg-2 text-fg-2">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">#</th>
                  <th scope="col" className="px-3 py-2 font-medium">Started</th>
                  <th scope="col" className="px-3 py-2 font-medium">Outcome</th>
                  <th scope="col" className="px-3 py-2 font-medium">Error</th>
                  <th scope="col" className="px-3 py-2 font-medium">Duration</th>
                </tr>
              </thead>
              <tbody>
                {detail.attempts.map((a) => (
                  <tr key={a.id} className="border-t border-border-subtle">
                    <td className="tabular px-3 py-2">{a.attemptNo}</td>
                    <td className="px-3 py-2 text-fg-2">{formatDateTime(a.startedAt)}</td>
                    <td className="px-3 py-2 text-fg-1">{a.outcome ?? 'In flight'}</td>
                    <td className="px-3 py-2 font-mono text-xs text-fg-2">{a.errorCode ? `${a.errorCode} ${a.errorRedacted ?? ''}` : ''}</td>
                    <td className="tabular px-3 py-2 text-fg-2">{a.durationMs === null ? '' : `${a.durationMs} ms`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="timeline-heading" className="flex flex-col gap-3">
        <h2 id="timeline-heading" className="font-display text-lg font-semibold text-fg-1">
          Correlation timeline
        </h2>
        <ol className="flex flex-col gap-2">
          {detail.timeline.map((t, i) => (
            <li key={`${t.kind}-${t.ref}-${i}`} className="flex flex-wrap gap-x-3 gap-y-0.5 rounded-md border border-border-subtle bg-bg-1 px-3 py-2 text-sm">
              <span className="tabular text-fg-2">{formatDateTime(t.at)}</span>
              {t.kind === 'job' ? (
                <Link href={`/dashboard/admin/jobs/${t.ref}`} className="font-mono text-cyan underline-offset-4 hover:underline">
                  {t.label}
                </Link>
              ) : (
                <span className="font-mono text-fg-1">{t.label}</span>
              )}
              <span className="text-fg-2">{t.detail}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
