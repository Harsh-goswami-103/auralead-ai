/**
 * `npm run lead:erase` (T24): erase one lead's personal data on request.
 *
 * The lead and every lead merged into it (the same person) are deleted together with all rows
 * that carry their data: contact keys, source records and their merge reviews, consent records,
 * conversations, messages (and their status events, dispatch attempts and approvals), call
 * requests, quotes (versions, items, shares, view events, acceptance, rendered PDF artifact and
 * its file), pipeline execution, stage runs and AI drafts. Webhook events that processed this
 * person's data lose their encrypted processing payload and their inspector view.
 *
 * Kept on purpose:
 *  - Suppression rows and their contact HMAC, so an opted-out person stays opted out (C17); their
 *    `contactPlain` is nulled.
 *  - Audit rows (summaries are PII-free by contract), plus one `lead.erase` tombstone with counts.
 *  - Jobs (payloads hold ids only); the person's QUEUED or RUNNING jobs are cancelled.
 *  - Bulk run results and import batch counts (ids and codes only).
 *
 * Refused (409 ERASE_SEND_IN_FLIGHT) while a send to the person is SENDING: its settle would
 * write to rows that no longer exist. Retry once it settles.
 * Everything runs in one transaction with deferred foreign keys, so a referencing row this code
 * missed fails the commit instead of leaving a dangling reference; the PDF files are removed
 * after the commit.
 */
import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { Prisma, PrismaClient } from '@/generated/prisma/client';
import type { Clock } from '@/lib/clock';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors';
import { withTx } from '@/server/db/tx';
import { requestCancel } from '@/server/jobs/queue';
import { contactKey } from '@/server/security/contact-key';
import { recordAudit } from '@/server/services/audit/record';

type Tx = Prisma.TransactionClient;

export type EraseLeadInput = {
  workspaceId: string;
  leadId: string;
  reason: string;
  /** SUPPRESSION_PEPPER: finds the person's suppression rows by contact HMAC. */
  contactKeyPepper: string;
  storageDir: string;
  correlationId: string;
};

export type EraseLeadResult = {
  leadIds: string[];
  counts: Record<string, number>;
  suppressionsKept: number;
  jobsCancelled: number;
  webhookEventsPurged: number;
  filesDeleted: number;
};

const MAX_MERGE_DEPTH = 50;

async function mergeGroup(tx: Tx, workspaceId: string, leadId: string): Promise<string[]> {
  let root = leadId;
  for (let i = 0; i < MAX_MERGE_DEPTH; i += 1) {
    const row = await tx.lead.findFirst({ where: { id: root, workspaceId }, select: { mergedIntoLeadId: true } });
    if (!row?.mergedIntoLeadId) break;
    root = row.mergedIntoLeadId;
  }
  const group = new Set([root]);
  let frontier = [root];
  for (let i = 0; i < MAX_MERGE_DEPTH && frontier.length > 0; i += 1) {
    const children = await tx.lead.findMany({ where: { workspaceId, mergedIntoLeadId: { in: frontier } }, select: { id: true } });
    frontier = children.map((c) => c.id).filter((id) => !group.has(id));
    for (const id of frontier) group.add(id);
  }
  return [...group];
}

function safeKey(pepper: string, kind: 'phone' | 'email', value: string): string | null {
  try {
    return contactKey(pepper, kind, value);
  } catch {
    return null;
  }
}

function containsAny(value: unknown, needles: readonly string[]): boolean {
  if (value === null || value === undefined) return false;
  const text = JSON.stringify(value);
  return needles.some((n) => text.includes(n));
}

