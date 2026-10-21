/**
 * Google Sheets and Forms setup for one workspace (T28 shell, T34 adds the live parts; PRD "Sheets/
 * Form setup (config, validation, mapping, preview, sync status, Apps Script, simulation)"; 06-design
 * §11.2.2 "Status card, config, mapping, sync log, simulate button (demo)"). Shows the stored
 * GOOGLE_SHEETS status with Test connection and its setup link, the spreadsheet id, the active
 * column mapping with its consent column and notice hash (P1), the DEMO simulation (the same webhook
 * path and ingestion as the Apps Script push), the recent pushes with their per-record counts, and
 * the rows that need attention. The `[ws]` slug is resolved against the employee's assignments;
 * reading needs `leads.read`.
 *
 * T34 live parts (`services/sheets/view.ts`): the service account to share the Sheet with (email,
 * masked key file, share guidance), the mapping editor (load row 1, map fields and the consent
 * column, dry-run preview, confirm), the Apps Script (signing secret shown once, the generated
 * script with copy and setup steps) and the sync status with Sync now and drift blocking. They act
 * only in LIVE with `sheets.manage`; DEMO shows them gated on mode and keeps the simulator.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, Code, FileSpreadsheet, FlaskConical, ListChecks, RefreshCw, Table2, TriangleAlert, UserRoundCheck } from 'lucide-react';
import { CopyButton } from '@/components/admin/CopyButton';
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
import type { Gate } from '@/components/patterns/GatedAction';
import { buttonVariants } from '@/components/ui/button';
import { getRuntime } from '@/server/boot';
import { getSheetsSetup } from '@/server/services/integrations/source-pages';
import { getSheetsLiveView, type SheetsLiveView } from '@/server/services/sheets/view';
import { readOrNull, workspacePage } from '../integrations/_lib/workspace-page';
import { AppsScriptPanel } from './AppsScriptPanel';
import { SheetsMappingEditor } from './SheetsMappingEditor';
import { SheetsSyncPanel } from './SheetsSyncPanel';

const NOT_READY = new Set(['NOT_CONFIGURED', 'REVOKED', 'SIMULATED']);

/** The gate of the live Sheets actions: mode, then permission, then configuration (plan §12). */
function liveGate(live: SheetsLiveView, setup: string): Gate | null {
  if (live.mode === 'demo') return { category: 'mode', reason: 'DEMO never contacts Google: form rows come from the simulator on this page. Reading a real Sheet, the mapping, the Apps Script secret and Sync now work in a LIVE install.' };
  if (!live.canManage) return { category: 'permission', reason: 'Your assignment here does not include “Manage Sheets”. A super admin can grant it.' };
  if (live.integrationStatus === null || NOT_READY.has(live.integrationStatus)) return { category: 'configuration', reason: 'Save the service account key and the spreadsheet ID first.', fix: { href: setup, label: 'Open setup' } };
  return null;
}

function scriptMissingReason(live: SheetsLiveView): string | null {
  if (live.appsScript.script) return null;
  if (live.mode === 'demo') return 'DEMO pushes come from the simulator; the Apps Script is generated in a LIVE install.';
  if (!live.mapping) return 'Confirm a column mapping first: the script sends exactly the mapped columns.';
  if (!live.appsScript.keyId) return 'Issue the signing secret to get the script.';
  return 'Save the spreadsheet ID in the setup to get the script.';
}

export const metadata: Metadata = { title: 'Google Sheets' };
export const dynamic = 'force-dynamic';

