/**
 * Operator panel home (T09, M1; assignment overview T28): the workspaces this employee is actively
 * assigned to, with the capabilities and discount cap each assignment grants and, per workspace
 * (06-design §11.2.2 "assigned workspaces with counts needing action, cross-workspace approval
 * count, integration health summary per workspace"), the stored counts read through that
 * workspace's own tenant-scoped context: approvals waiting, leads in the last 7 days, integration
 * health and the active pipeline version, plus links to every workspace section. Read through the
 * server context; the browser supplies nothing but the session cookie.
 *
 * Look (design spec §6): PageHeader in the operator hue; one spotlight card per assignment with the
 * panel hairline, a workspace tile, the real facts of the assignment (discount cap, number of
 * capabilities), the capabilities in words grouped under named areas (each area has an icon chip
 * in its category hue; the area name carries the meaning, the chips stay neutral), and links to
 * the workspace's lead console and approval queue. Cards rise in once.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowRight, BadgePercent, Building2, ClipboardCheck, FileText, KeyRound, MessagesSquare, Plug, Settings2, ShieldAlert, Users, Workflow, type LucideIcon } from 'lucide-react';
import { WORKSPACE_SECTIONS, workspaceSectionHref } from '@/components/integrations/sections';
import { EmptyState } from '@/components/patterns/EmptyState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { StatTile } from '@/components/patterns/StatTile';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Stagger, StaggerItem } from '@/components/visual/Reveal';
import { SpotlightCard } from '@/components/visual/SpotlightCard';
import { formatDate } from '@/lib/format/date';
import { NotFoundError } from '@/lib/errors';
import { getPageContext } from '@/server/auth/page-context';
import { getWorkspaceOverview, type WorkspaceOverview } from '@/server/services/shell/employee-overview';
import { loadEmployeeHome } from '@/server/services/shell/panel-home';

export const metadata: Metadata = { title: 'Assignments' };
export const dynamic = 'force-dynamic';

/** Capabilities in words, in the order of the closed list (src/lib/domain/enums CAPABILITIES). */
const CAPABILITY_LABELS: Readonly<Record<string, string>> = {
  'leads.read': 'Read leads',
  'leads.write': 'Add and edit leads',
  'leads.export': 'Export leads',
  'drafts.generate': 'Generate drafts',
  'quotes.edit': 'Edit quotations',
  'pricing.override': 'Override prices',
  'approvals.decide': 'Approve and reject',
  'dispatch.send': 'Send approved messages',
  'automation.manage': 'Manage automation',
  'integrations.manage': 'Manage integrations',
  'campaigns.control': 'Control campaigns',
  'extension.manage': 'Manage the Maps extension',
  'sheets.manage': 'Manage Google Sheets',
  'scoring.manage': 'Manage scoring',
  'pipeline.manage': 'Manage the pipeline',
  'finder.run': 'Run the lead finder',
  'leads.import': 'Import lead files',
  'consent.import': 'Import consent from files',
  'templates.manage': 'Manage WhatsApp templates',
  'leads.handoff': 'Hand leads over to the client',
};

/**
 * Capability areas, in a fixed order. Each area has an icon chip in a category hue (chart palette
 * order); the area name is always written, so the hue is never the only cue.
 */
const CAPABILITY_AREAS: ReadonlyArray<{ key: string; label: string; icon: LucideIcon; chip: string; prefixes: readonly string[] }> = [
  { key: 'leads', label: 'Leads', icon: Users, chip: 'bg-chart-1/16 text-chart-1-hi ring-chart-1-hi/30', prefixes: ['leads.', 'finder.', 'consent.'] },
  { key: 'quotes', label: 'Quotations', icon: FileText, chip: 'bg-chart-2/18 text-chart-2-hi ring-chart-2-hi/30', prefixes: ['quotes.', 'pricing.', 'approvals.'] },
  { key: 'messages', label: 'Messages', icon: MessagesSquare, chip: 'bg-chart-3/16 text-chart-3-hi ring-chart-3-hi/30', prefixes: ['drafts.', 'dispatch.', 'campaigns.', 'templates.'] },
  { key: 'sources', label: 'Sources', icon: Plug, chip: 'bg-chart-4/18 text-chart-4-hi ring-chart-4-hi/30', prefixes: ['integrations.', 'sheets.', 'extension.'] },
  { key: 'setup', label: 'Setup', icon: Settings2, chip: 'bg-bg-3 text-fg-2 ring-border-strong', prefixes: [] },
];

