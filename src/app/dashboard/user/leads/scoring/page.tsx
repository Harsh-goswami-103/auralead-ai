/**
 * Client panel scoring tab (T26, P9: "Workspace owner has read-only access"): the active scoring
 * configuration (weights, targets, website preference, review target, note) and every version, as
 * the operator console's editor saved them. Read-only: changing it is an operator's action with
 * scoring.manage, which the page says next to a focusable gated control (plan §12).
 */
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { Gauge, History, Users } from 'lucide-react';
import { LeadsTabs } from '@/components/leads/LeadsTabs';
import { ScoringCaption, ScoringHistory, ScoringWeights } from '@/components/leads/ScoringConfigView';
import { ChipTitle } from '@/components/patterns/IconChip';
import { EmptyState } from '@/components/patterns/EmptyState';
import { GatedAction } from '@/components/patterns/GatedAction';
import { PageHeader } from '@/components/patterns/PageHeader';
import { SectionCard } from '@/components/patterns/SectionCard';
import { NotFoundError, PermissionDeniedError } from '@/lib/errors';
import { getPageContext } from '@/server/auth/page-context';
import { loadScoringOverview } from '@/server/services/scoring/manage';
import { scoringVersionDtos } from './scoring-dto';

export const metadata: Metadata = { title: 'Lead scoring' };
export const dynamic = 'force-dynamic';

export default async function UserScoringPage() {
  const page = await getPageContext();
  if (!page) redirect('/login');
  let overview;
  try {
    overview = await loadScoringOverview(page.ctx);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    if (error instanceof PermissionDeniedError) {
      return (
        <EmptyState
          icon={<Users aria-hidden="true" className="size-5" />}
          title="Leads are not part of your access"
          description="Your membership in this workspace does not include leads.read. Ask the workspace owner."
        />
      );
    }
    throw error;
  }
  const { active, history } = scoringVersionDtos(overview);
  const tz = overview.workspace.timezone;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={overview.workspace.name}
        title="Lead scoring"
        description="How each lead's fit score is worked out. The score helps you sort leads; it is not purchase intent or consent."
      />
      <LeadsTabs current="scoring" leadsHref="/dashboard/user/leads" scoringHref="/dashboard/user/leads/scoring" />
      <SectionCard
        title={<ChipTitle icon={<Gauge aria-hidden="true" />} hue="volt">{active ? `Active configuration: version ${active.version}` : 'No active configuration'}</ChipTitle>}
        actions={<GatedAction label="Change weights" size="sm" gate={{ category: 'permission', reason: overview.readOnlyReason ?? 'Operators with scoring.manage change the scoring configuration.' }} />}
      >
        {active?.config ? (
          <ScoringWeights config={active.config} />
        ) : (
          <p className="text-sm text-fg-2">Leads are not scored until an operator activates a scoring configuration.</p>
        )}
        <ScoringCaption />
      </SectionCard>
      {history.length > 0 ? (
        <SectionCard title={<ChipTitle icon={<History aria-hidden="true" />}>Versions</ChipTitle>} meta="Every activation is a new version; earlier versions are kept as they were.">
          <ScoringHistory history={history} timeZone={tz} />
        </SectionCard>
      ) : null}
    </div>
  );
}
