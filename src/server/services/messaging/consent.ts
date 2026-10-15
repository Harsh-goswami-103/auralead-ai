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
 * The record's `contactKey` is the same HMAC as Suppression.contactKey (C17). A captured OPT_IN
 * goes through the re-opt-in rule of `suppression.ts` in the same transaction: it clears an active
 * suppression only when its submission time is strictly newer than the latest Stop (O2, E3). The
 * ingestion transaction belongs to the caller, so that clear's journal line is exported by the
 * `suppression.journalReconcile` job it queues (E8).
 *
 * Callers pass the transaction that creates or matches the lead, so consent commits with it.
 *
 * T18 adds the other writers: manual grants with evidence (OPT_IN), the employee B2B email
 * attestation (M2 / ADR-14, user decision D4: only while the workspace enables it; never an opt-in,
 * so it never clears a suppression), the START keyword (OPT_IN, re-opt-in) and inbound-message
 * consent (P13, service conversation only) for the WhatsApp webhook (T20).
 */
import { createHash } from 'node:crypto';
import { ZodError } from 'zod';
import type { ConsentSource, LeadSource, Prisma } from '@/generated/prisma/client';
import { DomainRuleError, NotFoundError, PermissionDeniedError, ValidationError } from '@/lib/errors';
import { B2bAttestationBody, ManualConsentBody } from '@/lib/schemas/consent';
import type { ConsentMapping } from '@/lib/schemas/ingest';
import type { AppCtx } from '@/server/auth/context';
import { requireActor, requireCapability, requireWorkspace } from '@/server/auth/guards';
import { withTx } from '@/server/db/tx';
import { contactKey } from '@/server/security/contact-key';
import { recordAudit, type AuditCtx } from '@/server/services/audit/record';
import { leadContactKey } from './eligibility';
import { clearSuppressionForConsent, runSuppressionTx, type JournalFlushResult, type JournalSink, type ReoptInOutcome, type SuppressionDeps } from './suppression';

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

type ConsentDb = Pick<Prisma.TransactionClient, 'consentRecord' | 'auditEvent' | 'suppression' | 'job'>;

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
  await clearSuppressionForConsent(
    tx as Prisma.TransactionClient,
    ctx,
    'enqueue-reconcile',
    { id: record.id, channel: mapping.channel, contactKey: key, basis: 'OPT_IN', collectedAt: input.submittedAt },
    { simulated: input.simulated },
  );
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

// ---- Manual grants, B2B attestation, START keyword, inbound messages (T18) ----------------------

type Tx = Prisma.TransactionClient;

function parseBody<T>(schema: { parse(v: unknown): T }, raw: unknown): T {
  try {
    return schema.parse(raw);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ValidationError({ message: 'consent request is invalid', safeDetails: { fields: error.issues.map((i) => i.path.join('.')) } });
    }
    throw error;
  }
}

function rule(code: string, userMessage: string): DomainRuleError {
  return new DomainRuleError({ code, userMessage });
}

async function loadLeadContact(tx: Tx, workspaceId: string, leadId: string) {
  const lead = await tx.lead.findFirst({ where: { workspaceId, id: leadId }, select: { id: true, phoneE164: true, emailNormalized: true, simulated: true } });
  if (!lead) throw new NotFoundError();
  return lead;
}

export type ManualGrantResult = { consentId: string; reoptIn: ReoptInOutcome; journal: JournalFlushResult };

/**
 * A person records an opt-in they hold evidence for (purpose, evidence source, evidence time and a
 * note; plan §7). OPT_IN basis; it clears an active suppression only when its evidence time is
 * strictly newer than the latest Stop. Needs `leads.write`.
 */