/** The granted capabilities grouped by area (areas with none are left out; unknown keys land in Setup). */
function groupCapabilities(capabilities: readonly string[]) {
  const areaOf = (c: string) => CAPABILITY_AREAS.find((a) => a.prefixes.some((p) => c.startsWith(p)))?.key ?? 'setup';
  return CAPABILITY_AREAS.map((area) => ({ ...area, capabilities: capabilities.filter((c) => areaOf(c) === area.key) })).filter((g) => g.capabilities.length > 0);
}

/** One workspace's counts through its own `[ws]`-resolved context; null if the assignment just ended. */
async function overviewFor(slug: string): Promise<WorkspaceOverview | null> {
  try {
    const scoped = await getPageContext({ workspaceSlug: slug });
    return scoped ? await getWorkspaceOverview(scoped.ctx) : null;
  } catch (error) {
    if (error instanceof NotFoundError) return null;
    throw error;
  }
}

function integrationSummary(o: WorkspaceOverview, mode: 'demo' | 'live'): string {
  const i = o.integrations;
  const parts = [mode === 'demo' ? `${i.simulated} simulated` : `${i.connected} connected`];
  if (i.attention > 0) parts.push(`${i.attention} need attention`);
  parts.push(`${i.notConfigured} not configured`);
  return parts.join(' · ');
}

const SECONDARY_SECTIONS = WORKSPACE_SECTIONS.filter((s) => s.segment !== 'leads' && s.segment !== 'approvals');

