'use client';

/**
 * The Pricing page body (T13): tabs for services, tax, discounts, timelines and history, rendered
 * from the server-read overview. Changes go through the /api/app/pricing route handlers and the
 * page re-reads the database after each one. Members without `pricing.override` see the same
 * data read-only, with the controls gated by permission (plan §12, the only gate used here).
 */
import { useState, type ComponentProps, type ReactNode } from 'react';
import { Archive, Pencil, Plus, Tags } from 'lucide-react';
import { Tabs } from 'radix-ui';
import { ConfirmDialog } from '@/components/patterns/ConfirmDialog';
import { EmptyState } from '@/components/patterns/EmptyState';
import { GatedAction, type Gate } from '@/components/patterns/GatedAction';
import { Button } from '@/components/ui/button';
import { formatDate, formatDateTime } from '@/lib/format/date';
import { formatINR } from '@/lib/money';
import { bpsToPercentString } from '@/lib/schemas/pricing';
import type { CatalogServiceDto, PricingOverviewDto } from '@/server/services/pricing/catalog';
import { ServiceDialog } from './service-dialog';
import { DiscountLimitForm, TaxForm, ValidityForm } from './settings-forms';
import { usePricingMutation, versionMessage, type VersionResult } from './use-pricing-mutation';

const TABS = [
  ['services', 'Services'],
  ['tax', 'Tax'],
  ['discounts', 'Discounts'],
  ['timelines', 'Timelines'],
  ['history', 'History'],
] as const;

const OWNER_GATE: Gate = { category: 'permission', reason: 'Only the workspace owner can change pricing.' };

const money = (paise: string) => formatINR(BigInt(paise));
const pct = (bps: number | null) => (bps === null ? 'None' : `${bpsToPercentString(bps)}%`);

function Panel(props: { title: string; description?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4 rounded-xl border border-border-subtle bg-bg-1 p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="font-display text-lg font-semibold text-fg-1">{props.title}</h2>
          {props.description ? <p className="max-w-prose text-sm text-fg-2">{props.description}</p> : null}
        </div>
        {props.actions}
      </div>
      {props.children}
    </section>
  );
}

function Th({ children, right }: { children: ReactNode; right?: boolean }) {
  return (
    <th scope="col" className={`py-2 pr-3 font-medium ${right ? 'text-right' : ''}`}>
      {children}
    </th>
  );
}

