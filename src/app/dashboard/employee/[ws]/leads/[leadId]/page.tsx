/**
 * Lead detail in the employee lead console (T17, R32 console part). Everything shown comes from
 * the database through the tenant-scoped context (`loadLeadDetail`): contact and business facts,
 * the heuristic score with its reasons and unknown inputs, the pinned pipeline's progress, the
 * drafts (labelled with their generator), and the lead's quotations with approval and the stored
 * PDF. The `[ws]` slug is resolved against the employee's active assignments; a lead of another
 * workspace is 404. While the worker still has work for this lead the page re-reads itself.
 *
 * T26 completes it with the lead's stage control ("Move to stage", compare-and-set on the version
 * shown), consent per channel (matched by the contact HMAC, as eligibility) and the source records.
 *
 * Lead-gen F1 (ADR-118): a lead found through Google Places shows the Places attribution and "Confirm
 * details" (which keeps the Places-sourced fields past their 30-day expiry) under its contact facts.
 *
 * Lead-gen F5 (ADR-124, ADR-125): "Hand over to client" (the dialog says what will happen; gated on
 * leads.handoff) or, once handed over, the handoff card and the read-only state; and the reach-out
 * panel (WhatsApp consent state, record an opt-in with its notice and method, the click-to-chat link,
 * the workspace notice).
 *
 * Look (design spec §6): PageHeader with the source and stage chips and the score meter; the score
 * as a ring gauge with a bar per reason; the pipeline as a stepper rail with plain-language reasons;
 * the draft as message previews; quotations as cards. Status is icon + label everywhere, money is
 * neutral text.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft, Bot, CircleCheck, CircleHelp, Cog, Contact, Download, FileText, Gauge, Globe, Handshake, Inbox, Loader2, Mail, MapPin, MessageCircle, PenLine, Phone, Send, ShieldCheck, Sparkles, Star, Tag, TriangleAlert, Users, Wand2, Waypoints, Workflow, type LucideIcon } from 'lucide-react';
import { OperatorHandoff } from '@/components/handoff/HandoffSection';
import { HANDOFF_STATUS_CHIPS } from '@/components/handoff/handoff-vocabulary';
import { ReachOutPanel } from '@/components/reach-out/ReachOutPanel';
import { ToneChip } from '@/components/leads/ToneChip';
import { ConsentChips } from '@/components/leads/ConsentChips';
import { LeadPlacesNotice } from '@/components/leads/LeadPlacesNotice';
import { SourceRecords } from '@/components/leads/SourceRecords';
import { StageMoveMenu } from '@/components/leads/StageMoveMenu';
import { GatedAction } from '@/components/patterns/GatedAction';
import { ChipTitle } from '@/components/patterns/IconChip';
import { PipelineRail } from '@/components/leads/PipelineRail';
import { ScoreMeter } from '@/components/leads/ScoreMeter';
import { ScoreRing } from '@/components/leads/ScoreRing';
import { StageChip } from '@/components/leads/StageChip';
import { reviewReasonText, TRIGGER_LABELS, WEBSITE_LABELS } from '@/components/leads/lead-vocabulary';
import { EmptyState } from '@/components/patterns/EmptyState';
import type { Gate } from '@/components/patterns/GatedAction';
import { PageHeader } from '@/components/patterns/PageHeader';
import { SectionCard } from '@/components/patterns/SectionCard';
import { SourceChip } from '@/components/patterns/SourceChip';
import { ModeChip } from '@/components/patterns/StatusBadge';
import { buttonVariants, touchTarget } from '@/components/ui/button';
import { cn } from '@/components/ui/cn';
import { Reveal, Stagger, StaggerItem } from '@/components/visual/Reveal';
import { ShimmerText } from '@/components/visual/ShimmerText';
import { NotFoundError, PermissionDeniedError } from '@/lib/errors';
import { formatDate, formatDateTime } from '@/lib/format/date';
import { formatINR } from '@/lib/money';
import { generatorInfo, leadQuotePdfHref, type GeneratorKind } from '@/lib/schemas/lead-console';
import { SCORE_CAPTION } from '@/lib/schemas/scoring';
import { getPageContext } from '@/server/auth/page-context';
import { getRuntime } from '@/server/boot';
import { loadLeadHandoff, type LeadHandoffView } from '@/server/services/leads/handoff';
import { leadProfileDeps, loadLeadProfile, type LeadProfileDto } from '@/server/services/leads/profile';
import { loadReachOut } from '@/server/services/leads/reach-out';
import type { ReachOutDto } from '@/lib/schemas/reach-out';
import { loadLeadDetail, type DraftView, type LeadDetail, type LeadQuoteView } from '@/server/services/leads/console';
import { QuoteStatusBadge } from '../../../../user/quotations/quote-status';
import { AutoRefresh, DraftActions, QuoteApproveAction } from './lead-actions';

export const metadata: Metadata = { title: 'Lead' };
export const dynamic = 'force-dynamic';

const GENERATOR_ICONS: Readonly<Record<GeneratorKind, LucideIcon>> = {
  ai: Sparkles,
  template: Wand2,
  automatic: Bot,
  system: Cog,
  human: Users,
  none: CircleHelp,
  other: CircleHelp,
};

function paise(value: string | null): string {
  return value === null ? 'Not priced' : formatINR(BigInt(value));
}

/** True while the worker still owes this page something: unfinished pipeline stages or a PDF. */
function workerBusy(detail: LeadDetail): boolean {
  const stages = detail.pipeline;
  const failed = stages.some((s) => s.status === 'FAILED');
  const draft = stages.find((s) => s.stage === 'DRAFT');
  const pipelineRunning = stages.length > 0 && !failed && (draft === undefined || draft.status === 'PENDING' || draft.status === 'RUNNING');
  const pdfPending = detail.quotes.some((q) => !q.pdfReady && q.status !== 'CANCELLED');
  return pipelineRunning || pdfPending;
}

