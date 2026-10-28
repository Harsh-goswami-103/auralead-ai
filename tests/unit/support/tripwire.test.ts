// The DEMO zero-outbound tripwire (tests/support/tripwire.ts) is the evidence behind every "no outbound
// call" assertion in the suite, so it is tested itself: when armed, each way onto the wire throws and
// is counted; `data:` URLs pass; and it must be armed per test, because the vitest config sets
// `restoreMocks` and a spy installed in `beforeAll` is restored before the first test runs (four
// tripwire tests read zero counters whatever the code did until the cross-slice pass found this).
import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { armOutboundTripwire, newTripwireCounters, tripwireArmed } from '../../support/tripwire';

afterAll(() => vi.restoreAllMocks());

describe('armed in beforeEach', () => {
  const counters = newTripwireCounters();
  beforeEach(() => armOutboundTripwire(counters));

  it('is armed inside the test', () => {
    expect(tripwireArmed()).toBe(true);
  });

  it('refuses and counts a fetch', async () => {
    const before = counters.fetch;
    await expect(fetch('https://graph.facebook.com/v23.0/1/messages')).rejects.toThrow('tripwire: fetch attempted');
    await expect(fetch(new URL('https://api.resend.com/emails'))).rejects.toThrow('tripwire: fetch attempted');
    await expect(fetch(new Request('http://localhost:3000/x'))).rejects.toThrow('tripwire: fetch attempted');
    expect(counters.fetch).toBe(before + 3);
  });

  it('refuses and counts a socket connect, a TLS handshake and a DNS lookup', () => {
    const before = { ...counters };
    expect(() => new net.Socket().connect(80, '127.0.0.1')).toThrow('tripwire: socket connect attempted');
    expect(() => tls.connect({ host: 'example.com', port: 443 })).toThrow('tripwire: tls connect attempted');
    expect(() => dns.lookup('example.com', () => undefined)).toThrow('tripwire: dns lookup attempted');
    expect(counters).toEqual({ ...before, connect: before.connect + 1, tls: before.tls + 1, lookup: before.lookup + 1 });
  });

  it('lets a data: URL through (inline bytes are not the wire) without counting it', async () => {
    const before = counters.fetch;
    const res = await fetch('data:text/plain,inline');
    expect(await res.text()).toBe('inline');
    expect(counters.fetch).toBe(before);
  });

  it('is re-armed for the next test after the config restores the spies (counters keep adding up)', async () => {
    expect(tripwireArmed()).toBe(true);
    expect(counters.fetch).toBeGreaterThanOrEqual(3);
    await expect(fetch('https://example.com')).rejects.toThrow('tripwire');
  });
});

describe('armed in beforeAll (the mistake the helper documents)', () => {
  const counters = newTripwireCounters();
  beforeAll(() => armOutboundTripwire(counters));

  it('is already restored when the first test starts, so it would have counted nothing', () => {
    expect(tripwireArmed()).toBe(false);
  });
});