/** Used as a Radix `asChild` trigger, so it forwards the injected props (onClick, aria-*, ref) to the button. */
function EditTrigger({ label, ...triggerProps }: { label: string } & ComponentProps<typeof Button>) {
  return (
    <Button variant="ghost" size="sm" aria-label={label} {...triggerProps}>
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
        <Button variant="ghost" size="sm" aria-label={`Remove ${service.name}`}>
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
    <div className="flex justify-end gap-1">
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
        description={overview.activeVersion ? `Prices from price list v${overview.activeVersion.version}.` : 'No price list yet.'}
        actions={addButton}
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left">
            <caption className="sr-only">Services with their price in the active price list</caption>
            <thead className="text-xs text-fg-2">
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
            <tbody>
              {active.map((s) => (
                <tr key={s.id} className="border-b border-border-subtle align-top last:border-b-0">
                  <td className="py-3 pr-3">
                    <div className="font-medium text-fg-1">{s.name}</div>
                    <div className="font-mono text-xs text-fg-3">{s.code}</div>
                    {s.description ? <p className="mt-1 max-w-md text-sm text-fg-2">{s.description}</p> : null}
                  </td>
                  <td className="tabular py-3 pr-3 text-right whitespace-nowrap text-fg-1">
                    {s.price ? (
                      <>
                        {money(s.price.unitPricePaise)}
                        <span className="text-fg-3"> / {s.unitLabel}</span>
                      </>
                    ) : (
                      <span className="text-warning">Not priced: quotes need review</span>
                    )}
                  </td>
                  <td className="tabular py-3 pr-3 whitespace-nowrap text-fg-2">{s.price ? `${s.price.minQty} to ${s.price.maxQty.toLocaleString('en-IN')}` : 'Not set'}</td>
                  <td className="tabular py-3 pr-3 text-fg-2">{s.maxDiscountBps === null ? 'Workspace limit' : pct(s.maxDiscountBps)}</td>
                  <td className="py-3 text-right">
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
    <details className="rounded-xl border border-border-subtle bg-bg-1 p-5">
      <summary className="cursor-pointer font-medium text-fg-1">Archived services ({services.length})</summary>
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

function DiscountsTab({ overview, expectedVersion, gate }: { overview: PricingOverviewDto; expectedVersion: number; gate: Gate | null }) {
  const active = overview.services.filter((s) => s.archivedAt === null);
  return (
    <div className="flex flex-col gap-4">
      <Panel title="Workspace limit" description="The largest discount any quote may carry, as a percentage of the subtotal.">
        <DiscountLimitForm key={overview.settings.updatedAt} settings={overview.settings} gate={gate} />
      </Panel>
      <Panel title="Service limits" description="A quote that includes one of these services is limited to the lowest limit among its services and the workspace limit.">
        {active.length === 0 ? (
          <p className="text-fg-2">No services yet.</p>
        ) : (
          <ul className="flex flex-col">
            {active.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle py-2 last:border-b-0">
                <span className="text-fg-1">{s.name}</span>
                <span className="flex items-center gap-2">
                  <span className="tabular text-fg-2">
                    {s.maxDiscountBps === null ? `Workspace limit (${pct(overview.settings.maxDiscountBps)})` : pct(Math.min(s.maxDiscountBps, overview.settings.maxDiscountBps))}
                  </span>
                  {overview.canEdit ? (
                    <ServiceDialog service={s} expectedVersion={expectedVersion} workspaceName={overview.workspace.name} trigger={<EditTrigger label={`Edit discount limit of ${s.name}`} />} />
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function TimelinesTab({ overview, expectedVersion, gate }: { overview: PricingOverviewDto; expectedVersion: number; gate: Gate | null }) {
  const active = overview.services.filter((s) => s.archivedAt === null);
  return (
    <div className="flex flex-col gap-4">
      <Panel title="Quote validity">
        <ValidityForm key={overview.settings.updatedAt} settings={overview.settings} gate={gate} />
      </Panel>
      <Panel title="Typical timelines" description="Suggested delivery time per service, used when a quote's timeline is drafted.">
        {active.length === 0 ? (
          <p className="text-fg-2">No services yet.</p>
        ) : (
          <ul className="flex flex-col">
            {active.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle py-2 last:border-b-0">
                <span className="text-fg-1">{s.name}</span>
                <span className="flex items-center gap-2">
                  <span className="tabular text-fg-2">{s.defaultTimelineDays === null ? 'Not set' : `${s.defaultTimelineDays} days`}</span>
                  {overview.canEdit ? (
                    <ServiceDialog service={s} expectedVersion={expectedVersion} workspaceName={overview.workspace.name} trigger={<EditTrigger label={`Edit timeline of ${s.name}`} />} />
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
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
    <Panel title="Price list history" description="Read-only. Each version is the full price list at the time it was published; issued quotes point at the version they used.">
      <ol className="flex flex-col gap-2">
        {overview.versions.map((v) => (
          <li key={v.id}>
            <details className="rounded-lg border border-border-subtle bg-bg-2 px-4 py-3" open={v.active}>
              <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-medium text-fg-1">v{v.version}</span>
                {v.active ? <span className="rounded-full border border-success/40 px-2 py-0.5 text-xs text-success">Active</span> : null}
                <span className="text-sm text-fg-2">{v.note}</span>
                <span className="text-xs text-fg-3">
                  {formatDateTime(new Date(v.createdAt), tz)}
                  {v.createdByName ? ` by ${v.createdByName}` : ''}
                </span>
              </summary>
              {v.entries.length === 0 ? (
                <p className="mt-2 text-sm text-fg-2">Empty price list.</p>
              ) : (
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full min-w-[480px] text-left text-sm">
                    <caption className="sr-only">Prices in version {v.version}</caption>
                    <thead className="text-xs text-fg-2">
                      <tr className="border-b border-border-subtle">
                        <Th>Service</Th>
                        <Th right>Unit price</Th>
                        <Th>Quantity</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {v.entries.map((e) => (
                        <tr key={e.serviceId} className="border-b border-border-subtle last:border-b-0">
                          <td className="py-2 pr-3 text-fg-1">
                            {e.name} <span className="font-mono text-xs text-fg-3">{e.code}</span>
                          </td>
                          <td className="tabular py-2 pr-3 text-right text-fg-1">
                            {money(e.unitPricePaise)}
                            <span className="text-fg-3"> / {e.unitLabel}</span>
                          </td>
                          <td className="tabular py-2 pr-3 text-fg-2">
                            {e.minQty} to {e.maxQty.toLocaleString('en-IN')}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </details>
          </li>
        ))}
      </ol>
    </Panel>
  );
}

export function PricingWorkspace({ overview }: { overview: PricingOverviewDto }) {
  const [tab, setTab] = useState<string>('services');
  const expectedVersion = overview.activeVersion?.version ?? 0;
  const gate = overview.canEdit ? null : OWNER_GATE;
  const settingsKey = overview.settings.updatedAt;

  return (
    <Tabs.Root value={tab} onValueChange={setTab} className="flex flex-col gap-4">
      <Tabs.List aria-label="Pricing sections" className="flex gap-1 overflow-x-auto border-b border-border-subtle">
        {TABS.map(([value, label]) => (
          <Tabs.Trigger
            key={value}
            value={value}
            className="-mb-px shrink-0 border-b-2 border-transparent px-3 py-2 text-sm font-medium text-fg-2 outline-none hover:text-fg-1 focus-visible:ring-2 focus-visible:ring-ring/50 data-[state=active]:border-cyan data-[state=active]:text-fg-1"
          >
            {label}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      {!overview.canEdit ? <p className="text-sm text-fg-2">You can view pricing. Only the workspace owner can change it.</p> : null}
      <Tabs.Content value="services" className="outline-none">
        <ServicesTab overview={overview} expectedVersion={expectedVersion} />
      </Tabs.Content>
      <Tabs.Content value="tax" className="outline-none">
        <Panel title="Tax" description="Quotes carry at most one tax line, computed on the subtotal after discount.">
          <TaxForm key={settingsKey} settings={overview.settings} gate={gate} />
        </Panel>
      </Tabs.Content>
      <Tabs.Content value="discounts" className="outline-none">
        <DiscountsTab overview={overview} expectedVersion={expectedVersion} gate={gate} />
      </Tabs.Content>
      <Tabs.Content value="timelines" className="outline-none">
        <TimelinesTab overview={overview} expectedVersion={expectedVersion} gate={gate} />
      </Tabs.Content>
      <Tabs.Content value="history" className="outline-none">
        <HistoryTab overview={overview} />
      </Tabs.Content>
      {overview.activeVersion ? (
        <p className="text-xs text-fg-3">Active price list v{overview.activeVersion.version} since {formatDateTime(new Date(overview.activeVersion.createdAt), overview.workspace.timezone)}.</p>
      ) : null}
    </Tabs.Root>
  );
}
