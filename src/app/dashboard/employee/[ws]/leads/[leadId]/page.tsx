/**
 * Lead detail in the employee lead console (T17, R32 console part). Everything shown comes from
 * the database through the tenant-scoped context (`loadLeadDetail`): contact and business facts,
 * the heuristic score with its reasons and unknown inputs, the pinned pipeline's progress, the AI
 * drafts (labelled with their generator), and the lead's quotations with approval and the stored
 * PDF. The `[ws]` slug is resolved against the employee's active assignments; a lead of another
 * workspace is 404. While the worker still has work for this lead the page re-reads itself.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { ArrowLeft, Download, FileText, Loader2, Users } from 'lucide-react';
import { EmptyState } from '@/components/patterns/EmptyState';
import type { Gate } from '@/components/patterns/GatedAction';
import { ModeChip } from '@/components/patterns/StatusBadge';
import { buttonVariants } from '@/components/ui/button';
import { NotFoundError, PermissionDeniedError } from '@/lib/errors';
import { formatDate, formatDateTime } from '@/lib/format/date';
import { formatINR } from '@/lib/money';
import { leadQuotePdfHref } from '@/lib/schemas/lead-console';
import { SCORE_CAPTION } from '@/lib/schemas/scoring';
import { getPageContext } from '@/server/auth/page-context';
import { loadLeadDetail, type DraftView, type LeadDetail, type LeadQuoteView } from '@/server/services/leads/console';
import { QuoteStatusBadge } from '../../../../user/quotations/quote-status';
import { AutoRefresh, DraftActions, QuoteApproveAction } from './lead-actions';

export const metadata: Metadata = { title: 'Lead' };
export const dynamic = 'force-dynamic';

const SOURCE_LABELS: Record<string, string> = {
  GOOGLE_SHEETS: 'Google Sheets',
  META_ADS: 'Meta Lead Ads',
  GMAPS_EXTENSION: 'Maps extension',
  WHATSAPP_INBOUND: 'WhatsApp',
  EMAIL_INBOUND: 'Email',
  MANUAL: 'Manual',
};

const SALES_STAGE_LABELS: Record<string, string> = {
  NEW: 'New',
  CONTACTED: 'Contacted',
  REPLIED: 'Replied',
  QUOTE_SENT: 'Quote sent',
  CONVERTED: 'Converted',
  LOST: 'Lost',
};

const WEBSITE_LABELS: Record<string, string> = {
  UNKNOWN: 'Not checked',
  PRESENT_UNVERIFIED: 'Listed, not checked',
  REACHABLE: 'Reachable',
  UNREACHABLE: 'Unreachable',
  BLOCKED: 'Blocked by the safety check',
  VERIFIED_ABSENT: 'No website',
};

const PIPELINE_STAGE_LABELS: Record<string, string> = {
  INGESTION: 'Ingestion',
  SCORE: 'Website check and score',
  DRAFT: 'AI draft',
  APPROVAL: 'Approval',
  DELIVERY: 'Delivery',
};

const RUN_STATUS: Record<string, { label: string; tone: string }> = {
  PENDING: { label: 'Waiting', tone: 'text-warning' },
  RUNNING: { label: 'Running', tone: 'text-info' },
  DONE: { label: 'Done', tone: 'text-success' },
  SKIPPED: { label: 'Skipped', tone: 'text-fg-2' },
  FAILED: { label: 'Failed', tone: 'text-danger' },
};

const RUN_REASONS: Record<string, string> = {
  STAGE_HANDLER_MISSING: 'Waits for the approval step of the pipeline; use the quotation approval below.',
  NO_ACTIVE_SCORING_CONFIG: 'No active scoring configuration.',
  STAGE_ERROR: 'The stage failed; the job inspector has the details.',
};

const GENERATOR_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  'local-deterministic': 'Local template (deterministic)',
  none: 'Not generated',
};

const TRIGGER_LABELS: Record<string, string> = { PIPELINE: 'Pipeline', MANUAL: 'Requested', LOCAL_EXPLICIT: 'Local template, requested' };

const REVIEW_REASON_LABELS: Record<string, string> = {
  UNKNOWN_SERVICE: 'Proposed a service that is not in the catalog (dropped).',
  QTY_OUT_OF_BOUNDS: 'A proposed quantity was outside the price list limits.',
  DUPLICATE_SERVICE: 'The proposal named a service twice.',
  NO_ITEMS: 'The proposal names no catalog service.',
  PRICE_MISSING: 'A proposed service has no price in the active price list.',
  SERVICE_ARCHIVED: 'A proposed service is archived.',
  TOTAL_ABOVE_SANITY_CAP: 'The total is above the review limit.',
  PRICING_MISSING: 'The workspace has no active price list.',
  TAX_NOT_CONFIGURED: 'Tax is not configured.',
  GENERATION_FAILED: 'The AI provider did not return a usable draft.',
  AI_NOT_CONFIGURED: 'No AI provider is configured for this workspace.',
  MODE_MISMATCH: 'The workspace mode does not match the process mode.',
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

function Section({ id, title, children, aside }: { id: string; title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3 rounded-xl border border-border-subtle bg-bg-1 p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={id} className="font-display text-lg font-semibold text-fg-1">
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-fg-2">{label}</dt>
      <dd className="text-sm break-words text-fg-1">{children}</dd>
    </div>
  );
}

function DraftCard({ draft, tz }: { draft: DraftView; tz: string }) {
  return (
    <article data-draft-id={draft.id} className="flex flex-col gap-3 rounded-lg border border-border-subtle bg-bg-2 p-4">
      <header className="flex flex-wrap items-center gap-2 text-sm">
        <span data-field="draft-status" className={draft.status === 'READY' ? 'font-medium text-success' : 'font-medium text-warning'}>
          {draft.status === 'READY' ? 'Ready for review' : 'Needs review'}
        </span>
        <span className="text-fg-2">
          {GENERATOR_LABELS[draft.generatorLabel] ?? draft.generatorLabel} · {TRIGGER_LABELS[draft.trigger] ?? draft.trigger} · {formatDateTime(draft.createdAt, tz)}
        </span>
      </header>
      {draft.followUpText ? (
        <div className="flex flex-col gap-1">
          <h3 className="text-xs font-medium text-fg-2">Follow-up message</h3>
          <p className="text-sm whitespace-pre-line text-fg-1">{draft.followUpText}</p>
        </div>
      ) : null}
      {draft.emailSubject || draft.emailBody ? (
        <div className="flex flex-col gap-1">
          <h3 className="text-xs font-medium text-fg-2">Email</h3>
          {draft.emailSubject ? <p className="text-sm font-medium text-fg-1">{draft.emailSubject}</p> : null}
          {draft.emailBody ? <p className="text-sm whitespace-pre-line text-fg-1">{draft.emailBody}</p> : null}
        </div>
      ) : null}
      <div className="flex flex-col gap-1">
        <h3 className="text-xs font-medium text-fg-2">Quote proposal</h3>
        {draft.hasProposal ? (
          <>
            <ul className="flex flex-col gap-1 text-sm text-fg-1">
              {draft.proposalLines.map((l) => (
                <li key={l.serviceId} className="flex flex-wrap justify-between gap-2">
                  <span>
                    {l.serviceName} × {l.qty}
                  </span>
                  <span className="tabular text-fg-2">{paise(l.lineTotalPaise)}</span>
                </li>
              ))}
            </ul>
            {draft.previewTotalPaise ? (
              <p className="tabular text-sm text-fg-2">
                Preview total {paise(draft.previewTotalPaise)} (prices come from the server price list when the quote is created)
              </p>
            ) : null}
            {draft.scopeText ? <p className="text-sm text-fg-2">{draft.scopeText}</p> : null}
            {draft.timelineText ? <p className="text-sm text-fg-2">{draft.timelineText}</p> : null}
          </>
        ) : (
          <p className="text-sm text-fg-2">No catalog service was proposed.</p>
        )}
      </div>
      {draft.reviewReasons.length > 0 ? (
        <ul className="flex flex-col gap-1 text-sm text-warning">
          {draft.reviewReasons.map((r) => (
            <li key={r}>{REVIEW_REASON_LABELS[r] ?? r}</li>
          ))}
        </ul>
      ) : null}
    </article>
  );
}

function approveGate(q: LeadQuoteView, canApprove: boolean): Gate | null {
  if (!canApprove) return { category: 'permission', reason: 'Your assignment does not include approvals.decide. Ask a super admin to grant it.' };
  if (q.needsPricingReview) return { category: 'eligibility', reason: 'A service has no price or the total is above the limit; the workspace owner must revise it first.' };
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
  try {
    detail = await loadLeadDetail(page.ctx, leadId);
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

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <Link href={consoleHref} className="inline-flex w-fit items-center gap-1.5 text-sm text-fg-2 hover:text-fg-1">
          <ArrowLeft aria-hidden="true" className="size-4" />
          Lead console
        </Link>
        <p className="text-sm text-fg-2">{workspace.name}</p>
        <h1 className="flex flex-wrap items-center gap-3 font-display text-2xl font-semibold text-fg-1 sm:text-3xl">
          {lead.displayName}
          {lead.simulated ? <ModeChip simulated /> : null}
        </h1>
        <p className="text-sm text-fg-2">
          {SOURCE_LABELS[lead.firstSource] ?? lead.firstSource} · {SALES_STAGE_LABELS[lead.salesStage] ?? lead.salesStage} · added {formatDateTime(lead.createdAt, tz)}
        </p>
        <AutoRefresh active={workerBusy(detail)} label="The worker is still processing this lead; this page updates by itself." />
      </header>

      <div className="grid gap-6 lg:grid-cols-2">
        <Section id="contact-heading" title="Contact and business">
          <dl className="grid gap-3 sm:grid-cols-2">
            <Fact label="Phone">{lead.phoneE164 ?? 'None on record'}</Fact>
            <Fact label="Email">{lead.emailNormalized ?? 'None on record'}</Fact>
            <Fact label="Website">{lead.website ? `${lead.website} (${WEBSITE_LABELS[lead.websiteStatus] ?? lead.websiteStatus})` : WEBSITE_LABELS[lead.websiteStatus] ?? lead.websiteStatus}</Fact>
            <Fact label="Category">{lead.category ?? 'Unknown'}</Fact>
            <Fact label="City">{lead.city ?? 'Unknown'}</Fact>
            <Fact label="Address">{lead.address ?? 'Unknown'}</Fact>
            <Fact label="Rating">{lead.ratingX10 === null ? 'Unknown' : `${(lead.ratingX10 / 10).toFixed(1)} stars${lead.reviewCount === null ? '' : ` from ${lead.reviewCount} reviews`}`}</Fact>
          </dl>
        </Section>

        <Section
          id="score-heading"
          title="Score"
          aside={
            <span data-field="score" className="tabular text-lg font-semibold text-fg-1">
              {lead.score === null ? 'Not scored' : `${lead.score} / 100`}
            </span>
          }
        >
          <p className="text-xs text-fg-2">
            {SCORE_CAPTION}
            {detail.score.configVersion === null ? '' : ` Scoring configuration v${detail.score.configVersion}.`}
          </p>
          {detail.score.reasons.length > 0 ? (
            <ul className="flex flex-col gap-1 text-sm">
              {detail.score.reasons.map((r) => (
                <li key={r.input} className="flex justify-between gap-2">
                  <span className="text-fg-1">{r.label}</span>
                  <span className="tabular text-fg-2">
                    {r.points} / {r.maxPoints}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {detail.score.unknownInputs.length > 0 ? (
            <div className="flex flex-col gap-1">
              <h3 className="text-xs font-medium text-fg-2">Not known, scored 0</h3>
              <ul className="flex flex-col gap-0.5 text-sm text-fg-2">
                {detail.score.unknownInputs.map((u) => (
                  <li key={u.input}>{u.label}</li>
                ))}
              </ul>
            </div>
          ) : null}
        </Section>
      </div>

      <Section id="pipeline-heading" title="Pipeline">
        {detail.pipeline.length === 0 ? (
          <p className="text-sm text-fg-2">This lead was not routed into a pipeline (no active pipeline when it arrived).</p>
        ) : (
          <ol className="flex flex-col gap-2">
            {detail.pipeline.map((s) => {
              const status = RUN_STATUS[s.status] ?? { label: s.status, tone: 'text-fg-2' };
              return (
                <li key={s.stage} data-stage={s.stage} className="flex flex-col gap-0.5 sm:flex-row sm:items-center sm:justify-between">
                  <span className="text-sm text-fg-1">{PIPELINE_STAGE_LABELS[s.stage] ?? s.stage}</span>
                  <span className="flex flex-col sm:items-end">
                    <span className={`text-sm ${status.tone}`}>{status.label}</span>
                    {s.reasonCode ? <span className="text-xs text-fg-2">{RUN_REASONS[s.reasonCode] ?? s.reasonCode}</span> : null}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </Section>

      <Section id="draft-heading" title="AI draft">
        <DraftActions
          leadId={lead.id}
          workspaceSlug={workspace.slug}
          latestDraftId={latestDraft?.id ?? null}
          proposalDraftId={proposalDraft?.id ?? null}
          localGeneratorAvailable={latestDraft?.localGeneratorAvailable ?? false}
          permissions={detail.permissions}
        />
        {latestDraft ? (
          <DraftCard draft={latestDraft} tz={tz} />
        ) : (
          <p className="text-sm text-fg-2">No draft yet. The pipeline writes one after scoring, or generate one now.</p>
        )}
        {detail.drafts.length > 1 ? <p className="text-xs text-fg-2">{detail.drafts.length - 1} earlier draft(s) kept for the record.</p> : null}
      </Section>

      <Section id="quotes-heading" title="Quotations">
        {detail.quotes.length === 0 ? (
          <EmptyState
            icon={<FileText aria-hidden="true" className="size-5" />}
            title="No quotation yet"
            description="Create one from the draft's proposal. Prices always come from the workspace price list."
          />
        ) : (
          <ul className="flex flex-col divide-y divide-border-subtle">
            {detail.quotes.map((q) => (
              <li key={q.id} data-quote-number={q.number} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex flex-col gap-1">
                  <span className="flex flex-wrap items-center gap-2 text-sm font-medium text-fg-1">
                    {q.number} v{q.currentVersionNo}
                    <QuoteStatusBadge status={q.status} />
                  </span>
                  <span className="tabular text-sm text-fg-1">{paise(q.totalPaise)}</span>
                  <span className="text-xs text-fg-2">{q.validUntil ? `Valid until ${formatDate(q.validUntil, tz)}` : 'No validity date'}</span>
                </div>
                <div className="flex flex-wrap items-start gap-3">
                  {q.status === 'DRAFT' ? (
                    <QuoteApproveAction leadId={lead.id} quoteId={q.id} number={q.number} workspaceSlug={workspace.slug} versionNo={q.currentVersionNo} gate={approveGate(q, detail.permissions.canApprove)} />
                  ) : null}
                  {q.pdfReady ? (
                    <a href={leadQuotePdfHref(lead.id, q.id, workspace.slug)} download className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                      <Download aria-hidden="true" />
                      Download PDF
                    </a>
                  ) : q.status === 'CANCELLED' ? null : (
                    <span role="status" className="inline-flex items-center gap-1.5 text-sm text-fg-2">
                      <Loader2 aria-hidden="true" className="size-4 motion-safe:animate-spin" />
                      Preparing the PDF
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
