/**
 * Platform admin: webhook inspector list (T24, R33). Stored deliveries with provider, status,
 * routing, attempts and whether the encrypted processing payload is still held, filterable by
 * status and provider, plus the daily counters of rejected deliveries (never stored). Rows open
 * the event detail with its redacted payload and the jobs that processed it.
 *
 * Look (design spec §6): PageHeader, a plain GET filter form with readable option labels (values
 * stay the raw enums), a neutral table (provider chips in the shared source palette, status chips
 * with icon + label, the Simulated mode chip, mono keys with the full key on hover, held/purged
 * payload as plain icon + text so the rows stay calm) that becomes a divided list on phones, Newest/Older paging, and the rejection
 * counters as bars scaled to the largest real count, grouped by UTC day.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ChevronLeft, ChevronRight, Inbox, Lock, ShieldCheck, ShieldX, Trash2 } from 'lucide-react';
import { WEBHOOK_STATUS_VOCABULARY, providerStyle } from '@/components/admin/admin-vocabulary';
import { FilterForm } from '@/components/admin/FilterForm';
import { InlineEmpty } from '@/components/admin/InlineEmpty';
import { ProviderChip } from '@/components/admin/ProviderChip';
import { ScrollRegion } from '@/components/admin/ScrollRegion';
import { SectionTitle } from '@/components/admin/SectionTitle';
import { StatusChip } from '@/components/admin/StatusChip';
import { EmptyState } from '@/components/patterns/EmptyState';
import { PageHeader } from '@/components/patterns/PageHeader';
import { SectionCard } from '@/components/patterns/SectionCard';
import { ModeChip } from '@/components/patterns/StatusBadge';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import type { WebhookProvider, WebhookStatus } from '@/lib/domain/enums';
import { formatDate, formatDateTime } from '@/lib/format/date';
import { getPageContext } from '@/server/auth/page-context';
import { listWebhookEvents, WEBHOOK_PROVIDERS, WEBHOOK_STATUSES } from '@/server/services/admin/webhook-inspector';

export const metadata: Metadata = { title: 'Webhooks' };
export const dynamic = 'force-dynamic';

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (typeof v === 'string' && v.length > 0 ? v : undefined);

/** Whether the encrypted processing payload is still held: plain icon + text (a fact, not a status). */
function PayloadState({ held }: { held: boolean }) {
  const Icon = held ? Lock : Trash2;
  return (
    <span className={cn('inline-flex w-fit items-center gap-1.5 text-xs whitespace-nowrap', held ? 'text-fg-1' : 'text-fg-2')}>
      <Icon aria-hidden="true" className="size-3.5 shrink-0 text-fg-3" />
      {held ? 'Held (encrypted)' : 'Purged'}
    </span>
  );
}

/** A stretched row link's focus ring outlines the whole row (inset, so the list's clip keeps it). */
const ROW_FOCUS = 'focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:-outline-offset-2 focus-visible:after:outline-aura';

