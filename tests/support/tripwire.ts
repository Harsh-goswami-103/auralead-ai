/**
 * The DEMO zero-outbound tripwire (plan R1): a socket connect, a TLS handshake, a DNS lookup or a
 * `fetch` throws and is counted, so a test can assert that nothing reached the wire.
 *
 * Arm it in `beforeEach`, never in `beforeAll`: the vitest config sets `restoreMocks`, which
 * restores every spy before each test, so a spy installed in a `beforeAll` hook is already gone when
 * the first test runs and the counters would read zero whatever the code did. Armed again for each
 * test, the spies live until the next test's restore (or `vi.restoreAllMocks()`); the counters are
 * the caller's object and keep adding up across the file's tests.
 */
import dns from 'node:dns';
import net from 'node:net';
import tls from 'node:tls';
import { vi } from 'vitest';

export type TripwireCounters = { connect: number; tls: number; lookup: number; fetch: number };

export function newTripwireCounters(): TripwireCounters {
  return { connect: 0, tls: 0, lookup: 0, fetch: 0 };
}

/** The real fetch, kept for `data:` URLs (taken the first time the tripwire is armed, while fetch is still real). */
let realFetch: typeof fetch | null = null;

/** The address a fetch call was given, whatever form it took. */
function fetchUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

export function armOutboundTripwire(counters: TripwireCounters): void {
  if (!vi.isMockFunction(globalThis.fetch)) realFetch = globalThis.fetch;
  vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (this: net.Socket) {
    counters.connect += 1;
    throw new Error('tripwire: socket connect attempted');
  });
  vi.spyOn(tls, 'connect').mockImplementation(() => {
    counters.tls += 1;
    throw new Error('tripwire: tls connect attempted');
  });
  vi.spyOn(dns, 'lookup').mockImplementation((() => {
    counters.lookup += 1;
    throw new Error('tripwire: dns lookup attempted');
  }) as never);
  // A `data:` URL is inline bytes, not the wire (the PDF engine loads its layout WebAssembly this way): it passes.
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    if (realFetch !== null && fetchUrl(input).startsWith('data:')) return realFetch(input, init);
    counters.fetch += 1;
    throw new Error('tripwire: fetch attempted');
  });
}

/** True while the tripwire is armed (a test can assert it, so a regression to a hook cannot go unnoticed). */
export function tripwireArmed(): boolean {
  return vi.isMockFunction(globalThis.fetch) && vi.isMockFunction(net.Socket.prototype.connect) && vi.isMockFunction(tls.connect) && vi.isMockFunction(dns.lookup);
}
