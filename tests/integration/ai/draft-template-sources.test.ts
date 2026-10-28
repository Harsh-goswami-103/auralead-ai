// A first-touch draft fills the approved template's body variables. Positions the template maps to
// a lead or workspace fact (customer name, business name, city, category) get that fact, whatever
// the generator wrote: the local generator and a real model are only told how many variables there
// are, so "Hello {{1}}, this is {{2}} from Indore" used to read "this is SEO setup from Indore".
// Positions mapped as `manual`, and templates with no mapping, keep the generator's values.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { generateLeadDraft } from '@/server/services/ai/drafts';
import { syncWhatsAppTemplates } from '@/server/services/integrations/templates';
import { createAiHarness, createLead, jobCtx, KEY_RING, ownerCtx, WS_A, type AiHarness } from './support';

let h: AiHarness;
let db: PrismaClient;
let templateId: string;

const BODY = (text: string) => [{ type: 'BODY', text }];

beforeAll(async () => {
  h = await createAiHarness('ai-draft-template-sources');
  db = h.db;
  await syncWhatsAppTemplates(ownerCtx(db, h.clock, 'demo'), { liveSync: null });
  const first = await db.whatsAppTemplate.findFirstOrThrow({ where: { workspaceId: WS_A, intent: 'FIRST_TOUCH', status: 'APPROVED' } });
  templateId = first.id;
}, 120_000);

afterAll(async () => {
  await h.testDb.destroy();
});

async function draftValues(displayName: string): Promise<string[]> {
  const lead = await createLead(db, WS_A, { displayName });
  const draft = await generateLeadDraft(jobCtx(db, h.clock, 'demo'), { leadId: lead.id, trigger: 'MANUAL', requestedBy: 'user_test', finalAttempt: true }, { keyRing: KEY_RING });
  expect(draft.templateVariables.templateId).toBe(templateId);
  return draft.templateVariables.values;
}

describe('draft template variables follow the template mapping', () => {
  it('fills mapped lead and workspace positions with the real facts', async () => {
    await db.whatsAppTemplate.update({
      where: { id: templateId },
      data: { components: BODY('Hello {{1}}, this is {{2}} from {{3}}. {{4}}'), variableMap: { body: { '1': 'lead.firstName', '2': 'workspace.name', '3': 'lead.city', '4': 'manual' }, buttons: {} } },
    });

    const values = await draftValues('Kesar Fitness');

    const workspace = await db.workspace.findUniqueOrThrow({ where: { id: WS_A } });
    expect(values).toHaveLength(4);
    expect(values[0]).toBe('Kesar');
    expect(values[1]).toBe(workspace.name);
    expect(values[2]).toBe('Gurugram');
    // A manual position keeps what the generator wrote (the service of interest).
    expect(values[3]).not.toBe('');
    expect(values[3]).not.toBe(workspace.name);
  });

  it('keeps the generator values for a template without a mapping', async () => {
    await db.whatsAppTemplate.update({ where: { id: templateId }, data: { components: BODY('Hello {{1}}, about {{2}}.'), variableMap: {} } });

    const values = await draftValues('Priya Sharma');

    expect(values).toHaveLength(2);
    expect(values[0]).toBe('Priya');
    expect(values[1]).not.toBe('Priya');
  });

  it('keeps the generator value where a mapped fact is missing, never an empty string', async () => {
    await db.whatsAppTemplate.update({
      where: { id: templateId },
      data: { components: BODY('Hello {{1}}, this is {{2}}.'), variableMap: { body: { '1': 'lead.firstName', '2': 'lead.category' }, buttons: {} } },
    });
    const lead = await createLead(db, WS_A, { displayName: 'The Bake House', category: null });

    const draft = await generateLeadDraft(jobCtx(db, h.clock, 'demo'), { leadId: lead.id, trigger: 'MANUAL', requestedBy: 'user_test', finalAttempt: true }, { keyRing: KEY_RING });

    for (const v of draft.templateVariables.values) expect(v.trim()).not.toBe('');
  });
});
