'use client';

/**
 * "How it works" (plan T30, 06-design §11.7): the pipeline Source -> AuraLead core -> Score ->
 * Quote -> Message, each stage labelled with what the product really does (PRD: normalize and
 * dedupe by contact key, explainable heuristic score, prices from the price list and never from
 * AI, versioned quote and real PDF, approval by default, consent + 24h window + suppression
 * before any send). From lg a diagram rail draws the flow with AnimatedBeam pulses, and each node
 * says in one line what happens there; the five stage cards below share a subgrid, so titles,
 * leads and facts line up across the row. Below lg the stages read as a vertical timeline. Under
 * reduced motion the beams rest as solid lines and every annotation stays visible, so the section
 * is a static annotated diagram. The beams are aria-hidden; the ordered list carries the content.
 */
import { BadgeCheck, Check, Cpu, FileText, Gauge, Inbox, Send, type LucideIcon } from 'lucide-react';
import { useRef, type ReactNode, type RefObject } from 'react';
import { ProductMark } from '@/components/patterns/ProductMark';
import { SourceChip } from '@/components/patterns/SourceChip';
import { cn } from '@/components/ui/cn';
import { AnimatedBeam } from '@/components/visual/AnimatedBeam';
import { ChromaBorder } from '@/components/visual/ChromaBorder';
import { GridPattern } from '@/components/visual/Patterns';
import { Reveal, Stagger, StaggerItem } from '@/components/visual/Reveal';
import { SectionIntro } from './SectionIntro';

type Stage = { key: string; title: string; icon: LucideIcon; lead: string; facts: readonly string[]; tint: string; hairline: string; chip: string };

const PIPELINE_STAGES: readonly Stage[] = [
  {
    key: 'capture',
    title: 'Capture',
    icon: Inbox,
    lead: 'Leads arrive from Google Sheets (an Apps Script you paste in), Meta Lead Ads and the Maps extension.',
    facts: ['Every payload is authenticated, size-checked and replay-protected', 'DEMO simulates each source end to end'],
    tint: 'text-zest',
    hairline: 'bg-zest',
    chip: 'border-zest/30 bg-zest/10',
  },
  {
    key: 'normalize',
    title: 'Normalize and dedupe',
    icon: Cpu,
    lead: 'Phones become E.164 (India by default) and emails are never invented.',
    facts: ['Deduplicated per workspace by provider ID and contact key', 'Conflicting matches go to a person for review'],
    tint: 'text-aura',
    hairline: 'bg-aura',
    chip: 'border-aura/30 bg-aura/12',
  },
  {
    key: 'score',
    title: 'Score',
    icon: Gauge,
    lead: 'An explainable opportunity score from 0 to 100.',
    facts: ['Every point comes with its reason; unknown inputs are listed, not guessed', 'A heuristic, never a claim of intent or consent'],
    tint: 'text-volt-hi',
    hairline: 'bg-volt-hi',
    chip: 'border-volt-hi/35 bg-volt/14',
  },
  {
    key: 'quote',
    title: 'Quote',
    icon: FileText,
    lead: 'Prices are resolved from your versioned price list, never by AI.',
    facts: ['Tax and discount limits are computed on the server', 'Versioned quote, a real PDF and a revocable share link'],
    tint: 'text-aura',
    hairline: 'bg-aura',
    chip: 'border-aura/30 bg-aura/12',
  },
  {
    key: 'send',
    title: 'Approve, then send',
    icon: Send,
    lead: 'Nothing goes out until a person approves it. Auto-send is opt-in per workspace.',
    facts: ['Consent, the 24-hour WhatsApp window and suppression are checked before every send', 'A Stop reply suppresses at once and cancels queued outreach'],
    tint: 'text-flare',
    hairline: 'bg-flare',
    chip: 'border-flare/30 bg-flare/10',
  },
];

/** A node's caption under the diagram: what it is, then in one line what really happens there. */
function NodeCaption({ label, detail, strong }: { label: string; detail: string; strong?: boolean }) {
  return (
    <span className="absolute top-full left-1/2 mt-3 flex w-44 -translate-x-1/2 flex-col items-center gap-0.5 text-center">
      <span className={cn('text-sm text-fg-1', strong ? 'font-semibold' : 'font-medium')}>{label}</span>
      <span className="text-xs text-pretty text-fg-2">{detail}</span>
    </span>
  );
}

