/**
 * Consent records (R22, P1, P13, ADR-15). This module is the only writer of ConsentRecord.
 *
 * Capture at ingestion (T10): a Sheets or Meta form mapping may define a consent field (column
 * or question key, truthy values, verbatim notice text). For a record whose answer is truthy it
 * creates exactly one `ConsentRecord(basis=OPT_IN, source=SHEETS_FORM|META_FORM)` with the form
 * evidence, the notice hash and `collectedAt` = the submission time. Everything else creates
 * nothing and reports why: no mapping, a source that cannot carry consent (Google Maps leads never
 * get WhatsApp consent, nor any other source without a form), a missing column, a falsy value, no
 * submission time (undated evidence is never recorded), or no contact for the mapped channel.
 *
 * The record's `contactKey` is the same HMAC as Suppression.contactKey (C17). Capture does not
 * clear an active suppression: re-opt-in ordering (O2, E3) belongs to the suppression service
 * (T18), which compares this record's collectedAt with the latest Stop.
 *
 * Callers pass the transaction that creates or matches the lead, so consent commits with it.
 */
import { createHash } from 'node:crypto';
import type { ConsentSource, LeadSource, Prisma } from '@/generated/prisma/client';
import type { ConsentMapping } from '@/lib/schemas/ingest';
import { contactKey } from '@/server/security/contact-key';
import { recordAudit, type AuditCtx } from '@/server/services/audit/record';

export type ConsentCaptureNoneReason =
  | 'NO_MAPPING'
  | 'SOURCE_NOT_ELIGIBLE'
  | 'COLUMN_MISSING'
  | 'FALSY_VALUE'
  | 'NO_EVIDENCE_TIME'
  | 'NO_CONTACT_FOR_CHANNEL'
  /** A replayed record whose first processing created no consent. */
  | 'NOT_CAPTURED'
  /** The record went to merge review; there is no lead to attach evidence to. */
  | 'PENDING_REVIEW'
  | 'REJECTED';

export type ConsentCaptureResult = { outcome: 'CREATED'; consentRecordId: string } | { outcome: 'NONE'; reason: ConsentCaptureNoneReason };

/** Ingestion sources whose mapped form answers can carry consent evidence. */
const CAPTURE_SOURCES: Partial<Record<LeadSource, ConsentSource>> = {
  GOOGLE_SHEETS: 'SHEETS_FORM',
  META_ADS: 'META_FORM',
};

export function consentSourceFor(source: LeadSource): ConsentSource | null {
  return CAPTURE_SOURCES[source] ?? null;
}

export function noticeTextHash(noticeText: string): string {
  return createHash('sha256').update(noticeText, 'utf8').digest('hex');
}

function foldAnswer(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase();
}

export type AnswerValue = string | number | boolean | null;

/** True when `value` matches one of the mapping's truthy values (case, width and spacing folded). */
export function isTruthyAnswer(value: AnswerValue | undefined, truthyValues: readonly string[]): boolean {
  if (value === null || value === undefined) return false;
  const folded = foldAnswer(String(value));
  if (folded === '') return false;
  return truthyValues.some((t) => foldAnswer(t) === folded);
}

export type ConsentCaptureInput = {
  leadId: string;
  source: LeadSource;
  mapping: { consent?: ConsentMapping | null; formId?: string; version?: number } | undefined;
  answers: Readonly<Record<string, AnswerValue>> | undefined;
  /** The source record id (sheet row or event id, leadgen id): evidence `responseId`. */
  responseId: string;
  submittedAt: Date | null;
  phoneE164: string | null;
  emailNormalized: string | null;
  simulated: boolean;
};

type ConsentDb = Pick<Prisma.TransactionClient, 'consentRecord' | 'auditEvent'>;

export type ConsentCtx = AuditCtx & { workspaceId: string | null };

export async function captureIngestionConsent(tx: ConsentDb, ctx: ConsentCtx, input: ConsentCaptureInput, pepper: string): Promise<ConsentCaptureResult> {
  const mapping = input.mapping?.consent ?? null;
  if (mapping === null) return { outcome: 'NONE', reason: 'NO_MAPPING' };
  const source = consentSourceFor(input.source);
  if (source === null) return { outcome: 'NONE', reason: 'SOURCE_NOT_ELIGIBLE' };
  const answers = input.answers ?? {};
  if (!Object.prototype.hasOwnProperty.call(answers, mapping.column)) return { outcome: 'NONE', reason: 'COLUMN_MISSING' };
  if (!isTruthyAnswer(answers[mapping.column], mapping.truthyValues)) return { outcome: 'NONE', reason: 'FALSY_VALUE' };
  if (input.submittedAt === null) return { outcome: 'NONE', reason: 'NO_EVIDENCE_TIME' };

  const contact = mapping.channel === 'WHATSAPP' ? input.phoneE164 : input.emailNormalized;
  if (contact === null) return { outcome: 'NONE', reason: 'NO_CONTACT_FOR_CHANNEL' };
  const key = contactKey(pepper, mapping.channel === 'WHATSAPP' ? 'phone' : 'email', contact);

  const evidence: Record<string, string | number> = { responseId: input.responseId, questionKey: mapping.column };
  if (input.mapping?.formId !== undefined) evidence.formId = input.mapping.formId;
  if (input.mapping?.version !== undefined) evidence.mappingVersion = input.mapping.version;

  const workspaceId = ctx.workspaceId;
  if (workspaceId === null) throw new Error('captureIngestionConsent needs a workspace-scoped context');
  const record = await tx.consentRecord.create({
    data: {
      workspaceId,
      leadId: input.leadId,
      contactKey: key,
      channel: mapping.channel,
      purpose: mapping.purpose,
      basis: 'OPT_IN',
      source,
      evidence,
      noticeTextHash: noticeTextHash(mapping.noticeText),
      noticeVersion: mapping.noticeVersion ?? null,
      collectedAt: input.submittedAt,
      recordedAt: ctx.clock.now(),
      recordedBy: ctx.actor?.userId ?? null,
    },
    select: { id: true },
  });
  await recordAudit(tx, ctx, {
    action: 'consent.capture',
    targetType: 'ConsentRecord',
    targetId: record.id,
    simulated: input.simulated,
    summary: { leadId: input.leadId, channel: mapping.channel, purpose: mapping.purpose, basis: 'OPT_IN', source, questionKey: mapping.column },
  });
  return { outcome: 'CREATED', consentRecordId: record.id };
}

/**
 * The consent outcome of an already-processed source record, for replayed batches: the record
 * created by that row (matched on evidence.responseId and source in application code; JSON is
 * never filtered in SQL), or NOT_CAPTURED.
 */
export async function findCapturedConsent(
  tx: Pick<Prisma.TransactionClient, 'consentRecord'>,
  workspaceId: string,
  input: { leadId: string; source: LeadSource; responseId: string },
): Promise<ConsentCaptureResult> {
  const source = consentSourceFor(input.source);
  if (source === null) return { outcome: 'NONE', reason: 'SOURCE_NOT_ELIGIBLE' };
  const rows = await tx.consentRecord.findMany({
    where: { workspaceId, leadId: input.leadId, source },
    select: { id: true, evidence: true },
    orderBy: { recordedAt: 'asc' },
  });
  const match = rows.find((r) => (r.evidence as { responseId?: unknown } | null)?.responseId === input.responseId);
  return match ? { outcome: 'CREATED', consentRecordId: match.id } : { outcome: 'NONE', reason: 'NOT_CAPTURED' };
}
