// C12, AT5, R16, R17: the AI proposal holds only service ids, quantities, scope and timeline.
// - Keys named like price, discount or tax are stripped before validation and flagged
//   (ai_price_ignored, ai_discount_ignored, ai_tax_ignored); recipient-like keys are stripped and
//   flagged too (an injected "send to" can never reach a send).
// - Anything else outside the strict schema is malformed output (one repair retry upstream).
// - Unknown service ids are dropped into review reasons, never fuzzy-matched by name.
// - Quantities outside the price entry's bounds are dropped to review, never clamped.
// - The JSON schema sent to providers has no price, discount or tax field at all.
import { describe, expect, it } from 'vitest';
import {
  evaluateDraftOutput,
  LEAD_DRAFT_JSON_SCHEMA,
  stripForbiddenKeys,
  validateProposalItems,
} from '@/server/services/ai/proposal';
import { CATALOG, POLICY, validOutput } from './fixtures';

const evaluate = (output: unknown) => evaluateDraftOutput(typeof output === 'string' ? output : JSON.stringify(output), { catalog: CATALOG, policy: POLICY });

describe('stripForbiddenKeys', () => {
  it('removes price, discount and tax keys at any depth and flags each kind', () => {
    const raw = {
      ...validOutput(),
      discountPercent: 90,
      proposal: {
        items: [{ serviceId: 'svc_whiten', qty: 1, unitPrice: 1, lineTotalPaise: '100' }],
        scopeText: 'x',
        timelineText: 'y',
        taxBps: 0,
        gstRate: 0,
        couponCode: 'FREE',
      },
    };
    const { value, flags, strippedKeys } = stripForbiddenKeys(raw);
    expect(flags).toEqual(['ai_discount_ignored', 'ai_price_ignored', 'ai_tax_ignored']);
    expect(strippedKeys.sort()).toEqual(
      ['discountPercent', 'proposal.couponCode', 'proposal.gstRate', 'proposal.items[0].lineTotalPaise', 'proposal.items[0].unitPrice', 'proposal.taxBps'].sort(),
    );
    const v = value as { proposal: { items: Array<Record<string, unknown>> } };
    expect(v.proposal.items[0]).toEqual({ serviceId: 'svc_whiten', qty: 1 });
    expect(JSON.stringify(value)).not.toMatch(/unitPrice|discount|tax|gst|coupon|lineTotal/i);
  });

  it('removes recipient-like keys and flags ai_recipient_ignored', () => {
    const raw = { ...validOutput(), recipients: ['+15550001111'], email: { subject: 's', body: 'b', cc: 'boss@evil.example', to: 'x@evil.example' } };
    const { value, flags } = stripForbiddenKeys(raw);
    expect(flags).toEqual(['ai_recipient_ignored']);
    expect(value).not.toHaveProperty('recipients');
    expect((value as { email: Record<string, unknown> }).email).toEqual({ subject: 's', body: 'b' });
  });

  it('leaves a clean output untouched', () => {
    const raw = validOutput();
    const { value, flags, strippedKeys } = stripForbiddenKeys(raw);
    expect(value).toEqual(raw);
    expect(flags).toEqual([]);
    expect(strippedKeys).toEqual([]);
  });
});

describe('evaluateDraftOutput (strict schema after strip-and-flag)', () => {
  it('accepts a clean output as READY material: no flags, reasons or violations', () => {
    const r = evaluate(validOutput());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.flags).toEqual([]);
    expect(r.reviewReasons).toEqual([]);
    expect(r.violations).toEqual([]);
    expect(r.escalated).toBe(false);
    expect(r.draft.proposal.items).toEqual([{ serviceId: 'svc_whiten', qty: 1 }]);
  });

  it('a unitPrice in an item is stripped, flagged and escalated; the item itself survives', () => {
    const out = validOutput();
    (out.proposal as { items: unknown[] }).items = [{ serviceId: 'svc_whiten', qty: 2, unitPrice: 1 }];
    const r = evaluate(out);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.flags).toContain('ai_price_ignored');
    expect(r.escalated).toBe(true);
    expect(r.draft.proposal.items).toEqual([{ serviceId: 'svc_whiten', qty: 2 }]);
  });

  it('an unknown extra key is malformed output (strict), not silently accepted', () => {
    const r = evaluate({ ...validOutput(), sendNow: true });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errorCode).toBe('AI_MALFORMED_OUTPUT');
    expect(r.issues).toMatch(/sendNow|unrecognized/i);
  });

  it('non-JSON and empty text are malformed output', () => {
    for (const text of ['Sure! Here is your draft.', '', '{"templateVariables": [']) {
      const r = evaluate(text);
      expect(r.ok, text).toBe(false);
    }
  });

  it('a non-integer quantity is malformed output', () => {
    const out = validOutput();
    (out.proposal as { items: unknown[] }).items = [{ serviceId: 'svc_whiten', qty: 1.5 }];
    expect(evaluate(out).ok).toBe(false);
  });
});

