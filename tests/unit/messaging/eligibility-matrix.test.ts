// Plan §7 (A10), E4/ADR-45, M2/ADR-14, P13, R4: one eligibility function, table-driven over every
// reason code, the send intents each check applies to, and the check order.
//
// Order: 1 GLOBAL_PAUSED (deferrable), 2 WORKSPACE_PAUSED (automated, deferrable), 2a
// AUTO_SEND_DISABLED (automated), 3 SUPPRESSED, 4 consent (NO_WHATSAPP_OPT_IN / EMAIL_INVALID /
// NO_EMAIL_BASIS / ATTESTED_MANUAL_ONLY), 5 HUMAN_TAKEOVER / MODE_CHANGED (automated), 6
// QUALITY_PAUSED (automated WhatsApp), 7 TEMPLATE_NOT_APPROVED / WINDOW_CLOSED, 8 NOT_CONFIGURED,
// 9 CAP_REACHED (deferrable).
import { describe, expect, it } from 'vitest';
import { FixedClock } from '@/lib/clock';
import type { SendIntent } from '@/lib/domain/enums';
import {
  DEFERRABLE_REASONS,
  evaluateDispatchEligibility,
  isAutomatedIntent,
  REASON_ORDER,
  type DispatchKind,
  type EligibilityInput,
  type ReasonCode,
} from '@/server/services/messaging/eligibility';

const NOW = new Date('2026-10-16T06:00:00.000Z');
const clock = new FixedClock(NOW);
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

const OPT_IN_WA = { channel: 'WHATSAPP', purpose: 'MARKETING', basis: 'OPT_IN', collectedAt: ago(48 * HOUR), withdrawnAt: null } as const;
const INBOUND_WA = { channel: 'WHATSAPP', purpose: 'SERVICE_CONVERSATION', basis: 'INBOUND_MESSAGE', collectedAt: ago(HOUR), withdrawnAt: null } as const;
const OPT_IN_EMAIL = { channel: 'EMAIL', purpose: 'MARKETING', basis: 'OPT_IN', collectedAt: ago(48 * HOUR), withdrawnAt: null } as const;
const ATTESTED_EMAIL = { channel: 'EMAIL', purpose: 'MARKETING', basis: 'B2B_ATTESTED', collectedAt: ago(HOUR), withdrawnAt: null } as const;

/** An input that is eligible for `kind` and `sendIntent`. */
function base(kind: DispatchKind, sendIntent: SendIntent = 'MANUAL_SINGLE'): EligibilityInput {
  return {
    kind,
    sendIntent,
    globalPaused: false,
    workspaceAutomationPaused: false,
    qualityPaused: false,
    pipelineApprovalMode: 'POLICY_AUTO',
    suppression: null,
    consents: kind === 'EMAIL' ? [OPT_IN_EMAIL] : [OPT_IN_WA, INBOUND_WA],
    conversation: { humanTakeover: false, modeVersion: 3, lastInboundProviderAt: ago(HOUR) },
    expectedModeVersion: 3,
    template: kind === 'WA_TEMPLATE' ? { statusRaw: 'APPROVED', approved: true, category: 'MARKETING' } : null,
    emailAddressValid: kind === 'EMAIL',
    integrationReady: true,
    workspace: { emailB2bAttestationEnabled: false, autoSendEnabled: true },
    internalCapRemaining: 10,
    policyAutoOrigin: false,
    humanApproved: false,
  };
}

const KINDS: DispatchKind[] = ['WA_TEMPLATE', 'WA_FREEFORM', 'EMAIL'];
const INTENTS: SendIntent[] = ['MANUAL_SINGLE', 'BULK', 'AUTOMATED', 'CUSTOMER_REQUESTED_REPLY'];
const evaluate = (input: EligibilityInput) => evaluateDispatchEligibility(input, clock);

