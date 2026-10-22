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
 * Ended on purpose (T26, ADR-70, ADR-73): every READY CSV export of the workspace may hold the
 * person's row, so each is marked EXPIRED (`LEAD_ERASED`) in the same transaction and its file is
 * deleted after the commit, like the PDFs. A QUEUED export (possibly being built right now) is
 * marked FAILED (`LEAD_ERASED`): its job's settle then matches nothing and deletes the file it
 * wrote, and any file already at its path is deleted after the commit. Every export of the
 * workspace, in any status, loses its search text (it may be the person's name or phone).
 *
 * Lead-gen suite (ADR-118, ADR-120, ADR-124):
 *  - The lead's `LeadHandoff` row (note and AI summary) is deleted.
 *  - Lead Finder results of the person's place (imported as one of the leads, or carrying the
 *    lead's place ID, from `Lead.placeId` or a Maps PROVIDER key) lose their Places content
 *    (name, category, phone, website, rating, reviews, address, city, state, PIN code,
 *    attributions), their website emails and their import link (`importedLeadId`,
 *    `importedAt`); the place ID, keyword, location and `websiteListed` stay.
 *  - Every import of the workspace that still holds a parsed-rows file may hold the person's row:
 *    a PREVIEW import becomes EXPIRED, a QUEUED or RUNNING one FAILED, `storagePath` is cleared
 *    and the file is deleted after the commit (the rows are never in the database).
 *  - Exports are ended whatever their format (csv or xlsx); a queued export's file is deleted under
 *    either name.
 *  - Jobs whose payload names the handoff or an ended import are cancelled with the person's jobs.
 *
 * Refused (409 ERASE_SEND_IN_FLIGHT) while a send to the person is SENDING: its settle would
 * write to rows that no longer exist. Retry once it settles.
 * Everything runs in one transaction with deferred foreign keys, so a referencing row this code
 * missed fails the commit instead of leaving a dangling reference; the PDF files are removed
 * after the commit.
 */
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { Prisma, type PrismaClient } from '@/generated/prisma/client';
import type { Clock } from '@/lib/clock';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors';
import { withTx } from '@/server/db/tx';
import { requestCancel } from '@/server/jobs/queue';
import { contactKey } from '@/server/security/contact-key';
import { recordAudit } from '@/server/services/audit/record';
import { LEAD_EXPORT_FORMATS, leadExportRelPath, PURGE_FAILED, withoutSearchText } from '@/server/services/leads/export';

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
  /** READY lead CSV exports of the workspace ended because they may hold the person's row. */
  exportsExpired: number;
  /** QUEUED lead CSV exports cancelled (FAILED, LEAD_ERASED) so they are never written with it. */
  exportsCancelled: number;
  /** Lead Finder results of the person's place whose Places content, emails and import link were cleared. */
  finderResultsBlanked: number;
  /** PREVIEW, QUEUED or RUNNING imports ended because their parsed-rows file may hold the person. */
  importsEnded: number;
};

/** Places content and website emails of a Lead Finder result (ADR-118), cleared by an erase. */
const FINDER_RESULT_BLANK = {
  name: null,
  category: null,
  phoneRaw: null,
  hasPhone: false,
  website: null,
  ratingX10: null,
  reviewCount: null,
  address: null,
  city: null,
  state: null,
  pincode: null,
  attributions: Prisma.DbNull,
  emails: [],
  emailCount: 0,
  importedLeadId: null,
  importedAt: null,
} satisfies Prisma.LeadFinderResultUpdateManyMutationInput;

