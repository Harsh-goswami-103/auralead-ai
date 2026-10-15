// AT9 (unit), R24, C19, ADR-29: the WhatsApp customer-service window.
// windowOpen(now) = lastInboundProviderAt != null && now < lastInboundProviderAt + 24h (exclusive,
// safety margin 0). lastInboundProviderAt moves only as max(existing, inbound.providerTs) from valid
// inbound messages (text, media, interactive or button reply, quick replies); template sends,
// status webhooks, quote link opens, echoes and outbound free-form never touch it.
import { describe, expect, it } from 'vitest';
import { FixedClock } from '@/lib/clock';
import { evaluateDispatchEligibility, type EligibilityInput } from '@/server/services/messaging/eligibility';
import { advanceLastInbound, isWindowOpen, WINDOW_MS, windowEndsAt, type WindowEvent } from '@/server/services/messaging/window';

const T0 = new Date('2026-10-16T00:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const H24 = 24 * 60 * 60 * 1000;

function freeformInput(lastInbound: Date | null): EligibilityInput {
  return {
    kind: 'WA_FREEFORM',
    sendIntent: 'MANUAL_SINGLE',
    globalPaused: false,
    workspaceAutomationPaused: false,
    qualityPaused: false,
    pipelineApprovalMode: 'HUMAN',
    suppression: null,
    consents: [{ channel: 'WHATSAPP', purpose: 'SERVICE_CONVERSATION', basis: 'INBOUND_MESSAGE', collectedAt: lastInbound ?? T0, withdrawnAt: null }],
    conversation: { humanTakeover: false, modeVersion: 0, lastInboundProviderAt: lastInbound },
    template: null,
    emailAddressValid: false,
    integrationReady: true,
    workspace: { emailB2bAttestationEnabled: false, autoSendEnabled: false },
    internalCapRemaining: null,
  };
}

describe('window boundary (exclusive, margin 0)', () => {
  it('WINDOW_MS is exactly 24 hours', () => {
    expect(WINDOW_MS).toBe(H24);
  });

  it('T0+24h-1ms is open, T0+24h is closed, T0+24h+1ms is closed', () => {
    expect(isWindowOpen(T0, at(H24 - 1))).toBe(true);
    expect(isWindowOpen(T0, at(H24))).toBe(false);
    expect(isWindowOpen(T0, at(H24 + 1))).toBe(false);
    expect(isWindowOpen(null, T0)).toBe(false);
    expect(windowEndsAt(T0)?.toISOString()).toBe(at(H24).toISOString());
    expect(windowEndsAt(null)).toBeNull();
  });

  it('free-form eligibility follows the same boundary with the injected clock', () => {
    const before = evaluateDispatchEligibility(freeformInput(T0), new FixedClock(at(H24 - 1)));
    expect(before).toMatchObject({ eligible: true, mode: 'freeform', reasons: [] });
    expect(before.windowEndsAt?.toISOString()).toBe(at(H24).toISOString());

    for (const ms of [H24, H24 + 1]) {
      const after = evaluateDispatchEligibility(freeformInput(T0), new FixedClock(at(ms)));
      expect(after.eligible).toBe(false);
      expect(after.reasons).toEqual(['WINDOW_CLOSED']);
      expect(after.windowEndsAt).toBeNull();
    }
  });
});

describe('what moves lastInboundProviderAt', () => {
  const ev = (type: WindowEvent['type'], ms: number): WindowEvent => ({ type, providerTs: at(ms) });

  it('a delivered template (status webhook) does not reset the window', () => {
    expect(advanceLastInbound(T0, ev('STATUS_UPDATE', H24 - 10))).toEqual(T0);
    expect(advanceLastInbound(T0, ev('TEMPLATE_SENT', H24 - 10))).toEqual(T0);
    expect(advanceLastInbound(null, ev('TEMPLATE_SENT', 5))).toBeNull();
  });

  it('a quote link open, an echo or an outbound free-form message does not reset it', () => {
    expect(advanceLastInbound(T0, ev('QUOTE_OPENED', H24 - 10))).toEqual(T0);
    expect(advanceLastInbound(T0, ev('ECHO', H24 - 10))).toEqual(T0);
    expect(advanceLastInbound(T0, ev('OUTBOUND_FREEFORM', H24 - 10))).toEqual(T0);
  });

  it('a quick reply (interactive or button reply) resets it, as does any inbound message', () => {
    expect(advanceLastInbound(T0, ev('INBOUND_INTERACTIVE_REPLY', H24 - 10))).toEqual(at(H24 - 10));
    expect(advanceLastInbound(T0, ev('INBOUND_MESSAGE', 3_600_000))).toEqual(at(3_600_000));
    expect(advanceLastInbound(null, ev('INBOUND_MESSAGE', 7))).toEqual(at(7));
    // After the quick reply the window is open again past the old boundary.
    const last = advanceLastInbound(T0, ev('INBOUND_INTERACTIVE_REPLY', H24 - 10));
    expect(isWindowOpen(last, at(H24 + 1000))).toBe(true);
  });

  it('an older inbound delivered late never shrinks the window (monotone max)', () => {
    const newer = at(10 * 3_600_000);
    expect(advanceLastInbound(newer, ev('INBOUND_MESSAGE', 3_600_000))).toEqual(newer);
    expect(advanceLastInbound(newer, ev('INBOUND_INTERACTIVE_REPLY', 3_600_000))).toEqual(newer);
  });

  it('an inbound event with an invalid provider time is ignored', () => {
    expect(advanceLastInbound(T0, { type: 'INBOUND_MESSAGE', providerTs: new Date(Number.NaN) })).toEqual(T0);
  });
});