describe('baseline', () => {
  it.each(KINDS.flatMap((k) => INTENTS.map((i) => [k, i] as const)))('%s / %s is eligible with nothing blocking', (kind, intent) => {
    const r = evaluate(base(kind, intent));
    expect(r.reasons).toEqual([]);
    expect(r.eligible).toBe(true);
    expect(r.deferrable).toBe(false);
    expect(r.mode).toBe(kind === 'WA_TEMPLATE' ? 'template' : kind === 'WA_FREEFORM' ? 'freeform' : 'email');
  });

  it('automated means AUTOMATED, or CUSTOMER_REQUESTED_REPLY without a human approval', () => {
    expect(isAutomatedIntent('AUTOMATED', false)).toBe(true);
    expect(isAutomatedIntent('AUTOMATED', true)).toBe(true);
    expect(isAutomatedIntent('CUSTOMER_REQUESTED_REPLY', false)).toBe(true);
    expect(isAutomatedIntent('CUSTOMER_REQUESTED_REPLY', true)).toBe(false);
    expect(isAutomatedIntent('MANUAL_SINGLE', false)).toBe(false);
    expect(isAutomatedIntent('BULK', false)).toBe(false);
  });
});

type Row = {
  reason: ReasonCode;
  kinds: DispatchKind[];
  /** Intents that are blocked by this condition; every other intent passes. */
  blocks: SendIntent[];
  apply: (i: EligibilityInput) => EligibilityInput;
};

const AUTOMATED: SendIntent[] = ['AUTOMATED', 'CUSTOMER_REQUESTED_REPLY'];

const ROWS: Row[] = [
  { reason: 'GLOBAL_PAUSED', kinds: KINDS, blocks: INTENTS, apply: (i) => ({ ...i, globalPaused: true }) },
  { reason: 'WORKSPACE_PAUSED', kinds: KINDS, blocks: AUTOMATED, apply: (i) => ({ ...i, workspaceAutomationPaused: true }) },
  { reason: 'AUTO_SEND_DISABLED', kinds: KINDS, blocks: AUTOMATED, apply: (i) => ({ ...i, workspace: { ...i.workspace, autoSendEnabled: false } }) },
  {
    reason: 'AUTO_SEND_DISABLED',
    kinds: KINDS,
    blocks: AUTOMATED,
    apply: (i) => ({ ...i, policyAutoOrigin: true, pipelineApprovalMode: 'HUMAN' }),
  },
  { reason: 'SUPPRESSED', kinds: ['WA_TEMPLATE', 'WA_FREEFORM'], blocks: INTENTS, apply: (i) => ({ ...i, suppression: { channel: 'WHATSAPP', createdAt: ago(HOUR) } }) },
  { reason: 'SUPPRESSED', kinds: ['EMAIL'], blocks: INTENTS, apply: (i) => ({ ...i, suppression: { channel: 'EMAIL', createdAt: ago(HOUR) } }) },
  { reason: 'NO_WHATSAPP_OPT_IN', kinds: ['WA_TEMPLATE'], blocks: INTENTS, apply: (i) => ({ ...i, consents: [INBOUND_WA] }) },
  { reason: 'NO_WHATSAPP_OPT_IN', kinds: ['WA_TEMPLATE'], blocks: INTENTS, apply: (i) => ({ ...i, consents: [{ ...OPT_IN_WA, withdrawnAt: ago(1000) }] }) },
  { reason: 'NO_WHATSAPP_OPT_IN', kinds: ['WA_TEMPLATE'], blocks: INTENTS, apply: (i) => ({ ...i, consents: [{ ...OPT_IN_WA, purpose: 'SERVICE_CONVERSATION' }] }) },
  { reason: 'NO_WHATSAPP_OPT_IN', kinds: ['WA_TEMPLATE', 'WA_FREEFORM'], blocks: INTENTS, apply: (i) => ({ ...i, consents: [OPT_IN_EMAIL] }) },
  { reason: 'EMAIL_INVALID', kinds: ['EMAIL'], blocks: INTENTS, apply: (i) => ({ ...i, emailAddressValid: false }) },
  { reason: 'NO_EMAIL_BASIS', kinds: ['EMAIL'], blocks: INTENTS, apply: (i) => ({ ...i, consents: [OPT_IN_WA, INBOUND_WA] }) },
  { reason: 'NO_EMAIL_BASIS', kinds: ['EMAIL'], blocks: INTENTS, apply: (i) => ({ ...i, consents: [ATTESTED_EMAIL] }) },
  {
    reason: 'ATTESTED_MANUAL_ONLY',
    kinds: ['EMAIL'],
    blocks: ['BULK', 'AUTOMATED', 'CUSTOMER_REQUESTED_REPLY'],
    apply: (i) => ({ ...i, consents: [ATTESTED_EMAIL], workspace: { ...i.workspace, emailB2bAttestationEnabled: true } }),
  },
  { reason: 'HUMAN_TAKEOVER', kinds: KINDS, blocks: AUTOMATED, apply: (i) => ({ ...i, conversation: { ...i.conversation!, humanTakeover: true } }) },
  { reason: 'MODE_CHANGED', kinds: KINDS, blocks: AUTOMATED, apply: (i) => ({ ...i, expectedModeVersion: 2 }) },
  { reason: 'QUALITY_PAUSED', kinds: ['WA_TEMPLATE', 'WA_FREEFORM'], blocks: AUTOMATED, apply: (i) => ({ ...i, qualityPaused: true }) },
  { reason: 'TEMPLATE_NOT_APPROVED', kinds: ['WA_TEMPLATE'], blocks: INTENTS, apply: (i) => ({ ...i, template: { statusRaw: 'PENDING', approved: false, category: 'MARKETING' } }) },
  { reason: 'TEMPLATE_NOT_APPROVED', kinds: ['WA_TEMPLATE'], blocks: INTENTS, apply: (i) => ({ ...i, template: null }) },
  { reason: 'WINDOW_CLOSED', kinds: ['WA_FREEFORM'], blocks: INTENTS, apply: (i) => ({ ...i, conversation: { ...i.conversation!, lastInboundProviderAt: ago(24 * HOUR) } }) },
  { reason: 'WINDOW_CLOSED', kinds: ['WA_FREEFORM'], blocks: INTENTS, apply: (i) => ({ ...i, conversation: null }) },
  { reason: 'NOT_CONFIGURED', kinds: KINDS, blocks: INTENTS, apply: (i) => ({ ...i, integrationReady: false }) },
  { reason: 'CAP_REACHED', kinds: KINDS, blocks: INTENTS, apply: (i) => ({ ...i, internalCapRemaining: 0 }) },
];

