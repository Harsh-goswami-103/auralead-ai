/**
 * Truthfulness strip (plan T30, 06-design §11.7): the rules the product keeps, stated plainly:
 * your accounts and data (LIVE) or DEMO and LIVE never mix (DEMO, ADR-116), consent first, approval
 * by default, AI never sets prices. Icon + text
 * cards on a quiet band, each closed at the top by a hairline in its hue; no testimonials, logos,
 * "trusted by" or invented numbers anywhere on the page. Server-safe.
 */
import { BadgeIndianRupee, FlaskConical, LockKeyhole, ShieldCheck, UserCheck, type LucideIcon } from 'lucide-react';
import { cn } from '@/components/ui/cn';
import { GridPattern } from '@/components/visual/Patterns';
import { Stagger, StaggerItem } from '@/components/visual/Reveal';
import type { LandingMode } from './cta';
import { SectionIntro } from './SectionIntro';

type Principle = { title: string; body: string; icon: LucideIcon; tint: string; hairline: string };

const MODE_PRINCIPLE: Record<LandingMode, Principle> = {
  demo: {
    title: 'DEMO and LIVE never mix',
    body: 'DEMO runs on seeded data with simulated providers and says so on every screen. LIVE uses your own provider accounts and invitation-only sign-in.',
    icon: FlaskConical,
    tint: 'border-zest/30 bg-zest/10 text-zest',
    hairline: 'bg-zest',
  },
  live: {
    title: 'Your accounts, your data',
    body: 'Sign-in is by invitation only, provider credentials are stored encrypted per workspace, and your leads are kept in your own database.',
    icon: LockKeyhole,
    tint: 'border-zest/30 bg-zest/10 text-zest',
    hairline: 'bg-zest',
  },
};

const PRINCIPLES: readonly Principle[] = [
  {
    title: 'Consent first',
    body: 'WhatsApp needs opt-in evidence for that channel, and Maps leads start without it. Email permission is tracked separately, and a Stop is honoured at once.',
    icon: ShieldCheck,
    tint: 'border-aura/30 bg-aura/12 text-aura',
    hairline: 'bg-aura',
  },
  {
    title: 'Approval by default',
    body: 'A person approves every quote and outbound message before it is sent, unless a workspace turns on auto-send, which is audited and runs the same checks.',
    icon: UserCheck,
    tint: 'border-volt-hi/35 bg-volt/14 text-volt-hi',
    hairline: 'bg-volt-hi',
  },
  {
    title: 'AI never sets prices',
    body: 'AI may propose services and quantities. Prices, discounts and tax come from your price list and are computed on the server.',
    icon: BadgeIndianRupee,
    tint: 'border-flare/30 bg-flare/10 text-flare',
    hairline: 'bg-flare',
  },
];

export function TruthStrip({ mode }: { mode: LandingMode }) {
  return (
    <section
      id="principles"
      aria-labelledby="principles-title"
      data-landing-section="principles"
      className="relative isolate scroll-mt-20 overflow-hidden border-y border-border-subtle bg-bg-1/60 py-20 sm:py-24"
    >
      <GridPattern fade="radial" size={48} />
      <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-10 px-4 sm:px-6 lg:px-8">
        <SectionIntro
          id="principles-title"
          accent="flare"
          eyebrow="Principles"
          title="The rules it keeps"
          description="This page shows no testimonials, customer logos or invented numbers. The product keeps the same rules."
        />
        <Stagger className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[MODE_PRINCIPLE[mode], ...PRINCIPLES].map((p) => {
            const Icon = p.icon;
            return (
              <StaggerItem key={p.title} inView as="article" className="relative flex min-w-0 flex-col gap-3 overflow-hidden rounded-xl border border-border-subtle bg-bg-0/70 p-5">
                <span aria-hidden="true" className={cn('pointer-events-none absolute inset-x-0 top-0 h-0.5 opacity-80', p.hairline)} />
                <span aria-hidden="true" className={cn('grid size-10 place-items-center rounded-xl border', p.tint)}>
                  <Icon className="size-5" />
                </span>
                <h3 className="font-display text-base font-semibold text-fg-1">{p.title}</h3>
                <p className="text-sm text-fg-2">{p.body}</p>
              </StaggerItem>
            );
          })}
        </Stagger>
      </div>
    </section>
  );
}
