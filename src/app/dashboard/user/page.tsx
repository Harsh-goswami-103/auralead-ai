/**
 * Client panel home (T09, M1): the signed-in owner's workspace, read through the tenant-scoped
 * context: catalog priced from the active pricing version, quote settings, the active scoring
 * and pipeline versions and the team. Later tasks add the DB-derived command-center metrics.
 *
 * Aurora look (design spec §6): PageHeader with the workspace name as the gradient h1, a strip of
 * StatTiles built only from the data this page already reads (no invented metrics, no count-up;
 * each links to Pricing, where the fact is changed), the decorative Aura tile from 1440px, then
 * SectionCards in rows of equal height: the catalog beside the active configuration, the pipeline
 * as a full-width stepper rail that draws itself once, and the terms beside the team. Each fact
 * appears once on the page. Every grid column has a zero minimum; below sm the catalog rows are
 * laid out as two-line cards (name and price, then code and timeline) while staying table rows.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';
import {
  ArrowRight,
  BadgePercent,
  CalendarClock,
  CalendarDays,
  Clock,
  Crown,
  FilePlus2,
  Gauge,
  Globe2,
  Hand,
  History,
  Inbox,
  Layers,
  Receipt,
  ScrollText,
  Send,
  SlidersHorizontal,
  Tags,
  UserRound,
  Users,
  Workflow,
} from 'lucide-react';
import { ChipTitle, IconChip } from '@/components/client/IconChip';
import { InitialsAvatar } from '@/components/client/InitialsAvatar';
import { PipelineStepper } from '@/components/client/PipelineStepper';
import { ScrollRegion } from '@/components/client/ScrollRegion';
import { HUE_TILE, type BrandHue } from '@/components/client/hues';
import { days, plural } from '@/components/client/labels';
import { PageHeader } from '@/components/patterns/PageHeader';
import { SectionCard } from '@/components/patterns/SectionCard';
import { StatTile } from '@/components/patterns/StatTile';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { GlowFrame } from '@/components/visual/GlowFrame';
import { Stagger, StaggerItem } from '@/components/visual/Reveal';
import { AuraTile } from '@/components/visual/aura';
import { DotPattern } from '@/components/visual/Patterns';
import { formatDate } from '@/lib/format/date';
import { formatINR } from '@/lib/money';
import { hasCapability } from '@/server/auth/guards';
import { getPageContext } from '@/server/auth/page-context';
import { loadUserHome } from '@/server/services/shell/panel-home';

export const metadata: Metadata = { title: 'Command center' };
export const dynamic = 'force-dynamic';

const percent = (bps: number) => `${(bps / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}%`;

function MetaChip(props: { icon: ReactNode; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border-subtle bg-bg-1/70 px-2.5 py-1 text-xs text-fg-2 [&>svg]:size-3.5 [&>svg]:shrink-0 [&>svg]:text-panel">
      {props.icon}
      {props.children}
    </span>
  );
}

/**
 * One fact of a card: icon chip + label, the value right-aligned, and an optional note on its own
 * line under the label (a dl group may hold several dd), so a long explanation never squeezes the
 * value column.
 */
function Row(props: { label: string; icon: ReactNode; hue?: BrandHue; note?: ReactNode; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 border-b border-border-subtle py-2.5 last:border-b-0">
      <dt className="flex min-w-0 items-center gap-2.5 text-fg-2">
        <IconChip size="sm" hue={props.hue}>
          {props.icon}
        </IconChip>
        <span className="min-w-0">{props.label}</span>
      </dt>
      <dd className="text-right text-fg-1">{props.children}</dd>
      {props.note ? <dd className="col-span-2 pl-9.5 text-xs text-fg-2">{props.note}</dd> : null}
    </div>
  );
}

/** KPI tiles fill their grid cell; below sm the icon chip steps aside so labels stay on one line. */
const TILE = 'h-full max-sm:[&>div>span]:hidden';

const pricingLink = (
  <Link href="/dashboard/user/pricing" className="group inline-flex min-h-9 items-center gap-1 text-sm font-medium text-cyan underline-offset-4 hover:underline">
    Open Pricing
    <ArrowRight aria-hidden="true" className="size-3.5 transition-transform duration-fast motion-safe:group-hover:translate-x-0.5" />
  </Link>
);