/** Maps sources whose PROVIDER key value is `<source>:<placeId>`. */
const PLACE_PROVIDER_PREFIXES = ['GOOGLE_PLACES:', 'GMAPS_EXTENSION:'] as const;

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
      const leads = await tx.lead.findMany({ where: { id: { in: leadIds }, workspaceId }, select: { id: true, phoneE164: true, emailNormalized: true, alternatePhones: true, placeId: true } });

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

      // Lead-gen rows (ADR-118, ADR-120, ADR-124): the handoff, and every import still holding a
      // parsed-rows file (it may hold the person's row; the rows are never in the database).
      const handoffs = await tx.leadHandoff.findMany({ where: { workspaceId, leadId: { in: leadIds } }, select: { id: true } });
      const handoffIds = handoffs.map((x) => x.id);
      const imports = await tx.leadImport.findMany({
        where: { workspaceId, OR: [{ status: { in: ['PREVIEW', 'QUEUED', 'RUNNING'] } }, { storagePath: { not: null } }] },
        select: { id: true, status: true, storagePath: true },
      });
      const pendingImportIds = imports.filter((i) => i.status === 'PREVIEW' || i.status === 'QUEUED' || i.status === 'RUNNING').map((i) => i.id);

      // Cancel the person's pending work: dispatch jobs, then any job whose payload names their rows.
      const ids = [...leadIds, ...messageIds, ...quoteIds, ...versionIds, ...executionIds, ...conversationIds, ...handoffIds, ...pendingImportIds];
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

      // Lead exports (csv or xlsx) may hold this person's row, and their search text may be the person's
      // name or phone: end the ready ones, cancel the queued ones, drop every search text (files go after commit).
      const exports = await tx.leadExport.findMany({ where: { workspaceId }, select: { id: true, status: true, path: true, filters: true, errorCode: true } });
      let exportsExpired = 0;
      let exportsCancelled = 0;
      const exportFiles: string[] = [];
      for (const e of exports) {
        const filters = withoutSearchText(e.filters);
        const where = { id: e.id, workspaceId, status: e.status };
        if (e.status === 'READY') {
          exportsExpired += (await tx.leadExport.updateMany({ where, data: { status: 'EXPIRED', purgedAt: now, errorCode: 'LEAD_ERASED', filters } })).count;
          if (e.path) exportFiles.push(e.path);
        } else if (e.status === 'QUEUED') {
          exportsCancelled += (await tx.leadExport.updateMany({ where, data: { status: 'FAILED', completedAt: now, errorCode: 'LEAD_ERASED', filters } })).count;
          // Whichever format its job is writing right now.
          for (const format of LEAD_EXPORT_FORMATS) exportFiles.push(leadExportRelPath(workspaceId, e.id, format));
        } else {
          await tx.leadExport.updateMany({ where, data: { filters } });
          // A purge that gave up left the file on disk: it may hold the person's row too.
          if (e.status === 'EXPIRED' && e.errorCode === PURGE_FAILED && e.path) exportFiles.push(e.path);
        }
      }

      // Imports still holding parsed rows: end the pending ones, forget every file (deleted after commit).
      let importsEnded = 0;
      const importFiles: string[] = [];
      for (const i of imports) {
        if (i.storagePath) importFiles.push(i.storagePath);
        const where = { id: i.id, workspaceId, status: i.status };
        if (i.status === 'PREVIEW') importsEnded += (await tx.leadImport.updateMany({ where, data: { status: 'EXPIRED', storagePath: null, finishedAt: now } })).count;
        else if (i.status === 'QUEUED' || i.status === 'RUNNING') importsEnded += (await tx.leadImport.updateMany({ where, data: { status: 'FAILED', storagePath: null, finishedAt: now } })).count;
        else await tx.leadImport.updateMany({ where, data: { storagePath: null } });
      }

      // Lead Finder results of the person's place keep only the place ID, keyword, location and websiteListed.
      const placeIds = new Set<string>();
      for (const lead of leads) if (lead.placeId) placeIds.add(lead.placeId);
      for (const row of contactRows) {
        if (row.kind !== 'PROVIDER') continue;
        const prefix = PLACE_PROVIDER_PREFIXES.find((p) => row.value.startsWith(p));
        if (prefix && row.value.length > prefix.length) placeIds.add(row.value.slice(prefix.length));
      }
      const finderResultsBlanked = (
        await tx.leadFinderResult.updateMany({ where: { workspaceId, OR: [{ importedLeadId: { in: leadIds } }, { placeId: { in: [...placeIds] } }] }, data: FINDER_RESULT_BLANK })
      ).count;

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
      await del('leadHandoffs', tx.leadHandoff.deleteMany({ where: { workspaceId, id: { in: handoffIds } } }));
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
          summary: { leadIds, counts, suppressionsKept, jobsCancelled, webhookEventsPurged: touched.length, exportsExpired, exportsCancelled, finderResultsBlanked, importsEnded },
        },
      );
      return {
        leadIds,
        counts,
        suppressionsKept,
        jobsCancelled,
        webhookEventsPurged: touched.length,
        exportsExpired,
        exportsCancelled,
        finderResultsBlanked,
        importsEnded,
        artifacts: artifacts.map((a) => a.path),
        exportFiles: [...exportFiles, ...importFiles],
      };
    },
    { timeoutMs: 120_000 },
  );

  const { artifacts, exportFiles, ...rest } = outcome;
  let filesDeleted = 0;
  const root = path.resolve(input.storageDir);
  for (const rel of artifacts) {
    const full = path.resolve(root, rel);
    if (!full.startsWith(root + path.sep)) continue;
    await rm(full, { force: true, maxRetries: 3, retryDelay: 100 });
    filesDeleted += 1;
  }
  for (const rel of exportFiles) {
    const full = path.resolve(root, rel);
    if (!full.startsWith(root + path.sep)) continue;
    await rm(full, { force: true, maxRetries: 3, retryDelay: 100 });
  }
  return { ...rest, filesDeleted };
}
