/**
 * R28, C10 (plan §6.4, ADR-29): the delivery rank merge.
 *  - sent (1) < delivered (2) < read (3); an incoming status applies only above the current rank;
 *  - read before delivered gives READ (delivered implied);
 *  - failed applies only at rank <= sent; after delivered it is an anomaly and changes nothing;
 *  - property (fast-check, fixed seed): any shuffle of any events with duplicates ends at the same
 *    state, and the applied changes have strictly increasing rank (one change per rank).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalDeliveryEvent, mergeDeliveryStatus, type DeliveryEvent, type DeliveryState } from '@/server/services/messaging/status-merge';

const start: DeliveryState = { status: 'PENDING', statusRank: 0 };

describe('mergeDeliveryStatus', () => {
  it.each([
    [{ status: 'PENDING', statusRank: 0 }, 'sent', { status: 'SENT', statusRank: 1 }],
    [{ status: 'SENT', statusRank: 1 }, 'delivered', { status: 'DELIVERED', statusRank: 2 }],
    [{ status: 'DELIVERED', statusRank: 2 }, 'read', { status: 'READ', statusRank: 3 }],
    [{ status: 'SENT', statusRank: 1 }, 'read', { status: 'READ', statusRank: 3 }],
    [{ status: 'UNKNOWN', statusRank: 0 }, 'delivered', { status: 'DELIVERED', statusRank: 2 }],
    [{ status: 'PENDING', statusRank: 0 }, 'failed', { status: 'FAILED', statusRank: 1 }],
    [{ status: 'SENT', statusRank: 1 }, 'failed', { status: 'FAILED', statusRank: 1 }],
    [{ status: 'FAILED', statusRank: 1 }, 'delivered', { status: 'DELIVERED', statusRank: 2 }],
  ] as Array<[DeliveryState, DeliveryEvent, DeliveryState]>)('%o + %s -> %o', (current, incoming, expected) => {
    expect(mergeDeliveryStatus(current, incoming)).toEqual({ next: expected, anomaly: false });
  });

  it.each([
    [{ status: 'SENT', statusRank: 1 }, 'sent'],
    [{ status: 'DELIVERED', statusRank: 2 }, 'sent'],
    [{ status: 'DELIVERED', statusRank: 2 }, 'delivered'],
    [{ status: 'READ', statusRank: 3 }, 'delivered'],
    [{ status: 'FAILED', statusRank: 1 }, 'sent'],
    [{ status: 'FAILED', statusRank: 1 }, 'failed'],
  ] as Array<[DeliveryState, DeliveryEvent]>)('%o + %s changes nothing', (current, incoming) => {
    expect(mergeDeliveryStatus(current, incoming)).toEqual({ next: null, anomaly: false });
  });

  it('failed after delivered or read is an anomaly and changes nothing', () => {
    expect(mergeDeliveryStatus({ status: 'DELIVERED', statusRank: 2 }, 'failed')).toEqual({ next: null, anomaly: true });
    expect(mergeDeliveryStatus({ status: 'READ', statusRank: 3 }, 'failed')).toEqual({ next: null, anomaly: true });
  });

  it('maps provider status strings and ignores the rest', () => {
    expect(canonicalDeliveryEvent('WHATSAPP', 'delivered')).toBe('delivered');
    expect(canonicalDeliveryEvent('WHATSAPP', 'deleted')).toBeNull();
    expect(canonicalDeliveryEvent('EMAIL', 'email.delivered')).toBe('delivered');
    expect(canonicalDeliveryEvent('EMAIL', 'email.sent')).toBe('sent');
    expect(canonicalDeliveryEvent('EMAIL', 'email.bounced')).toBe('failed');
    // An open is not proof that a person read it (C4): stored, never a READ.
    expect(canonicalDeliveryEvent('EMAIL', 'email.opened')).toBeNull();
  });
});

const RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3 };

function expectedFinal(events: readonly DeliveryEvent[]): DeliveryState {
  const top = Math.max(0, ...events.filter((e) => e !== 'failed').map((e) => RANK[e]!));
  if (top >= 2) return { status: top === 2 ? 'DELIVERED' : 'READ', statusRank: top };
  if (events.includes('failed')) return { status: 'FAILED', statusRank: 1 };
  if (top === 1) return { status: 'SENT', statusRank: 1 };
  return start;
}

describe('rank merge under shuffles and duplicates (property)', () => {
  it('ends at the rank-max state with strictly increasing applied ranks', () => {
    const eventSet = fc.uniqueArray(fc.constantFrom<DeliveryEvent>('sent', 'delivered', 'read', 'failed'), { minLength: 1, maxLength: 4 });
    const withDuplicates = eventSet.chain((set) =>
      fc.tuple(...set.map((e) => fc.integer({ min: 1, max: 3 }).map((n) => Array<DeliveryEvent>(n).fill(e)))).chain((groups) => fc.shuffledSubarray(groups.flat(), { minLength: groups.flat().length })),
    );
    fc.assert(
      fc.property(withDuplicates, (events) => {
        let state = start;
        const appliedRanks: number[] = [];
        for (const e of events) {
          const { next } = mergeDeliveryStatus(state, e);
          if (next) {
            if (next.status !== 'FAILED') appliedRanks.push(next.statusRank);
            state = next;
          }
        }
        expect(state).toEqual(expectedFinal(events));
        for (let i = 1; i < appliedRanks.length; i += 1) expect(appliedRanks[i]!).toBeGreaterThan(appliedRanks[i - 1]!);
      }),
      { seed: 20261016, numRuns: 500 },
    );
  });
});