describe('validateProposalItems', () => {
  it('drops an unknown service id to review and never fuzzy-matches a service name', () => {
    const r = validateProposalItems(
      [
        { serviceId: 'Teeth whitening (in-clinic)', qty: 1 },
        { serviceId: 'svc_unknown', qty: 1 },
        { serviceId: 'svc_consult', qty: 1 },
      ],
      CATALOG,
    );
    expect(r.items).toEqual([{ serviceId: 'svc_consult', qty: 1 }]);
    expect(r.reviewReasons).toEqual([
      { code: 'UNKNOWN_SERVICE', position: 0 },
      { code: 'UNKNOWN_SERVICE', position: 1 },
    ]);
  });

  it('drops quantities outside the price entry bounds (never clamps)', () => {
    const r = validateProposalItems(
      [
        { serviceId: 'svc_rct', qty: 9 },
        { serviceId: 'svc_whiten', qty: 0 },
        { serviceId: 'svc_consult', qty: 10_001 },
      ],
      CATALOG,
    );
    expect(r.items).toEqual([]);
    expect(r.reviewReasons).toEqual([
      { code: 'QTY_OUT_OF_BOUNDS', serviceId: 'svc_rct', qty: 9, minQty: 1, maxQty: 8 },
      { code: 'QTY_OUT_OF_BOUNDS', serviceId: 'svc_whiten', qty: 0, minQty: 1, maxQty: 10_000 },
      { code: 'QTY_OUT_OF_BOUNDS', serviceId: 'svc_consult', qty: 10_001, minQty: 1, maxQty: 10_000 },
      { code: 'NO_ITEMS' },
    ]);
  });

  it('keeps quantities at the bounds and drops a repeated service to review', () => {
    const r = validateProposalItems(
      [
        { serviceId: 'svc_rct', qty: 8 },
        { serviceId: 'svc_rct', qty: 1 },
        { serviceId: 'svc_whiten', qty: 1 },
      ],
      CATALOG,
    );
    expect(r.items).toEqual([
      { serviceId: 'svc_rct', qty: 8 },
      { serviceId: 'svc_whiten', qty: 1 },
    ]);
    expect(r.reviewReasons).toEqual([{ code: 'DUPLICATE_SERVICE', serviceId: 'svc_rct' }]);
  });

  it('an empty proposal goes to review with NO_ITEMS', () => {
    expect(validateProposalItems([], CATALOG).reviewReasons).toEqual([{ code: 'NO_ITEMS' }]);
  });
});

describe('LEAD_DRAFT_JSON_SCHEMA (sent to providers)', () => {
  type Node = { type?: string; properties?: Record<string, Node>; required?: string[]; additionalProperties?: boolean; items?: Node };
  const objects: Node[] = [];
  const names: string[] = [];
  const walk = (n: Node) => {
    if (n.type === 'object') {
      objects.push(n);
      for (const [k, child] of Object.entries(n.properties ?? {})) {
        names.push(k);
        walk(child);
      }
    }
    if (n.items) walk(n.items);
  };
  walk(LEAD_DRAFT_JSON_SCHEMA as Node);

  it('is strict: every object closes additionalProperties and requires every property', () => {
    expect(objects.length).toBeGreaterThanOrEqual(4);
    for (const o of objects) {
      expect(o.additionalProperties).toBe(false);
      expect([...(o.required ?? [])].sort()).toEqual(Object.keys(o.properties ?? {}).sort());
    }
  });

  it('has no price, discount, tax or recipient field anywhere', () => {
    expect(names.join(' ')).not.toMatch(/price|discount|tax|gst|amount|total|cost|recipient|phone/i);
    expect(names).toEqual(expect.arrayContaining(['serviceId', 'qty', 'scopeText', 'timelineText', 'templateVariables', 'followUp', 'subject', 'body']));
  });
});
