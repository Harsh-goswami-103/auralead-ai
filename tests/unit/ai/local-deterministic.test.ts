// R16, C13: the labelled local generator sits behind the same AiPort as the providers. It is
// deterministic (keyed by the input hash), makes no network call, and its output passes the same
// strict schema and output policy as a provider's (so a clean lead gives a READY draft).
import { describe, expect, it } from 'vitest';
import { createLocalDeterministicAdapter, LOCAL_GENERATOR_LABEL } from '@/server/adapters/ai/local-deterministic';
import { buildDraftPrompt, type DraftFacts } from '@/server/services/ai/context-builder';
import { evaluateDraftOutput } from '@/server/services/ai/proposal';
import { CATALOG, POLICY } from './fixtures';

const FACTS: DraftFacts = {
  workspace: { name: 'Smile Avenue Dental Clinic' },
  lead: { displayName: 'Priya Sharma', category: 'Teeth whitening', city: 'Gurugram', websiteStatus: 'UNKNOWN', rating: null, reviewCount: null, firstSource: 'GOOGLE_SHEETS', hasPhone: true, hasEmail: true },
  catalog: CATALOG,
  template: { templateId: null, variableCount: 2 },
};

const port = createLocalDeterministicAdapter();
const request = (facts: DraftFacts) => {
  const p = buildDraftPrompt(facts, {});
  return { system: p.system, user: p.user, jsonSchema: p.jsonSchema, maxTokens: 4000 };
};

describe('local-deterministic generator', () => {
  it('is labelled and uses a fixed model id', () => {
    expect(port.label).toBe(LOCAL_GENERATOR_LABEL);
    expect(LOCAL_GENERATOR_LABEL).toBe('local-deterministic');
    expect(port.modelId).toBe('local-deterministic-v1');
  });

  it('returns byte-identical output for the same input', async () => {
    const a = await port.generate(request(FACTS));
    const b = await port.generate(request(FACTS));
    expect(a.text).toBe(b.text);
    expect(a.modelId).toBe('local-deterministic-v1');
  });

  it('passes the strict schema and output policy for a clean lead (READY material)', async () => {
    const out = await port.generate(request(FACTS));
    const r = evaluateDraftOutput(out.text, { catalog: CATALOG, policy: POLICY });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.flags).toEqual([]);
    expect(r.violations).toEqual([]);
    expect(r.reviewReasons).toEqual([]);
    expect(r.draft.templateVariables).toHaveLength(2);
    expect(r.draft.templateVariables[0]).toBe('Priya');
  });

  it('proposes the catalog service that matches the lead category, at its minimum quantity', async () => {
    const out = JSON.parse((await port.generate(request(FACTS))).text) as { proposal: { items: Array<{ serviceId: string; qty: number }> } };
    expect(out.proposal.items).toEqual([{ serviceId: 'svc_whiten', qty: 1 }]);
  });

  it('fills as many template variables as the approved template has', async () => {
    const out = JSON.parse((await port.generate(request({ ...FACTS, template: { templateId: 'tpl_1', variableCount: 3 } }))).text) as { templateVariables: string[] };
    expect(out.templateVariables).toHaveLength(3);
  });

  it('proposes nothing (review) when the workspace has no catalog', async () => {
    const out = await port.generate(request({ ...FACTS, catalog: [] }));
    const r = evaluateDraftOutput(out.text, { catalog: [], policy: POLICY });
    expect(r.ok && r.reviewReasons).toEqual([{ code: 'NO_ITEMS' }]);
  });
});
