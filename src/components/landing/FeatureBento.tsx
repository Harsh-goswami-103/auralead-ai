/**
 * Feature bento (plan T30): what the product does, as cards of mixed sizes. Every claim maps to a
 * PRD requirement that exists in the app; the small visuals use the product's real vocabulary
 * (quote states, consent checks, score reason labels from the scoring service, panel names), never
 * invented figures, customers or logos. Each card carries its accent: a corner wash, the icon
 * chip and a SpotlightCard wash that follows the pointer in that hue; the featured card carries a
 * BorderBeam and the middle row tilts slightly on a mouse (flat on touch and under reduced
 * motion). State sequences (quote states, job states) read as small rail steppers that keep their
 * order at every width. Two columns at md, the six-column bento from lg. The last card follows the
 * mode: DEMO describes its simulators, LIVE the provider accounts it connects (ADR-116: LIVE never
 * mentions the demo). Server-safe; the visual wrappers are client islands.
 */
import {
  BadgeCheck,
  Ban,
  CircleCheck,
  CircleHelp,
  Clock,
  Eye,
  FileText,
  FlaskConical,
  Gauge,
  Handshake,
  History,
  KeyRound,
  LayoutDashboard,
  Link2,
  MessageCircle,
  PenLine,
  Play,
  RotateCcw,
  Send,
  ShieldCheck,
  UserCheck,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { SourceChip } from '@/components/patterns/SourceChip';
import { ModeChip } from '@/components/patterns/StatusBadge';
import { cn } from '@/components/ui/cn';
import { BorderBeam } from '@/components/visual/BorderBeam';
import { SpotlightCard } from '@/components/visual/SpotlightCard';
import { Stagger, StaggerItem } from '@/components/visual/Reveal';
import { TiltCard } from '@/components/visual/TiltCard';
import type { LandingMode } from './cta';
import { SectionIntro } from './SectionIntro';

type Accent = 'aura' | 'zest' | 'volt' | 'flare';

const ACCENT: Record<Accent, string> = {
  aura: 'border-aura/30 bg-aura/12 text-aura',
  zest: 'border-zest/30 bg-zest/10 text-zest',
  volt: 'border-volt-hi/35 bg-volt/14 text-volt-hi',
  flare: 'border-flare/30 bg-flare/10 text-flare',
};

/*
 * A 10% corner wash in the card's accent (the StatTile recipe), so each card carries its hue. The
 * same hue drives the SpotlightCard pointer wash and border (it reads --panel-hue).
 */
const WASH: Record<Accent, string> = {
  aura: '[--wash:var(--aura)] [--panel-hue:var(--aura)]',
  zest: '[--wash:var(--zest)] [--panel-hue:var(--zest)]',
  volt: '[--wash:var(--volt-hi)] [--panel-hue:var(--volt-hi)]',
  flare: '[--wash:var(--flare)] [--panel-hue:var(--flare)]',
};
const card = (accent: Accent, extra?: string) =>
  cn(
    'flex h-full flex-col gap-5 p-5 sm:p-6 [background-image:radial-gradient(120%_90%_at_100%_0%,color-mix(in_oklab,var(--wash)_11%,transparent),transparent_62%)]',
    WASH[accent],
    extra,
  );

function CardHead(props: { icon: LucideIcon; accent: Accent; title: string; children: ReactNode }) {
  const Icon = props.icon;
  return (
    <div className="flex flex-col gap-3">
      <span aria-hidden="true" className={cn('grid size-10 place-items-center rounded-xl border', ACCENT[props.accent])}>
        <Icon className="size-5" />
      </span>
      <h3 className="font-display text-lg font-semibold text-fg-1">{props.title}</h3>
      <p className="text-sm text-fg-2">{props.children}</p>
    </div>
  );
}

type StateStep = { label: string; icon: LucideIcon };

const QUOTE_STATES: readonly StateStep[] = [
  { label: 'Draft', icon: PenLine },
  { label: 'Approved', icon: BadgeCheck },
  { label: 'Sent', icon: Send },
  { label: 'Viewed', icon: Eye },
  { label: 'Accepted', icon: Handshake },
];

/*
 * A sequence of states as a small rail stepper: icon nodes on one connector line, labels under
 * them, one column per state, so it never wraps out of order (the old chip row left a dangling
 * connector at the end of a wrapped line on phones).
 */
function StateRail(props: { label: string; steps: readonly StateStep[]; cols: string; node: string; line: string }) {
  const inset = `${50 / props.steps.length}%`;
  return (
    <ol aria-label={props.label} className={cn('relative grid gap-x-1', props.cols)}>
      <span aria-hidden="true" className={cn('pointer-events-none absolute top-4 h-px', props.line)} style={{ left: inset, right: inset }} />
      {props.steps.map((step) => {
        const Icon = step.icon;
        return (
          <li key={step.label} className="relative flex min-w-0 flex-col items-center gap-2 text-center">
            <span aria-hidden="true" className={cn('grid size-8 place-items-center rounded-full border bg-bg-2', props.node)}>
              <Icon className="size-4" />
            </span>
            <span className="text-xs font-medium text-fg-1">{step.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

/*
 * A schematic of a versioned quote: earlier versions stack behind the current one like sheets of
 * paper. Lines only, no figures; the front sheet carries its version and PDF tags. It grows to
 * fill the featured card when the neighbouring card is taller.
 */
function QuoteSheets() {
  return (
    <div aria-hidden="true" className="relative hidden min-h-40 flex-1 sm:block">
      <div className="absolute top-0 right-0 bottom-6 left-6 rounded-lg border border-border-subtle bg-bg-2/25" />
      <div className="absolute top-1.5 right-1.5 bottom-3 left-3 rounded-lg border border-border-subtle bg-bg-2/45" />
      <div className="absolute top-3 right-3 bottom-0 left-0 overflow-hidden rounded-lg border border-border-strong bg-bg-0/95">
        <span className="absolute inset-x-0 top-0 h-0.5 [background-image:linear-gradient(90deg,var(--aura),var(--ice))]" />
        <div className="flex items-start justify-between gap-4 px-5 pt-4">
          <div className="flex w-1/2 flex-col gap-2">
            <span className="h-2 w-2/3 rounded-full bg-aura/55" />
            <span className="h-1.5 w-full rounded-full bg-fg-3/25" />
          </div>
          <div className="flex items-center gap-1.5">
            <span className="rounded-md border border-aura/40 bg-aura/12 px-1.5 py-0.5 font-mono text-[11px] text-fg-1">v3</span>
            <span className="rounded-md border border-border-strong bg-bg-2 px-1.5 py-0.5 font-mono text-[11px] text-fg-1">PDF</span>
          </div>
        </div>
        <div className="mt-4 flex flex-col gap-2.5 px-5">
          {['w-5/12', 'w-1/3', 'w-1/2'].map((width) => (
            <div key={width} className="flex items-center justify-between gap-6">
              <span className={cn('h-1.5 rounded-full bg-fg-3/25', width)} />
              <span className="h-1.5 w-14 rounded-full bg-fg-3/25" />
            </div>
          ))}
        </div>
        <div className="absolute inset-x-5 bottom-4 flex items-center justify-between gap-6">
          <span className="flex items-center gap-1.5 text-aura">
            <Link2 className="size-3.5" />
            <span className="h-1.5 w-20 rounded-full bg-aura/35" />
          </span>
          <span className="h-2 w-16 rounded-full bg-fg-1/40" />
        </div>
      </div>
    </div>
  );
}

function QuoteLifecycle() {
  return (
    <div className="flex flex-1 flex-col gap-5">
      <StateRail
        label="Quote states"
        steps={QUOTE_STATES}
        cols="grid-cols-5"
        node="border-aura/45 text-aura"
        line="[background-image:linear-gradient(90deg,var(--aura),var(--ice))] opacity-60"
      />
      <QuoteSheets />
    </div>
  );
}

function CheckList({ items, icon: Icon = BadgeCheck, tint, className }: { items: readonly string[]; icon?: LucideIcon; tint: string; className?: string }) {
  return (
    <ul className={cn('flex flex-col gap-2', className)}>
      {items.map((item) => (
        <li key={item} className="flex items-start gap-2 rounded-lg border border-border-subtle bg-bg-2/60 px-3 py-2 text-sm text-fg-1">
          <Icon aria-hidden="true" className={cn('mt-0.5 size-4 shrink-0', tint)} />
          {item}
        </li>
      ))}
    </ul>
  );
}

/*
 * What a Stop reply does, worded as the product behaves (PRD: a Stop reply suppresses the contact at
 * once and cancels queued outreach). An example exchange, not a record.
 */
function StopExample() {
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-border-subtle bg-bg-0/50 p-3">
      <p className="flex items-center gap-1.5 text-xs text-fg-2">
        <MessageCircle aria-hidden="true" className="size-3.5 shrink-0 text-chart-3-hi" />
        Example WhatsApp reply
      </p>
      <p className="w-fit rounded-2xl rounded-tl-sm border border-border-strong bg-bg-2 px-3 py-1 font-mono text-sm text-fg-1">STOP</p>
      <p className="flex items-start gap-1.5 text-xs text-fg-1">
        <Ban aria-hidden="true" className="mt-px size-3.5 shrink-0 text-zest" />
        Suppressed at once; queued outreach is cancelled.
      </p>
    </div>
  );
}

function ScoreReasons() {
  const reasons = [
    { label: 'Website reachable', known: true },
    { label: 'Category matches a target category', known: true },
    { label: 'Phone on record', known: true },
    { label: 'Rating: not on record', known: false },
  ];
  return (
    <div className="mt-auto flex flex-col gap-2">
      <p className="text-xs text-fg-2">Example reasons, worded as the lead page shows them</p>
      <ul className="flex flex-col gap-1.5">
        {reasons.map((r) => (
          <li key={r.label} className="flex items-center gap-2 text-sm text-fg-1">
            {r.known ? (
              <BadgeCheck aria-hidden="true" className="size-4 shrink-0 text-volt-hi" />
            ) : (
              <CircleHelp aria-hidden="true" className="size-4 shrink-0 text-fg-2" />
            )}
            <span className="min-w-0">{r.label}</span>
            {r.known ? null : <span className="ml-auto rounded-full border border-border-strong px-1.5 text-[11px] text-fg-2">Unknown</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

const JOB_STEPS: readonly StateStep[] = [
  { label: 'Queued', icon: Clock },
  { label: 'Running', icon: Play },
  { label: 'Succeeded', icon: CircleCheck },
];

function JobFlow() {
  return (
    <div className="mt-auto flex flex-col gap-4">
      <StateRail
        label="Job states"
        steps={JOB_STEPS}
        cols="grid-cols-3"
        node="border-volt-hi/45 text-volt-hi"
        line="[background-image:linear-gradient(90deg,var(--volt-hi),var(--aura))] opacity-60"
      />
      <p className="flex items-start gap-2 text-xs text-fg-2">
        <RotateCcw aria-hidden="true" className="mt-px size-3.5 shrink-0 text-volt-hi" />
        A retryable failure goes back to Queued after a backoff; an ambiguous send waits for a person.
      </p>
    </div>
  );
}

function DemoSimulators() {
  return (
    <ul aria-label="Simulated sources and providers" className="mt-auto flex flex-wrap gap-2">
      {['sheets', 'meta', 'maps', 'WHATSAPP_INBOUND', 'EMAIL_INBOUND'].map((source) => (
        <li key={source} className="inline-flex items-center gap-1.5">
          <SourceChip source={source} withIcon />
          <ModeChip simulated />
        </li>
      ))}
    </ul>
  );
}

/** The sources and channels a LIVE workspace connects with its own provider accounts. */
function ConnectedSources() {
  return (
    <ul aria-label="Sources and channels you connect" className="mt-auto flex flex-wrap gap-2">
      {['sheets', 'meta', 'WHATSAPP_INBOUND', 'EMAIL_INBOUND'].map((source) => (
        <li key={source}>
          <SourceChip source={source} withIcon />
        </li>
      ))}
    </ul>
  );
}

const PANELS: readonly { name: string; who: string; dot: string }[] = [
  { name: 'Client', who: 'Owners: leads, inbox, pricing, quotations', dot: 'bg-aura' },
  { name: 'Operator', who: 'Employees: lead console, approvals, sources', dot: 'bg-zest' },
  { name: 'Platform admin', who: 'Workspaces, people, jobs, audit', dot: 'bg-flare' },
];

export function FeatureBento({ mode }: { mode: LandingMode }) {
  return (
    <section id="features" aria-labelledby="features-title" data-landing-section="features" className="relative isolate scroll-mt-20 py-10 sm:py-12">
      <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-10 px-4 sm:px-6 lg:px-8">
        <SectionIntro
          id="features-title"
          accent="zest"
          eyebrow="Features"
          title="Built for the work between a lead and a signed quote"
          description="Three panels on one workspace, with the rules that keep outreach honest built in rather than bolted on."
        />
        <Stagger className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-6">
          <StaggerItem inView className="md:col-span-2 lg:col-span-4">
            <SpotlightCard as="article" className={card('aura', 'relative isolate overflow-hidden')}>
              <BorderBeam duration={9} size={140} colorFrom="var(--aura)" colorTo="var(--zest)" />
              <CardHead icon={FileText} accent="aura" title="Versioned quotes with a real PDF">
                Every version keeps its line items and price snapshot, so a later catalog change never alters an issued quote. Editing an approved quote
                clears the approval; the share link is unguessable, expiring and revocable.
              </CardHead>
              <QuoteLifecycle />
            </SpotlightCard>
          </StaggerItem>
          <StaggerItem inView className="lg:col-span-2">
            <SpotlightCard as="article" className={card('zest')}>
              <CardHead icon={ShieldCheck} accent="zest" title="Consent before every send">
                WhatsApp needs channel-specific opt-in evidence. Scraped numbers and form fills are not opt-in.
              </CardHead>
              <CheckList tint="text-zest" items={['Opt-in evidence on record', 'Inside the 24-hour window, or an approved template', 'Not suppressed or unsubscribed']} />
              <div className="mt-auto">
                <StopExample />
              </div>
            </SpotlightCard>
          </StaggerItem>
          <StaggerItem inView className="lg:col-span-2">
            <TiltCard className="h-full">
              <SpotlightCard as="article" className={card('volt')}>
                <CardHead icon={Gauge} accent="volt" title="Scores you can explain">
                  A 0 to 100 heuristic with every reason shown and unknown inputs listed. It never stands in for intent or consent.
                </CardHead>
                <ScoreReasons />
              </SpotlightCard>
            </TiltCard>
          </StaggerItem>
          <StaggerItem inView className="lg:col-span-2">
            <TiltCard className="h-full">
              <SpotlightCard as="article" className={card('aura')}>
                <CardHead icon={UserCheck} accent="aura" title="Approval by default">
                  Drafts and quotes wait in an approval queue, and approval and dispatch bind to the same version. Auto-send is opt-in per workspace, audited,
                  and runs the same checks.
                </CardHead>
                <CheckList tint="text-aura" className="mt-auto" items={['Edit within your pricing permissions', 'Approve or reject with a reason']} />
              </SpotlightCard>
            </TiltCard>
          </StaggerItem>
          <StaggerItem inView className="lg:col-span-2">
            <TiltCard className="h-full">
              <SpotlightCard as="article" className={card('flare')}>
                <CardHead icon={LayoutDashboard} accent="flare" title="Three panels, one workspace">
                  Each role gets its own panel, with workspace and role enforced on the server for every read and write.
                </CardHead>
                <ul className="mt-auto flex flex-col gap-2">
                  {PANELS.map((p) => (
                    <li key={p.name} className="flex items-start gap-2.5 rounded-lg border border-border-subtle bg-bg-2/60 px-3 py-2">
                      <span aria-hidden="true" className={cn('mt-1.5 size-2 shrink-0 rounded-full', p.dot)} />
                      <span className="flex min-w-0 flex-col">
                        <span className="text-sm font-medium text-fg-1">{p.name}</span>
                        <span className="text-xs text-fg-2">{p.who}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              </SpotlightCard>
            </TiltCard>
          </StaggerItem>
          <StaggerItem inView className="lg:col-span-3">
            <SpotlightCard as="article" className={card('volt')}>
              <CardHead icon={History} accent="volt" title="Jobs that survive a restart">
                Sends, syncs and sweeps run as persistent jobs with retries and backoff. A send that timed out ambiguously is never blindly repeated, and every
                action lands in the audit log with its actor and result.
              </CardHead>
              <JobFlow />
            </SpotlightCard>
          </StaggerItem>
          <StaggerItem inView className="lg:col-span-3">
            {mode === 'demo' ? (
              <SpotlightCard as="article" className={card('zest')}>
                <CardHead icon={FlaskConical} accent="zest" title="A demo you can click through">
                  Fictitious businesses in Delhi NCR, Mumbai and Bengaluru, with a simulator for every source and provider. In DEMO mode nothing leaves the
                  app, and every simulated status says so.
                </CardHead>
                <DemoSimulators />
              </SpotlightCard>
            ) : (
              <SpotlightCard as="article" className={card('zest')}>
                <CardHead icon={KeyRound} accent="zest" title="Your own provider accounts">
                  WhatsApp Cloud API, Resend or SMTP email, Meta Lead Ads, Google Sheets and your AI provider connect with each workspace&apos;s own
                  credentials, stored encrypted. Every integration shows its status: connected, verification required or limited.
                </CardHead>
                <ConnectedSources />
              </SpotlightCard>
            )}
          </StaggerItem>
        </Stagger>
      </div>
    </section>
  );
}
