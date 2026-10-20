'use client';

/**
 * The Pricing page body (T13): tabs for services, tax, discounts, timelines and history, rendered
 * from the server-read overview. Changes go through the /api/app/pricing route handlers and the
 * page re-reads the database after each one. Members without `pricing.override` see the same
 * data read-only, with the controls gated by permission (plan §12, the only gate used here).
 *
 * Aurora look (design spec §6): the tabs are a pill strip with icons and a sliding indicator
 * (motion layoutId) that scrolls on phones, fading the edge that has more tabs and bringing the
 * active tab into view. The Services list stays a real table; below md its rows are laid out as
 * cards (name, price, quantity range, discount limit, actions) while keeping row and cell markup.
 * Tables sit in `relative` scrollers so the sr-only header text cannot widen the page (the 355px
 * overflow at 390). Statuses carry an icon with their words; money is never colored. History
 * tables use the same row-as-card layout below sm, so a price is never scrolled out of sight.
 */
import { useCallback, useEffect, useRef, useState, type ComponentProps, type CSSProperties, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { Archive, BadgePercent, CalendarClock, CircleCheck, History, Pencil, Plus, Receipt, Tags, Timer, TriangleAlert, type LucideIcon } from 'lucide-react';
import { Tabs } from 'radix-ui';
import { IconChip } from '@/components/client/IconChip';
import { ScrollRegion } from '@/components/client/ScrollRegion';
import type { BrandHue } from '@/components/client/hues';
import { days } from '@/components/client/labels';
import { spring } from '@/components/motion/presets';
import { ConfirmDialog } from '@/components/patterns/ConfirmDialog';
import { EmptyState } from '@/components/patterns/EmptyState';
import { GatedAction, type Gate } from '@/components/patterns/GatedAction';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { GlowFrame } from '@/components/visual/GlowFrame';
import { Reveal } from '@/components/visual/Reveal';
import { formatDate, formatDateTime } from '@/lib/format/date';
import { formatINR } from '@/lib/money';
import { bpsToPercentString } from '@/lib/schemas/pricing';
import type { CatalogServiceDto, PricingOverviewDto } from '@/server/services/pricing/catalog';
import { ServiceDialog } from './service-dialog';
import { DiscountLimitForm, TaxForm, ValidityForm } from './settings-forms';
import { usePricingMutation, versionMessage, type VersionResult } from './use-pricing-mutation';

const TABS: ReadonlyArray<readonly [value: string, label: string, icon: LucideIcon]> = [
  ['services', 'Services', Tags],
  ['tax', 'Tax', Receipt],
  ['discounts', 'Discounts', BadgePercent],
  ['timelines', 'Timelines', Timer],
  ['history', 'History', History],
];

const OWNER_GATE: Gate = { category: 'permission', reason: 'Only the workspace owner can change pricing.' };

const money = (paise: string) => formatINR(BigInt(paise));
const pct = (bps: number | null) => (bps === null ? 'None' : `${bpsToPercentString(bps)}%`);
const qtyRange = (min: number, max: number) => `${min.toLocaleString('en-IN')} to ${max.toLocaleString('en-IN')}`;

/** Tab panels are focusable (Radix): keep the global focus outline, shaped like the cards inside. */
const TAB_PANEL = 'rounded-xl focus-visible:outline-offset-4';

const pill = 'inline-flex w-fit items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap';

/** A tab's section card. `flushBelowMd` drops the card surface on phones when its rows are cards themselves. */
function Panel(props: { title: string; description?: string; icon?: ReactNode; hue?: BrandHue; actions?: ReactNode; children: ReactNode; flushBelowMd?: boolean }) {
  return (
    <section className={cn('flex min-w-0 flex-col gap-4 rounded-xl border border-border-subtle bg-bg-1/80 p-4 sm:p-5', props.flushBelowMd && 'max-md:border-0 max-md:bg-transparent max-md:p-0')}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          {props.icon ? <IconChip hue={props.hue}>{props.icon}</IconChip> : null}
          <div className="flex min-w-0 flex-col gap-1">
            <h2 className="font-display text-lg font-semibold text-fg-1">{props.title}</h2>
            {props.description ? <p className="max-w-prose text-sm text-fg-2">{props.description}</p> : null}
          </div>
        </div>
        {props.actions}
      </div>
      {props.children}
    </section>
  );
}

function Th({ children, right, className }: { children: ReactNode; right?: boolean; className?: string }) {
  return (
    <th scope="col" className={cn('py-2 pr-3 font-medium', right && 'text-right', className)}>
      {children}
    </th>
  );
}

/** Visible below md only, where a services row is laid out as a card; the header names it above. */
function CardLabel({ children }: { children: ReactNode }) {
  return <span className="mb-1 block text-xs font-medium text-fg-3 md:hidden">{children}</span>;
}

/** Used as a Radix `asChild` trigger, so it forwards the injected props (onClick, aria-*, ref) to the button. */
function EditTrigger({ label, className, ...triggerProps }: { label: string } & ComponentProps<typeof Button>) {
  return (
    <Button variant="ghost" size="sm" aria-label={label} className={cn('text-fg-2 hover:bg-aura/10 hover:text-cyan', className)} {...triggerProps}>
      <Pencil aria-hidden="true" />
      Edit
    </Button>
  );
}

function ArchiveControl(props: { service: CatalogServiceDto; expectedVersion: number; workspaceName: string }) {
  const mutate = usePricingMutation();
  const { service } = props;
  return (
    <ConfirmDialog
      trigger={
        <Button variant="ghost" size="sm" aria-label={`Remove ${service.name}`} className="text-fg-2 hover:bg-danger/10 hover:text-danger">
          <Archive aria-hidden="true" />
          Remove
        </Button>
      }
      title={`Remove ${service.name}?`}
      description="New quotes can no longer use it. If it was ever priced or quoted it is archived, so issued quotes and the price history keep it; the price list moves to a new version."
      confirmLabel="Remove service"
      pendingLabel="Removing"
      destructive
      workspaceName={props.workspaceName}
      onConfirm={async () => {
        const outcome = await mutate<VersionResult & { outcome: 'archived' | 'deleted' }>(
          `/api/app/pricing/services/${encodeURIComponent(service.id)}/archive`,
          { expectedVersion: props.expectedVersion },
          (data) => (data.outcome === 'deleted' ? `Deleted ${service.name}. Nothing referenced it.` : versionMessage(`Archived ${service.name}.`, data)),
        );
        return outcome.ok ? { ok: true } : { ok: false, message: outcome.message, reference: outcome.reference };
      }}
    />
  );
}

function ServiceActions(props: { service: CatalogServiceDto; canEdit: boolean; expectedVersion: number; workspaceName: string }) {
  if (!props.canEdit) return <span className="text-xs text-fg-3">Owner only</span>;
  return (
    <div className="flex gap-1 md:justify-end">
      <ServiceDialog service={props.service} expectedVersion={props.expectedVersion} workspaceName={props.workspaceName} trigger={<EditTrigger label={`Edit ${props.service.name}`} />} />
      <ArchiveControl service={props.service} expectedVersion={props.expectedVersion} workspaceName={props.workspaceName} />
    </div>
  );
}

function ServicesTab({ overview, expectedVersion }: { overview: PricingOverviewDto; expectedVersion: number }) {
  const active = overview.services.filter((s) => s.archivedAt === null);
  const archived = overview.services.filter((s) => s.archivedAt !== null);
  const ws = overview.workspace.name;
  const addButton = overview.canEdit ? (
    <GlowFrame>
      <ServiceDialog
        service={null}
        expectedVersion={expectedVersion}
        workspaceName={ws}
        trigger={
          <Button>
            <Plus aria-hidden="true" />
            Add service
          </Button>
        }
      />
    </GlowFrame>
  ) : (
    <GatedAction label="Add service" icon={<Plus aria-hidden="true" />} gate={OWNER_GATE} href="/dashboard/user/pricing" />
  );

  if (active.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <EmptyState icon={<Tags aria-hidden="true" className="size-5" />} title="No services" description="Add your first service and its price. Quotes can only use services listed here." action={addButton} />
        {archived.length > 0 ? <ArchivedList services={archived} tz={overview.workspace.timezone} /> : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Panel
        title="Services"
        flushBelowMd
        icon={<Tags aria-hidden="true" />}
        description={overview.activeVersion ? `Prices from price list v${overview.activeVersion.version}.` : 'No price list yet.'}
        actions={addButton}
      >
        <div className="relative md:-mx-1.5 md:overflow-x-auto md:px-1.5">
          <table className="w-full text-left text-sm md:min-w-[720px]">
            <caption className="sr-only">Services with their price in the active price list</caption>
            <thead className="text-xs text-fg-2 max-md:sr-only">
              <tr className="border-b border-border-subtle">
                <Th>Service</Th>
                <Th right>Unit price</Th>
                <Th>Quantity</Th>
                <Th>Discount limit</Th>
                <Th right>
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody className="max-md:flex max-md:flex-col max-md:gap-3">
              {active.map((s) => (
                <tr
                  key={s.id}
                  className="border-b border-border-subtle align-top transition-colors duration-fast last:border-b-0 md:hover:bg-bg-2/50 max-md:grid max-md:grid-cols-2 max-md:gap-x-3 max-md:gap-y-3 max-md:rounded-xl max-md:border max-md:bg-bg-1/80 max-md:p-4 max-md:last:border-b"
                >
                  <td className="py-3 pr-3 max-md:col-span-2 max-md:p-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-fg-1">{s.name}</span>
                      <span className="rounded-md border border-border-subtle bg-bg-2 px-1.5 py-0.5 font-mono text-[11px] text-fg-2">{s.code}</span>
                    </div>
                    {s.description ? <p className="mt-1 max-w-md text-sm text-fg-2">{s.description}</p> : null}
                  </td>
                  <td className="tabular py-3 pr-3 text-right whitespace-nowrap text-fg-1 max-md:col-span-2 max-md:p-0 max-md:text-left">
                    <CardLabel>Unit price</CardLabel>
                    {s.price ? (
                      <span className="max-md:font-display max-md:text-lg max-md:font-semibold">
                        {money(s.price.unitPricePaise)}
                        <span className="font-sans text-sm font-normal text-fg-3"> / {s.unitLabel}</span>
                      </span>
                    ) : (
                      <span className={cn(pill, 'border-warning/35 bg-warning/12 text-warning')}>
                        <TriangleAlert aria-hidden="true" className="size-3.5" />
                        Not priced: quotes need review
                      </span>
                    )}
                  </td>
                  <td className="py-3 pr-3 max-md:p-0">
                    <CardLabel>Quantity</CardLabel>
                    {s.price ? <span className={cn(pill, 'tabular border-border-strong bg-bg-2 text-fg-2')}>{qtyRange(s.price.minQty, s.price.maxQty)}</span> : <span className="text-fg-2">Not set</span>}
                  </td>
                  <td className="py-3 pr-3 max-md:p-0">
                    <CardLabel>Discount limit</CardLabel>
                    {s.maxDiscountBps === null ? (
                      <span className="text-fg-2">Workspace limit</span>
                    ) : (
                      <span className={cn(pill, 'tabular border-border-strong bg-bg-2 text-fg-1')}>
                        <BadgePercent aria-hidden="true" className="size-3.5 text-zest" />
                        {pct(s.maxDiscountBps)}
                      </span>
                    )}
                  </td>
                  <td className="py-3 text-right max-md:col-span-2 max-md:border-t max-md:border-border-subtle max-md:p-0 max-md:pt-2 max-md:text-left">
                    <ServiceActions service={s} canEdit={overview.canEdit} expectedVersion={expectedVersion} workspaceName={ws} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      {archived.length > 0 ? <ArchivedList services={archived} tz={overview.workspace.timezone} /> : null}
    </div>
  );
}

function ArchivedList({ services, tz }: { services: CatalogServiceDto[]; tz: string }) {
  return (
    <details className="group rounded-xl border border-border-subtle bg-bg-1/80 p-4 sm:p-5">
      <summary className="flex cursor-pointer items-center gap-2 font-medium text-fg-1">
        <Archive aria-hidden="true" className="size-4 text-fg-3" />
        Archived services ({services.length})
      </summary>
      <p className="mt-2 text-sm text-fg-2">Kept so issued quotes and older price lists stay readable. New quotes cannot use them.</p>
      <ul className="mt-3 flex flex-col">
        {services.map((s) => (
          <li key={s.id} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-border-subtle py-2 last:border-b-0">
            <span className="text-fg-1">
              {s.name} <span className="font-mono text-xs text-fg-3">{s.code}</span>
            </span>
            <span className="text-sm text-fg-2">Archived {formatDate(new Date(s.archivedAt!), tz)}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

function ServiceValueList(props: { services: CatalogServiceDto[]; value: (s: CatalogServiceDto) => ReactNode; action?: (s: CatalogServiceDto) => ReactNode }) {
  if (props.services.length === 0) return <p className="text-fg-2">No services yet.</p>;
  return (
    <ul className="flex flex-col">
      {props.services.map((s) => (
        <li key={s.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border-subtle py-2 last:border-b-0">
          <span className="min-w-0 text-fg-1">{s.name}</span>
          <span className="flex items-center gap-2">
            {props.value(s)}
            {props.action?.(s)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function DiscountsTab({ overview, expectedVersion, gate }: { overview: PricingOverviewDto; expectedVersion: number; gate: Gate | null }) {
  const active = overview.services.filter((s) => s.archivedAt === null);
  return (
    <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
      <Panel title="Workspace limit" icon={<BadgePercent aria-hidden="true" />} hue="zest" description="The largest discount any quote may carry, as a percentage of the subtotal.">
        <DiscountLimitForm key={overview.settings.updatedAt} settings={overview.settings} gate={gate} />
      </Panel>
      <Panel
        title="Service limits"
        icon={<Tags aria-hidden="true" />}
        hue="zest"
        description="A quote that includes one of these services is limited to the lowest limit among its services and the workspace limit."
      >
        <ServiceValueList
          services={active}
          value={(s) =>
            s.maxDiscountBps === null ? (
              <span className="tabular text-sm text-fg-2">Workspace limit ({pct(overview.settings.maxDiscountBps)})</span>
            ) : (
              <span className={cn(pill, 'tabular border-border-strong bg-bg-2 text-fg-1')}>
                <BadgePercent aria-hidden="true" className="size-3.5 text-zest" />
                {pct(Math.min(s.maxDiscountBps, overview.settings.maxDiscountBps))}
              </span>
            )
          }
          action={(s) =>
            overview.canEdit ? <ServiceDialog service={s} expectedVersion={expectedVersion} workspaceName={overview.workspace.name} trigger={<EditTrigger label={`Edit discount limit of ${s.name}`} />} /> : null
          }
        />
      </Panel>
    </div>
  );
}

function TimelinesTab({ overview, expectedVersion, gate }: { overview: PricingOverviewDto; expectedVersion: number; gate: Gate | null }) {
  const active = overview.services.filter((s) => s.archivedAt === null);
  return (
    <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
      <Panel title="Validity of new quotes" icon={<CalendarClock aria-hidden="true" />} hue="ice">
        <ValidityForm key={overview.settings.updatedAt} settings={overview.settings} gate={gate} />
      </Panel>
      <Panel title="Typical timelines" icon={<Timer aria-hidden="true" />} hue="ice" description="Suggested delivery time per service, used when a quote's timeline is drafted.">
        <ServiceValueList
          services={active}
          value={(s) =>
            s.defaultTimelineDays === null ? (
              <span className="text-sm text-fg-2">Not set</span>
            ) : (
              <span className={cn(pill, 'tabular border-border-strong bg-bg-2 text-fg-1')}>
                <Timer aria-hidden="true" className="size-3.5 text-ice" />
                {days(s.defaultTimelineDays)}
              </span>
            )
          }
          action={(s) =>
            overview.canEdit ? <ServiceDialog service={s} expectedVersion={expectedVersion} workspaceName={overview.workspace.name} trigger={<EditTrigger label={`Edit timeline of ${s.name}`} />} /> : null
          }
        />
      </Panel>
    </div>
  );
}

function HistoryTab({ overview }: { overview: PricingOverviewDto }) {
  const tz = overview.workspace.timezone;
  if (overview.versions.length === 0) {
    return <EmptyState title="No price list versions yet" description="A version is published each time a price is added, changed or removed." />;
  }
  return (
    <Panel
      title="Price list history"
      icon={<History aria-hidden="true" />}
      hue="volt"
      description="Read-only. Each version is the full price list at the time it was published; issued quotes point at the version they used."
    >
      <ol className="relative flex flex-col gap-3 pl-9 before:absolute before:top-3 before:bottom-3 before:left-3.5 before:w-px before:bg-[linear-gradient(to_bottom,var(--panel-hue),color-mix(in_oklab,var(--panel-hue-2)_60%,transparent),transparent)]">
        {overview.versions.map((v) => (
          <li key={v.id} className="relative">
            <span
              aria-hidden="true"
              className={cn(
                'absolute top-2.5 -left-9 flex size-7 items-center justify-center rounded-full bg-bg-1 ring-1 [&>svg]:size-3.5',
                v.active ? 'text-success ring-success/45' : 'text-volt-hi ring-volt-hi/35',
              )}
            >
              {v.active ? <CircleCheck /> : <History />}
            </span>
            <details className="rounded-lg border border-border-subtle bg-bg-2/60 px-4 py-3 open:border-border-strong" open={v.active}>
              <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1">
                <span className="font-display font-semibold text-fg-1">v{v.version}</span>
                {v.active ? (
                  <span className={cn(pill, 'border-success/35 bg-success/12 text-success')}>
                    <CircleCheck aria-hidden="true" className="size-3.5" />
                    Active
                  </span>
                ) : null}
                <span className="text-sm text-fg-2">{v.note}</span>
                <span className="text-xs text-fg-3">
                  {formatDateTime(new Date(v.createdAt), tz)}
                  {v.createdByName ? ` by ${v.createdByName}` : ''}
                </span>
              </summary>
              {v.entries.length === 0 ? (
                <p className="mt-2 text-sm text-fg-2">Empty price list.</p>
              ) : (
                <ScrollRegion label={`Prices in version ${v.version}`} className="mt-3">
                  <table className="w-full text-left text-sm sm:min-w-[480px]">
                    <caption className="sr-only">Prices in version {v.version}</caption>
                    <thead className="text-xs text-fg-2 max-sm:sr-only">
                      <tr className="border-b border-border-subtle">
                        <Th>Service</Th>
                        <Th right>Unit price</Th>
                        <Th>Quantity</Th>
                      </tr>
                    </thead>
                    <tbody className="max-sm:flex max-sm:flex-col">
                      {v.entries.map((e) => (
                        <tr
                          key={e.serviceId}
                          className="border-b border-border-subtle last:border-b-0 max-sm:grid max-sm:grid-cols-[minmax(0,1fr)_auto] max-sm:items-baseline max-sm:gap-x-3 max-sm:gap-y-0.5 max-sm:py-2.5"
                        >
                          <td className="py-2 pr-3 text-fg-1 max-sm:col-span-2 max-sm:p-0">
                            {e.name} <span className="font-mono text-xs text-fg-3">{e.code}</span>
                          </td>
                          <td className="tabular py-2 pr-3 text-right whitespace-nowrap text-fg-1 max-sm:order-2 max-sm:p-0">
                            {money(e.unitPricePaise)}
                            <span className="text-fg-3"> / {e.unitLabel}</span>
                          </td>
                          <td className="tabular py-2 pr-3 text-fg-2 max-sm:order-1 max-sm:p-0 max-sm:text-xs">{qtyRange(e.minQty, e.maxQty)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </ScrollRegion>
              )}
            </details>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

/** The scrollable tab strip: fades whichever edge has more tabs and keeps the active tab in view. */
function TabStrip(props: { active: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: true });
  const firstRender = useRef(true);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const start = el.scrollLeft <= 1;
    const end = el.scrollLeft + el.clientWidth >= el.scrollWidth - 1;
    setEdges((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, []);

  useEffect(() => {
    measure();
    const el = ref.current;
    if (!el || typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const tab = ref.current?.querySelector<HTMLElement>(`[data-tab="${props.active}"]`);
    tab?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [props.active]);

  const left = edges.start ? '#000' : 'transparent';
  const right = edges.end ? '#000' : 'transparent';
  const style: CSSProperties | undefined =
    edges.start && edges.end ? undefined : { maskImage: `linear-gradient(90deg, ${left} 0, #000 28px, #000 calc(100% - 28px), ${right} 100%)` };
  return (
    <div ref={ref} onScroll={measure} style={style} className="-mx-4 snap-x scroll-px-4 overflow-x-auto px-4 [scrollbar-width:none] sm:mx-0 sm:px-0 [&::-webkit-scrollbar]:hidden">
      {props.children}
    </div>
  );
}

export function PricingWorkspace({ overview }: { overview: PricingOverviewDto }) {
  const [tab, setTab] = useState<string>('services');
  const expectedVersion = overview.activeVersion?.version ?? 0;
  const gate = overview.canEdit ? null : OWNER_GATE;
  const settingsKey = overview.settings.updatedAt;

  return (
    <Tabs.Root value={tab} onValueChange={setTab} className="flex min-w-0 flex-col gap-4">
      <TabStrip active={tab}>
        <Tabs.List aria-label="Pricing sections" className="inline-flex gap-1 rounded-full border border-border-subtle bg-bg-1/80 p-1">
          {TABS.map(([value, label, Icon]) => (
            <Tabs.Trigger
              key={value}
              value={value}
              data-tab={value}
              className="group relative isolate inline-flex min-h-9 shrink-0 snap-start items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium text-fg-2 transition-colors duration-fast hover:text-fg-1 data-[state=active]:text-fg-1"
            >
              {tab === value ? (
                <motion.span layoutId="pricing-tab-pill" transition={spring.smooth} aria-hidden="true" className="absolute inset-0 -z-10 rounded-full bg-panel/14 ring-1 ring-panel/40 ring-inset" />
              ) : null}
              <Icon aria-hidden="true" className="size-4 shrink-0 text-fg-3 transition-colors duration-fast group-hover:text-fg-2 group-data-[state=active]:text-panel" />
              {label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
      </TabStrip>
      {!overview.canEdit ? <p className="text-sm text-fg-2">You can view pricing. Only the workspace owner can change it.</p> : null}
      <Tabs.Content value="services" className={TAB_PANEL}>
        <Reveal>
          <ServicesTab overview={overview} expectedVersion={expectedVersion} />
        </Reveal>
      </Tabs.Content>
      <Tabs.Content value="tax" className={TAB_PANEL}>
        <Reveal>
          <Panel title="Tax" icon={<Receipt aria-hidden="true" />} hue="zest" description="Quotes carry at most one tax line, computed on the subtotal after discount.">
            <TaxForm key={settingsKey} settings={overview.settings} gate={gate} />
          </Panel>
        </Reveal>
      </Tabs.Content>
      <Tabs.Content value="discounts" className={TAB_PANEL}>
        <Reveal>
          <DiscountsTab overview={overview} expectedVersion={expectedVersion} gate={gate} />
        </Reveal>
      </Tabs.Content>
      <Tabs.Content value="timelines" className={TAB_PANEL}>
        <Reveal>
          <TimelinesTab overview={overview} expectedVersion={expectedVersion} gate={gate} />
        </Reveal>
      </Tabs.Content>
      <Tabs.Content value="history" className={TAB_PANEL}>
        <Reveal>
          <HistoryTab overview={overview} />
        </Reveal>
      </Tabs.Content>
      {overview.activeVersion ? (
        <p className="text-xs text-fg-3">Active price list v{overview.activeVersion.version} since {formatDateTime(new Date(overview.activeVersion.createdAt), overview.workspace.timezone)}.</p>
      ) : null}
    </Tabs.Root>
  );
}