export async function grantManualConsent(ctx: AppCtx, raw: unknown, deps: SuppressionDeps): Promise<ManualGrantResult> {
  requireCapability(ctx, 'leads.write');
  const workspaceId = requireWorkspace(ctx);
  const input = parseBody(ManualConsentBody, raw);
  const collectedAt = new Date(input.collectedAt);
  if (collectedAt.getTime() > ctx.clock.now().getTime()) throw rule('EVIDENCE_IN_FUTURE', 'The evidence time cannot be in the future.');

  const { value, journal } = await runSuppressionTx(ctx, deps, async (tx, batch) => {
    const lead = await loadLeadContact(tx, workspaceId, input.leadId);
    const key = leadContactKey(deps.contactKeyPepper, input.channel, lead);
    if (key === null) throw rule('NO_CONTACT_FOR_CHANNEL', `This lead has no ${input.channel === 'WHATSAPP' ? 'WhatsApp number' : 'email address'}.`);
    const evidence: Record<string, string> = { note: input.evidence.note };
    if (input.evidence.reference !== undefined) evidence.reference = input.evidence.reference;
    const record = await tx.consentRecord.create({
      data: {
        workspaceId,
        leadId: lead.id,
        contactKey: key,
        channel: input.channel,
        purpose: input.purpose,
        basis: 'OPT_IN',
        source: input.source,
        evidence,
        noticeTextHash: input.noticeText === undefined ? null : noticeTextHash(input.noticeText),
        collectedAt,
        recordedAt: ctx.clock.now(),
        recordedBy: ctx.actor?.userId ?? null,
      },
      select: { id: true },
    });
    await recordAudit(tx, ctx, {
      action: 'consent.grant',
      targetType: 'ConsentRecord',
      targetId: record.id,
      simulated: lead.simulated,
      summary: { leadId: lead.id, channel: input.channel, purpose: input.purpose, basis: 'OPT_IN', source: input.source, fields: ['evidence.note'] },
    });
    const reoptIn = await clearSuppressionForConsent(tx, ctx, batch, { id: record.id, channel: input.channel, contactKey: key, basis: 'OPT_IN', collectedAt }, { simulated: lead.simulated });
    return { consentId: record.id, reoptIn };
  });
  return { ...value, journal };
}

/**
 * An employee attests a B2B basis for emailing a business (M2, ADR-14, user decision D4): actor,
 * time and note. Only while the workspace enables it (403 `ATTESTATION_DISABLED` otherwise). The
 * record allows manual single sends only (eligibility enforces it) and is not an opt-in, so it
 * never clears an email suppression. Needs `leads.write` and a signed-in person.
 */
export async function attestB2bEmail(ctx: AppCtx, raw: unknown, deps: Pick<SuppressionDeps, 'contactKeyPepper'>): Promise<{ consentId: string }> {
  requireCapability(ctx, 'leads.write');
  const actor = requireActor(ctx);
  const workspaceId = requireWorkspace(ctx);
  const input = parseBody(B2bAttestationBody, raw);

  return withTx(ctx.db, async (scoped) => {
    const tx = scoped as unknown as Tx;
    // The lead first, so an id of another workspace is 404 whatever this workspace's setting is (E10).
    const lead = await loadLeadContact(tx, workspaceId, input.leadId);
    const settings = await tx.workspaceSettings.findFirst({ where: { workspaceId }, select: { emailB2bAttestationEnabled: true } });
    if (settings?.emailB2bAttestationEnabled !== true) {
      throw new PermissionDeniedError({ code: 'ATTESTATION_DISABLED', userMessage: 'B2B email attestation is turned off for this workspace.' });
    }
    const key = leadContactKey(deps.contactKeyPepper, 'EMAIL', lead);
    if (key === null) throw rule('NO_CONTACT_FOR_CHANNEL', 'This lead has no email address.');
    const now = ctx.clock.now();
    const record = await tx.consentRecord.create({
      data: {
        workspaceId,
        leadId: lead.id,
        contactKey: key,
        channel: 'EMAIL',
        purpose: 'MARKETING',
        basis: 'B2B_ATTESTED',
        source: 'EMPLOYEE_ATTESTATION',
        evidence: { attestedBy: actor.userId, note: input.note },
        collectedAt: now,
        recordedAt: now,
        recordedBy: actor.userId,
      },
      select: { id: true },
    });
    await recordAudit(tx, ctx, {
      action: 'consent.attest_b2b',
      targetType: 'ConsentRecord',
      targetId: record.id,
      simulated: lead.simulated,
      summary: { leadId: lead.id, channel: 'EMAIL', basis: 'B2B_ATTESTED', source: 'EMPLOYEE_ATTESTATION', fields: ['evidence.note'] },
    });
    return { consentId: record.id };
  });
}