function Fact({ label, icon: Icon, children, className }: { label: string; icon: LucideIcon; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)}>
      <dt className="flex items-center gap-1.5 text-xs text-fg-2">
        <Icon aria-hidden="true" className="size-3.5 shrink-0 text-fg-3" />
        {label}
      </dt>
      <dd className="text-sm break-words text-fg-1">{children}</dd>
    </div>
  );
}

/** Five stars filled to the stored rating (decorative; the text next to it carries the value). */
function RatingStars({ ratingX10 }: { ratingX10: number }) {
  const share = Math.min(100, Math.max(0, (ratingX10 / 50) * 100));
  const row = (className: string) => (
    <span className={cn('flex gap-0.5', className)}>
      {[0, 1, 2, 3, 4].map((i) => (
        <Star key={i} className="size-3.5 shrink-0 fill-current" />
      ))}
    </span>
  );
  return (
    <span aria-hidden="true" className="relative inline-flex w-fit">
      {row('text-bg-3')}
      <span className="absolute inset-y-0 left-0 overflow-hidden" style={{ width: `${share}%` }}>
        {row('text-fg-1')}
      </span>
    </span>
  );
}

function DraftCard({ draft, tz }: { draft: DraftView; tz: string }) {
  const generator = generatorInfo(draft.generatorLabel);
  const GeneratorIcon = GENERATOR_ICONS[generator.kind];
  const ready = draft.status === 'READY';
  return (
    <article data-draft-id={draft.id} className="flex flex-col gap-4 rounded-xl border border-border-subtle bg-bg-2/50 p-4">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm">
        <span
          data-field="draft-status"
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium',
            ready ? 'border-success/35 bg-success/12 text-success' : 'border-warning/35 bg-warning/12 text-warning',
          )}
        >
          {ready ? <CircleCheck aria-hidden="true" className="size-3.5" /> : <TriangleAlert aria-hidden="true" className="size-3.5" />}
          {ready ? 'Ready for review' : 'Needs review'}
        </span>
        <span className="inline-flex min-w-0 items-center gap-1.5 text-fg-2">
          <GeneratorIcon aria-hidden="true" className="size-3.5 shrink-0" />
          <span>
            {generator.label} · {TRIGGER_LABELS[draft.trigger] ?? draft.trigger} · {formatDateTime(draft.createdAt, tz)}
          </span>
        </span>
      </header>

      {draft.reviewReasons.length > 0 ? (
        <ul className="flex flex-col gap-1 rounded-lg border border-warning/30 bg-warning/8 px-3 py-2 text-sm text-fg-1">
          {draft.reviewReasons.map((r) => (
            <li key={r} className="flex items-start gap-2">
              <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-warning" />
              {reviewReasonText(r)}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        {draft.followUpText ? (
          <div className="flex min-w-0 flex-col gap-1.5">
            <h3 className="flex items-center gap-1.5 text-xs font-medium text-fg-2">
              <MessageCircle aria-hidden="true" className="size-3.5" />
              Follow-up message
            </h3>
            <p className="rounded-2xl rounded-tl-sm border border-aura/25 bg-aura/12 px-3.5 py-2.5 text-sm whitespace-pre-line text-fg-1">{draft.followUpText}</p>
          </div>
        ) : null}
        {draft.emailSubject || draft.emailBody ? (
          <div className="flex min-w-0 flex-col gap-1.5">
            <h3 className="flex items-center gap-1.5 text-xs font-medium text-fg-2">
              <Mail aria-hidden="true" className="size-3.5" />
              Email
            </h3>
            <div className="flex flex-col overflow-hidden rounded-lg border border-border-subtle bg-bg-1">
              {draft.emailSubject ? <p className="border-b border-border-subtle px-3.5 py-2 text-sm font-medium text-fg-1">{draft.emailSubject}</p> : null}
              {draft.emailBody ? <p className="px-3.5 py-2.5 text-sm whitespace-pre-line text-fg-1">{draft.emailBody}</p> : null}
            </div>
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-1.5">
        <h3 className="flex items-center gap-1.5 text-xs font-medium text-fg-2">
          <FileText aria-hidden="true" className="size-3.5" />
          Quote proposal
        </h3>
        {draft.hasProposal ? (
          <div className="flex flex-col gap-2 rounded-lg border border-border-subtle bg-bg-1 px-3.5 py-2.5">
            <ul className="flex flex-col divide-y divide-border-subtle text-sm text-fg-1">
              {draft.proposalLines.map((l) => (
                <li key={l.serviceId} className="flex flex-wrap justify-between gap-2 py-1.5 first:pt-0">
                  <span>
                    {l.serviceName} <span className="text-fg-2">× {l.qty}</span>
                  </span>
                  <span className="tabular text-fg-1">{paise(l.lineTotalPaise)}</span>
                </li>
              ))}
            </ul>
            {draft.previewTotalPaise ? (
              <p className="tabular text-sm text-fg-2">
                Preview total <span className="font-medium text-fg-1">{paise(draft.previewTotalPaise)}</span> (prices come from the server price list when the quote is created)
              </p>
            ) : null}
            {draft.scopeText ? <p className="text-sm text-fg-2">{draft.scopeText}</p> : null}
            {draft.timelineText ? <p className="text-sm text-fg-2">{draft.timelineText}</p> : null}
          </div>
        ) : (
          <p className="text-sm text-fg-2">No catalog service was proposed.</p>
        )}
      </div>
    </article>
  );
}

function approveGate(q: LeadQuoteView, permissions: LeadDetail['permissions'], workspaceSlug: string): Gate | null {
  if (!permissions.canApprove) return { category: 'permission', reason: 'Your assignment does not include approvals.decide. Ask a super admin to grant it.' };
  if (q.needsPricingReview) {
    return permissions.canCreateQuote
      ? {
          category: 'eligibility',
          reason: 'A service has no price or the total is above the review limit. Revise the quotation first.',
          fix: { href: `/dashboard/employee/${workspaceSlug}/approvals`, label: 'Revise in the approval queue' },
        }
      : { category: 'eligibility', reason: 'A service has no price or the total is above the review limit. Someone who can edit quotations must revise it first.' };
  }
  if (q.validityPassed) return { category: 'eligibility', reason: 'This version is past its validity date and needs a revision.' };
  return null;
}

export default async function LeadDetailPage({ params }: { params: Promise<{ ws: string; leadId: string }> }) {
  const { ws, leadId } = await params;
  let page;
  try {
    page = await getPageContext({ workspaceSlug: ws });
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  if (!page) redirect('/login');
  if (page.session.user.globalRole !== 'EMPLOYEE') notFound();

  let detail: LeadDetail;
  let profile: LeadProfileDto;
  let handoff: LeadHandoffView;
  let reachOut: ReachOutDto;
  try {
    const config = getRuntime().config;
    [detail, profile, handoff, reachOut] = await Promise.all([
      loadLeadDetail(page.ctx, leadId),
      loadLeadProfile(page.ctx, leadId, leadProfileDeps(config)),
      loadLeadHandoff(page.ctx, leadId, { keyRing: config.secrets.credentials }),
      loadReachOut(page.ctx),
    ]);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    if (error instanceof PermissionDeniedError) {
      return (
        <EmptyState
          icon={<Users aria-hidden="true" className="size-5" />}
          title="Leads are not part of your assignment"
          description="Your assignment in this workspace does not include leads.read. A super admin can grant it from the people page."
        />
      );
    }
    throw error;
  }

  const { lead, workspace } = detail;
  const tz = workspace.timezone;
  const consoleHref = `/dashboard/employee/${workspace.slug}/leads`;
  const latestDraft = detail.drafts[0] ?? null;
  const proposalDraft = detail.drafts.find((d) => d.hasProposal) ?? null;
  const scoreText = lead.score === null ? 'Not scored' : `${lead.score} / 100`;
  const website = WEBSITE_LABELS[lead.websiteStatus] ?? lead.websiteStatus;
  // One primary action: approving the newest draft quotation when it can be approved, else creating one.
  const primaryQuoteId = detail.quotes.find((q) => q.status === 'DRAFT' && approveGate(q, detail.permissions, workspace.slug) === null)?.id ?? null;

  return (
    <div className="flex flex-col gap-6">
      <Link href={consoleHref} className={cn('group relative inline-flex w-fit items-center gap-1.5 text-sm text-fg-2 hover:text-fg-1', touchTarget)}>
        <ArrowLeft aria-hidden="true" className="size-4 transition-transform duration-fast motion-safe:group-hover:-translate-x-0.5" />
        Lead console
      </Link>
      <PageHeader
        className="-mt-3"
        eyebrow={workspace.name}
        title={lead.displayName}
        description={
          <span className="flex flex-wrap items-center gap-2 text-sm">
            <SourceChip source={lead.firstSource} withIcon />
            <StageChip stage={lead.salesStage} />
            {lead.simulated ? <ModeChip simulated /> : null}
            {handoff.handoff ? <ToneChip tone={HANDOFF_STATUS_CHIPS[handoff.handoff.status].tone} icon={HANDOFF_STATUS_CHIPS[handoff.handoff.status].icon} label={HANDOFF_STATUS_CHIPS[handoff.handoff.status].label} /> : null}
            <span className="text-fg-2">Added {formatDateTime(lead.createdAt, tz)}</span>
          </span>
        }
        actions={
          <div className="hidden min-w-48 flex-col gap-1.5 rounded-xl border border-border-subtle bg-bg-1/70 px-3.5 py-2.5 sm:flex">
            <span className="flex items-baseline justify-between gap-4">
              <span className="text-xs text-fg-2">Fit score</span>
              <span className="tabular font-display text-lg font-semibold text-fg-1">{scoreText}</span>
            </span>
            <ScoreMeter value={lead.score} size="md" />
          </div>
        }
      />
      <AutoRefresh active={workerBusy(detail)} label="The worker is still processing this lead; this page updates by itself." />

      <Stagger className="grid gap-6 lg:grid-cols-[minmax(0,6fr)_minmax(0,5fr)]">
        <StaggerItem className="flex min-w-0">
          <SectionCard
            title={
              <ChipTitle icon={<Gauge aria-hidden="true" />} hue="volt">
                Score
              </ChipTitle>
            }
            className="flex-1"
            meta={
              <>
                {SCORE_CAPTION}
                {detail.score.configVersion === null ? '' : ` Scoring configuration v${detail.score.configVersion}.`}
              </>
            }
          >
            <div className="flex flex-col items-center gap-5 sm:flex-row sm:items-start">
              <ScoreRing value={lead.score}>
                <span data-field="score" className="tabular font-display text-xl font-semibold text-fg-1">
                  {scoreText}
                </span>
                <span className="text-[11px] font-medium tracking-[0.12em] text-fg-2 uppercase">Fit</span>
              </ScoreRing>
              <div className="flex w-full min-w-0 flex-1 flex-col gap-3">
                {detail.score.reasons.length > 0 ? (
                  <ul className="flex flex-col gap-2.5 text-sm">
                    {detail.score.reasons.map((r) => (
                      <li key={r.input} className="flex flex-col gap-1">
                        <span className="flex justify-between gap-2">
                          <span className="text-fg-1">{r.label}</span>
                          <span className="tabular shrink-0 text-fg-2">
                            {r.points} / {r.maxPoints}
                          </span>
                        </span>
                        <ScoreMeter value={r.maxPoints > 0 ? (r.points / r.maxPoints) * 100 : 0} size="md" className="h-1" />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-fg-2">No scoring reasons recorded yet.</p>
                )}
                {detail.score.unknownInputs.length > 0 ? (
                  <div className="flex flex-col gap-1.5 border-t border-border-subtle pt-3">
                    <h3 className="text-xs font-medium text-fg-2">Not known, scored 0</h3>
                    <ul className="flex flex-col gap-1 text-sm text-fg-2">
                      {detail.score.unknownInputs.map((u) => (
                        <li key={u.input} className="flex items-start gap-2">
                          <CircleHelp aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-fg-3" />
                          {u.label}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            </div>
          </SectionCard>
        </StaggerItem>

        <StaggerItem className="flex min-w-0">
          <SectionCard title={<ChipTitle icon={<Contact aria-hidden="true" />}>Contact and business</ChipTitle>} className="flex-1">
            <dl className="grid gap-x-4 gap-y-3.5 sm:grid-cols-2">
              <Fact label="Phone" icon={Phone}>
                {lead.phoneE164 ?? 'None on record'}
              </Fact>
              <Fact label="Email" icon={Mail}>
                {lead.emailNormalized ?? 'None on record'}
              </Fact>
              <Fact label="Website" icon={Globe}>
                {lead.website ? `${lead.website} (${website})` : website}
              </Fact>
              <Fact label="Category" icon={Tag}>
                {lead.category ?? 'Unknown'}
              </Fact>
              <Fact label="City" icon={MapPin}>
                {lead.city ?? 'Unknown'}
              </Fact>
              <Fact label="Address" icon={MapPin}>
                {lead.address ?? 'Unknown'}
              </Fact>
              <Fact label="Rating" icon={Star} className="sm:col-span-2">
                {lead.ratingX10 === null ? (
                  'Unknown'
                ) : (
                  <span className="flex flex-wrap items-center gap-2">
                    <RatingStars ratingX10={lead.ratingX10} />
                    {`${(lead.ratingX10 / 10).toFixed(1)} stars${lead.reviewCount === null ? '' : ` from ${lead.reviewCount} reviews`}`}
                  </span>
                )}
              </Fact>
            </dl>
            <LeadPlacesNotice leadId={lead.id} places={profile.places} simulated={lead.simulated} timeZone={tz} workspaceSlug={workspace.slug} />
          </SectionCard>
        </StaggerItem>
      </Stagger>

      <Reveal delay={0.1} className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <SectionCard title={<ChipTitle icon={<Waypoints aria-hidden="true" />} hue="zest">Stage and consent</ChipTitle>} className="flex-1">
          <div className="flex flex-col gap-3">
            {profile.lead.merged ? (
              <p className="text-sm text-fg-2">This lead was merged into another lead; its stage is kept there.</p>
            ) : profile.permissions.canMoveStage ? (
              <StageMoveMenu lead={profile.lead} workspaceSlug={workspace.slug} className="self-start" />
            ) : (
              <GatedAction label="Move to stage" size="sm" gate={{ category: 'permission', reason: 'Your assignment does not include leads.write, which moving leads needs. A super admin can grant it from the people page.' }} />
            )}
            <h3 className="mt-2 flex items-center gap-1.5 text-xs font-medium text-fg-2">
              <ShieldCheck aria-hidden="true" className="size-3.5" />
              Consent by channel
            </h3>
            <ConsentChips consent={profile.consent} timeZone={tz} />
          </div>
        </SectionCard>
        <SectionCard title={<ChipTitle icon={<Inbox aria-hidden="true" />}>Source</ChipTitle>} className="flex-1">
          <SourceRecords records={profile.sources} timeZone={tz} />
        </SectionCard>
      </Reveal>

      <Reveal delay={0.12} className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)]">
        <SectionCard
          title={<ChipTitle icon={<Handshake aria-hidden="true" />} hue="volt">Hand over to the client</ChipTitle>}
          meta="The client's team closes the deal through the quote flow."
          className="flex-1"
        >
          <OperatorHandoff view={handoff} timeZone={tz} />
        </SectionCard>
        <SectionCard title={<ChipTitle icon={<Send aria-hidden="true" />} hue="ice">Reach out</ChipTitle>} meta="How to start a WhatsApp conversation this lead agreed to." className="flex-1">
          <ReachOutPanel
            reachOut={reachOut}
            whatsapp={profile.consent.find((c) => c.channel === 'WHATSAPP') ?? { channel: 'WHATSAPP', state: 'NO_CONTACT', since: null, source: null }}
            leadId={lead.id}
            handedOver={handoff.handoff !== null}
            integrationsHref={`/dashboard/employee/${workspace.slug}/integrations`}
          />
        </SectionCard>
      </Reveal>

      <Reveal delay={0.14}>
        <SectionCard title={<ChipTitle icon={<Workflow aria-hidden="true" />} hue="zest">Pipeline</ChipTitle>} meta="The steps this lead went through in its pinned pipeline.">
          {detail.pipeline.length === 0 ? (
            <p className="text-sm text-fg-2">This lead was not routed into a pipeline (no active pipeline when it arrived).</p>
          ) : (
            <PipelineRail steps={detail.pipeline} />
          )}
        </SectionCard>
      </Reveal>

      <Reveal delay={0.2} className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_24rem] xl:items-start">
        <SectionCard title={<ChipTitle icon={<PenLine aria-hidden="true" />} hue="ice">Draft</ChipTitle>} meta="Written by the pipeline or on request. Nothing is sent from here; sends go through the approval queue.">
          <DraftActions
            leadId={lead.id}
            workspaceSlug={workspace.slug}
            latestDraftId={latestDraft?.id ?? null}
            proposalDraftId={proposalDraft?.id ?? null}
            localGeneratorAvailable={latestDraft?.localGeneratorAvailable ?? false}
            permissions={detail.permissions}
            primary={primaryQuoteId === null}
          />
          {latestDraft ? (
            <DraftCard draft={latestDraft} tz={tz} />
          ) : (
            <p className="text-sm text-fg-2">No draft yet. The pipeline writes one after scoring, or generate one now.</p>
          )}
          {detail.drafts.length > 1 ? <p className="text-xs text-fg-2">{detail.drafts.length - 1} earlier draft(s) kept for the record.</p> : null}
        </SectionCard>

        <SectionCard title={<ChipTitle icon={<FileText aria-hidden="true" />}>Quotations</ChipTitle>} className="xl:sticky xl:top-[calc(var(--topbar-h)+1.5rem)]">
          {detail.quotes.length === 0 ? (
            <EmptyState
              headingLevel="h3"
              icon={<FileText aria-hidden="true" className="size-5" />}
              title="No quotation yet"
              description="Create one from the draft's proposal. Prices always come from the workspace price list."
            />
          ) : (
            <ul className="flex flex-col gap-3">
              {detail.quotes.map((q) => (
                <li key={q.id} data-quote-number={q.number} className="relative flex flex-col gap-3 overflow-hidden rounded-xl border border-border-subtle bg-bg-2/50 p-4">
                  <span aria-hidden="true" className="pointer-events-none absolute inset-y-3 left-0 w-0.5 rounded-full bg-aura/70" />
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="flex items-center gap-2 text-sm font-semibold text-fg-1">
                      <FileText aria-hidden="true" className="size-4 text-aura" />
                      {q.number} v{q.currentVersionNo}
                    </span>
                    <QuoteStatusBadge status={q.status} />
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <span className="tabular font-display text-xl font-semibold text-fg-1">{paise(q.totalPaise)}</span>
                    <span className="text-xs text-fg-2">{q.validUntil ? `Valid until ${formatDate(q.validUntil, tz)}` : 'No validity date'}</span>
                  </div>
                  <div className="flex flex-wrap items-start gap-2">
                    {q.status === 'DRAFT' ? (
                      <QuoteApproveAction
                        leadId={lead.id}
                        quoteId={q.id}
                        number={q.number}
                        workspaceSlug={workspace.slug}
                        versionNo={q.currentVersionNo}
                        gate={approveGate(q, detail.permissions, workspace.slug)}
                        primary={q.id === primaryQuoteId}
                      />
                    ) : null}
                    {q.pdfReady ? (
                      <a href={leadQuotePdfHref(lead.id, q.id, workspace.slug)} download className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                        <Download aria-hidden="true" />
                        Download PDF
                      </a>
                    ) : q.status === 'CANCELLED' ? null : (
                      <span role="status" className="inline-flex h-8 items-center gap-1.5 text-sm text-fg-2">
                        <Loader2 aria-hidden="true" className="size-4 text-info motion-safe:animate-spin" />
                        <ShimmerText>Preparing the PDF</ShimmerText>
                      </span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </Reveal>
    </div>
  );
}
