/**
 * Platform admin home (T09, M1): platform counts and worker liveness derived from the database.
 * No tenant records: drilling into a workspace goes through the audited adminContext (later
 * admin pages).
 *
 * Look (design spec §6): the PageHeader with its "As of" time, then the two platform health cards,
 * each with its state chip in the card header: the worker (its facts, and how far the last
 * heartbeat is into the stale window as a static bar) and outbound delivery (read through the same
 * pause model as Jobs and queue, so a hand-made outbound.lock shows here too, with its three
 * switches), then the account counts as tiles in one description
 * list (each role tile in the signature hue of the panel those people use: workspace owners and
 * members the Client panel's aura, employees the Operator panel's zest, super admins this panel's
 * flare; disabled accounts turn danger only when there are any), then links to the admin tools.
 * Values are final from the first frame. The word "Running" appears once (the worker state).
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowRight, Building2, Cpu, Crown, HeartCrack, HeartPulse, ListChecks, Send, ShieldCheck, UserCog, UserRoundX, UsersRound, Webhook } from 'lucide-react';
import { formatAge } from '@/components/admin/admin-vocabulary';
import { DetailField } from '@/components/admin/DetailField';
import { InlineEmpty } from '@/components/admin/InlineEmpty';
import { MetricTile } from '@/components/admin/MetricTile';
import { OutboundSources, OutboundStateChip, pauseSources } from '@/components/admin/OutboundState';
import { SectionTitle } from '@/components/admin/SectionTitle';
import { StatusChip } from '@/components/admin/StatusChip';
import { PageHeader } from '@/components/patterns/PageHeader';
import { SectionCard } from '@/components/patterns/SectionCard';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { BorderBeam } from '@/components/visual/BorderBeam';
import { Reveal } from '@/components/visual/Reveal';
import { SpotlightCard } from '@/components/visual/SpotlightCard';
import { formatDateTime } from '@/lib/format/date';
import { getPageContext } from '@/server/auth/page-context';
import { getRuntime } from '@/server/boot';
import { loadAdminHome, WORKER_STALE_AFTER_MS, type AdminHome } from '@/server/services/shell/panel-home';

export const metadata: Metadata = { title: 'Global metrics' };
export const dynamic = 'force-dynamic';

/** A stretched link's focus ring goes around the whole card (its ::after), not the title text. */
const STRETCHED_FOCUS = 'focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-aura';

const TOOLS = [
  {
    href: '/dashboard/admin/jobs',
    title: 'Jobs and queue',
    body: 'Worker liveness, the outbound pause, every job with its attempts, and safe retries.',
    icon: ListChecks,
  },
  {
    href: '/dashboard/admin/webhooks',
    title: 'Webhooks',
    body: 'Stored provider deliveries with redacted payloads, the jobs that processed them, and rejections.',
    icon: Webhook,
  },
] as const;

