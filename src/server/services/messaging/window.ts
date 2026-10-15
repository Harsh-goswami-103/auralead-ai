/**
 * The WhatsApp customer-service window (C19, A13, ADR-29, R24, AT9). Pure functions; callers pass
 * times from the injected clock and from provider payloads.
 *
 *  - `isWindowOpen(last, now)` is `last != null && now < last + 24h`: exclusive, safety margin 0.
 *  - `Conversation.lastInboundProviderAt` moves only through `advanceLastInbound`, which takes the
 *    max of the stored value and the provider timestamp of a valid inbound message (text, media,
 *    interactive or button reply, quick replies). Template sends, status webhooks, quote link
 *    opens, echoes and outbound free-form messages never touch it, and an older inbound delivered
 *    late never shrinks the window.
 */

export const WINDOW_MS = 24 * 60 * 60 * 1000;

export type WindowEvent = {
  type:
    | 'INBOUND_MESSAGE'
    | 'INBOUND_INTERACTIVE_REPLY'
    | 'TEMPLATE_SENT'
    | 'STATUS_UPDATE'
    | 'QUOTE_OPENED'
    | 'ECHO'
    | 'OUTBOUND_FREEFORM';
  /** The provider's own timestamp of the event (never the receive time). */
  providerTs: Date;
};

const OPENS_WINDOW: ReadonlySet<WindowEvent['type']> = new Set(['INBOUND_MESSAGE', 'INBOUND_INTERACTIVE_REPLY']);

export function windowEndsAt(lastInboundProviderAt: Date | null): Date | null {
  return lastInboundProviderAt === null ? null : new Date(lastInboundProviderAt.getTime() + WINDOW_MS);
}

export function isWindowOpen(lastInboundProviderAt: Date | null, now: Date): boolean {
  if (lastInboundProviderAt === null) return false;
  return now.getTime() < lastInboundProviderAt.getTime() + WINDOW_MS;
}

/** The new `lastInboundProviderAt` after `event` (a monotone max over valid inbound messages). */
export function advanceLastInbound(current: Date | null, event: WindowEvent): Date | null {
  const copy = (d: Date | null) => (d === null ? null : new Date(d.getTime()));
  if (!OPENS_WINDOW.has(event.type)) return copy(current);
  const ts = event.providerTs.getTime();
  if (!Number.isFinite(ts)) return copy(current);
  if (current !== null && current.getTime() >= ts) return copy(current);
  return new Date(ts);
}
