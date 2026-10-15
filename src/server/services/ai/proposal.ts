/**
 * The generator output contract and its server-side enforcement (C12, AT5, R16, R17, T10).
 *
 * Order of operations on a raw generator response:
 * 1. Parse JSON. Not JSON: malformed output (one repair retry upstream, then NEEDS_REVIEW).
 * 2. Strip and flag: any key named like a price, discount or tax is removed at any depth and
 *    flagged (`ai_price_ignored`, `ai_discount_ignored`, `ai_tax_ignored`); recipient-like keys
 *    are removed and flagged `ai_recipient_ignored`. The proposal survives, the attempt is an
 *    injection signal, and the draft is forced to review.
 * 3. Strict schema (zod): anything else outside the contract is malformed output.
 * 4. Proposal items: only exact catalog service ids (never fuzzy-matched by name), whole
 *    quantities within the price entry's bounds (never clamped), one line per service. Anything
 *    dropped becomes a review reason.
 * 5. Output policy on every string; a violating field is not stored, only the violation.
 * Prices are never read from the output: the server prices the surviving items itself.
 */
import { z } from 'zod';
import { redactText } from '@/lib/redact';
import type { CatalogEntry } from './context-builder';
import { checkDraftStrings, type OutputPolicyContext, type PolicyViolation, type DraftString } from './output-policy';

export const DRAFT_LIMITS = {
  templateVariables: 10,
  templateVariableChars: 200,
  followUpChars: 1000,
  emailSubjectChars: 150,
  emailBodyChars: 3000,
  proposalItems: 20,
  serviceIdChars: 64,
  scopeChars: 1000,
  timelineChars: 300,
} as const;

export const leadDraftOutputSchema = z.strictObject({
  templateVariables: z.array(z.string().trim().min(1).max(DRAFT_LIMITS.templateVariableChars)).max(DRAFT_LIMITS.templateVariables),
  followUp: z.string().trim().min(1).max(DRAFT_LIMITS.followUpChars),
  email: z.strictObject({
    subject: z.string().trim().min(1).max(DRAFT_LIMITS.emailSubjectChars),
    body: z.string().trim().min(1).max(DRAFT_LIMITS.emailBodyChars),
  }),
  proposal: z.strictObject({
    items: z
      .array(z.strictObject({ serviceId: z.string().min(1).max(DRAFT_LIMITS.serviceIdChars), qty: z.number().int() }))
      .max(DRAFT_LIMITS.proposalItems),
    scopeText: z.string().trim().max(DRAFT_LIMITS.scopeChars),
    timelineText: z.string().trim().max(DRAFT_LIMITS.timelineChars),
  }),
});
export type LeadDraftOutput = z.infer<typeof leadDraftOutputSchema>;

/**
 * The JSON schema sent to providers as structured output. Hand-written (types, required,
 * additionalProperties false) because provider structured-output dialects differ on length
 * keywords; lengths and bounds are enforced by `leadDraftOutputSchema` on the server.
 */
export const LEAD_DRAFT_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['templateVariables', 'followUp', 'email', 'proposal'],
  properties: {
    templateVariables: { type: 'array', items: { type: 'string' } },
    followUp: { type: 'string' },
    email: {
      type: 'object',
      additionalProperties: false,
      required: ['subject', 'body'],
      properties: { subject: { type: 'string' }, body: { type: 'string' } },
    },
    proposal: {
      type: 'object',
      additionalProperties: false,
      required: ['items', 'scopeText', 'timelineText'],
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['serviceId', 'qty'],
            properties: { serviceId: { type: 'string' }, qty: { type: 'integer' } },
          },
        },
        scopeText: { type: 'string' },
        timelineText: { type: 'string' },
      },
    },
  },
};

// ---- strip and flag --------------------------------------------------------------------------

export type PolicyFlag = 'ai_price_ignored' | 'ai_discount_ignored' | 'ai_tax_ignored' | 'ai_recipient_ignored' | 'ai_policy_violation';

const DISCOUNT_KEY = /discount|coupon|promo|voucher|markdown|rebate|cashback|offpercent/;
const TAX_KEY = /tax|gst|vat|cess/;
const PRICE_KEY = /price|cost|amount|total|paise|rupee|inr|fee|charge|rate|mrp|currency/;
const RECIPIENT_KEYS = new Set(['to', 'cc', 'bcc', 'recipient', 'recipients', 'sendto', 'phone', 'phones', 'phonenumber', 'mobile', 'whatsapp', 'whatsappnumber', 'emailaddress', 'emails', 'contacts', 'forwardto']);

function classifyKey(key: string): PolicyFlag | null {
  const k = key.toLowerCase().replace(/[^a-z]/g, '');
  if (RECIPIENT_KEYS.has(k)) return 'ai_recipient_ignored';
  if (DISCOUNT_KEY.test(k)) return 'ai_discount_ignored';
  if (TAX_KEY.test(k)) return 'ai_tax_ignored';
  if (PRICE_KEY.test(k)) return 'ai_price_ignored';
  return null;
}

export function stripForbiddenKeys(value: unknown): { value: unknown; flags: PolicyFlag[]; strippedKeys: string[] } {
  const flags = new Set<PolicyFlag>();
  const strippedKeys: string[] = [];
  const walk = (v: unknown, path: string): unknown => {
    if (Array.isArray(v)) return v.map((item, i) => walk(item, `${path}[${i}]`));
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(v as Record<string, unknown>)) {
        const childPath = path ? `${path}.${key}` : key;
        const flag = classifyKey(key);
        if (flag) {
          flags.add(flag);
          strippedKeys.push(childPath);
          continue;
        }
        out[key] = walk(child, childPath);
      }
      return out;
    }
    return v;
  };
  return { value: walk(value, ''), flags: [...flags].sort(), strippedKeys };
}

