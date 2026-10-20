import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { CircleCheck, MailMinus, ShieldCheck } from 'lucide-react';
import { ModeBanner } from '@/components/patterns/ModeBanner';
import { ProductMark } from '@/components/patterns/ProductMark';
import { Button } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { AuroraBackdrop } from '@/components/visual/AuroraBackdrop';
import { GlowFrame } from '@/components/visual/GlowFrame';
import { DotPattern } from '@/components/visual/Patterns';
import { Reveal } from '@/components/visual/Reveal';
import { getRuntime } from '@/server/boot';
import { deriveUnsubscribeKey } from '@/server/services/messaging/dispatch';
import { unsubscribeStatus } from '@/server/services/messaging/unsubscribe';

export const metadata: Metadata = { title: { absolute: 'Unsubscribe | AuraLead AI' }, robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

/**
 * /unsubscribe/[token] (T20, M2): the page every email's footer links to. Opening it changes
 * nothing (mail scanners open links); the button posts the signed token to /api/unsubscribe, which
 * suppresses synchronously and returns here. The state shown is read from the database.
 *
 * Look (design spec §6): the dark Aurora frame of /login without the WebGL scene, since this is a
 * short transactional page: aurora and a fading dot grid behind a glass card with the panel
 * hairline. The state icon carries the meaning with the heading (a mail-minus chip before, a
 * success check after, which scales in once). Entrances run once and rest under reduced motion.
 * In DEMO the mode banner says that no message leaves the app, as on /login.
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
  const StateIcon = status.unsubscribed ? CircleCheck : MailMinus;

  return (
    <div className="relative isolate flex min-h-dvh flex-col overflow-hidden bg-bg-0">
      {runtime.config.mode === 'demo' ? <ModeBanner mode="demo" /> : null}
      <AuroraBackdrop variant="auth" />
      <DotPattern fade="radial" gap={22} className="opacity-50" />
      <main id="main" className="flex flex-1 items-center justify-center px-4 py-12 sm:px-8">
        <div className="flex w-full max-w-md flex-col gap-7">
          <Reveal className="flex items-center gap-3">
            <ProductMark className="size-10" />
            <span className="flex flex-col gap-0.5">
              <span className="text-gradient font-display text-xl leading-6 font-bold tracking-tight">AuraLead AI</span>
              <span className="text-xs font-medium tracking-[0.14em] text-fg-2 uppercase">Email preferences</span>
            </span>
          </Reveal>
          <Reveal delay={0.08}>
            <section
              className="relative isolate flex flex-col gap-6 overflow-hidden rounded-2xl border border-border-strong bg-bg-1/85 p-6 shadow-overlay backdrop-blur-lg sm:p-7"
              aria-live="polite"
            >
              <AuroraBackdrop variant="card" />
              <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-(image:--grad-hairline)" />
              <span
                aria-hidden="true"
                data-unsubscribe-state={status.unsubscribed ? 'unsubscribed' : 'subscribed'}
                className={cn(
                  'flex size-14 items-center justify-center rounded-2xl ring-1 ring-inset',
                  'motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-50 motion-safe:duration-500 motion-safe:delay-200 motion-safe:fill-mode-backwards motion-safe:ease-emphasized',
                  status.unsubscribed ? 'bg-success/14 text-success ring-success/35' : 'bg-aura/12 text-aura ring-aura/30',
                )}
              >
                <StateIcon className="size-7" strokeWidth={1.75} />
              </span>
              <div className="flex flex-col gap-2">
                <h1 className="font-display text-2xl font-semibold text-balance text-fg-1 sm:text-3xl">{status.unsubscribed ? 'You are unsubscribed' : 'Unsubscribe from emails'}</h1>
                <p className="text-md text-fg-2">
                  {status.unsubscribed
                    ? `${status.workspaceName} will not send further emails to this address.`
                    : `Stop all emails from ${status.workspaceName} to this address.`}
                </p>
                {justDone ? <p className="text-sm text-fg-2">Your request was recorded just now.</p> : null}
              </div>
              {status.unsubscribed ? null : (
                <form method="post" action="/api/unsubscribe">
                  <input type="hidden" name="token" value={token} />
                  <GlowFrame className="w-full rounded-md">
                    <Button type="submit" size="lg" className="h-11 w-full">
                      <MailMinus aria-hidden="true" />
                      Unsubscribe
                    </Button>
                  </GlowFrame>
                </form>
              )}
            </section>
          </Reveal>
          <Reveal as="p" delay={0.14} className="flex items-start gap-2 text-xs text-fg-2">
            <ShieldCheck aria-hidden="true" className="mt-px size-3.5 shrink-0 text-fg-3" />
            <span>This page shows only the sender&apos;s name. No address or message content is displayed.</span>
          </Reveal>
        </div>
      </main>
    </div>
  );
}
