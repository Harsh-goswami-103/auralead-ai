/**
 * Platform admin: webhook inspector list (T24, R33). Stored deliveries with provider, status,
 * routing, attempts and whether the encrypted processing payload is still held, filterable by
 * status and provider, plus the daily counters of rejected deliveries (never stored). Rows open
 * the event detail with its redacted payload and the jobs that processed it.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Button } from '@/components/ui/button';
import type { WebhookProvider, WebhookStatus } from '@/lib/domain/enums';
import { formatDate, formatDateTime } from '@/lib/format/date';
import { getPageContext } from '@/server/auth/page-context';
import { listWebhookEvents, WEBHOOK_PROVIDERS, WEBHOOK_STATUSES } from '@/server/services/admin/webhook-inspector';

export const metadata: Metadata = { title: 'Webhooks' };
export const dynamic = 'force-dynamic';

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (typeof v === 'string' && v.length > 0 ? v : undefined);

export default async function AdminWebhooksPage(props: { searchParams: Promise<Search> }) {
  const page = await getPageContext();
  if (!page) redirect('/login');
  const search = await props.searchParams;
  const status = WEBHOOK_STATUSES.find((s) => s === one(search.status)) as WebhookStatus | undefined;
  const provider = WEBHOOK_PROVIDERS.find((p) => p === one(search.provider)) as WebhookProvider | undefined;
  const before = one(search.before);
  const list = await listWebhookEvents(page.ctx, { status, provider, before });
  const older = new URLSearchParams();
  if (status) older.set('status', status);
  if (provider) older.set('provider', provider);
  if (list.nextCursor) older.set('before', list.nextCursor);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <p className="text-sm text-fg-2">Platform admin</p>
        <h1 className="font-display text-2xl font-semibold text-fg-1 sm:text-3xl">Webhooks</h1>
        <p className="text-fg-2">Stored deliveries show a redacted view only. Retry or cancel their processing jobs from the job inspector.</p>
      </header>

      <form method="get" className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm text-fg-2">
          Status
          <select name="status" defaultValue={status ?? ''} className="h-9 rounded-md border border-input bg-input/30 px-2 text-fg-1">
            <option value="">All</option>
            {WEBHOOK_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm text-fg-2">
          Provider
          <select name="provider" defaultValue={provider ?? ''} className="h-9 rounded-md border border-input bg-input/30 px-2 text-fg-1">
            <option value="">All</option>
            {WEBHOOK_PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <Button type="submit" variant="outline" size="sm">
          Filter
        </Button>
      </form>

      {list.rows.length === 0 ? (
        <p className="rounded-xl border border-border-subtle bg-bg-1 p-5 text-fg-2">No webhook events match these filters.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border-subtle">
          <table className="w-full min-w-[760px] text-left text-sm">
            <thead className="bg-bg-2 text-fg-2">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">Received</th>
                <th scope="col" className="px-3 py-2 font-medium">Provider</th>
                <th scope="col" className="px-3 py-2 font-medium">Status</th>
                <th scope="col" className="px-3 py-2 font-medium">Workspace</th>
                <th scope="col" className="px-3 py-2 font-medium">Key</th>
                <th scope="col" className="px-3 py-2 font-medium">Payload</th>
              </tr>
            </thead>
            <tbody>
              {list.rows.map((e) => (
                <tr key={e.id} className="border-t border-border-subtle">
                  <td className="px-3 py-2">
                    <Link href={`/dashboard/admin/webhooks/${e.id}`} className="text-cyan underline-offset-4 hover:underline">
                      {formatDateTime(e.receivedAt)}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-fg-1">
                    {e.provider}
                    {e.simulated ? <span className="ml-2 rounded bg-demo/15 px-1.5 py-0.5 text-xs text-demo">Simulated</span> : null}
                  </td>
                  <td className="px-3 py-2 text-fg-1">{e.status}</td>
                  <td className="px-3 py-2 text-fg-2">{e.workspace?.name ?? 'Unrouted'}</td>
                  <td className="max-w-64 truncate px-3 py-2 font-mono text-xs text-fg-2">{e.externalKey}</td>
                  <td className="px-3 py-2 text-fg-2">{e.payloadHeld ? 'held (encrypted)' : 'purged'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.nextCursor ? (
        <Link href={`/dashboard/admin/webhooks?${older.toString()}`} className="self-start text-sm text-cyan underline-offset-4 hover:underline">
          Older events
        </Link>
      ) : null}

      <section aria-labelledby="rejections-heading" className="flex flex-col gap-2">
        <h2 id="rejections-heading" className="font-display text-lg font-semibold text-fg-1">
          Rejected deliveries
        </h2>
        {list.rejections.length === 0 ? (
          <p className="text-fg-2">No rejected deliveries recorded.</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm text-fg-2">
            {list.rejections.map((r) => (
              <li key={`${r.provider}-${r.reason}-${r.day.toISOString()}`}>
                {formatDate(r.day, 'UTC')} · {r.provider} · {r.reason}: <span className="tabular text-fg-1">{r.count}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
