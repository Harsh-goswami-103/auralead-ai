/**
 * ADR-126 (slice F6): the DEMO presentation pack. A sixth workspace `codecraft-web` (Codecraft Web
 * Studio, Indore) with a fourth persona `client` (Aarav Mehta, its OWNER), the operator persona
 * assigned with every capability except `consent.import`, its own scoring version, a SIMULATED
 * WhatsApp integration with authored web-development templates, a finished simulated finder run,
 * GOOGLE_PLACES leads (3 with a recorded opt-in), two chats with an open 24-hour window and one
 * lead handed over to the client. Checked against the real services: scores reproduce through
 * `scoreLead`, template shapes are sendable, eligibility allows template sends to the opted-in
 * leads only, and `demo:refresh` keeps the windows open. The other five workspaces stay as they
 * were (no integration, template, conversation or finder row: ADR-81).
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { FixedClock } from '@/lib/clock';
import { CAPABILITIES, isCapability } from '@/lib/domain/enums';
import { CONTACT_CONFIRMED_VIA, HANDOFF_SUMMARY_STATUSES, FINDER_EMAIL_STATUSES } from '@/lib/domain/lead-gen';
import { parseTemplateMapping, templateShape } from '@/lib/domain/whatsapp-templates';
import { CONFIG_FIELD_RULES } from '@/lib/schemas/integrations';
import { parseScoringConfig } from '@/lib/schemas/scoring';
import { getWebhookContext } from '@/server/auth/context';
import { DEMO_PERSONAS } from '@/server/auth/demo-personas';
import { checkDispatchEligibility } from '@/server/services/messaging/eligibility';
import { isWindowOpen } from '@/server/services/messaging/window';
import { scoreLead } from '@/server/services/scoring/score';
import { contactKey } from '@/server/security/contact-key';
import { seedId } from '../../../prisma/seed/ids';
import {
  AUTOMATED_DISCLOSURE,
  FINDER_RUN_FIXTURE,
  HANDOFF_FIXTURE,
  PRESENTATION_BUSINESS,
  PRESENTATION_OPT_IN_NOTICE,
  PRESENTATION_SLUG,
  STORY_LEADS,
  TEMPLATE_FIXTURES,
  presentationPlaces,
} from '../../../prisma/seed/fixtures/presentation';
import { WORKSPACE_FIXTURES } from '../../../prisma/seed/fixtures/workspaces';
import { seedDemo } from '../../../prisma/seed/seed';
import { refreshDemo } from '../../../scripts/demo-refresh';
import { createTestDb, type TestDb } from '../../support/db';

const T0 = new Date('2026-10-15T04:30:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PEPPER = `presentation-seed-pepper-${'p'.repeat(32)}`;
const CONFIG = { mode: 'demo' as const, secrets: { suppressionPepper: PEPPER } };
const WS = seedId('workspace', PRESENTATION_SLUG);
const leadIdOf = (place: string) => seedId('lead', `${PRESENTATION_SLUG}:${place}`);
const OPT_IN_METHODS = ['CALL_VERBAL', 'WRITTEN_FORM', 'WEBSITE_FORM', 'IN_PERSON', 'WHATSAPP_THREAD'];

let testDb: TestDb;
let db: PrismaClient;

beforeAll(async () => {
  testDb = await createTestDb({ label: 'seed-presentation' });
  db = testDb.client();
  await seedDemo(db, { config: CONFIG, now: T0 });
}, 120_000);
afterAll(async () => {
  await testDb?.destroy();
});

const ctxAt = (now: Date) => getWebhookContext({ workspaceId: WS }, { prisma: db, mode: 'demo', clock: new FixedClock(now) }, 'req_presentation_seed');

describe('the codecraft-web workspace and its people', () => {
  it('is a DEMO web studio in Indore with services in paise, the opt-in notice and automatic sending on', async () => {
    const ws = await db.workspace.findUniqueOrThrow({ where: { id: WS }, include: { settings: true } });
    expect(ws).toMatchObject({ slug: 'codecraft-web', name: 'Codecraft Web Studio', mode: 'DEMO', timezone: 'Asia/Kolkata', status: 'ACTIVE' });
    expect(ws.settings).toMatchObject({ autoSendEnabled: true, privacyContact: expect.stringMatching(/@.+\.example\.com$/) });
    const notice = ws.settings!.whatsappOptInNotice!;
    expect(notice).toContain(PRESENTATION_BUSINESS);
    expect(notice).toContain('WhatsApp');
    expect(ws.settings!.termsText).toContain('Indore');
    expect(ws.settings!.brandColor).toMatch(/^#[0-9A-F]{6}$/);

    const services = await db.service.findMany({ where: { workspaceId: WS }, include: { priceEntries: true }, orderBy: { code: 'asc' } });
    expect(services.map((s) => s.name).sort()).toEqual(['Business website', 'E-commerce store', 'Landing page', 'SEO setup', 'Website maintenance']);
    for (const s of services) {
      expect(s.priceEntries).toHaveLength(1);
      expect(typeof s.priceEntries[0]!.unitPricePaise).toBe('bigint');
      expect(s.priceEntries[0]!.unitPricePaise % 100n).toBe(0n);
      expect(s.priceEntries[0]!.unitPricePaise).toBeGreaterThan(0n);
    }
  });

  it('is owned by the client persona (Aarav Mehta) and only by them', async () => {
    const client = await db.user.findUniqueOrThrow({ where: { email: DEMO_PERSONAS.client.email }, include: { memberships: true } });
    expect(client).toMatchObject({ name: 'Aarav Mehta', globalRole: 'USER', isDemo: true, status: 'ACTIVE', passwordHash: null });
    expect(client.memberships.map((m) => [m.workspaceId, m.role])).toEqual([[WS, 'OWNER']]);
    expect(await db.membership.count({ where: { workspaceId: WS } })).toBe(1);
  });

  it('assigns the operator persona with every capability except consent.import', async () => {
    const employee = await db.user.findUniqueOrThrow({ where: { email: DEMO_PERSONAS.employee.email } });
    const assignment = await db.employeeAssignment.findFirstOrThrow({ where: { employeeUserId: employee.id, workspaceId: WS } });
    expect(assignment.active).toBe(true);
    const caps = assignment.capabilities as string[];
    for (const c of caps) expect(isCapability(c)).toBe(true);
    expect([...caps].sort()).toEqual(CAPABILITIES.filter((c) => c !== 'consent.import').sort());
    expect(caps).toEqual(expect.arrayContaining(['finder.run', 'leads.import', 'templates.manage', 'leads.handoff']));
  });

  it('has its own scoring version: no website listed earns the website points, web-studio target categories', async () => {
    const versions = await db.scoringConfigVersion.findMany({ where: { workspaceId: WS } });
    expect(versions).toHaveLength(1);
    const config = parseScoringConfig(versions[0]!.weights);
    expect(config.websitePreference).toBe('ABSENT');
    expect(config.targetCategories).toEqual(['restaurant', 'clinic', 'salon', 'gym', 'boutique', 'coaching']);
    // The other workspaces keep the shared v1 (no preference: PRESENT by default).
    const other = await db.scoringConfigVersion.findFirstOrThrow({ where: { workspaceId: seedId('workspace', 'smile-avenue-dental') } });
    expect(parseScoringConfig(other.weights).websitePreference).toBeUndefined();
  });
});

describe('the simulated WhatsApp integration and authored templates', () => {
  it('is SIMULATED with a valid display number and no routing key', async () => {
    const integration = await db.integration.findFirstOrThrow({ where: { workspaceId: WS, kind: 'WHATSAPP_CLOUD' } });
    expect(integration).toMatchObject({ status: 'SIMULATED', routingKey: null, secrets: null });
    const config = integration.config as Record<string, string>;
    expect(CONFIG_FIELD_RULES.WHATSAPP_CLOUD.displayPhoneNumber!.check(config.displayPhoneNumber!)).toBeNull();
  });

  it('carries approved, pending and rejected web-development templates that the send path can use', async () => {
    const rows = await db.whatsAppTemplate.findMany({ where: { workspaceId: WS }, orderBy: { name: 'asc' } });
    expect(rows.map((t) => [t.name, t.category, t.status])).toEqual([
      ['brochure_share', 'MARKETING', 'PENDING'],
      ['discount_blast', 'MARKETING', 'REJECTED'],
      ['follow_up', 'MARKETING', 'APPROVED'],
      ['meeting_confirm', 'UTILITY', 'APPROVED'],
      ['website_intro', 'MARKETING', 'APPROVED'],
    ]);
    for (const t of rows) {
      expect(t.origin).toBe('AUTHORED');
      expect(t.language).toBe('en');
      expect(templateShape(t.components).sendable).toEqual({ ok: true });
      const mapping = parseTemplateMapping(t.variableMap);
      expect(Object.keys(mapping.body).sort()).toEqual(templateShape(t.components).bodyVariables);
      expect(t.categoryHistory).toEqual([]);
      if (t.status === 'PENDING') expect(t.syncedAt).toBeNull();
      else expect(t.syncedAt!.getTime()).toBeGreaterThan(t.submittedAt!.getTime());
      expect(t.submittedAt!.getTime()).toBeLessThan(T0.getTime());
    }
    const byName = new Map(rows.map((t) => [t.name, t]));
    // MARKETING templates offer Stop (mapped to the STOP payload), except the rejected blast.
    for (const name of ['website_intro', 'follow_up', 'brochure_share']) {
      expect(Object.values(parseTemplateMapping(byName.get(name)!.variableMap).buttons)).toContain('STOP');
    }
    expect(byName.get('meeting_confirm')!.utilityTrigger).toBeTruthy();
    expect(byName.get('website_intro')!.utilityTrigger).toBeNull();
    expect(byName.get('discount_blast')!.rejectedReason).toMatch(/opt out/);
    expect(byName.get('brochure_share')!.copyGeneratorLabel).toBe('local-deterministic');
    expect(rows.filter((t) => t.status !== 'REJECTED').every((t) => t.rejectedReason === null)).toBe(true);
    expect(TEMPLATE_FIXTURES).toHaveLength(rows.length);
  });
});

describe('the finished simulated finder run', () => {
  it('searched every keyword x location cell and found about 40 places, half with no website listed', async () => {
    const run = await db.leadFinderRun.findUniqueOrThrow({ where: { id: seedId('finder-run', FINDER_RUN_FIXTURE.key) } });
    expect(run).toMatchObject({ workspaceId: WS, status: 'SUCCEEDED', simulated: true, extractEmails: false, cellsTotal: 6, cellsDone: 6, emailsFound: 0, errorCode: null, cancelledAt: null });
    expect(run.keywords).toEqual(['restaurants', 'dental clinic', 'salon']);
    expect(run.locations).toEqual(['Indore', 'Bhopal']);
    expect([20, 40, 60]).toContain(run.maxPerQuery);
    expect(run.startedAt!.getTime()).toBeLessThan(run.finishedAt!.getTime());
    expect(run.finishedAt!.getTime()).toBeLessThan(T0.getTime());

    const results = await db.leadFinderResult.findMany({ where: { runId: run.id } });
    expect(results).toHaveLength(run.resultsFound);
    expect(results.length).toBeGreaterThanOrEqual(36);
    expect(results.length).toBeLessThanOrEqual(44);
    expect(results.filter((r) => !r.websiteListed)).toHaveLength(results.length / 2);
    expect(new Set(results.map((r) => r.placeId)).size).toBe(results.length);
    for (const r of results) {
      expect((run.keywords as string[]).includes(r.keyword)).toBe(true);
      expect((run.locations as string[]).includes(r.location)).toBe(true);
      expect(r.city).toBe(r.location);
      expect(r.state).toBe('Madhya Pradesh');
      expect(r.pincode).toMatch(/^4[56]\d{4}$/);
      expect(r.simulated).toBe(true);
      expect(r.attributions).toBeNull();
      expect(r.emails).toEqual([]);
      expect(r.emailCount).toBe(0);
      expect(FINDER_EMAIL_STATUSES).toContain(r.emailStatus);
      expect(r.websiteListed).toBe(r.website !== null);
      expect(r.hasPhone).toBe(r.phoneRaw !== null);
      expect(r.ratingX10!).toBeGreaterThanOrEqual(10);
      expect(r.ratingX10!).toBeLessThanOrEqual(50);
      expect(r.contentExpiresAt!.getTime()).toBe(r.createdAt.getTime() + DAY);
      expect(r.contentExpiresAt!.getTime()).toBeGreaterThan(T0.getTime());
      expect(r.contentPurgedAt).toBeNull();
    }
    expect(results.some((r) => !r.hasPhone)).toBe(true);
  });

  it('imported 12 places as GOOGLE_PLACES leads that keep the place ID and the 30-day Places expiry', async () => {
    const imported = await db.leadFinderResult.findMany({ where: { workspaceId: WS, importedLeadId: { not: null } } });
    expect(imported).toHaveLength(12);
    const leads = await db.lead.findMany({ where: { workspaceId: WS } });
    expect(leads).toHaveLength(12);
    const scoring = await db.scoringConfigVersion.findFirstOrThrow({ where: { workspaceId: WS, active: true } });
    const pipeline = await db.pipelineConfigVersion.findFirstOrThrow({ where: { workspaceId: WS, active: true } });
    for (const r of imported) {
      const lead = leads.find((l) => l.id === r.importedLeadId)!;
      expect(lead).toBeDefined();
      expect(lead).toMatchObject({ firstSource: 'GOOGLE_PLACES', placeId: r.placeId, displayName: r.name, city: r.city, pincode: r.pincode, simulated: true });
      expect(lead.websiteStatus).toBe(r.websiteListed ? 'PRESENT_UNVERIFIED' : 'NOT_LISTED');
      expect(lead.rating).toBe(r.ratingX10);
      expect(lead.phoneE164).toMatch(/^\+91\d{10}$/);
      expect(r.importedAt!.getTime()).toBe(lead.createdAt.getTime());
      expect(lead.placesContentExpiresAt!.getTime()).toBe(lead.createdAt.getTime() + 30 * DAY);
      expect(lead.pipelineConfigVersionId).toBe(pipeline.id);
      // The stored score is exactly what the scorer gives with the workspace's config.
      const expected = scoreLead(lead, { id: scoring.id, version: scoring.version, config: parseScoringConfig(scoring.weights) });
      expect(lead.scoreConfigVersionId).toBe(scoring.id);
      expect(lead.score).toBe(expected.score);
      expect(lead.scoreReasons).toEqual(JSON.parse(JSON.stringify(expected.reasons)));
      expect(lead.unknownInputs).toEqual(JSON.parse(JSON.stringify(expected.unknownInputs)));
      const keys = await db.leadContactKey.findMany({ where: { leadId: lead.id } });
      expect(keys.map((k) => `${k.kind}:${k.value}`).sort()).toEqual([`PHONE:${lead.phoneE164}`, `PROVIDER:GOOGLE_PLACES:${r.placeId}`].sort());
      const sourceRecord = await db.leadSourceRecord.findFirstOrThrow({ where: { leadId: lead.id } });
      expect(sourceRecord).toMatchObject({ source: 'GOOGLE_PLACES', status: 'ACCEPTED', externalId: r.placeId, attribution: { keyword: r.keyword, location: r.location } });
    }
    expect(leads.filter((l) => l.websiteStatus === 'NOT_LISTED').length).toBeGreaterThanOrEqual(8);
    const noWebsite = leads.find((l) => l.websiteStatus === 'NOT_LISTED')!;
    expect((noWebsite.scoreReasons as Array<{ label: string; points: number; maxPoints: number }>).find((r) => r.label === 'No website listed')).toMatchObject({ points: 30, maxPoints: 30 });
  });

  it('matches the fixture builder (40 deterministic places)', () => {
    const places = presentationPlaces();
    expect(places).toHaveLength(40);
    expect(places.filter((p) => p.imported)).toHaveLength(12);
    expect(places.filter((p) => !p.websiteListed)).toHaveLength(20);
    expect(presentationPlaces()).toEqual(places);
  });
});

describe('opt-ins, chats and the handoff', () => {
  it('records a WhatsApp opt-in with the notice and its method for exactly three leads', async () => {
    const optIns = await db.consentRecord.findMany({ where: { workspaceId: WS, basis: 'OPT_IN' } });
    expect(optIns).toHaveLength(3);
    const noticeHash = createHash('sha256').update(PRESENTATION_OPT_IN_NOTICE, 'utf8').digest('hex');
    for (const c of optIns) {
      expect(c).toMatchObject({ channel: 'WHATSAPP', purpose: 'MARKETING', source: 'MANUAL_EVIDENCE', noticeTextHash: noticeHash, withdrawnAt: null, recordedBy: seedId('user', 'employee') });
      expect(OPT_IN_METHODS).toContain((c.evidence as { method: string }).method);
      expect((c.evidence as { note: string }).note.length).toBeGreaterThan(10);
      const lead = await db.lead.findUniqueOrThrow({ where: { id: c.leadId } });
      expect(c.contactKey).toBe(contactKey(PEPPER, 'phone', lead.phoneE164!));
      expect(lead.contactConfirmedVia).toBe('RECORDED_OPT_IN');
      expect(c.collectedAt.getTime()).toBeLessThanOrEqual(c.recordedAt.getTime());
    }
    expect(optIns.map((c) => c.leadId).sort()).toEqual([STORY_LEADS.autoChat, STORY_LEADS.escalated, STORY_LEADS.optInOnly].map(leadIdOf).sort());
    for (const l of await db.lead.findMany({ where: { workspaceId: WS, contactConfirmedVia: { not: null } } })) {
      expect(CONTACT_CONFIRMED_VIA).toContain(l.contactConfirmedVia);
    }
  });

  it('lets the operator send an approved template to the opted-in leads only (eligibility)', async () => {
    const ctx = ctxAt(T0);
    const intro = await db.whatsAppTemplate.findFirstOrThrow({ where: { workspaceId: WS, name: 'website_intro' } });
    const optedIn = new Set([STORY_LEADS.autoChat, STORY_LEADS.escalated, STORY_LEADS.optInOnly].map(leadIdOf));
    for (const lead of await db.lead.findMany({ where: { workspaceId: WS, phoneE164: { not: null }, handedOverAt: null } })) {
      const r = await checkDispatchEligibility(ctx.db, ctx, { leadId: lead.id, channel: 'WHATSAPP', kind: 'WA_TEMPLATE', sendIntent: 'MANUAL_SINGLE', templateId: intro.id }, { contactKeyPepper: PEPPER });
      if (optedIn.has(lead.id)) expect(r, lead.displayName).toMatchObject({ eligible: true, reasons: [] });
      else expect(r.reasons, lead.displayName).toEqual(['NO_WHATSAPP_OPT_IN']);
    }
  });

  it('has two open-window chats: one answered by automatic replies, one waiting for a person', async () => {
    const conversations = await db.conversation.findMany({ where: { workspaceId: WS }, include: { messages: { orderBy: { createdAt: 'asc' } }, lead: true } });
    const open = conversations.filter((c) => c.lead.handedOverAt === null && isWindowOpen(c.lastInboundProviderAt, T0));
    expect(open).toHaveLength(2);

    const auto = conversations.find((c) => c.leadId === leadIdOf(STORY_LEADS.autoChat))!;
    expect(auto).toMatchObject({ channel: 'WHATSAPP', aiMode: 'AUTO', humanTakeover: false, escalatedAt: null, closedAt: null });
    const aiReplies = auto.messages.filter((m) => m.direction === 'OUT' && m.generatorLabel === 'local-deterministic');
    expect(aiReplies.length).toBeGreaterThanOrEqual(1);
    expect(aiReplies[0]!.body!.startsWith(AUTOMATED_DISCLOSURE)).toBe(true);
    for (const m of aiReplies) expect(m).toMatchObject({ sendIntent: 'AUTOMATED', initiatedBy: 'system:reply.auto', simulated: true, modeVersionAtCreate: auto.modeVersion });
    for (const m of aiReplies) expect(m.replyToInboundId).not.toBeNull();
    const lastIn = [...auto.messages].reverse().find((m) => m.direction === 'IN')!;
    expect(auto.lastInboundMessageId).toBe(lastIn.id);
    expect(auto.lastInboundProviderAt!.getTime()).toBe(lastIn.providerTs!.getTime());

    const escalated = conversations.find((c) => c.leadId === leadIdOf(STORY_LEADS.escalated))!;
    expect(escalated).toMatchObject({ aiMode: 'AUTO', humanTakeover: false, closedAt: null });
    expect(escalated.escalatedAt).not.toBeNull();
    expect(escalated.escalatedAt!.getTime()).toBeLessThan(T0.getTime());
    expect(escalated.messages.at(-2)!.body).toMatch(/how much/i);

    // Every chat started with an approved template or with the customer's own message.
    for (const c of conversations) {
      const first = c.messages[0]!;
      if (first.direction === 'OUT') {
        expect(first.kind).toBe('TEMPLATE');
        const t = await db.whatsAppTemplate.findUniqueOrThrow({ where: { id: first.templateId! } });
        expect(t.status).toBe('APPROVED');
        expect(Object.keys(first.variables as Record<string, string>).sort()).toEqual(templateShape(t.components).bodyVariables);
      }
      expect(c.contactKey).toBe(contactKey(PEPPER, 'phone', c.lead.phoneE164!));
      for (const m of c.messages) {
        expect(m.simulated).toBe(true);
        expect(m.providerMessageId).toBeTruthy();
        if (m.direction === 'IN') expect(m.status).toBe('DELIVERED');
      }
    }
    // Each inbound message recorded its service-window consent, as the inbound path does.
    const inbound = conversations.flatMap((c) => c.messages.filter((m) => m.direction === 'IN'));
    expect(await db.consentRecord.count({ where: { workspaceId: WS, basis: 'INBOUND_MESSAGE', source: 'INBOUND_MESSAGE' } })).toBe(inbound.length);
  });

  it('hands one lead over to the client with a ready local summary; the AI stopped on its thread', async () => {
    const leadId = leadIdOf(HANDOFF_FIXTURE.place);
    const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(lead.salesStage).toBe('CONVERTED');
    expect(lead.handedOverAt!.getTime()).toBe(T0.getTime() - 3 * HOUR);
    const handoff = await db.leadHandoff.findUniqueOrThrow({ where: { workspaceId_leadId: { workspaceId: WS, leadId } } });
    expect(handoff).toMatchObject({ status: 'HANDED_OVER', summaryStatus: 'READY', summaryGeneratorLabel: 'local-deterministic', fromUserId: seedId('user', 'employee'), acknowledgedBy: null, acknowledgedAt: null });
    expect(HANDOFF_SUMMARY_STATUSES).toContain(handoff.summaryStatus);
    expect(handoff.createdAt.getTime()).toBe(lead.handedOverAt!.getTime());
    expect(handoff.summary).toContain(lead.displayName);
    expect(handoff.note).toBeTruthy();
    const thread = await db.conversation.findFirstOrThrow({ where: { leadId } });
    expect(thread).toMatchObject({ aiMode: 'OFF', humanTakeover: true });
    expect(isWindowOpen(thread.lastInboundProviderAt, T0)).toBe(true);
    // No messages after the handoff from the operator.
    const after = await db.message.findMany({ where: { conversationId: thread.id, createdAt: { gt: lead.handedOverAt! } } });
    expect(after).toHaveLength(0);
    expect(await db.leadHandoff.count({ where: { workspaceId: WS } })).toBe(1);
    const audit = await db.auditEvent.findFirstOrThrow({ where: { action: 'lead.handoff', targetId: leadId } });
    expect(JSON.stringify(audit.summary)).not.toContain(lead.displayName);
  });
});

describe('determinism, refresh and isolation', () => {
  it('stores no timestamps inside JSON columns of the presentation rows', async () => {
    const tables = await db.$queryRawUnsafe<Array<{ name: string }>>(`SELECT "name" FROM "sqlite_master" WHERE "type" = 'table' AND "name" NOT LIKE 'sqlite_%' AND "name" NOT LIKE '_prisma%'`);
    let checked = 0;
    for (const { name } of tables) {
      const columns = await db.$queryRawUnsafe<Array<{ name: string }>>(`PRAGMA table_info("${name}")`);
      if (!columns.some((c) => c.name === 'workspaceId')) continue;
      const rows = await db.$queryRawUnsafe<Array<Record<string, unknown>>>(`SELECT * FROM "${name}" WHERE "workspaceId" = ?`, WS);
      for (const row of rows) {
        for (const [column, value] of Object.entries(row)) {
          // The driver returns JSON columns parsed (objects and arrays); DateTime columns are Dates.
          if (value === null || typeof value !== 'object' || value instanceof Date || value instanceof Uint8Array) continue;
          checked += 1;
          expect(JSON.stringify(value), `${name}.${column}`).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
        }
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('keeps the chats open and the handoff 3 hours old after demo:refresh', async () => {
    const fresh = await createTestDb({ label: 'seed-presentation-refresh' });
    try {
      const client = fresh.client();
      await seedDemo(client, { config: CONFIG, now: T0 });
      const T1 = new Date(T0.getTime() + 3 * DAY + 5 * HOUR);
      await refreshDemo(client, { config: CONFIG, now: T1 });
      const open = await client.conversation.findMany({ where: { workspaceId: WS } });
      expect(open.filter((c) => isWindowOpen(c.lastInboundProviderAt, T1))).toHaveLength(3);
      const lead = await client.lead.findUniqueOrThrow({ where: { id: leadIdOf(HANDOFF_FIXTURE.place) } });
      expect(lead.handedOverAt!.getTime()).toBe(T1.getTime() - 3 * HOUR);
      const results = await client.leadFinderResult.findMany({ where: { workspaceId: WS } });
      for (const r of results) expect(r.contentExpiresAt!.getTime()).toBeGreaterThan(T1.getTime());
    } finally {
      await fresh.destroy();
    }
  }, 120_000);

  it('leaves the other five workspaces without integrations, templates, chats or finder rows (ADR-81)', async () => {
    const others = WORKSPACE_FIXTURES.filter((w) => w.slug !== PRESENTATION_SLUG).map((w) => seedId('workspace', w.slug));
    expect(others).toHaveLength(5);
    const where = { workspaceId: { in: others } };
    expect(await db.integration.count({ where })).toBe(0);
    expect(await db.whatsAppTemplate.count({ where })).toBe(0);
    expect(await db.conversation.count({ where })).toBe(0);
    expect(await db.consentRecord.count({ where })).toBe(0);
    expect(await db.leadFinderRun.count({ where })).toBe(0);
    expect(await db.leadHandoff.count({ where })).toBe(0);
  });
});