function RailNode({
  nodeRef,
  label,
  detail,
  icon: Icon,
  className,
}: {
  nodeRef: RefObject<HTMLDivElement | null>;
  label: string;
  detail: string;
  icon: LucideIcon;
  className?: string;
}) {
  return (
    <div className="relative flex justify-center">
      <div className="relative z-10 rounded-2xl bg-bg-1">
        <div ref={nodeRef} className={cn('grid size-16 place-items-center rounded-2xl border', className)}>
          <Icon aria-hidden="true" className="size-7" />
        </div>
      </div>
      <NodeCaption label={label} detail={detail} />
    </div>
  );
}

function ChipNode({ nodeRef, children }: { nodeRef: RefObject<HTMLSpanElement | null>; children: ReactNode }) {
  return (
    <span ref={nodeRef} className="relative z-10 inline-flex rounded-full bg-bg-1">
      {children}
    </span>
  );
}

function PipelineRail() {
  const containerRef = useRef<HTMLDivElement>(null);
  const sheetsRef = useRef<HTMLSpanElement>(null);
  const metaRef = useRef<HTMLSpanElement>(null);
  const mapsRef = useRef<HTMLSpanElement>(null);
  const coreRef = useRef<HTMLDivElement>(null);
  const scoreRef = useRef<HTMLDivElement>(null);
  const quoteRef = useRef<HTMLDivElement>(null);
  const whatsappRef = useRef<HTMLSpanElement>(null);
  const emailRef = useRef<HTMLSpanElement>(null);
  return (
    <div
      ref={containerRef}
      data-pipeline-rail=""
      className="relative isolate hidden grid-cols-5 items-center overflow-hidden rounded-2xl border border-border-subtle bg-bg-1/70 px-8 pt-12 pb-28 lg:grid"
    >
      <GridPattern fade="radial" size={32} />
      <div className="flex flex-col items-start gap-4">
        <ChipNode nodeRef={sheetsRef}>
          <SourceChip source="sheets" withIcon className="py-1" />
        </ChipNode>
        <ChipNode nodeRef={metaRef}>
          <SourceChip source="meta" withIcon className="py-1" />
        </ChipNode>
        <ChipNode nodeRef={mapsRef}>
          <SourceChip source="maps" withIcon className="py-1" />
        </ChipNode>
      </div>
      <div className="relative flex justify-center">
        <ChromaBorder radius="9999px" className="relative z-10">
          <div ref={coreRef} className="grid size-24 place-items-center rounded-full border border-aura/30 bg-bg-0 [background-image:radial-gradient(circle_at_50%_40%,color-mix(in_oklab,var(--aura)_22%,transparent),transparent_68%)]">
            <ProductMark className="size-12" />
          </div>
        </ChromaBorder>
        <NodeCaption label="AuraLead core" detail="E.164 phones, deduped by contact key" strong />
      </div>
      <RailNode
        nodeRef={scoreRef}
        label="Score 0 to 100"
        detail="Every point comes with its reason"
        icon={Gauge}
        className="border-volt-hi/45 bg-volt/14 text-volt-hi [background-image:radial-gradient(circle_at_50%_30%,color-mix(in_oklab,var(--volt-hi)_26%,transparent),transparent_72%)]"
      />
      <RailNode
        nodeRef={quoteRef}
        label="Versioned quote + PDF"
        detail="Priced from your price list, never by AI"
        icon={FileText}
        className="border-aura/45 bg-aura/12 text-aura [background-image:radial-gradient(circle_at_50%_30%,color-mix(in_oklab,var(--aura)_24%,transparent),transparent_72%)]"
      />
      <div className="flex flex-col items-end gap-4">
        <span className="flex items-start gap-2 text-xs text-fg-2">
          <BadgeCheck aria-hidden="true" className="mt-px size-4 shrink-0 text-aura" />
          <span>
            After approval,
            <br />
            consent and suppression checks
          </span>
        </span>
        <ChipNode nodeRef={whatsappRef}>
          <SourceChip source="WHATSAPP_INBOUND" withIcon className="py-1" />
        </ChipNode>
        <ChipNode nodeRef={emailRef}>
          <SourceChip source="EMAIL_INBOUND" withIcon className="py-1" />
        </ChipNode>
      </div>
      <AnimatedBeam containerRef={containerRef} fromRef={sheetsRef} toRef={coreRef} curvature={-24} fromColor="var(--chart-2-hi)" toColor="var(--aura)" duration={4.2} />
      <AnimatedBeam containerRef={containerRef} fromRef={metaRef} toRef={coreRef} fromColor="var(--chart-4-hi)" toColor="var(--aura)" duration={4.2} delay={0.7} />
      <AnimatedBeam containerRef={containerRef} fromRef={mapsRef} toRef={coreRef} curvature={24} fromColor="var(--chart-1-hi)" toColor="var(--aura)" duration={4.2} delay={1.4} />
      <AnimatedBeam containerRef={containerRef} fromRef={coreRef} toRef={scoreRef} fromColor="var(--aura)" toColor="var(--volt-hi)" duration={3.6} delay={0.4} width={3} />
      <AnimatedBeam containerRef={containerRef} fromRef={scoreRef} toRef={quoteRef} fromColor="var(--volt-hi)" toColor="var(--aura)" duration={3.6} delay={1.1} width={3} />
      <AnimatedBeam containerRef={containerRef} fromRef={quoteRef} toRef={whatsappRef} curvature={18} fromColor="var(--flare-ice)" toColor="var(--flare)" duration={4} delay={1.8} />
      <AnimatedBeam containerRef={containerRef} fromRef={quoteRef} toRef={emailRef} curvature={-18} fromColor="var(--aura)" toColor="var(--ice)" duration={4} delay={2.4} />
    </div>
  );
}

