/**
 * Google Maps extension hub for one workspace (T28 shell, T36 adds token creation, revocation and
 * the live receiver; PRD "Extension hub (scoped keys, revocation, webhook config, batch status,
 * errors, simulation)"; 06-design §11.2.2 "Token list (masked, scope, created, last used); batches:
 * status, counts, per-row failures; example payload, simulate batch"). Tokens are listed by prefix
 * and state only (the secret is never stored, its hash never leaves the server); batches show the
 * worker's per-record counts; rows that need attention show their reason; the documented batch body
 * is shown as an example; DEMO simulates a batch through the same ingestion. The `[ws]` slug is
 * resolved against the employee's assignments; reading needs `leads.read`.
 */
import type { Metadata } from 'next';
import { Boxes, Braces, CircleCheck, CircleSlash, Clock, FlaskConical, KeyRound, TriangleAlert } from 'lucide-react';
import { NotInAssignment } from '@/components/integrations/NotInAssignment';
import { DeliveryTable, IssueTable } from '@/components/integrations/SourceActivity';
import { SourceSimulator } from '@/components/integrations/SourceSimulator';
import { StatusChip } from '@/components/integrations/StatusChip';
import { simulationGateOf } from '@/components/integrations/vocabulary';
import { WorkspaceSectionNav } from '@/components/integrations/WorkspaceSectionNav';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ChipTitle } from '@/components/patterns/IconChip';
import { PageHeader } from '@/components/patterns/PageHeader';
import { SectionCard } from '@/components/patterns/SectionCard';
import { EXTENSION_MAX_RECORDS } from '@/lib/schemas/webhooks';
import { formatDateTime } from '@/lib/format/date';
import { getExtensionHub } from '@/server/services/integrations/source-pages';
import { readOrNull, workspacePage } from '../integrations/_lib/workspace-page';

export const metadata: Metadata = { title: 'Maps extension' };
export const dynamic = 'force-dynamic';

const TOKEN_STATE = {
  ACTIVE: { label: 'Active', tone: 'success', icon: CircleCheck },
  REVOKED: { label: 'Revoked', tone: 'neutral', icon: CircleSlash },
  EXPIRED: { label: 'Expired', tone: 'warning', icon: Clock },
} as const;

export default async function ExtensionPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const page = await workspacePage(ws);
  const view = await readOrNull(() => getExtensionHub(page.ctx));
  const name = view?.workspace.name ?? ws;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={name}
        title="Maps extension"
        description="Businesses scraped with the Google Maps extension arrive here in batches, each signed with an ingestion-only token of this workspace. The website configures and monitors the extension; it never controls the browser."
      />
      <WorkspaceSectionNav slug={ws} workspaceName={name} />
      {view === null ? (
        <NotInAssignment what="The extension hub" />
      ) : (
        <>
          <SectionCard
            title={
              <ChipTitle icon={<KeyRound aria-hidden="true" />} hue="volt">
                Ingestion tokens
              </ChipTitle>
            }
            meta="A token is shown once when it is created; afterwards only its prefix is known. Each one can only add leads to this workspace."
          >
            {view.tokens.length === 0 ? (
              <EmptyState
                headingLevel="h3"
                icon={<KeyRound aria-hidden="true" className="size-5" />}
                title="No ingestion tokens"
                description="No token has been issued for this workspace, so the extension cannot send batches to it."
              />
            ) : (
              <div className="relative overflow-x-auto rounded-lg border border-border-subtle">
                <table className="w-full min-w-[46rem] text-left text-sm">
                  <caption className="sr-only">Ingestion tokens</caption>
                  <thead className="bg-bg-2/60 text-xs text-fg-2">
                    <tr>
                      <th scope="col" className="px-3 py-2 font-medium">
                        Token
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        State
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        Scope
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        Created
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        Last used
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.tokens.map((t) => (
                      <tr key={t.id} data-token={t.prefix} className="border-t border-border-subtle">
                        <th scope="row" className="px-3 py-2 font-normal">
                          <span className="block text-fg-1">{t.name}</span>
                          <span className="font-mono text-xs text-fg-2">{t.prefix}_••••</span>
                        </th>
                        <td className="px-3 py-2">
                          <StatusChip entry={TOKEN_STATE[t.state]} />
                        </td>
                        <td className="px-3 py-2 text-xs text-fg-1">
                          {t.scopes.join(', ')}
                          {t.allowedExtensionId ? <span className="block font-mono text-fg-2">Extension {t.allowedExtensionId}</span> : null}
                        </td>
                        <td className="px-3 py-2 text-xs whitespace-nowrap text-fg-2">{formatDateTime(t.createdAt, view.workspace.timezone)}</td>
                        <td className="px-3 py-2 text-xs whitespace-nowrap text-fg-2">{t.lastUsedAt ? formatDateTime(t.lastUsedAt, view.workspace.timezone) : 'Never'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>

          <SectionCard
            title={
              <ChipTitle icon={<FlaskConical aria-hidden="true" />} hue="zest">
                Simulate a batch
              </ChipTitle>
            }
          >
            <SourceSimulator
              source="gmaps"
              workspaceSlug={ws}
              gate={simulationGateOf(view.simulation)}
              pending={view.deliveriesQueued > 0}
              description="Sends a simulated extension batch of fictitious businesses through the same ingestion as a token-signed batch. Maps leads never carry WhatsApp consent. Labelled Simulated."
            />
          </SectionCard>

          <SectionCard
            title={
              <ChipTitle icon={<Boxes aria-hidden="true" />} hue="aura">
                Batches
              </ChipTitle>
            }
          >
            {view.batches.length === 0 ? (
              <p className="text-sm text-fg-2">No batch has arrived yet.</p>
            ) : (
              <DeliveryTable
                caption="Recent extension batches"
                firstColumn="Batch"
                timeZone={view.workspace.timezone}
                rows={view.batches.map((b) => ({ id: b.id, label: b.externalBatchId, state: b.status, stateKind: 'batch', simulated: b.simulated, at: b.createdAt, counts: b.counts }))}
              />
            )}
          </SectionCard>

          {view.rowIssues.length > 0 ? (
            <SectionCard
              title={
                <ChipTitle icon={<TriangleAlert aria-hidden="true" />} hue="zest">
                  Records that need attention
                </ChipTitle>
              }
            >
              <IssueTable rows={view.rowIssues} timeZone={view.workspace.timezone} />
            </SectionCard>
          ) : null}

          <SectionCard
            title={
              <ChipTitle icon={<Braces aria-hidden="true" />} hue="ice">
                Batch format
              </ChipTitle>
            }
            meta={`Version 1, at most ${EXTENSION_MAX_RECORDS} records per batch. A repeated batch id returns the stored result instead of creating leads again.`}
          >
            <pre data-example-payload className="max-h-80 overflow-auto rounded-lg border border-border-subtle bg-bg-2 p-3 font-mono text-xs text-fg-1">
              {JSON.stringify(view.examplePayload, null, 2)}
            </pre>
          </SectionCard>
        </>
      )}
    </div>
  );
}