describe('every reason code, per kind and send intent', () => {
  const cases = ROWS.flatMap((row, n) => row.kinds.flatMap((kind) => INTENTS.map((intent) => [`#${n} ${row.reason}`, kind, intent, row] as const)));

  it.each(cases)('%s on %s / %s', (_label, kind, intent, row) => {
    const r = evaluate(row.apply(base(kind, intent)));
    if (row.blocks.includes(intent)) {
      expect(r.reasons).toEqual([row.reason]);
      expect(r.eligible).toBe(false);
      expect(r.deferrable).toBe(DEFERRABLE_REASONS.has(row.reason));
      expect(r.mode).toBe(r.deferrable ? (kind === 'WA_TEMPLATE' ? 'template' : kind === 'WA_FREEFORM' ? 'freeform' : 'email') : 'none');
    } else {
      expect(r.reasons).toEqual([]);
      expect(r.eligible).toBe(true);
    }
  });

  it('every reason code in the order list is covered by a row', () => {
    const covered = new Set(ROWS.map((r) => r.reason));
    expect([...REASON_ORDER].filter((c) => !covered.has(c))).toEqual([]);
  });

  it('only pauses and the internal cap are deferrable', () => {
    expect([...DEFERRABLE_REASONS].sort()).toEqual(['CAP_REACHED', 'GLOBAL_PAUSED', 'WORKSPACE_PAUSED']);
  });
});