export default async function AdminWebhooksPage(props: { searchParams: Promise<Search> }) {
  const page = await getPageContext();
  if (!page) redirect('/login');
  const search = await props.searchParams;
  const status = WEBHOOK_STATUSES.find((s) => s === one(search.status)) as WebhookStatus | undefined;
  const provider = WEBHOOK_PROVIDERS.find((p) => p === one(search.provider)) as WebhookProvider | undefined;
  const before = one(search.before);
  const list = await listWebhookEvents(page.ctx, { status, provider, before });
  const filters = new URLSearchParams();
  if (status) filters.set('status', status);
  if (provider) filters.set('provider', provider);
  const filterQuery = filters.toString();
  const newest = `/dashboard/admin/webhooks${filterQuery ? `?${filterQuery}` : ''}`;
  const older = new URLSearchParams(filters);
  if (list.nextCursor) older.set('before', list.nextCursor);
  const filtered = Boolean(status || provider);

  const days = new Map<string, { day: Date; rows: typeof list.rejections }>();
  for (const r of list.rejections) {
    const key = r.day.toISOString().slice(0, 10);
    const group = days.get(key) ?? { day: r.day, rows: [] };
    group.rows.push(r);
    days.set(key, group);
  }
  const maxRejected = Math.max(1, ...list.rejections.map((r) => r.count));

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Platform admin"
        title="Webhooks"
        description="Stored deliveries show a redacted view only. Retry or cancel their processing jobs from the job inspector."
      />

      <SectionCard
        title={
          <SectionTitle icon={<Inbox />}>
            Stored deliveries
          </SectionTitle>
        }
        meta={`Newest first${filtered ? ', filtered' : ''}. ${list.rows.length} shown${before ? ' from an older page' : ''}.`}>
        <FilterForm
          clearHref={filtered ? '/dashboard/admin/webhooks' : null}
          fields={[
            { name: 'status', label: 'Status', value: status ?? '', options: WEBHOOK_STATUSES.map((s) => ({ value: s, label: WEBHOOK_STATUS_VOCABULARY[s].label })) },
            { name: 'provider', label: 'Provider', value: provider ?? '', options: WEBHOOK_PROVIDERS.map((p) => ({ value: p, label: providerStyle(p).label })) },
          ]}
        />

        {list.rows.length === 0 ? (
          <EmptyState
            headingLevel="h3"
            title="No webhook events match these filters"
            description="Try another status or provider, or clear the filters to see every stored delivery."
            action={
              filtered ? (
                <Button asChild variant="secondary">
                  <Link href="/dashboard/admin/webhooks">Clear filters</Link>
                </Button>
              ) : undefined
            }
          />
        ) : (
          <>
            {/* Scroll padding clears the sticky header row (top) and the fade (bottom), so a focused row link is never hidden under them. */}
            <ScrollRegion label="Webhook events table" wrapperClassName="-mx-4 hidden border-y border-border-subtle md:block sm:-mx-5" className="max-h-[min(80vh,52rem)] overflow-auto scroll-pt-12 scroll-pb-12">
              <table className="w-full min-w-[52rem] text-left text-sm">
                <thead className="text-xs text-fg-2">
                  <tr>
                    {['Received', 'Provider', 'Status', 'Workspace', 'Key', 'Payload'].map((h, i, all) => (
                      <th
                        key={h}
                        scope="col"
                        className={cn('sticky top-0 z-10 border-b border-border-subtle bg-bg-1 px-3 py-2.5 font-medium', i === 0 && 'pl-4 sm:pl-5', i === all.length - 1 && 'pr-4 sm:pr-5')}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {list.rows.map((e) => (
                    <tr key={e.id} className="transition-colors duration-fast hover:bg-bg-2/60">
                      <td className="py-2.5 pr-3 pl-4 whitespace-nowrap sm:pl-5">
                        <Link href={`/dashboard/admin/webhooks/${e.id}`} className="tabular text-cyan underline-offset-4 hover:underline">
                          {formatDateTime(e.receivedAt)}
                        </Link>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="flex items-center gap-1.5">
                          <ProviderChip provider={e.provider} />
                          {e.simulated ? <ModeChip simulated /> : null}
                        </span>
                      </td>
                      <td className="px-3 py-2.5">
                        <StatusChip entry={WEBHOOK_STATUS_VOCABULARY[e.status]} state={e.status} />
                      </td>
                      <td className={cn('px-3 py-2.5 whitespace-nowrap', e.workspace ? 'text-fg-1' : 'text-fg-2')}>{e.workspace?.name ?? 'Unrouted'}</td>
                      <td className="max-w-48 truncate px-3 py-2.5 font-mono text-xs text-fg-2" title={e.externalKey}>
                        {e.externalKey}
                      </td>
                      <td className="py-2.5 pr-4 pl-3 sm:pr-5">
                        <PayloadState held={e.payloadHeld} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </ScrollRegion>
            <ul aria-label="Webhook events" className="flex flex-col divide-y divide-border-subtle overflow-hidden rounded-lg border border-border-subtle bg-bg-0/30 md:hidden">
              {list.rows.map((e) => (
                <li key={e.id} className="relative flex flex-col gap-1.5 px-3 py-2.5 transition-colors duration-fast hover:bg-bg-2/60 has-[a:focus-visible]:bg-bg-2/60">
                  <div className="flex items-start justify-between gap-2">
                    <Link href={`/dashboard/admin/webhooks/${e.id}`} className={cn('tabular text-sm text-cyan underline-offset-4 after:absolute after:inset-0 hover:underline', ROW_FOCUS)}>
                      {formatDateTime(e.receivedAt)}
                    </Link>
                    <StatusChip entry={WEBHOOK_STATUS_VOCABULARY[e.status]} state={e.status} />
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <ProviderChip provider={e.provider} />
                    {e.simulated ? <ModeChip simulated /> : null}
                  </div>
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-2">
                    <span>{e.workspace?.name ?? 'Unrouted'}</span>
                    <span aria-hidden="true" className="text-fg-3">
                      ·
                    </span>
                    <PayloadState held={e.payloadHeld} />
                  </p>
                  <p className="truncate font-mono text-xs text-fg-2">{e.externalKey}</p>
                </li>
              ))}
            </ul>
          </>
        )}
        {list.nextCursor || before ? (
          <nav aria-label="Webhook event pages" className="flex flex-wrap items-center gap-2">
            {before ? (
              <Button asChild variant="outline" size="sm">
                <Link href={newest}>
                  <ChevronLeft aria-hidden="true" />
                  Newest events
                </Link>
              </Button>
            ) : null}
            {list.nextCursor ? (
              <Button asChild variant="outline" size="sm">
                <Link href={`/dashboard/admin/webhooks?${older.toString()}`}>
                  Older events
                  <ChevronRight aria-hidden="true" />
                </Link>
              </Button>
            ) : null}
          </nav>
        ) : null}
      </SectionCard>

      <SectionCard
        title={
          <SectionTitle icon={<ShieldX />}>
            Rejected deliveries
          </SectionTitle>
        }
        meta="Counted per UTC day, provider and reason; rejected bodies are never stored."
      >
        {list.rejections.length === 0 ? (
          <InlineEmpty icon={<ShieldCheck />}>No rejected deliveries recorded.</InlineEmpty>
        ) : (
          <div className="flex flex-col gap-4">
            {[...days.values()].map((group) => (
              <div key={group.day.toISOString()} className="flex flex-col gap-2">
                <h3 className="text-xs font-medium tracking-[0.08em] text-fg-2 uppercase">{formatDate(group.day, 'UTC')} (UTC day)</h3>
                <ul className="flex flex-col gap-2">
                  {group.rows.map((r) => (
                    <li key={`${r.provider}-${r.reason}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[minmax(0,16rem)_minmax(0,1fr)_auto]">
                      <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                        <ProviderChip provider={r.provider} />
                        <span className="font-mono text-xs [overflow-wrap:anywhere] text-fg-2">{r.reason}</span>
                      </span>
                      <span aria-hidden="true" className="order-last col-span-2 h-2 overflow-hidden rounded-full bg-bg-2 sm:order-none sm:col-span-1">
                        <span className="block h-full rounded-full bg-chart-3" style={{ width: `${Math.max(2, (r.count / maxRejected) * 100)}%` }} />
                      </span>
                      <span className="tabular text-sm font-medium text-fg-1">{r.count}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}
