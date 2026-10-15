import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { ProductMark } from '@/components/patterns/ProductMark';
import { Button } from '@/components/ui/button';
import { getRuntime } from '@/server/boot';
import { deriveUnsubscribeKey } from '@/server/services/messaging/dispatch';
import { unsubscribeStatus } from '@/server/services/messaging/unsubscribe';

export const metadata: Metadata = { title: { absolute: 'Unsubscribe | AuraLead AI' }, robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

/**
 * /unsubscribe/[token] (T20, M2): the page every email's footer links to. Opening it changes
 * nothing (mail scanners open links); the button posts the signed token to /api/unsubscribe, which
 * suppresses synchronously and returns here. The state shown is read from the database.
 */
export default async function UnsubscribePage(props: { params: Promise<{ token: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { token } = await props.params;
  const search = await props.searchParams;
  const runtime = getRuntime();
  const secret = runtime.config.secrets.sessionSecret;
  if (!secret) notFound();
  const status = await unsubscribeStatus(runtime.prisma, runtime.config.mode, deriveUnsubscribeKey(secret), token);
  if (!status) notFound();
  const justDone = search.done === '1' && status.unsubscribed;

  return (
    <main id="main" className="flex min-h-dvh items-center justify-center bg-bg-0 px-4 py-12">
      <div className="flex w-full max-w-sm flex-col gap-8">
        <div className="flex items-center gap-2.5">
          <ProductMark className="size-8" />
          <span className="font-display text-lg font-semibold tracking-tight text-fg-1">AuraLead AI</span>
        </div>
        <section className="flex flex-col gap-6 rounded-xl border border-border-subtle bg-bg-1 p-6" aria-live="polite">
          <div className="flex flex-col gap-1.5">
            <h1 className="font-display text-2xl font-semibold text-fg-1">{status.unsubscribed ? 'You are unsubscribed' : 'Unsubscribe from emails'}</h1>
            <p className="text-fg-2">
              {status.unsubscribed
                ? `${status.workspaceName} will not send further emails to this address.`
                : `Stop all emails from ${status.workspaceName} to this address.`}
            </p>
            {justDone ? <p className="text-sm text-fg-3">Your request was recorded just now.</p> : null}
          </div>
          {status.unsubscribed ? null : (
            <form method="post" action="/api/unsubscribe">
              <input type="hidden" name="token" value={token} />
              <Button type="submit" className="w-full">
                Unsubscribe
              </Button>
            </form>
          )}
        </section>
        <p className="text-xs text-fg-3">This page shows only the sender&apos;s name. No address or message content is displayed.</p>
      </div>
    </main>
  );
}