describe('check order', () => {
  it('reports every failing check, in plan order (WhatsApp template, automated)', () => {
    const input: EligibilityInput = {
      ...base('WA_TEMPLATE', 'AUTOMATED'),
      globalPaused: true,
      workspaceAutomationPaused: true,
      workspace: { emailB2bAttestationEnabled: false, autoSendEnabled: false },
      suppression: { channel: 'WHATSAPP', createdAt: ago(HOUR) },
      consents: [],
      conversation: { humanTakeover: true, modeVersion: 3, lastInboundProviderAt: null },
      expectedModeVersion: 1,
      qualityPaused: true,
      template: { statusRaw: 'REJECTED', approved: false, category: 'MARKETING' },
      integrationReady: false,
      internalCapRemaining: 0,
    };
    const r = evaluate(input);
    expect(r.reasons).toEqual([
      'GLOBAL_PAUSED',
      'WORKSPACE_PAUSED',
      'AUTO_SEND_DISABLED',
      'SUPPRESSED',
      'NO_WHATSAPP_OPT_IN',
      'HUMAN_TAKEOVER',
      'MODE_CHANGED',
      'QUALITY_PAUSED',
      'TEMPLATE_NOT_APPROVED',
      'NOT_CONFIGURED',
      'CAP_REACHED',
    ]);
    expect(r.eligible).toBe(false);
    // A suppressed contact is skipped, never deferred, even while paused.
    expect(r.deferrable).toBe(false);
    expect(r.mode).toBe('none');
  });

  it('free-form and email orders follow the same list', () => {
    const ff = evaluate({ ...base('WA_FREEFORM'), globalPaused: true, consents: [], conversation: null, integrationReady: false, internalCapRemaining: 0 });
    expect(ff.reasons).toEqual(['GLOBAL_PAUSED', 'NO_WHATSAPP_OPT_IN', 'WINDOW_CLOSED', 'NOT_CONFIGURED', 'CAP_REACHED']);
    const em = evaluate({ ...base('EMAIL', 'BULK'), suppression: { channel: 'EMAIL', createdAt: ago(1) }, emailAddressValid: false, consents: [], integrationReady: false });
    expect(em.reasons).toEqual(['SUPPRESSED', 'EMAIL_INVALID', 'NO_EMAIL_BASIS', 'NOT_CONFIGURED']);
    expect(REASON_ORDER.indexOf('GLOBAL_PAUSED')).toBe(0);
    expect(REASON_ORDER.at(-1)).toBe('CAP_REACHED');
  });

  it('only pauses and the cap together stay deferrable', () => {
    const r = evaluate({ ...base('WA_TEMPLATE', 'AUTOMATED'), globalPaused: true, workspaceAutomationPaused: true, internalCapRemaining: 0 });
    expect(r).toMatchObject({ eligible: false, deferrable: true, mode: 'template', reasons: ['GLOBAL_PAUSED', 'WORKSPACE_PAUSED', 'CAP_REACHED'] });
  });
});

