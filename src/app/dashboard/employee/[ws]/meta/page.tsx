/**
 * Meta Lead Ads console for one workspace (T28 shell, T35 adds the live parts; PRD "Meta console
 * (metrics, spend, leads, CPL, pause/resume with confirmation, permissions, provider result, audit;
 * demo toggles simulated only)"; 06-design §11.2.2 "Connection status and permissions; campaign
 * table; lead event log"). Shows the stored META_ADS status with Test connection and its setup
 * link, the Page and ad account, the Instant Form mappings with their consent question (P1), the
 * synced campaigns with their latest metrics in the ad account's own currency (never converted, P6)
 * with the date window, attribution and As of time, the DEMO lead simulation, the recent leadgen
 * deliveries and the rows that need attention. The `[ws]` slug is resolved against the employee's
 * assignments; reading needs `leads.read`.
 *
 * T35 live parts: "Sync campaigns" (DEMO: simulated campaigns), pause and resume per campaign with a
 * typed confirmation and the newest action's result from Meta (Simulated in DEMO), the webhook
 * callback URL, the Instant Form mapping editor, "Backfill from form since T" with its runs, and
 * the leads that could not be fetched (by reason) with the forms that still need a mapping. Every
 * control is gated by configuration, permission or mode only (plan §12). Metric windows are
 * calendar dates in the ad account's time zone, shown as dates (not shifted to the workspace's).
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowRight, BarChart3, FlaskConical, History, ListChecks, Megaphone, NotebookTabs, TriangleAlert, Webhook } from 'lucide-react';
import { setupHref } from '@/components/integrations/IntegrationCard';
import { NotInAssignment } from '@/components/integrations/NotInAssignment';
import { DeliveryTable, IssueTable } from '@/components/integrations/SourceActivity';
import { SourceSimulator } from '@/components/integrations/SourceSimulator';
import { StatusChip } from '@/components/integrations/StatusChip';
import { TestConnectionButton } from '@/components/integrations/TestConnectionButton';
import { formatMinor, LEAD_FIELD_LABELS, rawStatusEntry, simulationGateOf, testConnectionGate } from '@/components/integrations/vocabulary';
import { WorkspaceSectionNav } from '@/components/integrations/WorkspaceSectionNav';
import { EmptyState } from '@/components/patterns/EmptyState';
import type { Gate } from '@/components/patterns/GatedAction';
import { ChipTitle } from '@/components/patterns/IconChip';
import { PageHeader } from '@/components/patterns/PageHeader';
import { SectionCard } from '@/components/patterns/SectionCard';
import { IntegrationStatusBadge, ModeChip } from '@/components/patterns/StatusBadge';
import { buttonVariants } from '@/components/ui/button';
import { formatDate, formatDateTime } from '@/lib/format/date';
import { getRuntime } from '@/server/boot';
import { getMetaLiveParts, type ControlGate } from '@/server/services/campaigns/console';
import { getMetaConsole } from '@/server/services/integrations/source-pages';
import { readOrNull, workspacePage } from '../integrations/_lib/workspace-page';
import { BackfillForm } from './backfill-form';
import { CampaignControl } from './campaign-control';
import { CampaignSyncButton } from './campaign-sync-button';
import { FormMappingForm } from './form-mapping-form';
import { BACKFILL_STATE, failureLabel } from './meta-vocabulary';

export const metadata: Metadata = { title: 'Meta Lead Ads' };
export const dynamic = 'force-dynamic';

const gateOf = (g: ControlGate, fix?: Gate['fix']): Gate | null => (g.allowed ? null : { category: g.category, reason: g.reason, ...(fix && g.category === 'configuration' ? { fix } : {}) });

/** `YYYY-MM-DDTHH:mm` (a datetime-local value) of `at` in the workspace time zone. */
function localInput(at: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

export default async function MetaPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const page = await workspacePage(ws);
  const view = await readOrNull(() => getMetaConsole(page.ctx));
  const config = getRuntime().config;
  const live = view
    ? await getMetaLiveParts(page.ctx, {
        graphVersionSet: config.meta.graphVersion !== null,
        marketingVersionSet: config.meta.marketingVersion !== null,
        appSecretSet: config.meta.appSecret !== null,
        verifyTokenSet: config.meta.verifyToken !== null,
      })
    : null;
  const name = view?.workspace.name ?? ws;
  const setup = setupHref(ws, 'meta-ads');
  const fix = { href: setup, label: 'Open setup' };
  const backfillDefault = localInput(new Date(page.ctx.clock.now().getTime() - 7 * 24 * 60 * 60 * 1000), view?.workspace.timezone ?? 'Asia/Kolkata');

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow={name}
        title="Meta Lead Ads"
        description="Instant Form leads from your Facebook Page and the metrics of your campaigns. Ads linked to a Google Form are not Instant Forms: their rows arrive through Google Sheets."
      />
      <WorkspaceSectionNav slug={ws} workspaceName={name} />
      {view === null || live === null ? (
        <NotInAssignment what="The Meta console" />
      ) : (
        <>
          <SectionCard
            title={
              <ChipTitle icon={<Megaphone aria-hidden="true" />} hue="volt">
                Connection
              </ChipTitle>
            }
            actions={
              <Link href={setup} className={buttonVariants({ variant: view.integration.status === 'NOT_CONFIGURED' ? 'secondary' : 'ghost', size: 'sm' })}>
                {view.integration.status === 'NOT_CONFIGURED' ? 'Set up Meta Lead Ads' : 'Manage setup'}
                <ArrowRight aria-hidden="true" />
              </Link>
            }
          >
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <dl className="grid gap-3 sm:grid-cols-3">
                <div className="flex flex-col gap-1">
                  <dt className="text-xs text-fg-2">Status</dt>
                  <dd>
                    <IntegrationStatusBadge status={view.integration.status} simulated={view.integration.simulated} showDetail checkedAt={view.integration.lastCheckedAt} timeZone={view.workspace.timezone} />
                  </dd>
                </div>
                <div className="flex flex-col gap-1">
                  <dt className="text-xs text-fg-2">Page ID</dt>
                  <dd className="font-mono text-sm break-all text-fg-1">{view.pageId ?? <span className="font-sans text-fg-2">Not set</span>}</dd>
                </div>
                <div className="flex flex-col gap-1">
                  <dt className="text-xs text-fg-2">Ad account ID</dt>
                  <dd className="font-mono text-sm break-all text-fg-1">{view.adAccountId ?? <span className="font-sans text-fg-2">Not set</span>}</dd>
                </div>
              </dl>
              <TestConnectionButton
                workspaceSlug={ws}
                kindSlug="meta-ads"
                label="Meta Lead Ads"
                gate={testConnectionGate({ mode: view.mode, canManage: view.canTestConnection, status: view.integration.status, label: 'Meta Lead Ads', setupHref: setup })}
              />
            </div>
            <div className="flex flex-col gap-1">
              <p className="flex items-center gap-1.5 text-xs text-fg-2">
                <Webhook aria-hidden="true" className="size-3.5" />
                Leadgen webhook callback URL
                {live.mode === 'live' && !(live.server.appSecretSet && live.server.verifyTokenSet) ? ' (the server has no META_APP_SECRET or META_VERIFY_TOKEN yet, so deliveries are refused)' : ''}
              </p>
              <code data-webhook-url className="block overflow-x-auto rounded-lg border border-border-subtle bg-bg-2 px-3 py-2 font-mono text-sm text-fg-1">
                {`${config.appOrigin}${live.webhookPath}`}
              </code>
            </div>
            {view.integration.lastError ? (
              <p role="note" className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-fg-1">
                Last check failed ({view.integration.lastError.code}){view.integration.lastError.message ? `: ${view.integration.lastError.message}` : '.'}
              </p>
            ) : null}
          </SectionCard>

          <SectionCard
            title={
              <ChipTitle icon={<BarChart3 aria-hidden="true" />} hue="aura">
                Campaigns
              </ChipTitle>
            }
            meta="Spend and cost per lead in the ad account’s own currency, for the window and attribution setting Meta reported."
            actions={<CampaignSyncButton workspaceSlug={ws} gate={gateOf(live.gates.sync, fix)} />}
          >
            {view.campaigns.length === 0 ? (
              <EmptyState
                headingLevel="h3"
                icon={<BarChart3 aria-hidden="true" className="size-5" />}
                title="No campaigns found for this ad account"
                description={
                  view.mode === 'demo'
                    ? 'DEMO has no real ad account. “Sync campaigns” adds simulated campaigns (labelled Simulated) so metrics and pause or resume can be tried; Meta is never contacted.'
                    : 'Campaign metrics appear here once Meta Lead Ads is connected and its campaigns have been synced.'
                }
              />
            ) : (
              <div className="relative overflow-x-auto rounded-lg border border-border-subtle">
                <table className="w-full min-w-[64rem] text-left text-sm">
                  <caption className="sr-only">Campaigns, their latest metrics and pause or resume</caption>
                  <thead className="bg-bg-2/60 text-xs text-fg-2">
                    <tr>
                      <th scope="col" className="px-3 py-2 font-medium">
                        Campaign
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        Status
                      </th>
                      <th scope="col" className="px-3 py-2 text-right font-medium">
                        Spend
                      </th>
                      <th scope="col" className="px-3 py-2 text-right font-medium">
                        Leads
                      </th>
                      <th scope="col" className="px-3 py-2 text-right font-medium">
                        Cost per lead
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        Window and As of
                      </th>
                      <th scope="col" className="px-3 py-2 font-medium">
                        Pause or resume
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.campaigns.map((c) => (
                      <tr key={c.id} data-campaign={c.providerCampaignId} className="border-t border-border-subtle align-top">
                        <th scope="row" className="px-3 py-2 font-normal">
                          <span className="flex flex-wrap items-center gap-2 text-fg-1">
                            {c.name}
                            <ModeChip simulated={c.simulated} />
                          </span>
                        </th>
                        <td className="px-3 py-2">
                          <StatusChip entry={rawStatusEntry(c.effectiveStatus)} title={`Configured: ${c.configuredStatus}`} />
                        </td>
                        <td className="tabular px-3 py-2 text-right text-fg-1">{c.latest ? formatMinor(c.latest.spendMinor, c.currency) : 'Unknown'}</td>
                        <td className="tabular px-3 py-2 text-right text-fg-1">{c.latest ? c.latest.leads : 'Unknown'}</td>
                        <td className="tabular px-3 py-2 text-right text-fg-1">{c.latest?.cplMinor ? formatMinor(c.latest.cplMinor, c.currency) : 'Unknown'}</td>
                        <td className="px-3 py-2 text-xs text-fg-2">
                          {c.latest ? (
                            <>
                              {formatDate(c.latest.dateStart, 'UTC')} to {formatDate(c.latest.dateStop, 'UTC')}
                              {c.latest.attributionSetting ? `, ${c.latest.attributionSetting}` : ', attribution not reported'}
                              <span className="block">As of {formatDateTime(c.latest.asOf, view.workspace.timezone)}</span>
                            </>
                          ) : (
                            'No metrics synced'
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <CampaignControl
                            workspaceSlug={ws}
                            workspaceName={name}
                            campaignId={c.id}
                            campaignName={c.name}
                            configuredStatus={c.configuredStatus}
                            latest={live.actions[c.id] ?? null}
                            gate={gateOf(live.gates.control, fix)}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>

          <SectionCard
            title={
              <ChipTitle icon={<NotebookTabs aria-hidden="true" />} hue="ice">
                Instant Form mappings
              </ChipTitle>
            }
          >
            {view.forms.length === 0 ? (
              <p className="text-sm text-fg-2">
                {view.mode === 'demo' ? 'The first simulated lead below installs the demo form’s mapping.' : 'Map each Instant Form’s questions to lead fields (and its consent question) so its leads can be read.'}
              </p>
            ) : (
              <ul className="grid gap-3 lg:grid-cols-2">
                {view.forms.map((f) => (
                  <li key={f.formId} data-form={f.formId} className="flex flex-col gap-2 rounded-lg border border-border-subtle bg-bg-2/50 p-3 text-sm">
                    <p className="text-xs text-fg-2">
                      Form <span className="font-mono text-fg-1">{f.formId}</span>
                    </p>
                    <p className="text-fg-1">{f.fields.map((m) => `${LEAD_FIELD_LABELS[m.field] ?? m.field}: ${m.column}`).join(' · ')}</p>
                    <p className="text-xs text-fg-2">
                      {f.consent ? `Consent question “${f.consent.column}” (${f.consent.channel.toLowerCase()}, opt-in answers: ${f.consent.truthyValues.join(', ')})` : 'No consent question mapped: leads from this form record no opt-in.'}
                    </p>
                  </li>
                ))}
              </ul>
            )}
            {live.unmappedForms.length > 0 ? (
              <p role="note" className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-fg-1">
                Leads arrived from {live.unmappedForms.length === 1 ? 'a form' : 'forms'} without a mapping: {live.unmappedForms.join(', ')}. Map {live.unmappedForms.length === 1 ? 'it' : 'them'}, then backfill from the form to bring those leads in.
              </p>
            ) : null}
            <details className="rounded-lg border border-border-subtle bg-bg-2/40 p-3">
              <summary className="cursor-pointer text-sm font-medium text-fg-1">Add or replace a form mapping</summary>
              <div className="mt-3">
                <FormMappingForm workspaceSlug={ws} gate={gateOf(live.gates.mapping, fix)} {...(live.unmappedForms[0] ? { defaultFormId: live.unmappedForms[0] } : {})} />
              </div>
            </details>
          </SectionCard>

          <SectionCard
            title={
              <ChipTitle icon={<History aria-hidden="true" />} hue="ice">
                Backfill from form
              </ChipTitle>
            }
            meta="Reads a mapped form’s leads created after a time (last 90 days) from Meta. Leads that already arrived are counted as duplicates, never added twice."
          >
            <BackfillForm workspaceSlug={ws} forms={view.forms.map((f) => f.formId)} defaultSince={backfillDefault} gate={gateOf(live.gates.backfill, fix)} />
            {live.backfills.length > 0 ? (
              <ul className="flex flex-col gap-2" data-backfill-runs>
                {live.backfills.map((b) => (
                  <li key={b.id} className="flex flex-col gap-1 rounded-lg border border-border-subtle bg-bg-2/50 p-3 text-sm">
                    <span className="flex flex-wrap items-center gap-2">
                      <StatusChip entry={BACKFILL_STATE[b.status] ?? BACKFILL_STATE.QUEUED!} />
                      <span className="text-fg-1">
                        Form <span className="font-mono">{b.formId}</span> since {formatDateTime(b.since, view.workspace.timezone)}
                      </span>
                    </span>
                    <span className="text-xs text-fg-2">
                      {b.pages} {b.pages === 1 ? 'page' : 'pages'}, {b.fetched} {b.fetched === 1 ? 'lead' : 'leads'} read
                      {b.counts ? `: ${b.counts.accepted} added, ${b.counts.duplicate} already known, ${b.counts.review} to review, ${b.counts.rejected} rejected` : ''}
                      {b.truncated ? '. More leads remain: run another backfill.' : '.'}
                    </span>
                    {b.errorCode ? (
                      <span className="text-xs text-danger">
                        {failureLabel(b.errorCode)}
                        {b.errorMessage ? `: ${b.errorMessage}` : ''}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </SectionCard>

          <SectionCard
            title={
              <ChipTitle icon={<FlaskConical aria-hidden="true" />} hue="volt">
                Simulate Instant Form leads
              </ChipTitle>
            }
          >
            <SourceSimulator
              source="meta"
              workspaceSlug={ws}
              gate={simulationGateOf(view.simulation)}
              pending={view.events.some((e) => e.status === 'RECEIVED')}
              description="Sends simulated leadgen events with their form answers through the same webhook path and ingestion as Meta. Labelled Simulated; Meta is never contacted."
            />
          </SectionCard>

          <SectionCard
            title={
              <ChipTitle icon={<ListChecks aria-hidden="true" />} hue="aura">
                Lead events
              </ChipTitle>
            }
          >
            {live.fetchFailures.length > 0 ? (
              <ul role="note" className="flex flex-col gap-1 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-fg-1" data-fetch-failures>
                {live.fetchFailures.map((f) => (
                  <li key={f.code}>
                    {f.count} {f.count === 1 ? 'lead' : 'leads'} not fetched: {failureLabel(f.code)} (oldest {formatDateTime(f.oldest, view.workspace.timezone)}).
                  </li>
                ))}
                <li className="text-xs text-fg-2">Fix the cause (a new token, a permission, the form’s mapping), then backfill from the form since the oldest time.</li>
              </ul>
            ) : null}
            {live.pendingFetch > 0 ? (
              <p className="text-xs text-fg-2">
                {live.pendingFetch} {live.pendingFetch === 1 ? 'lead is' : 'leads are'} waiting to be fetched from Meta by the worker.
              </p>
            ) : null}
            {view.events.length === 0 ? (
              <p className="text-sm text-fg-2">No leadgen event has arrived yet.</p>
            ) : (
              <DeliveryTable
                caption="Recent Meta leadgen events"
                firstColumn="Event"
                timeZone={view.workspace.timezone}
                rows={view.events.map((e) => ({ id: e.id, label: e.id.slice(-8), state: e.status, stateKind: 'delivery', simulated: e.simulated, at: e.receivedAt, counts: e.counts, failureCode: e.failureCode }))}
              />
            )}
          </SectionCard>

          {view.rowIssues.length > 0 ? (
            <SectionCard
              title={
                <ChipTitle icon={<TriangleAlert aria-hidden="true" />} hue="zest">
                  Leads that need attention
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
