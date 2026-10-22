/**
 * Setup page of one integration (T28; PRD: "Unavailable integration shows Not configured /
 * Verification required with a working setup action"). The Integration center's "Set up" link
 * lands here. It shows, from the server: the stored status (icon + label + Simulated/Live) with the
 * last check and error, Test connection, what DEMO uses instead of the provider, the provider-side
 * prerequisites, the non-secret configuration values, the credentials masked (saved + last four,
 * no reveal), the webhook URL where this app has the verified receiver, the channel's disclosures,
 * the synced WhatsApp templates with Sync templates, and the integration's recent audited activity.
 * With `integrations.manage` (T32) the Credentials section is the credential form (settings and
 * secrets, empty password fields, never echoed back), the templates open their mapping, and an
 * unreadable credential is called out ("Credential unreadable, re-enter"). Without it the masked
 * view is shown with the permission reason.
 * An unknown kind slug is 404; reading needs `leads.read`, actions `integrations.manage`.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, ClipboardList, FlaskConical, Gauge, Info, KeyRound, ListChecks, MessageSquareText, Settings2, Webhook } from 'lucide-react';
import { CredentialForm } from '@/components/integrations/CredentialForm';
import { setupHref } from '@/components/integrations/IntegrationCard';
import { MaskedCredentials } from '@/components/integrations/MaskedCredentials';
import { NotInAssignment } from '@/components/integrations/NotInAssignment';
import { TemplateSyncButton } from '@/components/integrations/TemplateSyncButton';
import { TemplateTable } from '@/components/integrations/TemplateTable';
import { TestConnectionButton } from '@/components/integrations/TestConnectionButton';
import { ACTIVITY_LABELS, manageGate, templateSyncGate, testConnectionGate } from '@/components/integrations/vocabulary';
import { WorkspaceSectionNav } from '@/components/integrations/WorkspaceSectionNav';
import { EmptyState } from '@/components/patterns/EmptyState';
import { GatedAction } from '@/components/patterns/GatedAction';
import { ChipTitle } from '@/components/patterns/IconChip';
import { PageHeader } from '@/components/patterns/PageHeader';
import { SectionCard } from '@/components/patterns/SectionCard';
import { IntegrationStatusBadge, ModeChip } from '@/components/patterns/StatusBadge';
import { touchTarget } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { catalogEntry, integrationKindFromSlug } from '@/lib/domain/integrations';
import { formatDateTime } from '@/lib/format/date';
import { getRuntime } from '@/server/boot';
import { getIntegrationSetup } from '@/server/services/integrations/center';
import { readOrNull, workspacePage } from '../_lib/workspace-page';

export const dynamic = 'force-dynamic';

/** A raw provider value, or "Unknown, last checked <time>" (R26: never a guessed tier). */
function rawOrUnknown(value: string | null, checkedAt: Date | null, timeZone: string): string {
  if (value !== null) return value;
  return checkedAt ? `Unknown, last checked ${formatDateTime(checkedAt, timeZone)}` : 'Unknown, never checked';
}

export async function generateMetadata({ params }: { params: Promise<{ kind: string }> }): Promise<Metadata> {
  const kind = integrationKindFromSlug((await params).kind);
  return { title: kind ? `${catalogEntry(kind).label} setup` : 'Integration setup' };
}