export async function eraseLead(db: PrismaClient, clock: Clock, input: EraseLeadInput): Promise<EraseLeadResult> {
  const reason = input.reason.trim();
  if (reason.length < 3 || reason.length > 500) throw new ValidationError({ code: 'REASON_REQUIRED', userMessage: 'Give a reason (3 to 500 characters).' });
  const { workspaceId } = input;

  const outcome = await withTx(
    db,
    async (tx) => {
      const now = clock.now();
      const requested = await tx.lead.findFirst({ where: { id: input.leadId, workspaceId }, select: { id: true } });
      if (!requested) throw new NotFoundError();
      const leadIds = await mergeGroup(tx, workspaceId, input.leadId);
      const leads = await tx.lead.findMany({ where: { id: { in: leadIds }, workspaceId }, select: { id: true, phoneE164: true, emailNormalized: true, alternatePhones: true } });

      const conversations = await tx.conversation.findMany({ where: { workspaceId, leadId: { in: leadIds } }, select: { id: true, contactKey: true } });
      const conversationIds = conversations.map((c) => c.id);
      const messages = await tx.message.findMany({ where: { workspaceId, conversationId: { in: conversationIds } }, select: { id: true, providerMessageId: true } });
      const messageIds = messages.map((m) => m.id);
      const quotes = await tx.quote.findMany({ where: { workspaceId, leadId: { in: leadIds } }, select: { id: true } });
      const quoteIds = quotes.map((q) => q.id);
      const versions = await tx.quoteVersion.findMany({ where: { workspaceId, quoteId: { in: quoteIds } }, select: { id: true } });
      const versionIds = versions.map((v) => v.id);
      const executions = await tx.pipelineExecution.findMany({ where: { workspaceId, leadId: { in: leadIds } }, select: { id: true } });
      const executionIds = executions.map((e) => e.id);
      const records = await tx.leadSourceRecord.findMany({ where: { workspaceId, leadId: { in: leadIds } }, select: { id: true } });
      const recordIds = records.map((r) => r.id);
      const attemptWhere = { workspaceId, OR: [{ messageId: { in: messageIds } }, { quoteVersionId: { in: versionIds } }] };

      if ((await tx.dispatchAttempt.count({ where: { ...attemptWhere, state: 'SENDING' } })) > 0) {
        throw new ConflictError({ code: 'ERASE_SEND_IN_FLIGHT', userMessage: 'A message to this lead is being sent right now. Try again in a minute.' });
      }

      // Suppressions stay (the person remains opted out); only the plain contact goes.
      const plains = new Set<string>();
      const keys = new Set<string>(conversations.map((c) => c.contactKey));
      const contactRows = await tx.leadContactKey.findMany({ where: { workspaceId, leadId: { in: leadIds } }, select: { kind: true, value: true } });
      const add = (kind: 'phone' | 'email', value: string | null | undefined) => {
        if (!value) return;
        plains.add(value);
        const key = safeKey(input.contactKeyPepper, kind, value);
        if (key) keys.add(key);
      };
      for (const lead of leads) {
        add('phone', lead.phoneE164);
        add('email', lead.emailNormalized);
        for (const alt of Array.isArray(lead.alternatePhones) ? lead.alternatePhones : []) if (typeof alt === 'string') add('phone', alt);
      }
      for (const row of contactRows) if (row.kind !== 'PROVIDER') add(row.kind === 'PHONE' ? 'phone' : 'email', row.value);
      const suppressionWhere = { workspaceId, OR: [{ contactKey: { in: [...keys] } }, { contactPlain: { in: [...plains] } }] };
      const suppressionsKept = await tx.suppression.count({ where: suppressionWhere });
      await tx.suppression.updateMany({ where: suppressionWhere, data: { contactPlain: null } });

      // Cancel the person's pending work: dispatch jobs, then any job whose payload names their rows.
      const ids = [...leadIds, ...messageIds, ...quoteIds, ...versionIds, ...executionIds, ...conversationIds];
      const attemptJobs = await tx.dispatchAttempt.findMany({ where: attemptWhere, select: { jobId: true } });
      const pending = await tx.job.findMany({ where: { workspaceId, status: { in: ['QUEUED', 'RUNNING'] } }, select: { id: true, payload: true } });
      const toCancel = new Set([...attemptJobs.map((a) => a.jobId), ...pending.filter((j) => containsAny(j.payload, ids)).map((j) => j.id)]);
      let jobsCancelled = 0;
      for (const jobId of toCancel) {
        const job = await tx.job.findUnique({ where: { id: jobId }, select: { status: true } });
        if (job?.status !== 'QUEUED' && job?.status !== 'RUNNING') continue;
        await requestCancel(tx, clock, jobId);
        jobsCancelled += 1;
      }

      // Webhook events that carried this person's data: drop the encrypted payload and the inspector view.
      const providerKeys = messages.map((m) => m.providerMessageId).filter((p): p is string => p !== null);
      const events = await tx.webhookEvent.findMany({ where: { workspaceId }, select: { id: true, externalKey: true, result: true, processingPurgedAt: true } });
      const touched = events.filter(
        (e) => containsAny(e.result, [...leadIds, ...messageIds]) || providerKeys.some((p) => e.externalKey === `wa:${p}` || e.externalKey.startsWith(`wa:${p}:`)),
      );
      for (const e of touched) {
        await tx.webhookEvent.update({ where: { id: e.id }, data: { processingPayload: null, processingPurgedAt: e.processingPurgedAt ?? now, payloadRedacted: { erased: true } } });
      }

      const artifacts = await tx.quoteArtifact.findMany({ where: { workspaceId, quoteVersionId: { in: versionIds } }, select: { path: true } });

      // Deletes: foreign keys are checked at commit, when every referencing row is gone too.
      await tx.$executeRawUnsafe('PRAGMA defer_foreign_keys = ON');
      const counts: Record<string, number> = {};
      const del = async (name: string, op: Promise<{ count: number }>) => {
        counts[name] = (await op).count;
      };
      await del('quoteViewEvents', tx.quoteViewEvent.deleteMany({ where: { workspaceId, quoteVersionId: { in: versionIds } } }));
      await del('quoteShares', tx.quoteShare.deleteMany({ where: { workspaceId, quoteId: { in: quoteIds } } }));
      await del('quoteAcceptances', tx.quoteAcceptance.deleteMany({ where: { workspaceId, quoteId: { in: quoteIds } } }));
      await del('quoteArtifacts', tx.quoteArtifact.deleteMany({ where: { workspaceId, quoteVersionId: { in: versionIds } } }));
      await del('dispatchAttempts', tx.dispatchAttempt.deleteMany({ where: attemptWhere }));
      await del('approvals', tx.approval.deleteMany({ where: { workspaceId, OR: [{ quoteId: { in: quoteIds } }, { quoteVersionId: { in: versionIds } }, { messageId: { in: messageIds } }] } }));
      await del('messageStatusEvents', tx.messageStatusEvent.deleteMany({ where: { workspaceId, messageId: { in: messageIds } } }));
      await del('callRequests', tx.callRequest.deleteMany({ where: { workspaceId, OR: [{ leadId: { in: leadIds } }, { conversationId: { in: conversationIds } }] } }));
      await del('messages', tx.message.deleteMany({ where: { workspaceId, id: { in: messageIds } } }));
      await del('conversations', tx.conversation.deleteMany({ where: { workspaceId, id: { in: conversationIds } } }));
      await del('quoteItems', tx.quoteItem.deleteMany({ where: { workspaceId, quoteVersionId: { in: versionIds } } }));
      await del('quotes', tx.quote.deleteMany({ where: { workspaceId, id: { in: quoteIds } } }));
      await del('quoteVersions', tx.quoteVersion.deleteMany({ where: { workspaceId, id: { in: versionIds } } }));
      await del('aiDrafts', tx.aiDraft.deleteMany({ where: { workspaceId, leadId: { in: leadIds } } }));
      await del('pipelineStageRuns', tx.pipelineStageRun.deleteMany({ where: { workspaceId, executionId: { in: executionIds } } }));
      await del('pipelineExecutions', tx.pipelineExecution.deleteMany({ where: { workspaceId, id: { in: executionIds } } }));
      await del('mergeReviews', tx.mergeReview.deleteMany({ where: { workspaceId, sourceRecordId: { in: recordIds } } }));
      await del('sourceRecords', tx.leadSourceRecord.deleteMany({ where: { workspaceId, id: { in: recordIds } } }));
      await del('consentRecords', tx.consentRecord.deleteMany({ where: { workspaceId, leadId: { in: leadIds } } }));
      await del('contactKeys', tx.leadContactKey.deleteMany({ where: { workspaceId, leadId: { in: leadIds } } }));
      await del('leads', tx.lead.deleteMany({ where: { workspaceId, id: { in: leadIds } } }));

      await recordAudit(
        tx,
        { kind: 'system', actor: null, workspaceId, correlationId: input.correlationId, clock },
        {
          action: 'lead.erase',
          targetType: 'Lead',
          targetId: input.leadId,
          reason,
          workspaceId,
          summary: { leadIds, counts, suppressionsKept, jobsCancelled, webhookEventsPurged: touched.length },
        },
      );
      return { leadIds, counts, suppressionsKept, jobsCancelled, webhookEventsPurged: touched.length, artifacts: artifacts.map((a) => a.path) };
    },
    { timeoutMs: 120_000 },
  );

  const { artifacts, ...rest } = outcome;
  let filesDeleted = 0;
  const root = path.resolve(input.storageDir);
  for (const rel of artifacts) {
    const full = path.resolve(root, rel);
    if (!full.startsWith(root + path.sep)) continue;
    await rm(full, { force: true, maxRetries: 3, retryDelay: 100 });
    filesDeleted += 1;
  }
  return { ...rest, filesDeleted };
}
