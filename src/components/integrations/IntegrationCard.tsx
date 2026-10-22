/**
 * IntegrationStatusCard (T28; 06-design §11.2.2 "Integrations: grid of IntegrationStatusCard, per
 * card setup, test connection, last check time; quality/limits or Unknown, last checked; internal
 * caps clearly labelled"). Everything shown comes from the server's card: the stored status (icon +
 * label + Simulated/Live chip), credentials as a saved count only, the last check, the last error
 * (already redacted), WhatsApp quality and limit as raw strings or Unknown, and the channel's
 * internal daily cap. The setup link is the "working setup action" for Not configured / Verification
 * required (PRD); Test connection is gated only on permission or configuration. Server-safe; the
 * test button is a client island.
 */
import Link from 'next/link';
import { ArrowRight, FlaskConical, Gauge, KeyRound, MessageSquareText, Timer, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { IntegrationStatusBadge } from '@/components/patterns/StatusBadge';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import type { IntegrationStatus, IntegrationKind } from '@/lib/domain/enums';
import { formatDateTime } from '@/lib/format/date';
import { TestConnectionButton } from './TestConnectionButton';
import { KIND_ICONS, testConnectionGate } from './vocabulary';

export type IntegrationCardData = {
  kind: IntegrationKind;
  slug: string;
  label: string;
  provider: string;
  summary: string;
  demoNote: string;
  status: IntegrationStatus;
  simulated: boolean;
  credentials: Array<{ saved: boolean }>;
  lastCheckedAt: Date | null;
  lastError: { code: string; message: string | null } | null;
  quality: { qualityRaw: string | null; messagingLimitRaw: string | null; checkedAt: Date | null; pausesAutomation?: boolean } | null;
  internalDailyCap: number | null;
  templates: { approved: number; total: number } | null;
};

function Fact({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-start gap-2.5">
      <span aria-hidden="true" className="mt-0.5 text-fg-3 [&>svg]:size-4">
        {icon}
      </span>
      <div className="flex min-w-0 flex-col">
        <dt className="text-xs text-fg-2">{label}</dt>
        <dd className="text-sm text-fg-1">{children}</dd>
      </div>
    </div>
  );
}

export function setupHref(workspaceSlug: string, kindSlug: string): string {
  return `/dashboard/employee/${encodeURIComponent(workspaceSlug)}/integrations/${kindSlug}`;
}

export function IntegrationCard(props: { card: IntegrationCardData; workspaceSlug: string; mode: 'demo' | 'live'; canManage: boolean; timeZone: string }) {
  const { card } = props;
  const Icon = KIND_ICONS[card.kind];
  const href = setupHref(props.workspaceSlug, card.slug);
  const saved = card.credentials.filter((c) => c.saved).length;
  const checked = (at: Date | null) => (at ? formatDateTime(at, props.timeZone) : 'Never');
  const needsSetup = card.status === 'NOT_CONFIGURED' || card.status === 'REVOKED';

  return (
    <article
      data-integration={card.kind}
      aria-labelledby={`integration-${card.slug}`}
      className="relative isolate flex min-w-0 flex-col gap-4 overflow-hidden rounded-xl border border-border-subtle bg-bg-1/80 p-4 sm:p-5"
    >
      <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-0.5 [background-image:var(--panel-grad)] opacity-70" />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span aria-hidden="true" className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-panel/30 bg-panel/12 text-panel">
            <Icon className="size-5" />
          </span>
          <div className="flex min-w-0 flex-col">
            <h3 id={`integration-${card.slug}`} className="font-display text-md font-semibold text-fg-1">
              {card.label}
            </h3>
            <p className="text-xs text-fg-2">{card.provider}</p>
          </div>
        </div>
        <IntegrationStatusBadge status={card.status} simulated={card.simulated} checkedAt={card.lastCheckedAt} timeZone={props.timeZone} />
      </div>
      <p className="text-sm text-fg-2">{card.summary}</p>

      <dl className="grid gap-3 sm:grid-cols-2">
        <Fact icon={<KeyRound />} label="Credentials">
          {saved === 0 ? 'None saved' : `${saved} of ${card.credentials.length} saved, encrypted`}
        </Fact>
        <Fact icon={<Timer />} label="Last check">
          {checked(card.lastCheckedAt)}
        </Fact>
        {card.quality ? (
          <Fact icon={<Gauge />} label="Quality and messaging limit">
            {card.quality.qualityRaw ?? 'Unknown'} · {card.quality.messagingLimitRaw ?? 'Unknown'}
            <span className="block text-xs text-fg-2">As reported by Meta. Last checked: {checked(card.quality.checkedAt)}</span>
            {card.quality.pausesAutomation ? (
              <span data-quality-pause className="mt-1 block text-xs text-warning">
                Automated WhatsApp sends are paused while the quality rating is RED. Sends a person approves still go out.
              </span>
            ) : null}
          </Fact>
        ) : null}
        {card.internalDailyCap !== null ? (
          <Fact icon={<Gauge />} label="Internal daily cap">
            {card.internalDailyCap.toLocaleString('en-IN')} a day
            <span className="block text-xs text-fg-2">Internal cap, not a provider limit</span>
          </Fact>
        ) : null}
        {card.templates ? (
          <Fact icon={<MessageSquareText />} label="Message templates">
            {card.templates.total === 0 ? 'None synced' : `${card.templates.approved} approved of ${card.templates.total} synced`}
          </Fact>
        ) : null}
      </dl>

      {card.lastError ? (
        <p role="note" className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-fg-1">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
          <span>
            Last check failed ({card.lastError.code}){card.lastError.message ? `: ${card.lastError.message}` : '.'}
          </span>
        </p>
      ) : null}

      {props.mode === 'demo' ? (
        <p className="flex items-start gap-2 text-xs text-fg-2">
          <FlaskConical aria-hidden="true" className="mt-px size-3.5 shrink-0 text-demo" />
          <span>{card.demoNote}</span>
        </p>
      ) : null}

      <div className="mt-auto flex flex-wrap items-start justify-between gap-3 border-t border-border-subtle pt-4">
        <TestConnectionButton
          workspaceSlug={props.workspaceSlug}
          kindSlug={card.slug}
          label={card.label}
          gate={testConnectionGate({ mode: props.mode, canManage: props.canManage, status: card.status, label: card.label, setupHref: href })}
        />
        <Link href={href} className={cn(buttonVariants({ variant: needsSetup ? 'secondary' : 'ghost', size: 'sm' }), 'group/setup')}>
          {needsSetup ? 'Set up' : 'Manage setup'}
          <span className="sr-only"> {card.label}</span>
          <ArrowRight aria-hidden="true" className="transition-transform duration-fast motion-safe:group-hover/setup:translate-x-0.5" />
        </Link>
      </div>
    </article>
  );
}