export default async function EmployeeHomePage() {
  const page = await getPageContext();
  if (!page) redirect('/login');
  const home = await loadEmployeeHome(page.ctx);
  const overviews = new Map(await Promise.all(home.assignments.map(async (a) => [a.slug, await overviewFor(a.slug)] as const)));
  const waitingTotal = [...overviews.values()].reduce((n, o) => n + (o?.pendingApprovals ?? 0), 0);
  const attentionTotal = [...overviews.values()].reduce((n, o) => n + (o?.integrations.attention ?? 0), 0);
  const newLeadsTotal = [...overviews.values()].reduce((n, o) => n + (o?.newLeads7d ?? 0), 0);
  const readable = [...overviews.values()].filter((o) => o !== null && o.pendingApprovals !== null).length;
  const count = home.assignments.length;
  const inactive = home.inactiveCount;
  // One primary link on the page: the current workspace's console, or the first one's.
  const primarySlug = home.assignments.find((a) => a.current)?.slug ?? home.assignments[0]?.slug;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Operator panel"
        title="Assignments"
        description={
          <>
            {page.session.user.name}, you are assigned to {count} {count === 1 ? 'workspace' : 'workspaces'}.
            {inactive > 0 ? ` ${inactive} earlier ${inactive === 1 ? 'assignment is' : 'assignments are'} inactive.` : ''}
          </>
        }
        actions={
          count > 0 ? (
            <Link href="/dashboard/employee/approvals" className={buttonVariants({ variant: 'secondary' })}>
              <ClipboardCheck aria-hidden="true" />
              All approvals
            </Link>
          ) : null
        }
      />

      {count > 0 ? (
        <Stagger className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <StaggerItem>
            <StatTile label="Approvals waiting" value={waitingTotal} icon={<ClipboardCheck />} hint={`Across ${readable} ${readable === 1 ? 'workspace' : 'workspaces'} you can read`} href="/dashboard/employee/approvals" />
          </StaggerItem>
          <StaggerItem>
            <StatTile label="New leads, last 7 days" value={newLeadsTotal} icon={<Users />} tone="neutral" hint={`In ${readable} ${readable === 1 ? 'workspace' : 'workspaces'} you can read`} />
          </StaggerItem>
          <StaggerItem className="col-span-2 sm:col-span-1">
            <StatTile label="Integrations needing attention" value={attentionTotal} icon={<ShieldAlert />} tone={attentionTotal > 0 ? 'warning' : 'neutral'} hint="Verification required, limited, failed or revoked" />
          </StaggerItem>
        </Stagger>
      ) : null}

      {count === 0 ? (
        <EmptyState
          icon={<Building2 aria-hidden="true" className="size-5" />}
          title="No workspace assigned"
          description="A super admin assigns workspaces and capabilities to employees. Active assignments appear here, and in the workspace switcher, as soon as they are granted."
        />
      ) : (
        <Stagger as="ul" className="grid gap-4 lg:grid-cols-2">
          {home.assignments.map((a) => (
            <StaggerItem as="li" key={a.slug} className="flex min-w-0">
              <SpotlightCard
                className={cn(
                  'relative flex flex-1 flex-col gap-5 overflow-hidden p-5',
                  'transition-[translate,border-color] duration-fast ease-enter hover:border-panel/45 motion-safe:hover:-translate-y-0.5',
                )}
              >
                <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-0.5 [background-image:var(--panel-grad)]" />
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(120%_80%_at_100%_0%,color-mix(in_oklab,var(--panel-hue)_9%,transparent),transparent_60%)]"
                />
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <span aria-hidden="true" className="flex size-11 shrink-0 items-center justify-center rounded-xl border border-panel/30 bg-panel/12 text-panel">
                      <Building2 className="size-5" />
                    </span>
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <h2 className="font-display text-lg font-semibold text-fg-1">{a.name}</h2>
                      <p className="text-sm text-fg-2">
                        {a.planLabel} plan · assigned {formatDate(a.since)}
                      </p>
                    </div>
                  </div>
                  {a.current ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full border border-panel/40 bg-panel/10 px-2.5 py-0.5 text-xs font-medium text-fg-1">
                      <span aria-hidden="true" className="size-1.5 rounded-full bg-panel" />
                      Current workspace
                    </span>
                  ) : null}
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="flex items-center gap-3 rounded-lg border border-border-subtle bg-bg-2/50 px-3 py-2.5">
                    <BadgePercent aria-hidden="true" className="hidden size-4 shrink-0 text-fg-2 sm:block" />
                    <dl className="flex min-w-0 flex-col">
                      <dt className="text-xs text-fg-2">Your discount limit</dt>
                      <dd className="tabular text-sm font-medium text-fg-1">{a.maxDiscountBps === null ? 'Workspace limit' : `up to ${(a.maxDiscountBps / 100).toLocaleString('en-IN')}%`}</dd>
                    </dl>
                  </div>
                  <div className="flex items-center gap-3 rounded-lg border border-border-subtle bg-bg-2/50 px-3 py-2.5">
                    <KeyRound aria-hidden="true" className="hidden size-4 shrink-0 text-fg-2 sm:block" />
                    <dl className="flex min-w-0 flex-col">
                      <dt className="text-xs text-fg-2">Capabilities granted</dt>
                      <dd className="tabular text-sm font-medium text-fg-1">{a.capabilities.length}</dd>
                    </dl>
                  </div>
                </div>

                <WorkspaceFacts overview={overviews.get(a.slug) ?? null} mode={page.ctx.mode} slug={a.slug} />

                <div className="flex flex-col gap-2.5">
                  <h3 className="text-xs font-medium tracking-[0.08em] text-fg-2 uppercase">What you can do here</h3>
                  {a.capabilities.length === 0 ? (
                    <p className="text-sm text-fg-2">None granted.</p>
                  ) : (
                    <dl aria-label={`Capabilities in ${a.name}`} className="flex flex-col gap-2.5">
                      {groupCapabilities(a.capabilities).map((g) => {
                        const AreaIcon = g.icon;
                        return (
                          <div key={g.key} className="grid gap-1.5 sm:grid-cols-[7.5rem_minmax(0,1fr)] sm:gap-3">
                            <dt className="flex items-center gap-2 text-xs font-medium text-fg-1 sm:h-6">
                              <span aria-hidden="true" className={cn('flex size-6 shrink-0 items-center justify-center rounded-md ring-1 ring-inset', g.chip)}>
                                <AreaIcon className="size-3.5" />
                              </span>
                              {g.label}
                            </dt>
                            <dd className="min-w-0">
                              <ul className="flex flex-wrap gap-1.5">
                                {g.capabilities.map((c) => (
                                  <li key={c} className="inline-flex h-6 items-center rounded-full border border-border-strong bg-bg-2 px-2.5 text-xs text-fg-1">
                                    {CAPABILITY_LABELS[c] ?? c}
                                  </li>
                                ))}
                              </ul>
                            </dd>
                          </div>
                        );
                      })}
                    </dl>
                  )}
                </div>

                <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-border-subtle pt-4">
                  <Link
                    href={`/dashboard/employee/${encodeURIComponent(a.slug)}/leads`}
                    className={cn(
                      buttonVariants({
                        variant: a.slug === primarySlug ? 'default' : 'secondary',
                        size: 'sm',
                      }),
                      'group/link',
                    )}
                  >
                    <Users aria-hidden="true" />
                    Open lead console
                    <span className="sr-only"> for {a.name}</span>
                    <ArrowRight aria-hidden="true" className="transition-transform duration-fast motion-safe:group-hover/link:translate-x-0.5" />
                  </Link>
                  <Link href={`/dashboard/employee/${encodeURIComponent(a.slug)}/approvals`} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
                    <ClipboardCheck aria-hidden="true" />
                    Approval queue<span className="sr-only"> for {a.name}</span>
                  </Link>
                </div>
                <nav aria-label={`More sections of ${a.name}`} className="-mt-2 flex flex-wrap gap-1">
                  {SECONDARY_SECTIONS.map((section) => {
                    const SectionIcon = section.icon;
                    return (
                      <Link key={section.segment} href={workspaceSectionHref(a.slug, section.segment)} className={buttonVariants({ variant: 'ghost', size: 'xs', className: 'text-fg-2' })}>
                        <SectionIcon aria-hidden="true" />
                        {section.label}
                        <span className="sr-only"> for {a.name}</span>
                      </Link>
                    );
                  })}
                </nav>
              </SpotlightCard>
            </StaggerItem>
          ))}
        </Stagger>
      )}
    </div>
  );
}

