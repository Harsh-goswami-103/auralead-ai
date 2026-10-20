/**
 * Google Sheets and Forms setup for one workspace (T28 shell, T34 adds the live parts; PRD "Sheets/
 * Form setup (config, validation, mapping, preview, sync status, Apps Script, simulation)"; 06-design
 * §11.2.2 "Status card, config, mapping, sync log, simulate button (demo)"). Shows the stored
 * GOOGLE_SHEETS status with Test connection and its setup link, the spreadsheet id, the active
 * column mapping with its consent column and notice hash (P1), the DEMO simulation (the same webhook
 * path and ingestion as the Apps Script push), the recent pushes with their per-record counts, and
 * the rows that need attention. The `[ws]` slug is resolved against the employee's assignments;
 * reading needs `leads.read`.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, FileSpreadsheet, FlaskConical, ListChecks, Table2, TriangleAlert } from 'lucide-react';
import { setupHref } from '@/components/integrations/IntegrationCard';
import { NotInAssignment } from '@/components/integrations/NotInAssignment';
import { DeliveryTable, IssueTable } from '@/components/integrations/SourceActivity';
import { SourceSimulator } from '@/components/integrations/SourceSimulator';
import { TestConnectionButton } from '@/components/integrations/TestConnectionButton';
import { LEAD_FIELD_LABELS, simulationGateOf, testConnectionGate } from '@/components/integrations/vocabulary';
import { WorkspaceSectionNav } from '@/components/integrations/WorkspaceSectionNav';
import { EmptyState } from '@/components/patterns/EmptyState';
import { ChipTitle } from '@/components/patterns/IconChip';
import { PageHeader } from '@/components/patterns/PageHeader';
import { SectionCard } from '@/components/patterns/SectionCard';
import { IntegrationStatusBadge } from '@/components/patterns/StatusBadge';
import { buttonVariants } from '@/components/ui/button';
import { getSheetsSetup } from '@/server/services/integrations/source-pages';
import { readOrNull, workspacePage } from '../integrations/_lib/workspace-page';

export const metadata: Metadata = { title: 'Google Sheets' };
export const dynamic = 'force-dynamic';

export default async function SheetsPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const page = await workspacePage(ws);
  const view = await readOrNull(() => getSheetsSetup(page.ctx));
  const name = view?.workspace.name ?? ws;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={name}
        title="Google Sheets"
        description="Google Form responses reach this workspace through an Apps Script that signs every push with the workspace’s secret. A Sheet URL alone grants no access."
      />
      <WorkspaceSectionNav slug={ws} workspaceName={name} />
      {view === null ? (
        <NotInAssignment what="Google Sheets" />
      ) : (
        <>
          <SectionCard
            title={
              <ChipTitle icon={<FileSpreadsheet aria-hidden="true" />} hue="zest">
                Connection
              </ChipTitle>
            }
            actions={
              <Link href={setupHref(ws, 'google-sheets')} className={buttonVariants({ variant: view.integration.status === 'NOT_CONFIGURED' ? 'secondary' : 'ghost', size: 'sm' })}>
                {view.integration.status === 'NOT_CONFIGURED' ? 'Set up Google Sheets' : 'Manage setup'}
                <ArrowRight aria-hidden="true" />
              </Link>
            }
          >
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <dl className="grid gap-3 sm:grid-cols-2">
                <div className="flex flex-col gap-1">
                  <dt className="text-xs text-fg-2">Status</dt>
                  <dd>
                    <IntegrationStatusBadge status={view.integration.status} simulated={view.integration.simulated} showDetail checkedAt={view.integration.lastCheckedAt} timeZone={view.workspace.timezone} />
                  </dd>
                </div>
                <div className="flex flex-col gap-1">
                  <dt className="text-xs text-fg-2">Spreadsheet ID</dt>
                  <dd className="font-mono text-sm break-all text-fg-1">{view.sheetId ?? <span className="font-sans text-fg-2">Not set</span>}</dd>
                </div>
              </dl>
              <TestConnectionButton
                workspaceSlug={ws}
                kindSlug="google-sheets"
                label="Google Sheets"
                gate={testConnectionGate({ mode: view.mode, canManage: view.canTestConnection, status: view.integration.status, label: 'Google Sheets', setupHref: setupHref(ws, 'google-sheets') })}
              />
            </div>
          </SectionCard>

          <SectionCard
            title={
              <ChipTitle icon={<Table2 aria-hidden="true" />} hue="ice">
                Column mapping
              </ChipTitle>
            }
            meta={view.mapping ? `Version ${view.mapping.version}${view.mapping.active ? ', active' : ''}. Header fingerprint ${view.mapping.headerFingerprint.slice(0, 12)}.` : undefined}
          >
            {view.mapping ? (
              <div className="grid gap-4 lg:grid-cols-2">
                <div className="relative overflow-x-auto rounded-lg border border-border-subtle">
                  <table className="w-full text-left text-sm">
                    <caption className="sr-only">Lead fields and the Sheet columns they come from</caption>
                    <thead className="bg-bg-2/60 text-xs text-fg-2">
                      <tr>
                        <th scope="col" className="px-3 py-2 font-medium">
                          Lead field
                        </th>
                        <th scope="col" className="px-3 py-2 font-medium">
                          Sheet column
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {view.mapping.fields.map((f) => (
                        <tr key={f.field} data-mapped-field={f.field} className="border-t border-border-subtle">
                          <th scope="row" className="px-3 py-2 font-normal text-fg-1">
                            {LEAD_FIELD_LABELS[f.field] ?? f.field}
                          </th>
                          <td className="px-3 py-2 text-fg-1">{f.column}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="flex flex-col gap-2 rounded-lg border border-border-subtle bg-bg-2/50 p-3 text-sm">
                  <h3 className="font-medium text-fg-1">WhatsApp consent column</h3>
                  {view.mapping.consent ? (
                    <dl className="flex flex-col gap-1.5">
                      <div>
                        <dt className="text-xs text-fg-2">Column and opt-in answers</dt>
                        <dd className="text-fg-1">
                          {view.mapping.consent.column}: {view.mapping.consent.truthyValues.join(', ')}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-fg-2">Notice shown on the form</dt>
                        <dd className="text-fg-1">“{view.mapping.consent.noticeText}”</dd>
                      </div>
                      {view.mapping.consent.noticeTextHash ? (
                        <div>
                          <dt className="text-xs text-fg-2">Notice fingerprint (sha256)</dt>
                          <dd className="font-mono text-xs break-all text-fg-1">{view.mapping.consent.noticeTextHash}</dd>
                        </div>
                      ) : null}
                    </dl>
                  ) : (
                    <p className="text-fg-2">No consent column is mapped, so rows from this Sheet never record a WhatsApp opt-in.</p>
                  )}
                </div>
              </div>
            ) : (
              <EmptyState
                headingLevel="h3"
                icon={<Table2 aria-hidden="true" className="size-5" />}
                title="No column mapping yet"
                description={
                  view.mode === 'demo'
                    ? 'The first simulated push below installs the demo form’s mapping, including its WhatsApp consent column.'
                    : 'The mapping is made from the Sheet’s header row once Google Sheets is set up.'
                }
              />
            )}
          </SectionCard>

          <SectionCard
            title={
              <ChipTitle icon={<FlaskConical aria-hidden="true" />} hue="volt">
                Simulate form responses
              </ChipTitle>
            }
          >
            <SourceSimulator
              source="sheets"
              workspaceSlug={ws}
              gate={simulationGateOf(view.simulation)}
              pending={view.events.some((e) => e.status === 'RECEIVED')}
              description="Pushes simulated Google Form rows through the same signed-webhook path and ingestion as the Apps Script. Every other row answers Yes to the WhatsApp consent question. Labelled Simulated; Google is never contacted."
            />
          </SectionCard>

          <SectionCard
            title={
              <ChipTitle icon={<ListChecks aria-hidden="true" />} hue="aura">
                Recent pushes
              </ChipTitle>
            }
          >
            {view.events.length === 0 ? (
              <p className="text-sm text-fg-2">No push has arrived yet.</p>
            ) : (
              <DeliveryTable
                caption="Recent Sheets pushes"
                firstColumn="Push"
                timeZone={view.workspace.timezone}
                rows={view.events.map((e) => ({ id: e.id, label: e.id.slice(-8), state: e.status, stateKind: 'delivery', simulated: e.simulated, at: e.receivedAt, counts: e.counts, failureCode: e.failureCode }))}
              />
            )}
          </SectionCard>

          {view.rowIssues.length > 0 ? (
            <SectionCard
              title={
                <ChipTitle icon={<TriangleAlert aria-hidden="true" />} hue="zest">
                  Rows that need attention
                </ChipTitle>
              }
            >
              <IssueTable rows={view.rowIssues} timeZone={view.workspace.timezone} />
            </SectionCard>
          ) : null}
        </>
      )}
    </div>
  );
}
