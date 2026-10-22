/**
 * Plan §5.2 and the lead-gen suite (ADR-118, ADR-120): a workspace OWNER holds every capability,
 * including the five lead-gen ones; a MEMBER works leads, drafts, quotes and sends and may import
 * lead files, but never imports consent (owner only), runs paid finder searches, authors
 * templates or hands leads over.
 */
import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from '@/lib/domain/enums';
import { MEMBER_CAPABILITIES, OWNER_CAPABILITIES } from '@/server/auth/guards';

describe('membership capabilities', () => {
  it('gives an owner every capability', () => {
    expect([...OWNER_CAPABILITIES].sort()).toEqual([...CAPABILITIES].sort());
    for (const c of ['finder.run', 'leads.import', 'consent.import', 'templates.manage', 'leads.handoff'] as const) expect(OWNER_CAPABILITIES.has(c), c).toBe(true);
  });

  it('gives a member lead imports but not consent imports or the other lead-gen capabilities', () => {
    expect([...MEMBER_CAPABILITIES].sort()).toEqual(['dispatch.send', 'drafts.generate', 'leads.import', 'leads.read', 'leads.write', 'quotes.edit']);
    for (const c of ['consent.import', 'finder.run', 'templates.manage', 'leads.handoff'] as const) expect(MEMBER_CAPABILITIES.has(c), c).toBe(false);
  });
});