export default async function SheetsPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const page = await workspacePage(ws);
  const view = await readOrNull(() => getSheetsSetup(page.ctx));
  const runtimeConfig = getRuntime().config;
  const live = view ? await getSheetsLiveView(page.ctx, { keyRing: runtimeConfig.secrets.credentials, appOrigin: runtimeConfig.appOrigin, now: page.ctx.clock.now() }) : null;
  const name = view?.workspace.name ?? ws;
  const gate = live ? liveGate(live, setupHref(ws, 'google-sheets')) : null;
  const syncGate: Gate | null =
    gate ??
    (live && !live.mapping
      ? { category: 'configuration', reason: 'Confirm a column mapping before syncing.' }
      : live?.sync.drift
        ? { category: 'configuration', reason: 'Re-confirm the mapping: the Sheet’s columns changed since it was confirmed.' }
        : null);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={name}
        title="Google Sheets"
        description="Google Form responses reach this workspace through an Apps Script that signs every push with the workspace’s secret. A Sheet URL alone grants no access."
      />
      <WorkspaceSectionNav slug={ws} workspaceName={name} />
      {view === null || live === null ? (
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
            {live.lastError ? (
              <p role="note" className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-fg-1">
                Last check failed ({live.lastError.code}){live.lastError.message ? `: ${live.lastError.message}` : '.'}
              </p>
            ) : null}
            {live.serviceAccount.state === 'saved' ? (
              <div data-service-account className="flex flex-col gap-2 rounded-lg border border-border-subtle bg-bg-2/50 p-3">
                <p className="flex items-center gap-2 text-sm font-medium text-fg-1">
                  <UserRoundCheck aria-hidden="true" className="size-4 text-fg-3" />
                  Share the Sheet with this service account
                </p>
                <div className="flex flex-wrap items-center gap-2">
                  <code className="font-mono text-sm break-all text-fg-1">{live.serviceAccount.email}</code>
                  <CopyButton value={live.serviceAccount.email} label="service account email" />
                </div>
                <p className="text-xs text-fg-2">Open the Sheet, choose Share, add this address as a Viewer and untick “Notify people”. A Sheet URL alone grants no access; Google answers 403 until it is shared.</p>
                <pre className="overflow-x-auto rounded border border-border-subtle bg-bg-1 p-2 font-mono text-xs text-fg-2">
                  {JSON.stringify(
                    { type: 'service_account', project_id: live.serviceAccount.projectId, client_email: live.serviceAccount.email, private_key_id: live.serviceAccount.privateKeyIdLast4 ? `••••${live.serviceAccount.privateKeyIdLast4}` : null, private_key: 'saved, never shown' },
                    null,
                    2,
                  )}
                </pre>
              </div>
            ) : live.mode === 'live' && live.serviceAccount.state !== 'missing' ? (
              <p role="note" className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-fg-1">
                {live.serviceAccount.state === 'unreadable' ? 'Credential unreadable, re-enter the service account key in the setup.' : 'The saved key is not a service account JSON key; save the key file again in the setup.'}
              </p>
            ) : null}
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
              <ChipTitle icon={<Table2 aria-hidden="true" />} hue="ice">
                Edit the mapping
              </ChipTitle>
            }
            meta="Read from the Sheet’s row 1 through the service account. Preview is a dry run; confirming makes a new mapping version."
          >
            <SheetsMappingEditor workspaceSlug={ws} initial={live.mapping ? { fieldMap: live.mapping.fieldMap, submittedAtColumn: live.mapping.submittedAtColumn, consent: live.mapping.consent } : null} activeVersion={live.mapping?.version ?? 0} gate={gate} />
          </SectionCard>

          <SectionCard
            title={
              <ChipTitle icon={<Code aria-hidden="true" />} hue="aura">
                Apps Script
              </ChipTitle>
            }
            meta="Pushes each new form response, signed with the workspace’s secret. The secret lives in Script Properties, never in a cell or in the script."
          >
            <AppsScriptPanel
              workspaceSlug={ws}
              workspaceName={name}
              keyId={live.appsScript.keyId}
              secretIssuedAt={live.appsScript.secretIssuedAt ? live.appsScript.secretIssuedAt.toISOString() : null}
              endpoint={live.appsScript.endpoint}
              originReachable={live.appsScript.originReachable}
              script={live.appsScript.script}
              scriptMissingReason={scriptMissingReason(live)}
              gate={gate}
              timeZone={view.workspace.timezone}
            />
          </SectionCard>

          <SectionCard
            title={
              <ChipTitle icon={<RefreshCw aria-hidden="true" />} hue="zest">
                Sync from the Sheet
              </ChipTitle>
            }
            meta="Reads new rows through the service account and ingests them exactly like a push. A row the script already sent is never created twice."
          >
            <SheetsSyncPanel
              workspaceSlug={ws}
              runs={live.sync.runs.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null }))}
              cursorRow={live.sync.cursorRow}
              open={live.sync.open}
              drift={live.sync.drift}
              gate={syncGate}
              timeZone={view.workspace.timezone}
            />
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
