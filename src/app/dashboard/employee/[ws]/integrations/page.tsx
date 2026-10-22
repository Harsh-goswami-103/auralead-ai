/**
 * Integration center for one workspace (T28; PRD "Integration center (masked creds, connection
 * tests, real status, template config, quality/limits, internal caps, AI/email setup)"; 06-design
 * §11.2.2 "grid of IntegrationStatusCard"). The `[ws]` slug is resolved against the employee's
 * active assignments (404 otherwise); reading needs `leads.read`, testing and setup changes
 * `integrations.manage`. Every status is the stored one (Not configured when nothing is stored);
 * DEMO says what runs instead of each provider, and its tests answer "Simulated, no provider
 * contacted". Facts at the top are counts of the cards on screen.
 *
 * Look (design spec §6): PageHeader in the operator hue, the workspace section tabs, three fact
 * tiles, then one section per group (messaging, lead sources, AI drafting) with a two-column card
 * grid, and the Maps extension hub link.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, CircleCheck, CircleDashed, FlaskConical, MapPin, ShieldAlert } from 'lucide-react';
import { IntegrationCard } from '@/components/integrations/IntegrationCard';
import { NotInAssignment } from '@/components/integrations/NotInAssignment';
import { WorkspaceSectionNav } from '@/components/integrations/WorkspaceSectionNav';
import { ChipTitle } from '@/components/patterns/IconChip';
import { PageHeader } from '@/components/patterns/PageHeader';
import { SectionCard } from '@/components/patterns/SectionCard';
import { StatTile } from '@/components/patterns/StatTile';
import { buttonVariants } from '@/components/ui/button';
import { Stagger, StaggerItem } from '@/components/visual/Reveal';
import { INTEGRATION_GROUP_LABELS, type IntegrationGroup } from '@/lib/domain/integrations';
import { getIntegrationCenter } from '@/server/services/integrations/center';
import { readOrNull, workspacePage } from './_lib/workspace-page';

export const metadata: Metadata = { title: 'Integrations' };
export const dynamic = 'force-dynamic';

const GROUPS: readonly IntegrationGroup[] = ['messaging', 'sources', 'ai'];
const ATTENTION = new Set(['CONFIGURED_UNVERIFIED', 'VERIFYING', 'DEGRADED', 'ERROR', 'REVOKED']);

export default async function IntegrationsPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const page = await workspacePage(ws);
  const center = await readOrNull(() => getIntegrationCenter(page.ctx));
  const name = center?.workspace.name ?? ws;
  const attention = center?.cards.filter((c) => ATTENTION.has(c.status)).length ?? 0;

  const description =
    page.ctx.mode === 'demo'
      ? 'DEMO mode: every channel runs on simulators and demo transports. No provider is contacted, and every result is labelled Simulated.'
      : 'Each card shows the status stored for this workspace. Nothing shows Connected until the provider has answered a connection test.';

  return (
    <div className="flex flex-col gap-6">
      <PageHeader eyebrow={name} title="Integrations" description={description} />
      <WorkspaceSectionNav slug={ws} workspaceName={name} />
      {center === null ? (
        <NotInAssignment what="The Integration center" />
      ) : (
        <>
          <Stagger className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <StaggerItem>
              <StatTile
                label={center.mode === 'demo' ? 'Demo simulations' : 'Connected'}
                value={center.cards.filter((c) => (center.mode === 'demo' ? c.status === 'SIMULATED' : c.status === 'CONNECTED')).length}
                icon={center.mode === 'demo' ? <FlaskConical /> : <CircleCheck />}
                hint={`Of ${center.cards.length} integrations`}
              />
            </StaggerItem>
            <StaggerItem>
              <StatTile
                label="Need attention"
                value={attention}
                icon={<ShieldAlert />}
                tone={attention > 0 ? 'warning' : 'neutral'}
                hint="Verification required, limited, failed or revoked"
              />
            </StaggerItem>
            <StaggerItem className="col-span-2 sm:col-span-1">
              <StatTile label="Not configured" value={center.cards.filter((c) => c.status === 'NOT_CONFIGURED').length} icon={<CircleDashed />} tone="neutral" hint="Open a card’s setup to see what it needs" />
            </StaggerItem>
          </Stagger>

          {!center.canManage ? (
            <p className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-fg-1">
              <ShieldAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
              Read-only: your assignment here does not include “Manage integrations”, so connection tests and template syncs are not available to you.
            </p>
          ) : null}

          {GROUPS.map((group) => (
            <SectionCard key={group} title={INTEGRATION_GROUP_LABELS[group]} id={`group-${group}`}>
              <ul className="grid gap-4 lg:grid-cols-2">
                {center.cards
                  .filter((c) => c.group === group)
                  .map((card) => (
                    <li key={card.kind} className="flex min-w-0">
                      <div className="flex min-w-0 flex-1 flex-col">
                        <IntegrationCard card={card} workspaceSlug={ws} mode={center.mode} canManage={center.canManage} timeZone={center.workspace.timezone} />
                      </div>
                    </li>
                  ))}
                {group === 'sources' ? (
                  <li className="flex min-w-0">
                    <div className="flex min-w-0 flex-1 flex-col justify-between gap-4 rounded-xl border border-dashed border-border-strong bg-bg-1/60 p-4 sm:p-5">
                      <h3 className="font-display text-md font-semibold text-fg-1">
                        <ChipTitle icon={<MapPin aria-hidden="true" />} hue="zest">
                          Google Maps extension
                        </ChipTitle>
                      </h3>
                      <p className="text-sm text-fg-2">Businesses the extension collects arrive in batches signed with a workspace ingestion token. Tokens, batches and per-row results are on the extension hub.</p>
                      <Link href={`/dashboard/employee/${encodeURIComponent(ws)}/extension`} className={buttonVariants({ variant: 'ghost', size: 'sm', className: 'w-fit' })}>
                        Open extension hub
                        <ArrowRight aria-hidden="true" />
                      </Link>
                    </div>
                  </li>
                ) : null}
              </ul>
            </SectionCard>
          ))}
        </>
      )}
    </div>
  );
}
