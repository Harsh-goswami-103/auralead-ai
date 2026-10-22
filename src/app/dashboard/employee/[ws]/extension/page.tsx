/**
 * Google Maps extension hub for one workspace (T28 shell, T36 live parts; PRD "Extension hub
 * (scoped keys, revocation, webhook config, batch status, errors, simulation)"; 06-design §11.2.2
 * "Token list (masked, scope, created, last used); batches: status, counts, per-row failures;
 * example payload, simulate batch").
 * - Connect: the webhook URL the bridge posts to and the four setup steps (extension-bridge/).
 * - Tokens: create (shown once, then the prefix only), list with state, scope, last use and the
 *   allowed extension id, set that id, revoke behind a typed confirmation. Creating and revoking
 *   need `extension.manage`; without it the controls are permission-gated (plan §12).
 * - Simulate a batch (DEMO only, the same ingestion as a token-signed batch).
 * - Batches: every recent delivery, queued ones included, with the sending token, state, counts
 *   and the records that failed (intake and ingestion) with their reasons; rows that need
 *   attention; refused token uses with their reason (revoked, expired, wrong secret, wrong origin).
 * - The documented v1 batch body.
 * The `[ws]` slug is resolved against the employee's assignments; reading needs `leads.read`.
 * Secrets never reach the page: tokens are read by prefix only.
 */
import type { Metadata } from 'next';
import { Ban, Boxes, Braces, CircleCheck, CircleSlash, Clock, FlaskConical, KeyRound, Link2, ShieldAlert, TriangleAlert } from 'lucide-react';
import { CopyButton } from '@/components/admin/CopyButton';
import { NotInAssignment } from '@/components/integrations/NotInAssignment';
import { IssueTable } from '@/components/integrations/SourceActivity';
import { SourceSimulator } from '@/components/integrations/SourceSimulator';
import { StatusChip } from '@/components/integrations/StatusChip';
import { BATCH_STATE, DELIVERY_STATE, rowReason, simulationGateOf } from '@/components/integrations/vocabulary';
import { WorkspaceSectionNav } from '@/components/integrations/WorkspaceSectionNav';
import { EmptyState } from '@/components/patterns/EmptyState';
import { GatedAction } from '@/components/patterns/GatedAction';
import { ChipTitle } from '@/components/patterns/IconChip';
import { PageHeader } from '@/components/patterns/PageHeader';
import { SectionCard } from '@/components/patterns/SectionCard';
import { ModeChip } from '@/components/patterns/StatusBadge';
import { EXTENSION_MAX_RECORDS } from '@/lib/schemas/webhooks';
import { formatDateTime } from '@/lib/format/date';
import { getRuntime } from '@/server/boot';
import { getExtensionHubDetails } from '@/server/services/extension/hub';
import { readOrNull, workspacePage } from '../integrations/_lib/workspace-page';
import { CreateTokenForm } from './create-token-form';
import { TokenActions } from './token-actions';

export const metadata: Metadata = { title: 'Maps extension' };
export const dynamic = 'force-dynamic';

const TOKEN_STATE = {
  ACTIVE: { label: 'Active', tone: 'success', icon: CircleCheck },
  REVOKED: { label: 'Revoked', tone: 'neutral', icon: CircleSlash },
  EXPIRED: { label: 'Expired', tone: 'warning', icon: Clock },
} as const;

const FAILURE_REASONS: Readonly<Record<string, string>> = {
  INVALID_RECORD: 'Malformed record (a field has the wrong type or is too long)',
};

const DENIAL_REASONS: Readonly<Record<string, string>> = {
  REVOKED: 'Token revoked',
  EXPIRED: 'Token expired',
  SECRET_MISMATCH: 'Wrong secret for this token prefix',
  SCOPE_MISSING: 'Token lacks the ingest:gmaps scope',
  EXTENSION_NOT_ALLOWED: 'Sent by a different Chrome extension than the allowed one',
  MODE_MISMATCH: 'Token of a workspace in the other mode',
};

const failureReason = (code: string | null) => (code && FAILURE_REASONS[code]) ?? rowReason(code);