export default async function AdminHomePage() {
  const page = await getPageContext();
  if (!page) redirect('/login');
  const { config } = getRuntime();
  const home = await loadAdminHome(page.ctx, {
    envOutboundPaused: config.outboundPaused,
    lockFile: config.paths.outboundLockFile,
  });
  const asOf = page.ctx.clock.now();
  const { workspaces, people, worker, outbound } = home;
  const paused = workspaces.automationPaused;
  const beatAge = worker ? Math.max(0, asOf.getTime() - worker.lastBeatAt.getTime()) : null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Platform admin"
        title="Global metrics"
        description={`Counts for this ${page.ctx.mode === 'demo' ? 'DEMO' : 'LIVE'} database. Workspace records open only through an audited drilldown.`}
        meta={`As of ${formatDateTime(asOf)}`}
      />

      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <Reveal delay={0.06} className="flex min-w-0">
          <SectionCard
            title={
              <SectionTitle icon={<Cpu />} hue="volt">
                Worker
              </SectionTitle>
            }
            meta="Background jobs: sends, AI drafts, PDFs, webhook processing."
            actions={<WorkerChip worker={worker} />}
            className="flex-1"
            accent
          >
            {worker === null ? (
              <InlineEmpty icon={<HeartCrack />}>No worker has reported yet. Start it with npm run worker.</InlineEmpty>
            ) : (
              <>
                <HeartbeatWindow ageMs={beatAge ?? 0} running={worker.running} />
                {worker.running ? null : (
                  <p className="flex items-start gap-2 rounded-lg border border-danger/35 bg-danger/8 px-3 py-2.5 text-sm text-fg-1">
                    <HeartCrack aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
                    The worker stopped reporting. Restart it with npm run worker.
                  </p>
                )}
                <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border border-border-subtle bg-bg-0/40 p-3">
                  <DetailField label="Last heartbeat" value={formatDateTime(worker.lastBeatAt)} className="col-span-2 sm:col-span-1" />
                  <DetailField label="Activity" value={worker.running ? (worker.currentJobId ? 'Processing a job' : 'Idle, waiting for due jobs') : 'Not reporting'} className="col-span-2 sm:col-span-1" />
                  <DetailField label="Worker id" value={worker.workerId} mono />
                  <DetailField
                    label="Current job"
                    value={
                      worker.running && worker.currentJobId ? (
                        <Link href={`/dashboard/admin/jobs/${worker.currentJobId}`} className="font-mono text-[13px] break-all text-cyan underline-offset-4 hover:underline">
                          {worker.currentJobId}
                        </Link>
                      ) : (
                        'None'
                      )
                    }
                  />
                </dl>
              </>
            )}
          </SectionCard>
        </Reveal>

        <Reveal delay={0.1} className="flex min-w-0">
          <SectionCard
            title={
              <SectionTitle icon={<Send />}>
                Outbound delivery
              </SectionTitle>
            }
            meta="Any one switch holds every WhatsApp and email send."
            actions={<OutboundStateChip paused={home.outboundPaused} size="md" />}
            className={cn('flex-1', home.outboundPaused && 'border-danger/45 [--grad-hairline:linear-gradient(var(--danger),var(--danger))]')}
            accent
          >
            {home.outboundPaused ? null : (
              // Clip the streak's box: the mask hides it visually, but its layout box would widen the page at 390px.
              <span aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]">
                <BorderBeam duration={10} />
              </span>
            )}
            {home.outboundPaused ? (
              <p className="text-sm text-fg-1">{outbound ? `Held by ${pauseSources(outbound).join(', ')}. Nothing new passes preflight.` : 'Paused globally. Nothing new passes preflight.'}</p>
            ) : null}
            {outbound ? <OutboundSources state={outbound} /> : null}
            <div className="mt-auto flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle pt-4">
              <p className="text-sm text-fg-2">
                <span className="tabular font-medium text-fg-1">{paused}</span> {paused === 1 ? 'workspace has' : 'workspaces have'} automation paused
              </p>
              <Button asChild variant="secondary" size="sm">
                <Link href="/dashboard/admin/jobs">
                  Pause controls
                  <ArrowRight aria-hidden="true" />
                </Link>
              </Button>
            </div>
          </SectionCard>
        </Reveal>
      </div>

      <section aria-labelledby="accounts-heading" className="flex flex-col gap-3">
        <Reveal as="h2" delay={0.12} id="accounts-heading" className="font-display text-lg font-semibold text-fg-1">
          Workspaces and accounts
        </Reveal>
        <dl className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <MetricTile
            index={0}
            label="Workspaces"
            value={workspaces.total.toLocaleString('en-IN')}
            hue="client"
            icon={<Building2 />}
            hint={`${workspaces.active} active, ${workspaces.suspended} suspended`}
          />
          <MetricTile index={1} label="Owners" value={people.owners.toLocaleString('en-IN')} hue="client" icon={<Crown />} hint="Client panel" />
          <MetricTile index={2} label="Members" value={people.members.toLocaleString('en-IN')} hue="client" icon={<UsersRound />} hint="Client panel" />
          <MetricTile index={3} label="Employees" value={people.employees.toLocaleString('en-IN')} hue="operator" icon={<UserCog />} hint={`${home.activeAssignments} active assignments`} />
          <MetricTile index={4} label="Super admins" value={people.superAdmins.toLocaleString('en-IN')} hue="admin" icon={<ShieldCheck />} hint="Platform admin" />
          <MetricTile
            index={5}
            label="Disabled"
            value={people.disabled.toLocaleString('en-IN')}
            hue={people.disabled > 0 ? 'danger' : 'neutral'}
            icon={<UserRoundX />}
            hint={people.disabled > 0 ? 'accounts that cannot sign in' : 'no accounts disabled'}
          />
        </dl>
      </section>

      <nav aria-label="Admin tools" className="grid min-w-0 gap-4 md:grid-cols-2">
        {TOOLS.map((tool, i) => {
          const Icon = tool.icon;
          return (
            <Reveal key={tool.href} delay={0.18 + i * 0.05} inView className="flex min-w-0">
              <SpotlightCard className="group relative flex-1 p-4 transition-[translate,border-color] duration-fast ease-enter hover:border-panel/45 has-[a:focus-visible]:border-panel/45 motion-safe:hover:-translate-y-0.5 sm:p-5">
                <div className="flex items-start gap-4">
                  <span aria-hidden="true" className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-panel/14 text-panel ring-1 ring-panel/30 ring-inset">
                    <Icon className="size-5" />
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <Link href={tool.href} className={cn('font-display text-lg font-semibold text-fg-1 after:absolute after:inset-0 after:rounded-xl', STRETCHED_FOCUS)}>
                      {tool.title}
                    </Link>
                    <p className="text-sm text-fg-2">{tool.body}</p>
                  </div>
                  <ArrowRight aria-hidden="true" className="mt-1 size-5 shrink-0 text-fg-3 transition-transform duration-fast group-hover:text-panel motion-safe:group-hover:translate-x-0.5" />
                </div>
              </SpotlightCard>
            </Reveal>
          );
        })}
      </nav>
    </div>
  );
}