export default async function IntegrationSetupPage({ params }: { params: Promise<{ ws: string; kind: string }> }) {
  const { ws, kind: slug } = await params;
  const page = await workspacePage(ws);
  const kind = integrationKindFromSlug(slug);
  if (!kind) notFound();
  const entry = catalogEntry(kind);
  const setup = await readOrNull(() => getIntegrationSetup(page.ctx, kind));
  const name = setup?.workspace.name ?? ws;
  const back = `/dashboard/employee/${encodeURIComponent(ws)}/integrations`;

  return (
    <div className="flex flex-col gap-6">
      <Link href={back} className={cn('group relative inline-flex w-fit items-center gap-1.5 text-sm text-fg-2 hover:text-fg-1', touchTarget)}>
        <ArrowLeft aria-hidden="true" className="size-4 transition-transform duration-fast motion-safe:group-hover:-translate-x-0.5" />
        All integrations
      </Link>
      <PageHeader className="-mt-3" eyebrow={name} title={`${entry.label} setup`} description={entry.summary} />
      <WorkspaceSectionNav slug={ws} workspaceName={name} />
      {setup === null ? (
        <NotInAssignment what="Integration setup" />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <SectionCard
            className="lg:col-span-2"
            title={
              <ChipTitle icon={<Settings2 aria-hidden="true" />} hue="aura">
                Status
              </ChipTitle>
            }
          >
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <dl className="grid gap-3 sm:grid-cols-3">
                <div className="flex flex-col gap-1">
                  <dt className="text-xs text-fg-2">Status</dt>
                  <dd>
                    <IntegrationStatusBadge status={setup.card.status} simulated={setup.card.simulated} showDetail timeZone={setup.workspace.timezone} />
                  </dd>
                </div>
                <div className="flex flex-col gap-1">
                  <dt className="text-xs text-fg-2">Last check</dt>
                  <dd className="text-sm text-fg-1">{setup.card.lastCheckedAt ? formatDateTime(setup.card.lastCheckedAt, setup.workspace.timezone) : 'Never'}</dd>
                </div>
                <div className="flex flex-col gap-1">
                  <dt className="text-xs text-fg-2">Verified with {entry.provider}</dt>
                  <dd className="text-sm text-fg-1">{setup.card.verifiedAt ? formatDateTime(setup.card.verifiedAt, setup.workspace.timezone) : 'Not verified'}</dd>
                </div>
              </dl>
              <TestConnectionButton
                workspaceSlug={ws}
                kindSlug={entry.slug}
                label={entry.label}
                size="default"
                gate={testConnectionGate({ mode: setup.mode, canManage: setup.canManage, status: setup.card.status, label: entry.label, setupHref: setupHref(ws, entry.slug) })}
              />
            </div>
            {setup.card.lastError ? (
              <p role="note" className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-fg-1">
                Last check failed ({setup.card.lastError.code}){setup.card.lastError.message ? `: ${setup.card.lastError.message}` : '.'}
              </p>
            ) : null}
            {setup.mode === 'demo' ? (
              <p className="flex items-start gap-2 rounded-lg border border-demo/35 bg-demo/8 px-3 py-2 text-sm text-fg-1">
                <FlaskConical aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-demo" />
                {entry.demoNote}
              </p>
            ) : null}
          </SectionCard>

          {setup.card.quality ? (
            <SectionCard
              className="lg:col-span-2"
              title={
                <ChipTitle icon={<Gauge aria-hidden="true" />} hue="ice">
                  Quality and messaging limit
                </ChipTitle>
              }
              meta="Exactly as Meta reports them, checked every hour while WhatsApp is connected. No tier list is assumed."
            >
              <dl className="grid gap-3 sm:grid-cols-3" data-quality>
                <div className="flex flex-col gap-1">
                  <dt className="text-xs text-fg-2">Quality rating</dt>
                  <dd className="font-mono text-sm text-fg-1">{rawOrUnknown(setup.card.quality.qualityRaw, setup.card.quality.checkedAt, setup.workspace.timezone)}</dd>
                </div>
                <div className="flex flex-col gap-1">
                  <dt className="text-xs text-fg-2">Messaging limit</dt>
                  <dd className="font-mono text-sm text-fg-1">{rawOrUnknown(setup.card.quality.messagingLimitRaw, setup.card.quality.checkedAt, setup.workspace.timezone)}</dd>
                </div>
                <div className="flex flex-col gap-1">
                  <dt className="text-xs text-fg-2">Last checked</dt>
                  <dd className="text-sm text-fg-1">{setup.card.quality.checkedAt ? formatDateTime(setup.card.quality.checkedAt, setup.workspace.timezone) : 'Never'}</dd>
                </div>
              </dl>
              {setup.card.quality.pausesAutomation ? (
                <p role="note" data-quality-pause className="rounded-lg border border-warning/35 bg-warning/10 px-3 py-2 text-sm text-fg-1">
                  Automated WhatsApp sends are paused while the quality rating is RED. Sends a person approves still go out.
                </p>
              ) : null}
            </SectionCard>
          ) : null}

          <SectionCard
            title={
              <ChipTitle icon={<ListChecks aria-hidden="true" />} hue="zest">
                Before you connect
              </ChipTitle>
            }
            meta={`Done in ${entry.provider === 'Your mail server' ? 'your mail provider' : `the ${entry.provider} console`}.`}
          >
            <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm text-fg-1 marker:text-fg-2">
              {entry.prerequisites.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ol>
          </SectionCard>

          <SectionCard
            title={
              <ChipTitle icon={<ClipboardList aria-hidden="true" />} hue="ice">
                Configuration
              </ChipTitle>
            }
            meta="Non-secret values stored with the integration."
          >
            <dl className="flex flex-col gap-2">
              {setup.card.config.map((c) => (
                <div key={c.key} data-config={c.key} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-lg border border-border-subtle bg-bg-2/50 px-3 py-2">
                  <dt className="text-sm text-fg-2">{c.label}</dt>
                  <dd className={cn('text-sm', c.value ? 'font-mono text-fg-1' : 'text-fg-2')}>{c.value ?? 'Not set'}</dd>
                </div>
              ))}
            </dl>
          </SectionCard>

          <SectionCard
            title={
              <ChipTitle icon={<KeyRound aria-hidden="true" />} hue="volt">
                Credentials
              </ChipTitle>
            }
            meta="Encrypted with the deployment key ring. Only the last four characters are ever shown; a saved value cannot be revealed."
          >
            {setup.canManage ? (
              <CredentialForm
                workspaceSlug={ws}
                workspaceName={name}
                kind={kind}
                kindSlug={entry.slug}
                label={entry.label}
                provider={entry.provider}
                mode={setup.mode}
                timeZone={setup.workspace.timezone}
                config={setup.card.config}
                credentials={setup.card.credentials}
                credentialProblem={setup.card.credentialProblem}
              />
            ) : (
              <div className="flex flex-col gap-3">
                {setup.card.credentialProblem ? (
                  <p role="note" className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-fg-1">
                    {setup.card.credentialProblem}.
                  </p>
                ) : null}
                <MaskedCredentials items={setup.card.credentials} timeZone={setup.workspace.timezone} />
                <GatedAction label="Edit credentials" variant="secondary" size="sm" gate={manageGate(false)!} />
              </div>
            )}
          </SectionCard>

          {setup.webhookUrlPath ? (
            <SectionCard
              title={
                <ChipTitle icon={<Webhook aria-hidden="true" />} hue="aura">
                  Webhook
                </ChipTitle>
              }
              meta={`${entry.provider} signs every delivery; deliveries without a valid signature are rejected and never stored.`}
            >
              <p className="text-sm text-fg-2">Callback URL</p>
              <code data-webhook-url className="block overflow-x-auto rounded-lg border border-border-subtle bg-bg-2 px-3 py-2 font-mono text-sm text-fg-1">
                {`${getRuntime().config.appOrigin}${setup.webhookUrlPath}`}
              </code>
            </SectionCard>
          ) : null}

          {entry.disclosures.length > 0 ? (
            <SectionCard
              title={
                <ChipTitle icon={<Info aria-hidden="true" />} hue="ice">
                  Good to know
                </ChipTitle>
              }
            >
              <ul className="flex list-disc flex-col gap-2 pl-5 text-sm text-fg-1 marker:text-fg-2">
                {entry.disclosures.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            </SectionCard>
          ) : null}

          {kind === 'WHATSAPP_CLOUD' ? (
            <SectionCard
              className="lg:col-span-2"
              title={
                <ChipTitle icon={<MessageSquareText aria-hidden="true" />} hue="zest">
                  Message templates
                </ChipTitle>
              }
              meta="Authored and approved in WhatsApp Manager, synced here with their status and category exactly as Meta reports them."
              actions={<TemplateSyncButton workspaceSlug={ws} gate={templateSyncGate({ mode: setup.mode, canManage: setup.canManage, status: setup.card.status, setupHref: setupHref(ws, entry.slug) })} />}
            >
              {setup.templates.length === 0 ? (
                <EmptyState
                  headingLevel="h3"
                  icon={<MessageSquareText aria-hidden="true" className="size-5" />}
                  title="No templates synced"
                  description="Business-initiated WhatsApp messages need an approved template. Sync them to make them available to approvals and the inbox."
                />
              ) : (
                <TemplateTable templates={setup.templates} timeZone={setup.workspace.timezone} mapping={setup.canManage ? { workspaceSlug: ws } : null} />
              )}
            </SectionCard>
          ) : null}

          <SectionCard className="lg:col-span-2" title="Recent activity" meta="Connection tests, demo set-up and template syncs, from the audit trail.">
            {setup.activity.length === 0 ? (
              <p className="text-sm text-fg-2">Nothing has happened with this integration yet.</p>
            ) : (
              <ol className="flex flex-col gap-2">
                {setup.activity.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border-subtle bg-bg-2/50 px-3 py-2 text-sm">
                    <span className="flex flex-wrap items-center gap-2 text-fg-1">
                      {ACTIVITY_LABELS[a.action] ?? 'Integration change'}
                      {a.outcome === 'VERIFICATION_REQUIRED' ? <span className="text-xs text-warning">Verification required</span> : null}
                      {a.result === 'FAILED' && a.outcome !== 'VERIFICATION_REQUIRED' ? <span className="text-xs text-danger">Failed</span> : null}
                      <ModeChip simulated={a.simulated} />
                    </span>
                    <span className="text-xs text-fg-2">{formatDateTime(a.createdAt, setup.workspace.timezone)}</span>
                  </li>
                ))}
              </ol>
            )}
          </SectionCard>
        </div>
      )}
    </div>
  );
}
