/**
 * Minimal tenant graphs for the T03 DB-layer tests. Rows are created through the unscoped client
 * (the scoped client is what is under test) with fixed timestamps; nothing here reads the clock.
 */
import type { PrismaClient } from '@/generated/prisma/client';

export const T0 = new Date('2026-10-15T10:00:00.000Z');

export function at(minutes: number): Date {
  return new Date(T0.getTime() + minutes * 60_000);
}

export type TenantGraph = {
  workspaceId: string;
  leadId: string;
  serviceId: string;
  pricingVersionId: string;
  quoteId: string;
  quoteVersionId: string;
  conversationId: string;
  messageId: string;
  integrationId: string;
  templateId: string;
};

/** Creates one workspace with a lead, a service, an active pricing version, a quote with one version, a conversation with one message, and a WhatsApp integration with one template. */
export async function createTenantGraph(db: PrismaClient, slug: string): Promise<TenantGraph> {
  const ws = await db.workspace.create({ data: { slug, name: `Workspace ${slug}`, mode: 'DEMO', planLabel: 'Starter', createdAt: T0 } });
  const workspaceId = ws.id;
  const lead = await db.lead.create({
    data: {
      workspaceId,
      displayName: `Lead ${slug}`,
      nameNormalized: `lead ${slug}`,
      phoneE164: '+919800000001',
      alternatePhones: [],
      scoreReasons: [],
      unknownInputs: [],
      firstSource: 'MANUAL',
      createdAt: T0,
    },
  });
  const service = await db.service.create({
    data: { workspaceId, code: 'WEB', name: 'Website', description: 'Business website', unitLabel: 'site' },
  });
  const pricing = await db.pricingVersion.create({
    data: { workspaceId, version: 1, active: true, note: 'v1', createdBy: 'seed', createdAt: T0 },
  });
  await db.priceEntry.create({
    data: { workspaceId, pricingVersionId: pricing.id, serviceId: service.id, unitPricePaise: 1_500_000n },
  });
  const quote = await db.quote.create({
    data: { workspaceId, leadId: lead.id, number: 'Q-0001', createdBy: 'seed', createdAt: T0 },
  });
  const version = await db.quoteVersion.create({
    data: {
      workspaceId,
      quoteId: quote.id,
      versionNo: 1,
      pricingVersionId: pricing.id,
      snapshot: {},
      scopeText: 'Scope',
      timelineText: '2 weeks',
      subtotalPaise: 1_500_000n,
      discountPaise: 0n,
      taxablePaise: 1_500_000n,
      taxPaise: 0n,
      totalPaise: 1_500_000n,
      validUntil: at(60 * 24 * 15),
      aiPolicyFlags: [],
      reviewReasons: [],
      createdBy: 'seed',
      createdAt: T0,
    },
  });
  await db.quote.update({ where: { id: quote.id }, data: { currentVersionId: version.id, currentVersionNo: 1 } });
  const conversation = await db.conversation.create({
    data: { workspaceId, leadId: lead.id, channel: 'WHATSAPP', contactKey: `ck-${slug}`, createdAt: T0 },
  });
  const message = await db.message.create({
    data: {
      workspaceId,
      conversationId: conversation.id,
      direction: 'OUT',
      channel: 'WHATSAPP',
      kind: 'TEXT',
      body: 'Hello',
      status: 'DRAFT',
      createdAt: T0,
    },
  });
  const integration = await db.integration.create({
    data: { workspaceId, kind: 'WHATSAPP_CLOUD', status: 'SIMULATED', config: {} },
  });
  const template = await db.whatsAppTemplate.create({
    data: {
      workspaceId,
      integrationId: integration.id,
      name: 'first_touch',
      language: 'en',
      category: 'MARKETING',
      status: 'APPROVED',
      components: [],
      variableSchema: {},
      variableMap: {},
      categoryHistory: [],
      syncedAt: T0,
    },
  });
  return {
    workspaceId,
    leadId: lead.id,
    serviceId: service.id,
    pricingVersionId: pricing.id,
    quoteId: quote.id,
    quoteVersionId: version.id,
    conversationId: conversation.id,
    messageId: message.id,
    integrationId: integration.id,
    templateId: template.id,
  };
}

/** Inserts a QUEUED job with a unique idempotency key. */
export async function createJob(db: PrismaClient, key: string, workspaceId: string | null = null) {
  return db.job.create({
    data: { workspaceId, type: 'test.noop', payload: {}, runAt: T0, idempotencyKey: key, correlationId: `corr-${key}`, createdAt: T0 },
  });
}

/** Asserts that `promise` rejects with a Prisma unique-constraint violation (P2002). */
export async function expectUniqueViolation(promise: Promise<unknown>): Promise<void> {
  await expectPrismaCode(promise, 'P2002');
}

/** Asserts that `promise` rejects with a Prisma foreign-key violation (P2003). */
export async function expectForeignKeyViolation(promise: Promise<unknown>): Promise<void> {
  await expectPrismaCode(promise, 'P2003');
}

async function expectPrismaCode(promise: Promise<unknown>, code: string): Promise<void> {
  let caught: unknown = null;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  if (caught === null) throw new Error(`expected Prisma error ${code}, but the write succeeded`);
  const actual = (caught as { code?: unknown }).code;
  if (actual !== code) throw new Error(`expected Prisma error ${code}, got ${String(actual)}: ${String(caught)}`);
}
