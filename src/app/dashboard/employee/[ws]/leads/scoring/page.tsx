/**
 * Operator console scoring tab (T26, P9, R14): the workspace's scoring configuration. An operator
 * with scoring.manage edits the weights and settings, previews the result on the 20 newest leads
 * and activates it as a new version (the worker then rescores every lead); everyone else with
 * leads.read sees the configuration read-only with the reason (plan §12). The version history is
 * listed under it. The `[ws]` slug is resolved against the employee's active assignments (404
 * otherwise).
 */
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { Gauge, History, SlidersHorizontal, Users } from 'lucide-react';
import { LeadsTabs } from '@/components/leads/LeadsTabs';
import { ScoringCaption, ScoringHistory, ScoringWeights } from '@/components/leads/ScoringConfigView';
import { ScoringEditor } from '@/components/leads/ScoringEditor';
import { ChipTitle } from '@/components/patterns/IconChip';
import { EmptyState } from '@/components/patterns/EmptyState';
import { GatedAction } from '@/components/patterns/GatedAction';
import { PageHeader } from '@/components/patterns/PageHeader';
import { SectionCard } from '@/components/patterns/SectionCard';
import { NotFoundError, PermissionDeniedError } from '@/lib/errors';
import { getPageContext } from '@/server/auth/page-context';
import { loadScoringOverview } from '@/server/services/scoring/manage';
import { scoringVersionDtos } from '../../../../user/leads/scoring/scoring-dto';

export const metadata: Metadata = { title: 'Lead scoring' };
export const dynamic = 'force-dynamic';

export default async function EmployeeScoringPage({ params }: { params: Promise<{ ws: string }> }) {
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

  let overview;
  try {
    overview = await loadScoringOverview(page.ctx);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    if (error instanceof PermissionDeniedError) {
      return (
        <EmptyState
          icon={<Users aria-hidden="true" className="size-5" />}
          title="Leads are not part of your assignment"
          description="Your assignment in this workspace does not include leads.read. A super admin can grant it from the people page."
        />
      );
    }
    throw error;
  }
  const { active, history } = scoringVersionDtos(overview);
  const base = `/dashboard/employee/${overview.workspace.slug}/leads`;
  const tz = overview.workspace.timezone;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={overview.workspace.name}
        title="Lead scoring"
        description="Weigh what makes a lead a good fit for this business. Every change is a new version, previewed first; activating it rescores every lead."
      />
      <LeadsTabs current="scoring" leadsHref={base} scoringHref={`${base}/scoring`} />

      {overview.canManage ? (
        <SectionCard
          title={<ChipTitle icon={<SlidersHorizontal aria-hidden="true" />} hue="volt">Edit the scoring configuration</ChipTitle>}
          meta={active ? `Starts from the active version ${active.version}.` : 'No version is active yet; leads are not scored until one is.'}
        >
          <ScoringEditor workspaceSlug={overview.workspace.slug} workspaceName={overview.workspace.name} active={active} history={history} />
          <ScoringCaption />
        </SectionCard>
      ) : (
        <SectionCard
          title={<ChipTitle icon={<Gauge aria-hidden="true" />} hue="volt">{active ? `Active configuration: version ${active.version}` : 'No active configuration'}</ChipTitle>}
          actions={<GatedAction label="Change weights" size="sm" gate={{ category: 'permission', reason: overview.readOnlyReason ?? 'Your assignment does not include scoring.manage.' }} />}
        >
          {active?.config ? <ScoringWeights config={active.config} /> : <p className="text-sm text-fg-2">Leads are not scored until an operator activates a scoring configuration.</p>}
          <ScoringCaption />
        </SectionCard>
      )}

      {history.length > 0 ? (
        <SectionCard title={<ChipTitle icon={<History aria-hidden="true" />}>Versions</ChipTitle>} meta="Every activation is a new version; earlier versions are kept as they were.">
          <ScoringHistory history={history} timeZone={tz} />
        </SectionCard>
      ) : null}
    </div>
  );
}