describe('specific rules', () => {
  it('a suppression on the other channel does not block (WhatsApp Stop leaves email alone)', () => {
    expect(evaluate({ ...base('EMAIL'), suppression: { channel: 'WHATSAPP', createdAt: ago(1) } }).eligible).toBe(true);
    expect(evaluate({ ...base('WA_TEMPLATE'), suppression: { channel: 'EMAIL', createdAt: ago(1) } }).eligible).toBe(true);
  });

  it('P13: inbound-message consent enables in-window free-form replies only, never templates', () => {
    const consents = [INBOUND_WA];
    expect(evaluate({ ...base('WA_FREEFORM'), consents }).eligible).toBe(true);
    expect(evaluate({ ...base('WA_TEMPLATE'), consents }).reasons).toEqual(['NO_WHATSAPP_OPT_IN']);
  });

  it('M2: WhatsApp consent never implies email; attested B2B is manual single only and needs the setting', () => {
    expect(evaluate({ ...base('EMAIL'), consents: [OPT_IN_WA] }).reasons).toEqual(['NO_EMAIL_BASIS']);
    const attested = { consents: [ATTESTED_EMAIL], workspace: { emailB2bAttestationEnabled: true, autoSendEnabled: true } };
    expect(evaluate({ ...base('EMAIL', 'MANUAL_SINGLE'), ...attested }).eligible).toBe(true);
    for (const intent of ['BULK', 'AUTOMATED', 'CUSTOMER_REQUESTED_REPLY'] as const) {
      expect(evaluate({ ...base('EMAIL', intent), ...attested }).reasons).toEqual(['ATTESTED_MANUAL_ONLY']);
    }
    // A customer-requested reply a human approved is a manual send, but still not MANUAL_SINGLE.
    expect(evaluate({ ...base('EMAIL', 'CUSTOMER_REQUESTED_REPLY'), ...attested, humanApproved: true }).reasons).toEqual(['ATTESTED_MANUAL_ONLY']);
    // Email opt-in allows every intent.
    expect(evaluate({ ...base('EMAIL', 'BULK'), consents: [ATTESTED_EMAIL, OPT_IN_EMAIL] }).eligible).toBe(true);
  });

  it('E4: AUTO_SEND_DISABLED does not touch manual sends; a POLICY_AUTO attempt needs the pinned pipeline to still be POLICY_AUTO', () => {
    const off = { workspace: { emailB2bAttestationEnabled: false, autoSendEnabled: false } };
    expect(evaluate({ ...base('WA_TEMPLATE', 'MANUAL_SINGLE'), ...off }).eligible).toBe(true);
    expect(evaluate({ ...base('WA_TEMPLATE', 'BULK'), ...off }).eligible).toBe(true);
    expect(evaluate({ ...base('WA_TEMPLATE', 'AUTOMATED'), ...off }).reasons).toEqual(['AUTO_SEND_DISABLED']);
    expect(evaluate({ ...base('WA_TEMPLATE', 'AUTOMATED'), policyAutoOrigin: true, pipelineApprovalMode: 'POLICY_AUTO' }).eligible).toBe(true);
    // An automated reply that did not come from a POLICY_AUTO node does not depend on the pipeline mode.
    expect(evaluate({ ...base('WA_TEMPLATE', 'AUTOMATED'), policyAutoOrigin: false, pipelineApprovalMode: 'HUMAN' }).eligible).toBe(true);
    // A human-approved customer-requested reply is not automated.
    expect(evaluate({ ...base('WA_TEMPLATE', 'CUSTOMER_REQUESTED_REPLY'), ...off, humanApproved: true }).eligible).toBe(true);
  });

  it('A15: quality pause stops automated WhatsApp only; manual approved sends pass', () => {
    expect(evaluate({ ...base('WA_TEMPLATE', 'MANUAL_SINGLE'), qualityPaused: true }).eligible).toBe(true);
    expect(evaluate({ ...base('EMAIL', 'AUTOMATED'), qualityPaused: true }).eligible).toBe(true);
  });

  it('MODE_CHANGED only applies when the caller pins an expected mode version', () => {
    const { expectedModeVersion: _drop, ...rest } = base('WA_FREEFORM', 'AUTOMATED');
    void _drop;
    expect(evaluate(rest).eligible).toBe(true);
  });

  it('a consent withdrawn in the future still counts now; one with evidence in the future does not', () => {
    expect(evaluate({ ...base('WA_TEMPLATE'), consents: [{ ...OPT_IN_WA, withdrawnAt: new Date(NOW.getTime() + 1000) }] }).eligible).toBe(true);
    expect(evaluate({ ...base('WA_TEMPLATE'), consents: [{ ...OPT_IN_WA, collectedAt: new Date(NOW.getTime() + 1000) }] }).reasons).toEqual(['NO_WHATSAPP_OPT_IN']);
  });

  it('a null internal cap means no cap; a positive remainder passes', () => {
    expect(evaluate({ ...base('EMAIL'), internalCapRemaining: null }).eligible).toBe(true);
    expect(evaluate({ ...base('EMAIL'), internalCapRemaining: 1 }).eligible).toBe(true);
    expect(evaluate({ ...base('EMAIL'), internalCapRemaining: -2 }).reasons).toEqual(['CAP_REACHED']);
  });

  it('R4: eligibility never reads the sales stage', () => {
    const input = base('WA_TEMPLATE');
    expect(Object.keys(input)).not.toContain('salesStage');
    const withStage = { ...input, salesStage: 'LOST' } as EligibilityInput;
    expect(evaluate(withStage)).toEqual(evaluate(input));
  });

  it('is pure: the same input and clock give the same result and the input is not mutated', () => {
    const input = base('WA_FREEFORM', 'AUTOMATED');
    const snapshot = JSON.stringify(input);
    expect(evaluate(input)).toEqual(evaluate(input));
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