export default async function UserHomePage() {
  const page = await getPageContext();
  if (!page) redirect('/login');
  const home = await loadUserHome(page.ctx);
  const { workspace, settings, pipeline } = home;
  const tz = workspace.timezone;
  const canQuote = hasCapability(page.ctx, 'quotes.edit');
  const priced = home.services.filter((s) => s.unitPricePaise !== null).length;
  const terms = (settings?.termsText ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Command center"
        title={workspace.name}
        description={
          <span className="flex flex-wrap items-center gap-1.5">
            <MetaChip icon={workspace.role === 'OWNER' ? <Crown aria-hidden="true" /> : <UserRound aria-hidden="true" />}>{workspace.role === 'OWNER' ? 'Owner' : 'Member'}</MetaChip>
            <MetaChip icon={<Layers aria-hidden="true" />}>{workspace.planLabel} plan</MetaChip>
            <MetaChip icon={<Globe2 aria-hidden="true" />}>{tz}</MetaChip>
            <MetaChip icon={<CalendarDays aria-hidden="true" />}>On AuraLead since {formatDate(workspace.createdAt, tz)}</MetaChip>
          </span>
        }
        actions={
          <>
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

      <section aria-label="At a glance" className="grid grid-cols-1 gap-4 min-[1440px]:grid-cols-[minmax(0,1fr)_22rem]">
        <Stagger className="grid min-w-0 grid-cols-2 gap-3 sm:gap-4 lg:max-[1439px]:grid-cols-4">
          <StaggerItem className="min-w-0">
            <StatTile
              label="Services priced"
              value={
                <>
                  {priced}
                  <span className="text-base font-medium text-fg-2"> / {home.services.length}</span>
                </>
              }
              hint={priced === home.services.length ? 'Every service has a price' : `${plural(home.services.length - priced, 'service needs', 'services need')} a price`}
              icon={<Tags />}
              href="/dashboard/user/pricing"
              className={cn(TILE, HUE_TILE.aura)}
            />
          </StaggerItem>
          <StaggerItem className="min-w-0">
            <StatTile
              label="Price list"
              value={home.pricing ? `v${home.pricing.version}` : 'None'}
              hint={home.pricing ? `Published ${formatDate(home.pricing.createdAt, tz)}` : 'Add a service to publish one'}
              icon={<History />}
              href="/dashboard/user/pricing"
              className={cn(TILE, HUE_TILE.volt)}
            />
          </StaggerItem>
          <StaggerItem className="min-w-0">
            <StatTile
              label="Maximum discount"
              value={settings ? percent(settings.maxDiscountBps) : 'Not set'}
              hint="Limit on any quote"
              icon={<BadgePercent />}
              href="/dashboard/user/pricing"
              className={cn(TILE, HUE_TILE.zest)}
            />
          </StaggerItem>
          <StaggerItem className="min-w-0">
            <StatTile
              label="Quote validity"
              value={settings ? days(settings.quoteValidityDays) : 'Not set'}
              hint="New quotes lapse after this"
              icon={<CalendarClock />}
              href="/dashboard/user/pricing"
              className={cn(TILE, HUE_TILE.ice)}
            />
          </StaggerItem>
        </Stagger>
        <div aria-hidden="true" className="relative hidden min-h-56 overflow-hidden rounded-xl border border-border-subtle bg-bg-0 min-[1440px]:block">
          <AuraTile className="absolute inset-0" />
        </div>
      </section>

      <Stagger className="grid grid-cols-1 gap-6 xl:grid-cols-3" delay={0.15}>
        <StaggerItem className="min-w-0 xl:col-span-2" variant="fade">
          <SectionCard
            accent
            className="h-full"
            title={<ChipTitle icon={<Tags aria-hidden="true" />}>Service catalog</ChipTitle>}
            meta={home.pricing ? `${plural(home.services.length, 'service', 'services')} from price list v${home.pricing.version}` : 'No active price list'}
            actions={pricingLink}
          >
            <ScrollRegion label="Service catalog table">
              <table className="w-full text-left text-sm sm:min-w-[520px]">
                <caption className="sr-only">Services and unit prices from the active price list</caption>
                <thead className="text-xs text-fg-2 max-sm:sr-only">
                  <tr className="border-b border-border-subtle">
                    <th scope="col" className="py-2 pr-3 font-medium">
                      Service
                    </th>
                    <th scope="col" className="py-2 pr-3 font-medium">
                      Code
                    </th>
                    <th scope="col" className="py-2 pr-3 font-medium">
                      Typical timeline
                    </th>
                    <th scope="col" className="py-2 text-right font-medium">
                      Unit price
                    </th>
                  </tr>
                </thead>
                <tbody className="max-sm:flex max-sm:flex-col">
                  {home.services.map((s) => (
                    <tr
                      key={s.code}
                      className="border-b border-border-subtle transition-colors duration-fast last:border-b-0 sm:hover:bg-bg-2/60 max-sm:grid max-sm:grid-cols-[minmax(0,1fr)_auto] max-sm:items-center max-sm:gap-x-3 max-sm:gap-y-1.5 max-sm:py-3"
                    >
                      <td className="py-2.5 pr-3 font-medium text-fg-1 max-sm:order-1 max-sm:p-0">{s.name}</td>
                      <td className="py-2.5 pr-3 max-sm:order-3 max-sm:p-0">
                        <span className="rounded-md border border-border-subtle bg-bg-2 px-1.5 py-0.5 font-mono text-[11px] text-fg-2">{s.code}</span>
                      </td>
                      <td className="tabular py-2.5 pr-3 text-fg-2 max-sm:order-4 max-sm:justify-self-end max-sm:p-0 max-sm:text-xs">
                        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
                          <Clock aria-hidden="true" className="size-3.5 text-fg-3" />
                          {s.defaultTimelineDays === null ? 'Not set' : days(s.defaultTimelineDays)}
                        </span>
                      </td>
                      <td className="tabular py-2.5 text-right whitespace-nowrap text-fg-1 max-sm:order-2 max-sm:p-0">
                        {s.unitPricePaise === null ? 'Not priced' : formatINR(s.unitPricePaise)}
                        <span className="text-fg-3"> / {s.unitLabel}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollRegion>
          </SectionCard>
        </StaggerItem>

        <StaggerItem className="min-w-0">
          <SectionCard className="h-full" title={<ChipTitle icon={<SlidersHorizontal aria-hidden="true" />} hue="zest">Active configuration</ChipTitle>} meta="What new quotes and replies follow">
            <dl className="flex flex-col text-sm">
              <Row label="Tax" icon={<Receipt />} hue="zest">
                {settings ? (settings.taxMode === 'CONFIGURED' && settings.taxBps !== null ? `${settings.taxLabel ?? 'Tax'} ${percent(settings.taxBps)}` : 'No tax') : 'Not set'}
              </Row>
              <Row
                label="Automatic sending"
                icon={settings?.autoSendEnabled ? <Send /> : <Hand />}
                hue="zest"
                note={settings ? (settings.autoSendEnabled ? 'Threads set to Auto may send safe replies' : 'Every send needs a person') : undefined}
              >
                {settings?.autoSendEnabled ? (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-info/35 bg-info/12 px-2 py-0.5 text-xs font-medium text-info">
                    <Send aria-hidden="true" className="size-3.5" />
                    On
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-border-strong bg-bg-2 px-2 py-0.5 text-xs font-medium text-fg-1">
                    <Hand aria-hidden="true" className="size-3.5 text-fg-2" />
                    Off
                  </span>
                )}
              </Row>
              <Row label="Lead scoring" icon={<Gauge />} hue="volt">
                {home.scoring ? `v${home.scoring.version}, since ${formatDate(home.scoring.createdAt, tz)}` : 'None'}
              </Row>
              <Row label="Pipeline" icon={<Workflow />} hue="volt">
                {pipeline ? `v${pipeline.version}, ${pipeline.approvalMode === 'HUMAN' ? 'human approval' : 'policy approval'}` : 'None'}
              </Row>
            </dl>
          </SectionCard>
        </StaggerItem>

        {pipeline ? (
          <StaggerItem className="min-w-0 xl:col-span-3">
            <SectionCard
              title={<ChipTitle icon={<Workflow aria-hidden="true" />} hue="volt">Pipeline stages</ChipTitle>}
              meta={`What happens to every new lead, in order. Version ${pipeline.version}, ${pipeline.approvalMode === 'HUMAN' ? 'a person approves before anything is sent' : 'policy approval'}.`}
            >
              <div className="relative isolate overflow-hidden rounded-lg border border-border-subtle bg-bg-0/40 px-1 py-4 sm:px-4 sm:py-5">
                <DotPattern fade="radial" className="opacity-60" />
                <PipelineStepper stages={pipeline.stages} size="lg" inView />
              </div>
            </SectionCard>
          </StaggerItem>
        ) : null}

        {settings ? (
          <StaggerItem className="min-w-0 xl:col-span-2">
            <SectionCard className="h-full" title={<ChipTitle icon={<ScrollText aria-hidden="true" />}>Quotation terms</ChipTitle>} meta="Printed on every quotation">
              <ul className="flex flex-col gap-2 text-sm text-fg-2">
                {terms.map((line, i) => (
                  <li key={i} className="flex gap-2.5">
                    <span aria-hidden="true" className="mt-[0.45rem] size-1.5 shrink-0 rounded-full bg-panel/70" />
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
            </SectionCard>
          </StaggerItem>
        ) : null}

        <StaggerItem className={cn('min-w-0', !settings && 'xl:col-span-3')}>
          <SectionCard className="h-full" title={<ChipTitle icon={<Users aria-hidden="true" />} hue="ice">Team</ChipTitle>} meta={plural(home.members.length, 'person', 'people')}>
            <ul className="flex flex-col">
              {home.members.map((m, i) => (
                <li key={`${m.name}-${m.role}-${i}`} className="flex items-center gap-3 border-b border-border-subtle py-2.5 last:border-b-0">
                  <InitialsAvatar name={m.name} />
                  <span className="min-w-0 flex-1 truncate text-fg-1">{m.name}</span>
                  <span
                    className={cn(
                      'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium',
                      m.role === 'OWNER' ? 'border-panel/35 bg-panel/10 text-fg-1' : 'border-border-strong bg-bg-2 text-fg-2',
                    )}
                  >
                    {m.role === 'OWNER' ? <Crown aria-hidden="true" className="size-3 text-panel" /> : null}
                    {m.role === 'OWNER' ? 'Owner' : 'Member'}
                  </span>
                </li>
              ))}
            </ul>
          </SectionCard>
        </StaggerItem>
      </Stagger>
    </div>
  );
}
