/**
 * Client command center (T25; PRD "command center: DB-derived counts, conversations, quote metrics,
 * pipeline value vs confirmed revenue, funnel, activity"; 06-design §11.1 and §11.3).
 *
 * Every number comes from `loadClientCommandCenter` (services/metrics), read through the
 * tenant-scoped context at one "As of" instant: the KPI row (new leads in 7 days, open
 * conversations, quotes awaiting approval, pipeline value, accepted quote value and confirmed
 * revenue, which is unavailable because AuraLead records no payments: O6), "Needs you", leads by
 * sales stage and the recent audit activity. Each number has its definition one click away ("How
 * it's counted"), renders its final value from the first frame (no count-up) and changes only when
 * someone presses Refresh. A section whose query failed says so with a reference and a Retry while
 * the rest of the page keeps its numbers.
 *
 * Aurora look (design spec §6): PageHeader with the workspace name as the gradient h1 and the
 * "As of" line, the KPI tiles beside the decorative Aura tile from 1440px (aria-hidden, no data),
 * then "Needs you" and the funnel beside the activity feed. Every grid column has a zero minimum.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import { Activity, BadgeCheck, BellRing, CircleSlash, ClipboardCheck, FilePlus2, Filter, Globe2, Inbox, Layers, MessagesSquare, TrendingUp, UserPlus } from 'lucide-react';
import { ActivityFeed } from '@/components/metrics/ActivityFeed';
import { KpiTile, type KpiState } from '@/components/metrics/KpiTile';
import { NeedsYouList } from '@/components/metrics/NeedsYouList';
import { RefreshButton } from '@/components/metrics/RefreshButton';
import { StageFunnel } from '@/components/metrics/StageFunnel';
import { WidgetError } from '@/components/metrics/WidgetError';
import { plural } from '@/components/client/labels';
import { ChipTitle } from '@/components/patterns/IconChip';
import { PageHeader } from '@/components/patterns/PageHeader';
import { SectionCard } from '@/components/patterns/SectionCard';
import { buttonVariants } from '@/components/ui/button';
import { GlowFrame } from '@/components/visual/GlowFrame';
import { Stagger, StaggerItem } from '@/components/visual/Reveal';
import { AuraTile } from '@/components/visual/aura';
import { formatDateTime } from '@/lib/format/date';
import { formatINR } from '@/lib/money';
import { hasCapability } from '@/server/auth/guards';
import { getPageContext } from '@/server/auth/page-context';
import { getRuntime } from '@/server/boot';
import { loadClientCommandCenter } from '@/server/services/metrics/command-center';
import { CLIENT_METRICS, CONFIRMED_REVENUE } from '@/server/services/metrics/definitions';
import type { MoneyMetric, WidgetOutcome } from '@/server/services/metrics/widget';

export const metadata: Metadata = { title: 'Command center' };
export const dynamic = 'force-dynamic';

function MetaChip(props: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border-subtle bg-bg-1/70 px-2.5 py-1 text-xs text-fg-2 [&>svg]:size-3.5 [&>svg]:shrink-0 [&>svg]:text-panel">
      {props.icon}
      {props.children}
    </span>
  );
}

function countState(o: WidgetOutcome<number>, hint: (n: number) => ReactNode): KpiState {
  return o.ok ? { ok: true, value: o.value.toLocaleString('en-IN'), hint: hint(o.value) } : o;
}

function moneyState(o: WidgetOutcome<MoneyMetric>, hint: (n: number) => ReactNode): KpiState {
  return o.ok ? { ok: true, value: formatINR(o.value.paise), hint: hint(o.value.count) } : o;
}

export default async function UserHomePage() {
  const page = await getPageContext();
  if (!page) redirect('/login');
  const { logger } = getRuntime();
  const cc = await loadClientCommandCenter(page.ctx, {
    onWidgetError: (widget, err) => logger.error({ err, widget, correlationId: page.ctx.correlationId }, 'command center widget failed'),
  });
  const { workspace, kpis } = cc;
  const tz = workspace.timezone;
  const canQuote = hasCapability(page.ctx, 'quotes.edit');

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Command center"
        title={workspace.name}
        description={
          <span className="flex flex-wrap items-center gap-1.5">
            <MetaChip icon={<Layers aria-hidden="true" />}>{workspace.planLabel} plan</MetaChip>
            <MetaChip icon={<Globe2 aria-hidden="true" />}>{tz}</MetaChip>
          </span>
        }
        meta={`As of ${formatDateTime(cc.asOf, tz)}`}
        actions={
          <>
            <RefreshButton />
            <Link href="/dashboard/user/inbox" className={buttonVariants({ variant: 'outline' })}>
              <Inbox aria-hidden="true" />
              Open inbox
            </Link>
            {canQuote ? (
              <GlowFrame>
                <Link href="/dashboard/user/quotations/new" className={buttonVariants()}>
                  <FilePlus2 aria-hidden="true" />
                  New quotation
                </Link>
              </GlowFrame>
            ) : null}
          </>
        }
      />

      <section aria-label="Key numbers" className="grid grid-cols-1 gap-4 min-[1440px]:grid-cols-[minmax(0,1fr)_22rem]">
        <Stagger className="grid min-w-0 grid-cols-1 gap-3 min-[420px]:grid-cols-2 sm:gap-4 md:grid-cols-3">
          <StaggerItem className="min-w-0">
            <KpiTile
              label={CLIENT_METRICS.newLeads.label}
              definition={CLIENT_METRICS.newLeads.definition}
              state={countState(kpis.newLeads, () => 'Created in the last 7 days')}
              icon={<UserPlus />}
            />
          </StaggerItem>
          <StaggerItem className="min-w-0">
            <KpiTile
              label={CLIENT_METRICS.openConversations.label}
              definition={CLIENT_METRICS.openConversations.definition}
              state={countState(kpis.openConversations, () => 'WhatsApp and email threads')}
              icon={<MessagesSquare />}
              hue="ice"
            />
          </StaggerItem>
          <StaggerItem className="min-w-0">
            <KpiTile
              label={CLIENT_METRICS.quotesAwaitingApproval.label}
              definition={CLIENT_METRICS.quotesAwaitingApproval.definition}
              state={countState(kpis.quotesAwaitingApproval, (n) => (n === 0 ? 'No drafts waiting' : 'Drafts waiting for a decision'))}
              icon={<ClipboardCheck />}
              hue="zest"
            />
          </StaggerItem>
          <StaggerItem className="min-w-0">
            <KpiTile
              label={CLIENT_METRICS.pipelineValue.label}
              definition={CLIENT_METRICS.pipelineValue.definition}
              state={moneyState(kpis.pipelineValue, (n) => `${plural(n, 'quotation', 'quotations')} sent or opened`)}
              icon={<TrendingUp />}
              hue="volt"
            />
          </StaggerItem>
          <StaggerItem className="min-w-0">
            <KpiTile
              label={CLIENT_METRICS.acceptedQuoteValue.label}
              definition={CLIENT_METRICS.acceptedQuoteValue.definition}
              state={moneyState(kpis.acceptedQuoteValue, (n) => `${plural(n, 'quotation', 'quotations')} accepted; not payments`)}
              icon={<BadgeCheck />}
              hue="volt"
            />
          </StaggerItem>
          <StaggerItem className="min-w-0">
            <KpiTile
              label={kpis.confirmedRevenue.label}
              definition={CONFIRMED_REVENUE.definition}
              state={{ ok: true, value: kpis.confirmedRevenue.value, hint: kpis.confirmedRevenue.reason }}
              icon={<CircleSlash />}
              tone="neutral"
            />
          </StaggerItem>
        </Stagger>
        <div aria-hidden="true" className="relative hidden min-h-56 overflow-hidden rounded-xl border border-border-subtle bg-bg-0 min-[1440px]:block">
          <AuraTile className="absolute inset-0" />
        </div>
      </section>

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-6">
          <SectionCard accent title={<ChipTitle icon={<BellRing aria-hidden="true" />} hue="zest">{CLIENT_METRICS.needsYou.label}</ChipTitle>} meta="Counted from the stored records; each line says what it counts.">
            {cc.needsYou.ok ? <NeedsYouList items={cc.needsYou.value} /> : <WidgetError what="This list" reference={cc.needsYou.reference} />}
          </SectionCard>

          <SectionCard
            title={<ChipTitle icon={<Filter aria-hidden="true" />} hue="volt">{CLIENT_METRICS.funnel.label}</ChipTitle>}
            meta={cc.funnel.ok ? `${plural(cc.funnel.value.total, 'lead', 'leads')}. ${CLIENT_METRICS.funnel.definition}` : CLIENT_METRICS.funnel.definition}
          >
            {!cc.funnel.ok ? (
              <WidgetError what="Leads by stage" reference={cc.funnel.reference} />
            ) : cc.funnel.value.total === 0 ? (
              <p className="rounded-lg border border-dashed border-border-strong bg-bg-2/40 px-4 py-3 text-sm text-fg-2">
                <span className="block font-medium text-fg-1">No leads yet</span>
                Leads arrive from the sources your AuraLead operator connects for this workspace: Google Sheets forms, Meta Lead Ads and the Maps extension. Each new lead is counted here in its sales stage.
              </p>
            ) : (
              <StageFunnel stages={cc.funnel.value.stages} total={cc.funnel.value.total} />
            )}
          </SectionCard>
        </div>

        <SectionCard className="min-w-0" title={<ChipTitle icon={<Activity aria-hidden="true" />} hue="ice">{CLIENT_METRICS.activity.label}</ChipTitle>} meta={CLIENT_METRICS.activity.definition}>
          {!cc.activity.ok ? (
            <WidgetError what="Recent activity" reference={cc.activity.reference} />
          ) : cc.activity.value.length === 0 ? (
            <p className="text-sm text-fg-2">Nothing has happened in this workspace yet.</p>
          ) : (
            <ActivityFeed entries={cc.activity.value} timeZone={tz} />
          )}
        </SectionCard>
      </div>
    </div>
  );
}