export function HowItWorks() {
  return (
    <section id="how-it-works" aria-labelledby="how-title" data-landing-section="how-it-works" className="relative isolate scroll-mt-20 pt-20 pb-10 sm:pt-24 sm:pb-12">
      <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-10 px-4 sm:px-6 lg:gap-12 lg:px-8">
        <SectionIntro
          id="how-title"
          accent="aura"
          eyebrow="How it works"
          title="One pipeline, labelled with what really happens"
          description="Every lead takes the same five steps. Each label below is what the product does, not a promise."
        />
        <Reveal inView variant="fade">
          <PipelineRail />
        </Reveal>
        {/* From lg the five cards share four subgrid rows (icon, title, lead, facts), so the rows line up across the stages. */}
        <Stagger as="ol" className="relative grid gap-4 lg:grid-cols-5 lg:gap-x-4 lg:gap-y-3">
          {PIPELINE_STAGES.map((stage, index) => (
            <StaggerItem key={stage.key} as="li" inView className="relative min-w-0 lg:row-span-4 lg:grid lg:grid-rows-subgrid">
              <StageCard stage={stage} index={index} last={index === PIPELINE_STAGES.length - 1} />
            </StaggerItem>
          ))}
        </Stagger>
      </div>
    </section>
  );
}

function StageCard({ stage, index, last }: { stage: Stage; index: number; last: boolean }) {
  const Icon = stage.icon;
  const step = String(index + 1).padStart(2, '0');
  return (
    <div data-stage={stage.key} className="flex h-full gap-4 lg:row-span-4 lg:grid lg:grid-rows-subgrid">
      {/* Below lg: a timeline rail. The connector runs aura -> ice (pink only ever meets ice). */}
      <div aria-hidden="true" className="relative flex flex-col items-center lg:hidden">
        <span className={cn('relative z-10 grid size-12 shrink-0 place-items-center rounded-2xl border bg-bg-2', stage.chip, stage.tint)}>
          <Icon className="size-5" />
        </span>
        {last ? null : <span className="-mb-4 w-px flex-1 [background-image:linear-gradient(in_oklab_to_bottom,var(--aura),var(--ice))]" />}
      </div>
      <div className="relative flex h-full min-w-0 flex-1 flex-col gap-3 overflow-hidden rounded-xl border border-border-subtle bg-bg-1/80 p-4 sm:p-5 lg:row-span-4 lg:grid lg:grid-rows-subgrid lg:gap-3">
        <span aria-hidden="true" className={cn('pointer-events-none absolute inset-x-0 top-0 h-0.5 opacity-80', stage.hairline)} />
        {/* From lg: the stage icon in its hue, with the step number on the right. */}
        <div aria-hidden="true" className="hidden items-center justify-between lg:flex">
          <span className={cn('grid size-10 place-items-center rounded-xl border', stage.chip, stage.tint)}>
            <Icon className="size-5" />
          </span>
          <span className="font-mono text-xs text-fg-3 tabular">{step}</span>
        </div>
        <div className="flex items-center gap-2">
          <span aria-hidden="true" className="rounded-full border border-border-strong bg-bg-2 px-2 py-0.5 font-mono text-[11px] text-fg-2 tabular lg:hidden">
            {step}
          </span>
          <h3 className="font-display text-base font-semibold text-balance text-fg-1">{stage.title}</h3>
        </div>
        <p className="text-sm text-fg-1">{stage.lead}</p>
        <ul className="flex flex-col gap-2 border-t border-border-subtle pt-3">
          {stage.facts.map((fact) => (
            <li key={fact} className="flex gap-2 text-sm text-fg-2">
              <Check aria-hidden="true" className={cn('mt-0.5 size-4 shrink-0', stage.tint)} />
              <span>{fact}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
