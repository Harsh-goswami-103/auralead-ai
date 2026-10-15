/**
 * Delivery status rank merge (C10, plan §6.4, ADR-29, R28). Pure: no I/O.
 *
 *   sent (1) < delivered (2) < read (3)
 *   - a positive status applies only above the current rank (`statusRank < incoming`), so
 *     duplicates and out-of-order arrivals never move a message backwards; read before delivered
 *     gives READ (delivered implied);
 *   - failed applies only while nothing above "sent" was seen (`statusRank <= 1`, not already
 *     FAILED) and pins the rank at 1, so a late "sent" cannot undo it; after delivered or read it
 *     is an anomaly (stored, flagged, no state change).
 * The final state is therefore the same for every order of the same events.
 */
import type { Channel, MessageStatus } from '@/generated/prisma/client';
import { STATUS_RANK } from './delivery-state';

export type DeliveryEvent = 'sent' | 'delivered' | 'read' | 'failed';
export type DeliveryState = { status: MessageStatus; statusRank: number };
export type MergeResult = { next: DeliveryState | null; anomaly: boolean };

/** Rank stored on MessageStatusEvent rows: failed and unmapped statuses carry 0. */
export function eventRank(event: DeliveryEvent | null): number {
  switch (event) {
    case 'sent':
      return STATUS_RANK.SENT;
    case 'delivered':
      return STATUS_RANK.DELIVERED;
    case 'read':
      return STATUS_RANK.READ;
    default:
      return 0;
  }
}

const POSITIVE: Record<Exclude<DeliveryEvent, 'failed'>, MessageStatus> = { sent: 'SENT', delivered: 'DELIVERED', read: 'READ' };

export function mergeDeliveryStatus(current: DeliveryState, incoming: DeliveryEvent): MergeResult {
  if (incoming === 'failed') {
    if (current.statusRank >= STATUS_RANK.DELIVERED) return { next: null, anomaly: true };
    if (current.status === 'FAILED') return { next: null, anomaly: false };
    return { next: { status: 'FAILED', statusRank: STATUS_RANK.SENT }, anomaly: false };
  }
  const rank = eventRank(incoming);
  if (current.statusRank >= rank) return { next: null, anomaly: false };
  return { next: { status: POSITIVE[incoming], statusRank: rank }, anomaly: false };
}

/**
 * Maps a provider status string onto a delivery event, or null for statuses that are stored but
 * never change a message (WhatsApp `deleted`; email opens, clicks, delays, complaints: an open is
 * not proof a person read it, C4).
 */
export function canonicalDeliveryEvent(channel: Channel, raw: string): DeliveryEvent | null {
  if (channel === 'WHATSAPP') {
    return raw === 'sent' || raw === 'delivered' || raw === 'read' || raw === 'failed' ? raw : null;
  }
  switch (raw) {
    case 'email.sent':
      return 'sent';
    case 'email.delivered':
      return 'delivered';
    case 'email.bounced':
      return 'failed';
    default:
      return null;
  }
}
