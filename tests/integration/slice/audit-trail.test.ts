/**
 * T17 vertical slice (R7, R32 console part, plan §11 M2): one simulated Maps lead travels through
 * the real webhook path, ingestion, scoring, AI draft (local deterministic generator in DEMO),
 * "Create quote from proposal", approval and the worker-rendered PDF, driven through the
 * employee lead console routes. Asserts:
 *  - the AuditEvents in insertion order, each carrying the correlation id of the request that
 *    started its segment (simulate -> the whole automated pipeline; create -> quote.create and the
 *    worker's quote.pdf.render; approve -> quote.approve), linked by target ids into one chain;
 *  - the Job graph: every job carries its segment's correlation id, and each pipeline step's job
 *    names the job that enqueued it as its causation;
 *  - log capture and audit summaries never contain the lead's phone or email literal;
 *  - DEMO made zero outbound calls (the website fetcher was never invoked).
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildUserContext, getJobContext } from '@/server/auth/context';
import { loadSession } from '@/server/auth/session';
import { loadLeadDetail } from '@/server/services/leads/console';
import {
  approveLeadQuote,
  auditTrail,
  createQuoteFromProposal,
  createSliceHarness,
  downloadLeadQuotePdf,
  requestDraft,
  sessionFor,
  simulateGmaps,
  WS_A,
  WS_A_SLUG,
  WS_B_LEAD,
  WS_B_QUOTE,
  WS_B_SLUG,
  type Auth,
  type SliceHarness,
} from './support';

const C_SIM = 'req_slice_simulate_0001';
const C_CREATE = 'req_slice_quote_create_0001';
const C_APPROVE = 'req_slice_quote_approve_0001';
const C_PDF = 'req_slice_pdf_0001';

let h: SliceHarness;
let employee: Auth;
let started: Date;

beforeAll(async () => {
  h = await createSliceHarness('slice-audit-trail');
  employee = await sessionFor(h, 'employee');
  started = h.clock.now();
}, 120_000);

afterAll(async () => {
  await h?.destroy();
});

describe('simulated Maps lead -> score -> draft -> quote v1 -> approve -> PDF', () => {
  let leadId: string;
  let quoteId: string;

  it('runs the whole slice through the console routes with one correlation chain', async () => {
    // 1. Simulate one Maps extension record into workspace A (the employee's assignment).
    const sim = await simulateGmaps(employee, { workspaceSlug: WS_A_SLUG, count: 1 }, C_SIM);
    expect(sim.status).toBe(200);
    expect(sim.requestId).toBe(C_SIM);

    // 2. The worker runs ingest.process, then the pinned pipeline: INGESTION, SCORE, DRAFT; APPROVAL waits (T23).
    expect(await h.drain()).toBeGreaterThanOrEqual(4);
    const lead = await h.db.lead.findFirstOrThrow({ where: { workspaceId: WS_A, firstSource: 'GMAPS_EXTENSION' } });
    leadId = lead.id;
    expect(lead.simulated).toBe(true);
    expect(lead.score).not.toBeNull();
    expect(lead.phoneE164).toMatch(/^\+91\d{10}$/);
    const execution = await h.db.pipelineExecution.findFirstOrThrow({ where: { leadId }, include: { stageRuns: true } });
    const runs = Object.fromEntries(execution.stageRuns.map((r) => [r.stage, r.status]));
    expect(runs).toMatchObject({ INGESTION: 'DONE', SCORE: 'DONE', DRAFT: 'DONE', APPROVAL: 'PENDING' });
    const draft = await h.db.aiDraft.findFirstOrThrow({ where: { leadId, executionId: execution.id } });
    expect(draft).toMatchObject({ status: 'READY', generatorLabel: 'local-deterministic', trigger: 'PIPELINE', correlationId: C_SIM });
    const proposal = draft.proposal as { items: Array<{ serviceId: string; qty: number }> };
    expect(proposal.items.length).toBeGreaterThanOrEqual(1);

    // 3. "Create quote from proposal": DRAFT v1 priced by the server from the proposal's services.
    const created = await createQuoteFromProposal(employee, leadId, { workspaceSlug: WS_A_SLUG, draftId: draft.id }, C_CREATE);
    expect(created.status).toBe(200);
    expect(created.requestId).toBe(C_CREATE);
    const createdQuote = created.body!.quote as { id: string; number: string; status: string; currentVersionNo: number };
    quoteId = createdQuote.id;
    expect(createdQuote).toMatchObject({ status: 'DRAFT', currentVersionNo: 1 });
    const version = await h.db.quoteVersion.findFirstOrThrow({ where: { quoteId, versionNo: 1 }, include: { items: true } });
    expect(version.items.map((i) => i.serviceId).sort()).toEqual(proposal.items.map((i) => i.serviceId).sort());

    // 4. The PDF is not rendered yet: 503 + Retry-After (the render job was enqueued with the version).
    const early = await downloadLeadQuotePdf(employee, leadId, quoteId, `workspaceSlug=${WS_A_SLUG}`, C_PDF);
    expect(early.status).toBe(503);
    expect(Number(early.headers.get('retry-after'))).toBeGreaterThan(0);

    // 5. Approve v1.
    const approved = await approveLeadQuote(employee, leadId, quoteId, { workspaceSlug: WS_A_SLUG, expectedVersion: 1 }, C_APPROVE);
    expect(approved.status).toBe(200);
    expect((approved.body!.quote as { status: string }).status).toBe('APPROVED');
    const approval = await h.db.approval.findFirstOrThrow({ where: { quoteId } });
    expect(approval.status).toBe('APPROVED');

    // 6. The worker renders the PDF; the download serves the stored artifact byte for byte.
    expect(await h.drain()).toBeGreaterThanOrEqual(1);
    const artifact = await h.db.quoteArtifact.findFirstOrThrow({ where: { quoteVersionId: version.id } });
    const pdf = await downloadLeadQuotePdf(employee, leadId, quoteId, `workspaceSlug=${WS_A_SLUG}`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    expect(pdf.headers.get('content-disposition')).toContain(`${createdQuote.number}`);
    expect(pdf.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(createHash('sha256').update(pdf.bytes).digest('hex')).toBe(artifact.sha256);

    // 7. The audit trail, in insertion order, with each segment's correlation id.
    const trail = await auditTrail(h.db, WS_A, started);
    expect(trail.map((a) => [a.action, a.correlationId])).toEqual([
      ['webhook.receive', C_SIM],
      ['lead.ingest', C_SIM],
      ['import.batch.ingest', C_SIM],
      ['webhook.process', C_SIM],
      ['pipeline.stage.done', C_SIM],
      ['lead.enrich', C_SIM],
      ['lead.score', C_SIM],
      ['pipeline.stage.done', C_SIM],
      ['ai.draft.generate', C_SIM],
      ['pipeline.stage.done', C_SIM],
      ['pipeline.stage.waiting', C_SIM],
      ['quote.create', C_CREATE],
      ['quote.approve', C_APPROVE],
      ['quote.pdf.render', C_CREATE],
    ]);
    expect(trail.every((a) => a.result === 'SUCCESS')).toBe(true);

    // The segments link into one chain by target: event -> lead -> execution -> draft -> quote.
    const byAction = (action: string) => trail.filter((a) => a.action === action);
    const event = await h.db.webhookEvent.findFirstOrThrow({ where: { id: byAction('webhook.receive')[0]!.targetId } });
    expect(event).toMatchObject({ provider: 'GMAPS_EXTENSION', status: 'PROCESSED', simulated: true });
    expect(byAction('lead.ingest')[0]!.targetId).toBe(leadId);
    expect(byAction('pipeline.stage.done').every((a) => a.targetId === execution.id)).toBe(true);
    expect(byAction('ai.draft.generate')[0]!.targetId).toBe(draft.id);
    for (const action of ['quote.create', 'quote.approve', 'quote.pdf.render']) expect(byAction(action)[0]!.targetId).toBe(quoteId);
    expect(byAction('quote.create')[0]!.summary).toMatchObject({ fromDraft: true, versionNo: 1 });
    const quoteRow = await h.db.quote.findFirstOrThrow({ where: { id: quoteId } });
    expect(quoteRow.leadId).toBe(leadId);
    expect(byAction('quote.create')[0]!.actorKind).toBe('EMPLOYEE');
    expect(byAction('quote.pdf.render')[0]!.actorKind).toBe('WORKER');

    // 8. Jobs: each segment's correlation id; pipeline steps name the job that enqueued them.
    const jobs = await h.db.job.findMany({ where: { workspaceId: WS_A, createdAt: { gte: started } }, orderBy: [{ createdAt: 'asc' }] });
    const ingestJob = jobs.find((j) => j.type === 'ingest.process')!;
    expect(ingestJob.correlationId).toBe(C_SIM);
    const advances = jobs.filter((j) => j.type === 'pipeline.advance');
    expect(advances.map((j) => (j.payload as { stage: string }).stage)).toEqual(['INGESTION', 'SCORE', 'DRAFT', 'APPROVAL']);
    expect(advances.every((j) => j.correlationId === C_SIM)).toBe(true);
    expect(advances[0]!.causationId).toBe(ingestJob.id);
    for (let i = 1; i < advances.length; i++) expect(advances[i]!.causationId).toBe(advances[i - 1]!.id);
    const render = jobs.find((j) => j.type === 'quote.renderPdf')!;
    expect(render).toMatchObject({ correlationId: C_CREATE, status: 'SUCCEEDED' });
    const attempts = await h.db.jobAttempt.findMany({ where: { jobId: { in: jobs.map((j) => j.id) } } });
    for (const a of attempts) expect(a.correlationId).toBe(jobs.find((j) => j.id === a.jobId)!.correlationId);
    expect(jobs.filter((j) => j.status === 'DEAD')).toEqual([]);

    // 9. No contact literal in logs or audit summaries; DEMO never fetched the website.
    const literals = [lead.phoneE164, lead.phoneE164!.slice(3), lead.phoneRaw, lead.emailNormalized].filter((v): v is string => typeof v === 'string' && v.length > 0);
    expect(literals.length).toBeGreaterThanOrEqual(2);
    expect(h.logs.length).toBeGreaterThan(0);
    const logText = h.logs.join('\n');
    const summaries = trail.map((a) => JSON.stringify(a.summary)).join('\n');
    for (const literal of literals) {
      expect(logText).not.toContain(literal);
      expect(summaries).not.toContain(literal);
    }
    expect(h.outboundCalls).toEqual([]);
  });

  it('the console read model shows the lead, its score, draft and the approved quote with its PDF', async () => {
    const session = await loadSession(h.db, employee.cookie.split('=')[1]!, { now: h.clock.now(), mode: 'DEMO' });
    const ctx = await buildUserContext(session!, { prisma: h.db, mode: 'demo', clock: h.clock }, { correlationId: 'req_slice_read_0001', workspaceSlug: WS_A_SLUG });
    const detail = await loadLeadDetail(ctx, leadId);
    expect(detail.lead.id).toBe(leadId);
    expect(detail.lead.score).not.toBeNull();
    expect(detail.score.reasons.length).toBeGreaterThan(0);
    expect(detail.pipeline.map((s) => [s.stage, s.status])).toEqual([
      ['INGESTION', 'DONE'],
      ['SCORE', 'DONE'],
      ['DRAFT', 'DONE'],
      ['APPROVAL', 'PENDING'],
    ]);
    expect(detail.drafts[0]).toMatchObject({ status: 'READY', generatorLabel: 'local-deterministic', hasProposal: true });
    expect(detail.quotes).toHaveLength(1);
    expect(detail.quotes[0]).toMatchObject({ id: quoteId, status: 'APPROVED', currentVersionNo: 1, pdfReady: true });
    expect(detail.permissions).toEqual({ canGenerateDraft: true, canCreateQuote: true, canApprove: true });
  });

  it('"Generate draft" enqueues an ai.draft job that writes a MANUAL draft under its own correlation id', async () => {
    const C_DRAFT = 'req_slice_draft_0001';
    const since = h.clock.now();
    const res = await requestDraft(employee, leadId, { workspaceSlug: WS_A_SLUG }, C_DRAFT);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ trigger: 'MANUAL' });
    expect(await h.drain()).toBe(1);
    const manual = await h.db.aiDraft.findFirstOrThrow({ where: { leadId, trigger: 'MANUAL' } });
    expect(manual).toMatchObject({ status: 'READY', correlationId: C_DRAFT, executionId: null });
    const trail = await auditTrail(h.db, WS_A, since);
    expect(trail.map((a) => [a.action, a.correlationId])).toEqual([
      ['ai.draft.request', C_DRAFT],
      ['ai.draft.generate', C_DRAFT],
    ]);
  });

  it('refuses foreign leads and quotes, a quote of another lead, and an empty proposal', async () => {
    // Workspace B's lead and quote through the employee's own workspace slug: 404.
    expect((await requestDraft(employee, WS_B_LEAD, { workspaceSlug: WS_A_SLUG })).status).toBe(404);
    expect((await approveLeadQuote(employee, WS_B_LEAD, WS_B_QUOTE, { workspaceSlug: WS_A_SLUG, expectedVersion: 1 })).status).toBe(404);
    expect((await downloadLeadQuotePdf(employee, WS_B_LEAD, WS_B_QUOTE, `workspaceSlug=${WS_A_SLUG}`)).status).toBe(404);
    // A slug the employee is not assigned to: 404.
    expect((await requestDraft(employee, WS_B_LEAD, { workspaceSlug: WS_B_SLUG })).status).toBe(404);
    // Without a session: 401.
    expect((await requestDraft(null, leadId, { workspaceSlug: WS_A_SLUG })).status).toBe(401);

    // A quote id that belongs to a different lead of the same workspace: 404.
    const other = await h.db.lead.create({
      data: { workspaceId: WS_A, displayName: 'Other Lead', nameNormalized: 'other lead', alternatePhones: [], scoreReasons: [], unknownInputs: [], firstSource: 'MANUAL' },
    });
    expect((await approveLeadQuote(employee, other.id, quoteId, { workspaceSlug: WS_A_SLUG, expectedVersion: 1 })).status).toBe(404);

    // A draft of another lead: 404; a draft whose proposal has no services: 422 with a code.
    const draft = await h.db.aiDraft.findFirstOrThrow({ where: { leadId, trigger: 'PIPELINE' } });
    expect((await createQuoteFromProposal(employee, other.id, { workspaceSlug: WS_A_SLUG, draftId: draft.id })).status).toBe(404);
    const ctx = getJobContext({ id: 'job_slice_empty', workspaceId: WS_A, correlationId: 'req_slice_empty_0001' }, { prisma: h.db, mode: 'demo', clock: h.clock });
    const empty = await ctx.db.aiDraft.create({
      data: {
        workspaceId: WS_A,
        leadId: other.id,
        trigger: 'MANUAL',
        status: 'NEEDS_REVIEW',
        generatorLabel: 'local-deterministic',
        inputHash: 'slice-empty',
        templateVariables: { templateId: null, values: [] },
        proposal: { items: [], scopeText: null, timelineText: null },
        aiPolicyFlags: [],
        reviewReasons: [{ code: 'NO_ITEMS' }],
        policyViolations: [],
        requestedBy: 'test',
        correlationId: 'req_slice_empty_0001',
      },
    });
    const refused = await createQuoteFromProposal(employee, other.id, { workspaceSlug: WS_A_SLUG, draftId: empty.id });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ code: 'PROPOSAL_EMPTY' });
    expect(await h.db.quote.count({ where: { leadId: other.id } })).toBe(0);
  });

  it('an assigned employee without the capability gets 403 on draft, quote and approve', async () => {
    // neha is assigned to workspace B with leads.read only: drafts and quotes are 403 there.
    const neha = await sessionFor(h, 'neha');
    expect((await requestDraft(neha, WS_B_LEAD, { workspaceSlug: WS_B_SLUG })).status).toBe(403);
    expect((await createQuoteFromProposal(neha, WS_B_LEAD, { workspaceSlug: WS_B_SLUG, draftId: 'x'.repeat(24) })).status).toBe(403);
    expect((await approveLeadQuote(neha, WS_B_LEAD, WS_B_QUOTE, { workspaceSlug: WS_B_SLUG, expectedVersion: 1 })).status).toBe(403);
  });
});