export type InboundConsentInput = {
  leadId: string;
  phoneE164: string;
  /** The provider timestamp of the inbound message: the evidence time. */
  providerTs: Date;
  messageId: string;
  simulated?: boolean;
};

/**
 * A START keyword received on WhatsApp (T20 calls this inside its route transaction): an OPT_IN
 * MARKETING record whose evidence time is the message's provider time, then the re-opt-in rule.
 */
export async function recordStartKeywordConsent(
  tx: Tx,
  ctx: ConsentCtx,
  sink: JournalSink,
  input: InboundConsentInput,
  pepper: string,
): Promise<{ consentId: string; reoptIn: ReoptInOutcome }> {
  const id = await createInboundConsent(tx, ctx, input, pepper, { basis: 'OPT_IN', purpose: 'MARKETING', source: 'START_KEYWORD' });
  const reoptIn = await clearSuppressionForConsent(
    tx,
    ctx,
    sink,
    { id, channel: 'WHATSAPP', contactKey: contactKey(pepper, 'phone', input.phoneE164), basis: 'OPT_IN', collectedAt: input.providerTs },
    { simulated: input.simulated ?? false },
  );
  return { consentId: id, reoptIn };
}

/**
 * Any valid inbound WhatsApp message (P13): INBOUND_MESSAGE / SERVICE_CONVERSATION consent, which
 * enables in-window free-form replies only, never templates, and never clears a suppression.
 */
export async function recordInboundMessageConsent(tx: Tx, ctx: ConsentCtx, input: InboundConsentInput, pepper: string): Promise<{ consentId: string }> {
  return { consentId: await createInboundConsent(tx, ctx, input, pepper, { basis: 'INBOUND_MESSAGE', purpose: 'SERVICE_CONVERSATION', source: 'INBOUND_MESSAGE' }) };
}

async function createInboundConsent(
  tx: Tx,
  ctx: ConsentCtx,
  input: InboundConsentInput,
  pepper: string,
  kind: { basis: 'OPT_IN' | 'INBOUND_MESSAGE'; purpose: 'MARKETING' | 'SERVICE_CONVERSATION'; source: 'START_KEYWORD' | 'INBOUND_MESSAGE' },
): Promise<string> {
  const workspaceId = ctx.workspaceId;
  if (workspaceId === null) throw new Error('inbound consent needs a workspace-scoped context');
  if (!Number.isFinite(input.providerTs.getTime())) throw new ValidationError({ code: 'EVIDENCE_TIME_INVALID', message: 'inbound consent needs a provider timestamp' });
  const lead = await loadLeadContact(tx, workspaceId, input.leadId);
  const record = await tx.consentRecord.create({
    data: {
      workspaceId,
      leadId: lead.id,
      contactKey: contactKey(pepper, 'phone', input.phoneE164),
      channel: 'WHATSAPP',
      purpose: kind.purpose,
      basis: kind.basis,
      source: kind.source,
      evidence: { messageId: input.messageId },
      collectedAt: input.providerTs,
      recordedAt: ctx.clock.now(),
      recordedBy: null,
    },
    select: { id: true },
  });
  await recordAudit(tx, ctx, {
    action: kind.source === 'START_KEYWORD' ? 'consent.start_keyword' : 'consent.inbound',
    targetType: 'ConsentRecord',
    targetId: record.id,
    simulated: input.simulated ?? false,
    summary: { leadId: lead.id, channel: 'WHATSAPP', purpose: kind.purpose, basis: kind.basis, source: kind.source },
  });
  return record.id;
}