// ---- proposal items ----------------------------------------------------------------------------

export type ProposalItem = { serviceId: string; qty: number };

export type DraftReviewReason =
  | { code: 'UNKNOWN_SERVICE'; position: number }
  | { code: 'QTY_OUT_OF_BOUNDS'; serviceId: string; qty: number; minQty: number; maxQty: number }
  | { code: 'DUPLICATE_SERVICE'; serviceId: string }
  | { code: 'NO_ITEMS' };

export function validateProposalItems(items: readonly ProposalItem[], catalog: readonly CatalogEntry[]): { items: ProposalItem[]; reviewReasons: DraftReviewReason[] } {
  const byId = new Map(catalog.map((c) => [c.serviceId, c]));
  const kept: ProposalItem[] = [];
  const seen = new Set<string>();
  const reviewReasons: DraftReviewReason[] = [];
  items.forEach((item, position) => {
    const service = byId.get(item.serviceId);
    if (!service) {
      reviewReasons.push({ code: 'UNKNOWN_SERVICE', position });
      return;
    }
    if (!Number.isSafeInteger(item.qty) || item.qty < service.minQty || item.qty > service.maxQty) {
      reviewReasons.push({ code: 'QTY_OUT_OF_BOUNDS', serviceId: service.serviceId, qty: item.qty, minQty: service.minQty, maxQty: service.maxQty });
      return;
    }
    if (seen.has(service.serviceId)) {
      reviewReasons.push({ code: 'DUPLICATE_SERVICE', serviceId: service.serviceId });
      return;
    }
    seen.add(service.serviceId);
    kept.push({ serviceId: service.serviceId, qty: item.qty });
  });
  if (kept.length === 0) reviewReasons.push({ code: 'NO_ITEMS' });
  return { items: kept, reviewReasons };
}

// ---- whole output ---------------------------------------------------------------------------

export type EvaluatedDraft = {
  templateVariables: string[];
  followUpText: string | null;
  emailSubject: string | null;
  emailBody: string | null;
  proposal: { items: ProposalItem[]; scopeText: string | null; timelineText: string | null };
};

export type DraftEvaluation =
  | { ok: false; errorCode: 'AI_MALFORMED_OUTPUT'; issues: string }
  | {
      ok: true;
      draft: EvaluatedDraft;
      flags: PolicyFlag[];
      strippedKeys: string[];
      reviewReasons: DraftReviewReason[];
      violations: PolicyViolation[];
      /** An injection signal: stripped keys, a policy hit, or a proposal line outside the catalog. */
      escalated: boolean;
    };

const MAX_ISSUES_CHARS = 1500;

function describeIssues(error: z.ZodError): string {
  const text = error.issues
    .slice(0, 12)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
  return redactText(text).slice(0, MAX_ISSUES_CHARS);
}

export function evaluateDraftOutput(raw: string, opts: { catalog: readonly CatalogEntry[]; policy: OutputPolicyContext }): DraftEvaluation {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    return { ok: false, errorCode: 'AI_MALFORMED_OUTPUT', issues: 'The output was not valid JSON. Return only the JSON object.' };
  }
  const stripped = stripForbiddenKeys(parsedJson);
  const parsed = leadDraftOutputSchema.safeParse(stripped.value);
  if (!parsed.success) return { ok: false, errorCode: 'AI_MALFORMED_OUTPUT', issues: describeIssues(parsed.error) };
  const out = parsed.data;

  const proposal = validateProposalItems(out.proposal.items, opts.catalog);
  const strings: DraftString[] = [
    ...out.templateVariables.map((text, i) => ({ field: `templateVariables[${i}]`, text, templateVariable: true })),
    { field: 'followUp', text: out.followUp },
    { field: 'email.subject', text: out.email.subject },
    { field: 'email.body', text: out.email.body },
    { field: 'proposal.scopeText', text: out.proposal.scopeText },
    { field: 'proposal.timelineText', text: out.proposal.timelineText },
  ];
  const violations = checkDraftStrings(strings, opts.policy);
  const hit = new Set(violations.map((v) => (v.field.startsWith('templateVariables[') ? 'templateVariables' : v.field)));

  const flags = new Set<PolicyFlag>(stripped.flags);
  if (violations.length > 0) flags.add('ai_policy_violation');
  const offCatalog = proposal.reviewReasons.some((r) => r.code !== 'NO_ITEMS');

  return {
    ok: true,
    draft: {
      templateVariables: hit.has('templateVariables') ? [] : out.templateVariables,
      followUpText: hit.has('followUp') ? null : out.followUp,
      emailSubject: hit.has('email.subject') ? null : out.email.subject,
      emailBody: hit.has('email.body') ? null : out.email.body,
      proposal: {
        items: proposal.items,
        scopeText: hit.has('proposal.scopeText') ? null : out.proposal.scopeText,
        timelineText: hit.has('proposal.timelineText') ? null : out.proposal.timelineText,
      },
    },
    flags: [...flags].sort(),
    strippedKeys: stripped.strippedKeys,
    reviewReasons: proposal.reviewReasons,
    violations,
    escalated: flags.size > 0 || offCatalog,
  };
}
