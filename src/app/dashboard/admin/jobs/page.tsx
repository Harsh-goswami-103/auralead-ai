/**
 * Platform admin: jobs and queue health (T24, R33, R40). Worker liveness ("Worker not running"
 * after 30 s without a heartbeat), AMBIGUOUS attempts awaiting an operator, due and retry-waiting
 * jobs, the global outbound pause (with its three sources) and the job list with filters. Rows
 * open the job inspector. Platform metadata only: no tenant records are shown here.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Button } from '@/components/ui/button';
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

function age(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

function Stat(props: { label: string; value: string; detail?: string; tone?: 'danger' | 'warning' | 'success' }) {
  const tone = props.tone === 'danger' ? 'text-danger' : props.tone === 'warning' ? 'text-warning' : props.tone === 'success' ? 'text-success' : 'text-fg-1';
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-border-subtle bg-bg-1 p-4">
      <dt className="text-sm text-fg-2">{props.label}</dt>
      <dd className={`tabular font-display text-2xl font-semibold ${tone}`}>{props.value}</dd>
      {props.detail ? <dd className="text-xs text-fg-2">{props.detail}</dd> : null}
    </div>
  );
}

export default async function AdminJobsPage(props: { searchParams: Promise<Search> }) {
  const page = await getPageContext();
  if (!page) redirect('/login');
  const search = await props.searchParams;
  const { config } = getRuntime();
  const statusParam = one(search.status);
  const status = JOB_STATUSES.includes(statusParam as JobStatus) ? (statusParam as JobStatus) : undefined;
  const type = one(search.type);
  const before = one(search.before);

  const health = await loadQueueHealth(page.ctx, { lockFile: config.paths.outboundLockFile, envPaused: config.outboundPaused });
  const list = await listJobs(page.ctx, { status, type, before });
  const outbound = health.outbound!;
  const mode = page.ctx.mode;
  const query = (extra: Record<string, string | undefined>) => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries({ status, type, ...extra })) if (v) params.set(k, v);
    const s = params.toString();
    return s ? `?${s}` : '';
  };

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <p className="text-sm text-fg-2">Platform admin</p>
        <h1 className="font-display text-2xl font-semibold text-fg-1 sm:text-3xl">Jobs and queue</h1>
        <p className="text-fg-2">As of {formatDateTime(health.asOf)}. Actions need a reason and a sign-in within 15 minutes, and are audited.</p>
      </header>

      <dl className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <Stat
          label="Worker"
          value={health.worker.label}
          tone={health.worker.running ? 'success' : 'danger'}
          detail={health.worker.lastBeatAt ? `last heartbeat ${age(health.worker.ageMs ?? 0)} ago` : 'no heartbeat recorded; start it with npm run worker'}
        />
        <Stat label="Delivery unknown" value={String(health.ambiguousAttempts)} tone={health.ambiguousAttempts > 0 ? 'warning' : undefined} detail="AMBIGUOUS attempts awaiting an operator" />
        <Stat label="Due now" value={String(health.dueQueued)} detail={health.oldestDueQueued ? `oldest waiting ${age(health.oldestDueQueued.ageMs)}` : 'nothing waiting'} />
        <Stat label="Retry waiting" value={String(health.retryWaiting)} detail="queued with a later run time" />
        <Stat label="Running" value={String(health.byStatus.RUNNING)} />
        <Stat label="Dead" value={String(health.byStatus.DEAD)} tone={health.byStatus.DEAD > 0 ? 'warning' : undefined} />
      </dl>

      <section aria-labelledby="outbound-heading" className="flex flex-col gap-3 rounded-xl border border-border-subtle bg-bg-1 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="outbound-heading" className="font-display text-lg font-semibold text-fg-1">
            Outbound delivery: {outbound.paused ? <span className="text-warning">paused</span> : <span className="text-success">running</span>}
          </h2>
          {outbound.db.paused ? (
            <AdminAction
              mode={mode}
              triggerLabel="Resume outbound"
              title="Resume outbound delivery"
              description="Queued sends pass preflight again (each still checks consent, suppression, approval and pauses). A lock written by a database restore is removed too."
              confirmLabel="Resume"
              endpoint="/api/admin/system/outbound-pause"
              body={{ paused: false }}
              successMessage="Outbound delivery resumed."
            />
          ) : (
            <AdminAction
              mode={mode}
              destructive
              triggerLabel="Pause all outbound"
              title="Pause all outbound delivery"
              description="Every WhatsApp and email send in every workspace waits at preflight until you resume. Sends already handed to a provider complete."
              confirmLabel="Pause outbound"
              endpoint="/api/admin/system/outbound-pause"
              body={{ paused: true }}
              successMessage="Outbound delivery paused."
            />
          )}
        </div>
        <ul className="flex flex-col gap-1 text-sm text-fg-2">
          <li>
            Admin switch: {outbound.db.paused ? `on since ${outbound.db.at ? formatDateTime(outbound.db.at) : 'unknown'} (${outbound.db.reason ?? 'no reason'})` : 'off'}
          </li>
          <li>
            outbound.lock:{' '}
            {outbound.lockFile.present
              ? outbound.lockFile.writtenByRestore
                ? 'present, written by a database restore (removed when you resume)'
                : `present (${outbound.lockFile.path}); remove the file to lift it`
              : 'absent'}
          </li>
          <li>OUTBOUND_PAUSED environment flag: {outbound.env.paused ? 'set (restart without it to lift)' : 'not set'}</li>
        </ul>
      </section>

      <section aria-labelledby="jobs-heading" className="flex flex-col gap-3">
        <h2 id="jobs-heading" className="font-display text-lg font-semibold text-fg-1">
          Jobs
        </h2>
        <form method="get" className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm text-fg-2">
            Status
            <select name="status" defaultValue={status ?? ''} className="h-9 rounded-md border border-input bg-input/30 px-2 text-fg-1">
              <option value="">All</option>
              {JOB_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-sm text-fg-2">
            Type
            <select name="type" defaultValue={type ?? ''} className="h-9 rounded-md border border-input bg-input/30 px-2 text-fg-1">
              <option value="">All</option>
              {list.types.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <Button type="submit" variant="outline" size="sm">
            Filter
          </Button>
        </form>
        {list.rows.length === 0 ? (
          <p className="rounded-xl border border-border-subtle bg-bg-1 p-5 text-fg-2">No jobs match these filters.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border-subtle">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead className="bg-bg-2 text-fg-2">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">Type</th>
                  <th scope="col" className="px-3 py-2 font-medium">Status</th>
                  <th scope="col" className="px-3 py-2 font-medium">Workspace</th>
                  <th scope="col" className="px-3 py-2 font-medium">Attempts</th>
                  <th scope="col" className="px-3 py-2 font-medium">Run at</th>
                  <th scope="col" className="px-3 py-2 font-medium">Last error</th>
                </tr>
              </thead>
              <tbody>
                {list.rows.map((j) => (
                  <tr key={j.id} className="border-t border-border-subtle">
                    <td className="px-3 py-2">
                      <Link href={`/dashboard/admin/jobs/${j.id}`} className="font-mono text-cyan underline-offset-4 hover:underline">
                        {j.type}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-fg-1">{j.label}</td>
                    <td className="px-3 py-2 text-fg-2">{j.workspace?.name ?? 'System'}</td>
                    <td className="tabular px-3 py-2 text-fg-2">
                      {j.attempts}/{j.maxAttempts}
                    </td>
                    <td className="px-3 py-2 text-fg-2">{formatDateTime(j.runAt)}</td>
                    <td className="px-3 py-2 font-mono text-xs text-fg-2">{j.lastErrorCode ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {list.nextCursor ? (
          <Link href={`/dashboard/admin/jobs${query({ before: list.nextCursor })}`} className="self-start text-sm text-cyan underline-offset-4 hover:underline">
            Older jobs
          </Link>
        ) : null}
      </section>
    </div>
  );
}