function WorkspaceFacts({ overview, mode, slug }: { overview: WorkspaceOverview | null; mode: 'demo' | 'live'; slug: string }) {
  if (!overview) return null;
  return (
    <dl className="grid gap-2 sm:grid-cols-2">
      <div className="flex flex-col rounded-lg border border-border-subtle bg-bg-2/50 px-3 py-2">
        <dt className="text-xs text-fg-2">Approvals waiting</dt>
        <dd className="tabular text-sm font-medium text-fg-1">{overview.pendingApprovals === null ? 'Not readable with your assignment' : overview.pendingApprovals}</dd>
      </div>
      <div className="flex flex-col rounded-lg border border-border-subtle bg-bg-2/50 px-3 py-2">
        <dt className="text-xs text-fg-2">New leads, last 7 days</dt>
        <dd className="tabular text-sm font-medium text-fg-1">{overview.newLeads7d === null ? 'Not readable with your assignment' : overview.newLeads7d}</dd>
      </div>
      <div className="flex flex-col rounded-lg border border-border-subtle bg-bg-2/50 px-3 py-2">
        <dt className="flex items-center gap-1.5 text-xs text-fg-2">
          <Plug aria-hidden="true" className="size-3.5" />
          Integrations
        </dt>
        <dd className="text-sm text-fg-1">
          <Link href={workspaceSectionHref(slug, 'integrations')} className="underline-offset-4 hover:underline">
            {integrationSummary(overview, mode)}
          </Link>
        </dd>
      </div>
      <div className="flex flex-col rounded-lg border border-border-subtle bg-bg-2/50 px-3 py-2">
        <dt className="flex items-center gap-1.5 text-xs text-fg-2">
          <Workflow aria-hidden="true" className="size-3.5" />
          Pipeline
        </dt>
        <dd className="text-sm text-fg-1">
          {overview.pipeline ? `v${overview.pipeline.version}, ${overview.pipeline.approvalMode === 'HUMAN' ? 'human approval' : 'policy approval'}` : 'None active'}
        </dd>
      </div>
    </dl>
  );
}
