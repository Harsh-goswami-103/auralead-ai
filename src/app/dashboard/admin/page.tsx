/**
 * Platform admin home (T09, M1): platform counts and worker liveness derived from the database.
 * No tenant records: drilling into a workspace goes through the audited adminContext (later
 * admin pages).
 */
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { formatDateTime } from '@/lib/format/date';
import { getPageContext } from '@/server/auth/page-context';
import { getRuntime } from '@/server/boot';
import { loadAdminHome } from '@/server/services/shell/panel-home';

export const metadata: Metadata = { title: 'Global metrics' };
export const dynamic = 'force-dynamic';

function Stat(props: { label: string; value: number; detail?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-border-subtle bg-bg-1 p-5">
      <dt className="text-sm text-fg-2">{props.label}</dt>
      <dd className="tabular font-display text-3xl font-semibold text-fg-1">{props.value.toLocaleString('en-IN')}</dd>
      {props.detail ? <dd className="text-xs text-fg-2">{props.detail}</dd> : null}
    </div>
  );
}

export default async function AdminHomePage() {
  const page = await getPageContext();
  if (!page) redirect('/login');
  const home = await loadAdminHome(page.ctx, { envOutboundPaused: getRuntime().config.outboundPaused });
  const { workspaces, people, worker } = home;
  const paused = workspaces.automationPaused;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <p className="text-sm text-fg-2">Platform admin</p>
        <h1 className="font-display text-2xl font-semibold text-fg-1 sm:text-3xl">Global metrics</h1>
        <p className="text-fg-2">
          Counts for this {page.ctx.mode === 'demo' ? 'DEMO' : 'LIVE'} database. Workspace records open only through an audited drilldown.
        </p>
      </header>

      <dl className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="Workspaces" value={workspaces.total} detail={`${workspaces.active} active, ${workspaces.suspended} suspended`} />
        <Stat label="Owners" value={people.owners} />
        <Stat label="Members" value={people.members} />
        <Stat label="Employees" value={people.employees} detail={`${home.activeAssignments} active assignments`} />
        <Stat label="Super admins" value={people.superAdmins} />
        <Stat label="Disabled accounts" value={people.disabled} />
      </dl>

      <section className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-2 rounded-xl border border-border-subtle bg-bg-1 p-5">
          <h2 className="font-display text-lg font-semibold text-fg-1">Worker</h2>
          {worker === null ? (
            <p className="text-fg-2">No worker has reported yet. Start it with npm run worker.</p>
          ) : (
            <p className="text-fg-2">
              <span className={worker.running ? 'font-medium text-success' : 'font-medium text-danger'}>{worker.running ? 'Running' : 'Worker not running'}</span>
              {` · last heartbeat ${formatDateTime(worker.lastBeatAt)}`}
              {worker.currentJobId ? ' · processing a job' : ' · idle'}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-2 rounded-xl border border-border-subtle bg-bg-1 p-5">
          <h2 className="font-display text-lg font-semibold text-fg-1">Outbound delivery</h2>
          <p className="text-fg-2">
            {home.outboundPaused ? <span className="font-medium text-warning">Paused globally</span> : <span className="font-medium text-fg-1">Not paused</span>}
            {` · ${paused} ${paused === 1 ? 'workspace has' : 'workspaces have'} automation paused`}
          </p>
        </div>
      </section>
    </div>
  );
}
