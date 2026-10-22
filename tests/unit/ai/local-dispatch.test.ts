// Lead-gen B2 (ADR-18, ADR-122..124): the labelled local generator is a dispatcher on the JSON
// user message's `task` field. Each task has its own module under adapters/ai/local/ and one line
// in LOCAL_TASKS (the slices add conversation_reply, template_copy and handoff_summary at their
// anchors). The lead_draft branch moved to local/draft.ts unchanged: the hashes below were taken
// from the generator before the move, so any change to a byte of its output fails here.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateLocalDraft } from '@/server/adapters/ai/local/draft';
import { createLocalDeterministicAdapter, LOCAL_GENERATOR_MODEL, LOCAL_TASKS } from '@/server/adapters/ai/local-deterministic';
import type { AiRequest } from '@/server/adapters/ai/port';
import { buildDraftPrompt, type DraftFacts } from '@/server/services/ai/context-builder';
import { CATALOG } from './fixtures';

const FACTS: DraftFacts = {
  workspace: { name: 'Smile Avenue Dental Clinic' },
  lead: { displayName: 'Priya Sharma', category: 'Teeth whitening', city: 'Gurugram', websiteStatus: 'UNKNOWN', rating: null, reviewCount: null, firstSource: 'GOOGLE_SHEETS', hasPhone: true, hasEmail: true },
  catalog: CATALOG,
  template: { templateId: null, variableCount: 2 },
};

/** sha256 of the generator's output text for each input, recorded before the dispatcher existed. */
const GOLDEN: ReadonlyArray<[string, DraftFacts, string]> = [
  ['base', FACTS, '3739060d682337992aa04c459ff21f1b3cd879d9a2acc781bc302453b9821b92'],
  ['three variables', { ...FACTS, template: { templateId: 'tpl_1', variableCount: 3 } }, '8d3485d39b0caaebd947b12392af0066f99c2eff3ddf4e73de2ce5d2313b313b'],
  ['no catalog', { ...FACTS, catalog: [] }, 'a3b5a5551e71ff071f1280bf070ce5bea0c22cc6fad6b6a2db747b1470f86f80'],
  ['no name, no category', { ...FACTS, lead: { ...FACTS.lead, displayName: '   ', category: null } }, '3caa78eac69868f2dd7035c962114a076280e228f3b2518962ae3db5b901e778'],
  [
    'weeks timeline',
    {
      ...FACTS,
      lead: { ...FACTS.lead, displayName: 'Dr. Ravi Kumar', category: 'Root canal' },
      catalog: CATALOG.map((c) => ({ ...c, typicalTimelineDays: c.code === 'RCT' ? 45 : c.typicalTimelineDays })),
    },
    'e96d6f194243c360d4da08a3b28173e2eb741d2733f13e521b811933168aa111',
  ],
  [
    'months timeline, null timelines',
    { ...FACTS, lead: { ...FACTS.lead, category: 'canal treatment' }, catalog: CATALOG.map((c) => ({ ...c, typicalTimelineDays: c.code === 'RCT' ? 120 : null })) },
    'a0ccf40b3a2b663b858bcc842e5af7ef23dc27599d407241e1ec73d78d95dd1d',
  ],
];

const BASE_TEXT =
  '{"templateVariables":["Priya","Teeth whitening (in-clinic)"],"followUp":"Hi Priya, thank you for asking about Teeth whitening (in-clinic) at Smile Avenue Dental Clinic. Would you like us to prepare a detailed quotation? Reply here and our team will get back to you.","email":{"subject":"Your enquiry about Teeth whitening (in-clinic)","body":"Hi Priya,\\n\\nThank you for asking about Teeth whitening (in-clinic). We would be happy to prepare a detailed quotation for you, covering the scope and timeline.\\n\\nJust reply to this email with any questions or details you would like us to include.\\n\\nRegards,\\nSmile Avenue Dental Clinic"},"proposal":{"items":[{"serviceId":"svc_whiten","qty":1}],"scopeText":"Teeth whitening (in-clinic): One 60-minute in-clinic whitening session.","timelineText":"Usually completed within a day."}}';