/** The worker state chip: the one element on this page whose text is exactly "Running". */
function WorkerChip(props: { worker: AdminHome['worker'] }) {
  const { worker } = props;
  if (worker === null) return <StatusChip entry={{ label: 'No heartbeat yet', tone: 'neutral', icon: HeartCrack }} state="none" size="md" />;
  return (
    <StatusChip
      entry={worker.running ? { label: 'Running', tone: 'success', icon: HeartPulse } : { label: 'Worker not running', tone: 'danger', icon: HeartCrack }}
      state={worker.running ? 'running' : 'stale'}
      size="md"
    />
  );
}

/**
 * The worker's pulse as one fact: how long since the last heartbeat (final value from the first
 * frame, never ticking), and a static bar of how far that is into the stale window
 * (WORKER_STALE_AFTER_MS). Success inside the window, danger and full once the worker is stale.
 * The text carries the value; the bar is decorative.
 */
function HeartbeatWindow(props: { ageMs: number; running: boolean }) {
  const share = Math.min(1, props.ageMs / WORKER_STALE_AFTER_MS);
  return (
    <div className="flex flex-col gap-2">
      <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="tabular font-display text-3xl font-semibold text-fg-1">{formatAge(props.ageMs)}</span>
        <span className="text-sm text-fg-2">since the last heartbeat</span>
      </p>
      <span aria-hidden="true" className="block h-1.5 overflow-hidden rounded-full bg-bg-2 ring-1 ring-border-subtle ring-inset">
        <span className={cn('block h-full rounded-full', props.running ? 'bg-success' : 'bg-danger')} style={{ width: `${Math.max(3, share * 100)}%` }} />
      </span>
      <p className="text-xs text-fg-2">Marked not running after {formatAge(WORKER_STALE_AFTER_MS)} without one.</p>
    </div>
  );
}
