/**
 * Webhook event detail (T24, R33): routing, status, attempts, the redacted inspector payload and
 * stored result, whether the encrypted processing payload is still held (it is never decrypted
 * here), and links to the jobs that processed the event.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { NotFoundError } from '@/lib/errors';
import { formatDateTime } from '@/lib/format/date';
import { getPageContext } from '@/server/auth/page-context';
import { getWebhookEventDetail, type WebhookDetail } from '@/server/services/admin/webhook-inspector';

export const metadata: Metadata = { title: 'Webhook event' };
export const dynamic = 'force-dynamic';

function Field(props: { label: string; value: string | null }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-fg-2">{props.label}</dt>
      <dd className="break-all font-mono text-sm text-fg-1">{props.value ?? '-'}</dd>
    </div>
  );
}

export default async function WebhookEventPage(props: { params: Promise<{ eventId: string }> }) {
  const page = await getPageContext();
  if (!page) redirect('/login');
  const { eventId } = await props.params;
  let e: WebhookDetail;
  try {
    e = await getWebhookEventDetail(page.ctx, eventId);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <Link href="/dashboard/admin/webhooks" className="text-sm text-cyan underline-offset-4 hover:underline">
          Webhooks
        </Link>
        <h1 className="font-display text-2xl font-semibold text-fg-1">
          {e.provider} · {e.status}
        </h1>
        <p className="text-fg-2">
          {e.workspace?.name ?? 'Unrouted'}
          {e.simulated ? ' · Simulated' : ''} · received {formatDateTime(e.receivedAt)}
        </p>
      </header>

      <dl className="grid gap-3 rounded-xl border border-border-subtle bg-bg-1 p-5 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Event id" value={e.id} />
        <Field label="External key" value={e.externalKey} />
        <Field label="Scope key" value={e.scopeKey} />
        <Field label="Body sha256" value={e.bodySha256} />
        <Field label="Attempts" value={String(e.attempts)} />
        <Field label="Processed" value={e.processedAt ? formatDateTime(e.processedAt) : null} />
        <Field label="Processing payload" value={e.payloadHeld ? 'held, encrypted (not shown)' : `purged${e.processingPurgedAt ? ` ${formatDateTime(e.processingPurgedAt)}` : ''}`} />
      </dl>

      <section aria-labelledby="payload-heading" className="flex flex-col gap-2">
        <h2 id="payload-heading" className="font-display text-lg font-semibold text-fg-1">
          Redacted payload
        </h2>
        <pre className="overflow-x-auto rounded-md bg-bg-0 p-3 font-mono text-xs text-fg-1">{JSON.stringify(e.payloadRedacted, null, 2)}</pre>
      </section>

      <section aria-labelledby="result-heading" className="flex flex-col gap-2">
        <h2 id="result-heading" className="font-display text-lg font-semibold text-fg-1">
          Result
        </h2>
        <pre className="overflow-x-auto rounded-md bg-bg-0 p-3 font-mono text-xs text-fg-1">{e.result === null ? 'Not processed yet.' : JSON.stringify(e.result, null, 2)}</pre>
      </section>

      <section aria-labelledby="jobs-heading" className="flex flex-col gap-2">
        <h2 id="jobs-heading" className="font-display text-lg font-semibold text-fg-1">
          Processing jobs
        </h2>
        {e.jobs.length === 0 ? (
          <p className="text-fg-2">No job processed this event (unrouted events are stored only).</p>
        ) : (
          <ul className="flex flex-col gap-1 text-sm">
            {e.jobs.map((j) => (
              <li key={j.id} className="flex flex-wrap gap-3">
                <Link href={`/dashboard/admin/jobs/${j.id}`} className="font-mono text-cyan underline-offset-4 hover:underline">
                  {j.type}
                </Link>
                <span className="text-fg-2">{j.label}</span>
                <span className="text-fg-2">{formatDateTime(j.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