const port = createLocalDeterministicAdapter();
const draftRequest = (facts: DraftFacts): AiRequest => {
  const p = buildDraftPrompt(facts, {});
  return { system: p.system, user: p.user, jsonSchema: p.jsonSchema, maxTokens: 4000 };
};
const rawRequest = (user: string): AiRequest => ({ system: 's', user, jsonSchema: {}, maxTokens: 100 });
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

describe('lead_draft through the dispatcher', () => {
  it('is byte-for-byte the output of the generator before the move', async () => {
    const base = await port.generate(draftRequest(FACTS));
    expect(base.text).toBe(BASE_TEXT);
    for (const [name, facts, hash] of GOLDEN) {
      expect(sha256((await port.generate(draftRequest(facts))).text), name).toBe(hash);
    }
  });

  it('local/draft.ts gives the same output for the parsed message and its sha256 seed', async () => {
    const request = draftRequest(FACTS);
    const seed = createHash('sha256').update(request.user, 'utf8').digest().readUInt32BE(0);
    expect(JSON.stringify(generateLocalDraft({ message: JSON.parse(request.user), seed }))).toBe((await port.generate(request)).text);
  });

  it('reports the fixed local model and no provider metadata', async () => {
    expect(await port.generate(draftRequest(FACTS))).toMatchObject({ modelId: LOCAL_GENERATOR_MODEL, providerRequestId: null, usage: null });
  });

  it('still refuses a lead_draft message whose data is not the draft shape', async () => {
    await expect(port.generate(rawRequest(JSON.stringify({ task: 'lead_draft', data: { lead: {} } })))).rejects.toThrow('local-deterministic generator: unexpected input shape');
  });
});

describe('LOCAL_TASKS', () => {
  it('has the lead_draft entry, served by local/draft.ts', () => {
    expect(Object.hasOwn(LOCAL_TASKS, 'lead_draft')).toBe(true);
    expect(LOCAL_TASKS.lead_draft).toBe(generateLocalDraft);
  });

  it('only names known AI tasks', () => {
    for (const task of Object.keys(LOCAL_TASKS)) expect(['lead_draft', 'conversation_reply', 'template_copy', 'handoff_summary']).toContain(task);
  });

  it('carries one anchor per slice task for its single line', () => {
    const source = readFileSync(path.resolve(import.meta.dirname, '../../../src/server/adapters/ai/local-deterministic.ts'), 'utf8');
    for (const anchor of ['// ---- lead-gen F3 conversation_reply ----', '// ---- lead-gen F4 template_copy ----', '// ---- lead-gen F5 handoff_summary ----']) {
      expect(source).toContain(anchor);
    }
  });
});

describe('dispatch errors', () => {
  it('an unknown task throws a clear error naming the task', async () => {
    await expect(port.generate(rawRequest(JSON.stringify({ task: 'poem_writer', data: {} })))).rejects.toThrow(/no local generator for task "poem_writer"/);
  });

  it('inherited object keys are not tasks', async () => {
    for (const task of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      await expect(port.generate(rawRequest(JSON.stringify({ task, data: {} }))), task).rejects.toThrow(/no local generator for task/);
    }
  });

  it('a message without a string task field throws', async () => {
    await expect(port.generate(rawRequest(JSON.stringify({ data: {} })))).rejects.toThrow(/no "task" field/);
    await expect(port.generate(rawRequest(JSON.stringify({ task: 7, data: {} })))).rejects.toThrow(/no "task" field/);
    await expect(port.generate(rawRequest(JSON.stringify(['lead_draft'])))).rejects.toThrow(/no "task" field/);
  });

  it('a user message that is not JSON throws', async () => {
    await expect(port.generate(rawRequest('lead_draft please'))).rejects.toThrow(/not JSON/);
  });
});