export default async function ExtensionPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const page = await workspacePage(ws);
  const view = await readOrNull(() => getExtensionHubDetails(page.ctx, { appOrigin: getRuntime().config.appOrigin }));
  const name = view?.workspace.name ?? ws;
  const tz = view?.workspace.timezone ?? 'Asia/Kolkata';

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
              <ChipTitle icon={<Link2 aria-hidden="true" />} hue="ice">
                Connect the extension
              </ChipTitle>
            }
            meta="The bridge (extension-bridge/ in the AuraLead repository) is added to the extension with one line; see its PATCH-GUIDE.md. Verified against the documented contract only, not against a live extension install."
          >
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1">
                <span className="text-xs text-fg-2">Webhook URL</span>
                <span className="flex flex-wrap items-center gap-2">
                  <code data-webhook-url className="rounded-md border border-border-subtle bg-bg-2 px-2 py-1 font-mono text-xs break-all text-fg-1">
                    {view.webhookUrl}
                  </code>
                  <CopyButton value={view.webhookUrl} label="webhook URL" />
                </span>
              </div>
              <ol className="ml-5 list-decimal space-y-1 text-sm text-fg-1">
                <li>Create a token below and copy it (it is shown once).</li>
                <li>In the bridge&apos;s options page, enter this site&apos;s address and the token, then Save.</li>
                <li>Copy the extension id shown there into the token&apos;s allowed extension id.</li>
                <li>Extract as usual: new rows arrive here as batches of at most {EXTENSION_MAX_RECORDS}. Sync stays off while the extension is not licensed.</li>
              </ol>
            </div>
          </SectionCard>

          <SectionCard
            title={
              <ChipTitle icon={<KeyRound aria-hidden="true" />} hue="volt">
                Ingestion tokens
              </ChipTitle>
            }
            meta={`A token is shown once when it is created; afterwards only its prefix is known. Each one can only add leads to this workspace. ${view.activeTokens} of ${view.tokenLimit} active.`}
          >
            <div className="flex flex-col gap-4">
              {view.manageGate ? (
                <GatedAction label="Create token" icon={<KeyRound aria-hidden="true" />} gate={view.manageGate} />
              ) : (
                <CreateTokenForm workspaceSlug={ws} limitReached={view.activeTokens >= view.tokenLimit} limit={view.tokenLimit} />
              )}
              {view.tokens.length === 0 ? (
                <EmptyState
                  headingLevel="h3"
                  icon={<KeyRound aria-hidden="true" className="size-5" />}
                  title="No ingestion tokens"
                  description="No token has been issued for this workspace, so the extension cannot send batches to it."
                />
              ) : (
                <div className="relative overflow-x-auto rounded-lg border border-border-subtle">
                  <table className="w-full min-w-[56rem] text-left text-sm">
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
                        <th scope="col" className="px-3 py-2 font-medium">
                          Extension
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {view.tokens.map((t) => (
                        <tr key={t.id} data-token={t.prefix} className="border-t border-border-subtle align-top">
                          <th scope="row" className="px-3 py-2 font-normal">
                            <span className="block text-fg-1">{t.name}</span>
                            <span className="font-mono text-xs text-fg-2">{t.prefix}_••••</span>
                          </th>
                          <td className="px-3 py-2">
                            <StatusChip entry={TOKEN_STATE[t.state]} />
                            {t.expiresAt && t.state === 'ACTIVE' ? <span className="mt-1 block text-xs text-fg-2">Expires {formatDateTime(t.expiresAt, tz)}</span> : null}
                          </td>
                          <td className="px-3 py-2 text-xs text-fg-1">{t.scopes.join(', ')}</td>
                          <td className="px-3 py-2 text-xs whitespace-nowrap text-fg-2">{formatDateTime(t.createdAt, tz)}</td>
                          <td className="px-3 py-2 text-xs whitespace-nowrap text-fg-2">{t.lastUsedAt ? formatDateTime(t.lastUsedAt, tz) : 'Never'}</td>
                          <td className="px-3 py-2 text-xs">
                            {t.state === 'ACTIVE' && view.canManage ? (
                              <TokenActions workspaceSlug={ws} workspaceName={name} tokenId={t.id} tokenName={t.name} prefix={t.prefix} allowedExtensionId={t.allowedExtensionId} />
                            ) : (
                              <span className="font-mono text-fg-2">{t.allowedExtensionId ?? 'Any extension'}</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
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
            meta="Each batch with its token, state and per-record results. A queued batch is processed by the worker within moments."
          >
            {view.deliveries.length === 0 ? (
              <p className="text-sm text-fg-2">No batch has arrived yet.</p>
            ) : (
              <ul className="flex flex-col gap-2" aria-label="Recent extension batches">
                {view.deliveries.map((d) => {
                  const entry = d.state === 'PROCESSED' && d.batchStatus ? BATCH_STATE[d.batchStatus] : DELIVERY_STATE[d.state === 'QUEUED' ? 'RECEIVED' : d.state];
                  return (
                    <li key={d.eventId} data-delivery={d.batchId} className="rounded-lg border border-border-subtle p-3">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="font-mono text-xs break-all text-fg-1">{d.batchId}</span>
                        <ModeChip simulated={d.simulated} />
                        {entry ? <StatusChip entry={entry} /> : <span className="text-xs text-fg-2">{d.state}</span>}
                        <span className="text-xs text-fg-2">{formatDateTime(d.receivedAt, tz)}</span>
                        <span className="text-xs text-fg-2">{d.tokenName ? `${d.tokenName} (${d.tokenPrefix})` : d.simulated ? 'Simulator' : 'Token unknown'}</span>
                      </div>
                      <p className="mt-1 text-xs text-fg-1">
                        {d.counts
                          ? `${d.counts.received} received · ${d.counts.accepted} created · ${d.counts.duplicate} duplicate · ${d.counts.review} in review · ${d.counts.rejected} rejected`
                          : d.failureCode
                            ? `Could not be processed (reason code ${d.failureCode})`
                            : 'Not processed yet'}
                      </p>
                      {d.failures.length > 0 ? (
                        <details className="mt-2">
                          <summary className="cursor-pointer text-xs text-fg-2">
                            {d.failures.length + d.moreFailures} {d.failures.length + d.moreFailures === 1 ? 'record needs' : 'records need'} attention
                          </summary>
                          <ul className="mt-1 flex flex-col gap-1">
                            {d.failures.map((f, i) => (
                              <li key={`${f.recordId}-${i}`} className="flex flex-wrap gap-2 text-xs">
                                <span className="font-mono text-fg-1">{f.recordId}</span>
                                <span className="text-fg-2">{f.status === 'REVIEW' ? 'Needs review' : 'Rejected'}:</span>
                                <span className="text-fg-1">{failureReason(f.reasonCode)}</span>
                              </li>
                            ))}
                            {d.moreFailures > 0 ? <li className="text-xs text-fg-2">and {d.moreFailures} more</li> : null}
                          </ul>
                        </details>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
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
              <IssueTable rows={view.rowIssues} timeZone={tz} />
            </SectionCard>
          ) : null}

          {view.denials.length > 0 ? (
            <SectionCard
              title={
                <ChipTitle icon={<ShieldAlert aria-hidden="true" />} hue="zest">
                  Refused requests
                </ChipTitle>
              }
              meta="Requests with one of this workspace's tokens that were refused, newest first. Nothing they carried was stored."
            >
              <ul className="flex flex-col gap-1" data-denials>
                {view.denials.map((d, i) => (
                  <li key={`${d.at.toISOString()}-${i}`} className="flex flex-wrap items-center gap-2 text-xs">
                    <Ban aria-hidden="true" className="size-3.5 text-danger" />
                    <span className="text-fg-1">{DENIAL_REASONS[d.reason] ?? d.reason}</span>
                    {d.prefix ? <span className="font-mono text-fg-2">{d.prefix}</span> : null}
                    <span className="text-fg-2">{formatDateTime(d.at, tz)}</span>
                  </li>
                ))}
              </ul>
            </SectionCard>
          ) : null}

          <SectionCard
            title={
              <ChipTitle icon={<Braces aria-hidden="true" />} hue="ice">
                Batch format
              </ChipTitle>
            }
            meta={`Version 1, at most ${EXTENSION_MAX_RECORDS} records per batch, sent as POST with "Authorization: Bearer alx_...". A repeated batch id with the same body returns the stored result instead of creating leads again; with a different body it is refused (409).`}
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
