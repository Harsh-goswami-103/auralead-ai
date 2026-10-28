// Cross-slice (integrator): the production worker boots with the job types of all six slices at once.
// `buildJobRegistry()` is what `worker/index.ts` registers: a duplicated type name (two slices
// claiming the same string) or an invalid one throws there, so this is the worker-boot check
// without a process. Every type in LEAD_GEN_JOB_TYPES has exactly one handler, and the kinds the
// ADRs fix are the registered ones (fetch jobs run behind sends, ai jobs get their own attempts).
import { describe, expect, it } from 'vitest';
import { LEAD_GEN_JOB_OWNERS, LEAD_GEN_JOB_TYPES } from '@/lib/domain/lead-gen';
import { buildJobRegistry, JOB_DEFINITIONS } from '@/server/jobs/registry';

describe('the worker registry with every lead-gen job type', () => {
  const registry = buildJobRegistry();

  it('registers every job type of the suite once (a duplicate or malformed name would throw here)', () => {
    expect(() => buildJobRegistry()).not.toThrow();
    const types = JOB_DEFINITIONS.map((d) => d.type);
    expect(new Set(types).size).toBe(types.length);
    for (const type of Object.values(LEAD_GEN_JOB_TYPES)) expect(registry.get(type), type).toBeDefined();
    expect(Object.keys(LEAD_GEN_JOB_OWNERS).sort()).toEqual(Object.values(LEAD_GEN_JOB_TYPES).sort());
  });

  it('registers them with the kinds and payload versions the ADRs fix', () => {
    const kinds: Record<string, string> = {
      'leadFinder.search': 'fetch',
      'leadFinder.emails': 'fetch',
      'handoff.summary': 'ai',
      'reply.auto': 'ai',
    };
    for (const [type, kind] of Object.entries(kinds)) expect(registry.get(type)?.kind, type).toBe(kind);
    for (const type of Object.values(LEAD_GEN_JOB_TYPES)) expect(registry.get(type)!.payloadVersions, type).toContain(1);
  });
});
