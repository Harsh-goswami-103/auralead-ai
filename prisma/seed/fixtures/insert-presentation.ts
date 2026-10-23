/**
 * Writes the DEMO presentation pack (ADR-126; data in presentation.ts) into the seed
 * transaction, after the workspaces, people and price lists exist. Rows are written directly with
 * deterministic `seedId` ids, shaped exactly as the services write them, and built with the same
 * pure functions the services use (`normalizeLeadFields`, `contactKeysFor`, `scoreLead`,
 * `templateShape`, `resolveLeadTemplateVariables`, `contactKey`), so a seeded lead, consent or
 * chat behaves like one the app created:
 *
 * - SIMULATED WhatsApp integration (no routing key; display number for click-to-chat) and the
 *   authored templates (approved, pending, rejected with a reason).
 * - The finished, simulated finder run and its 40 results; 12 imported through one GOOGLE_PLACES
 *   import batch as leads with contact keys, an accepted source record, the workspace's pinned
 *   pipeline version and a score from its own scoring version.
 * - Recorded opt-ins (notice hash + method, ADR-125), chats with their inbound service-window
 *   consents, the handoff (ADR-124) and PII-free audit rows for the opt-ins and the handoff.
 *
 * Contact keys are HMACs with the configured SUPPRESSION_PEPPER (`deps.contactKeyPepper`), so the
 * eligibility check finds the seeded consents. Every time is relative to the anchor `now`, and
 * every column written here is in REBASE_COLUMNS.
 */
import { createHash } from 'node:crypto';
import type { Prisma } from '../../../src/generated/prisma/client';
import { demoMobile } from '../../../src/lib/demo/contacts';
import { resolveLeadTemplateVariables, templateShape, variableSchemaOf, type TemplateMapping } from '../../../src/lib/domain/whatsapp-templates';
import { redact } from '../../../src/lib/redact';
import { parseScoringConfig } from '../../../src/lib/schemas/scoring';
import { contactKey } from '../../../src/server/security/contact-key';
import { contactKeysFor } from '../../../src/server/services/leads/dedupe';
import { normalizeLeadFields } from '../../../src/server/services/leads/normalize';
import { scoreLead } from '../../../src/server/services/scoring/score';
import { seedId } from '../ids';
import {
  CONVERSATION_FIXTURES,
  FINDER_PRESENTATION_CONTENT_DAYS,
  FINDER_RUN_FIXTURE,
  HANDOFF_FIXTURE,
  OPT_IN_FIXTURES,
  PLACES_LEAD_TTL_DAYS,
  PRESENTATION_BUSINESS,
  PRESENTATION_OPERATOR,
  PRESENTATION_OPT_IN_NOTICE,
  PRESENTATION_SLUG,
  REPLY_INITIATOR,
  TEMPLATE_FIXTURES,
  presentationPlaces,
  type ConversationFixture,
  type MessageFixture,
  type PresentationPlace,
} from './presentation';
import { WORKSPACE_FIXTURES } from './workspaces';

type Tx = Prisma.TransactionClient;

export type PresentationDeps = { contactKeyPepper: string };

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const STATUS_RANK = { DELIVERED: 2, READ: 3 } as const;

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const json = (value: unknown) => value as Prisma.InputJsonValue;

function fixtureError(message: string): Error {
  return new Error(`presentation fixture error: ${message}`);
}

export async function insertPresentation(tx: Tx, now: Date, deps: PresentationDeps): Promise<void> {
  const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * MINUTE);
  const plus = (time: Date, ms: number) => new Date(time.getTime() + ms);
  const ws = WORKSPACE_FIXTURES.find((w) => w.slug === PRESENTATION_SLUG);
  if (!ws) throw fixtureError(`workspace ${PRESENTATION_SLUG} is not in WORKSPACE_FIXTURES`);
  const wsId = seedId('workspace', ws.slug);
  const operatorId = seedId('user', PRESENTATION_OPERATOR);
  const key = (kind: string, k: string) => seedId(kind, `${PRESENTATION_SLUG}:${k}`);
  const keyFor = (phoneE164: string) => contactKey(deps.contactKeyPepper, 'phone', phoneE164);

  // ---- WhatsApp integration and authored templates (ADR-123) -------------------------------------
  const integrationId = key('integration', 'WHATSAPP_CLOUD');
  await tx.integration.create({
    data: {
      id: integrationId,
      workspaceId: wsId,
      kind: 'WHATSAPP_CLOUD',
      status: 'SIMULATED',
      config: { phoneNumberId: `demo-${wsId}`, displayPhoneNumber: demoMobile(`${PRESENTATION_SLUG}:display`).replace(/\s/g, '') },
    },
  });
  const templateIds = new Map<string, string>();
  const templateMappings = new Map<string, TemplateMapping>();
  for (const t of TEMPLATE_FIXTURES) {
    const shape = templateShape(t.components);
    if (!shape.sendable.ok) throw fixtureError(`template ${t.name} is not sendable (${shape.sendable.reason})`);
    const quickReplies = new Set(shape.quickReplies.map((q) => String(q.index)));
    if (!Object.keys(t.buttons).every((i) => quickReplies.has(i))) throw fixtureError(`template ${t.name} maps a button that is not a quick reply`);
    if ([...shape.bodyVariables].sort().join() !== Object.keys(t.variables).sort().join()) throw fixtureError(`template ${t.name} variables do not match its body`);
    const mapping: TemplateMapping = { body: { ...t.variables }, buttons: { ...t.buttons } };
    const id = key('whatsapp-template', t.name);
    const submittedAt = at(t.submittedMinutesAgo);
    await tx.whatsAppTemplate.create({
      data: {
        id,
        workspaceId: wsId,
        integrationId,
        name: t.name,
        language: 'en',
        category: t.category,
        status: t.status,
        components: json(t.components),
        variableSchema: json(variableSchemaOf(shape, mapping)),
        intent: t.intent,
        variableMap: json(mapping),
        categoryHistory: [],
        syncedAt: t.reviewedAfterSeconds === null ? null : plus(submittedAt, t.reviewedAfterSeconds * 1000),
        origin: 'AUTHORED',
        providerTemplateId: null,
        rejectedReason: t.rejectedReason,
        submittedBy: operatorId,
        submittedAt,
        headerMediaId: null,
        copyGeneratorLabel: t.copyGeneratorLabel,
        utilityTrigger: t.utilityTrigger,
      },
    });
    templateIds.set(t.name, id);
    templateMappings.set(t.name, mapping);
  }

  // ---- The finished, simulated finder run (ADR-118) ------------------------------------------------
  const run = FINDER_RUN_FIXTURE;
  const places = presentationPlaces();
  const runId = seedId('finder-run', run.key);
  const startedAt = at(run.startedMinutesAgo);
  const cellDoneAt = (cellIndex: number) => plus(startedAt, (cellIndex + 1) * run.cellSeconds * 1000);
  const importedAt = at(run.importedMinutesAgo);
  await tx.leadFinderRun.create({
    data: {
      id: runId,
      workspaceId: wsId,
      requestKey: run.requestKey,
      requestedBy: operatorId,
      keywords: [...run.keywords],
      locations: [...run.locations],
      maxPerQuery: run.maxPerQuery,
      extractEmails: false,
      emailBlacklist: [],
      status: 'SUCCEEDED',
      cellsTotal: run.cells.length,
      cellsDone: run.cells.length,
      resultsFound: places.length,
      emailsFound: 0,
      simulated: true,
      errorCode: null,
      createdAt: startedAt,
      startedAt,
      finishedAt: cellDoneAt(run.cells.length - 1),
      cancelledAt: null,
    },
  });
  const leadIdOf = (place: PresentationPlace) => seedId('lead', `${PRESENTATION_SLUG}:${place.key}`);
  for (const place of places) {
    const fetchedAt = cellDoneAt(place.cellIndex);
    await tx.leadFinderResult.create({
      data: {
        id: seedId('finder-result', `${run.key}:${place.key}`),
        workspaceId: wsId,
        runId,
        placeId: place.placeId,
        keyword: place.keyword,
        location: place.location,
        name: place.name,
        category: place.category,
        phoneRaw: place.phone,
        hasPhone: place.phone !== null,
        website: place.website,
        websiteListed: place.websiteListed,
        ratingX10: place.ratingX10,
        reviewCount: place.reviewCount,
        address: place.address,
        city: place.city,
        state: place.state,
        pincode: place.pincode,
        // Simulated places are not Google content: no attribution (ADR-118 (b)).
        attributions: undefined,
        emails: [],
        emailCount: 0,
        emailStatus: 'NOT_REQUESTED',
        simulated: true,
        // A year, not 24 hours: the pack must survive until the presentation (ADR-134).
        contentExpiresAt: plus(fetchedAt, FINDER_PRESENTATION_CONTENT_DAYS * DAY),
        contentPurgedAt: null,
        importedLeadId: place.imported ? leadIdOf(place) : null,
        importedAt: place.imported ? importedAt : null,
        createdAt: fetchedAt,
      },
    });
  }

  // ---- Imported GOOGLE_PLACES leads ------------------------------------------------------------------
  const imported = places.filter((p) => p.imported);
  const records = imported.map((place) => ({
    externalId: place.placeId,
    providerId: place.placeId,
    fields: {
      name: place.name,
      phone: place.phone,
      website: place.website,
      websiteListed: place.websiteListed,
      address: place.address,
      city: place.city,
      category: place.category,
      rating: place.ratingX10 / 10,
      reviewCount: place.reviewCount,
      pincode: place.pincode,
    },
    attribution: { keyword: place.keyword, location: place.location },
  }));
  const batchId = key('import-batch', `${run.key}:import-1`);
  await tx.importBatch.create({
    data: {
      id: batchId,
      workspaceId: wsId,
      source: 'GOOGLE_PLACES',
      externalBatchId: `finder:${runId}:import-1`,
      bodyHash: sha256(JSON.stringify(records)),
      status: 'COMPLETED',
      counts: { received: records.length, accepted: records.length, duplicate: 0, review: 0, rejected: 0 },
      simulated: true,
      createdAt: importedAt,
      completedAt: importedAt,
    },
  });

  const scoringRow = await tx.scoringConfigVersion.findFirst({ where: { workspaceId: wsId, active: true }, select: { id: true, version: true, weights: true } });
  const pipelineRow = await tx.pipelineConfigVersion.findFirst({ where: { workspaceId: wsId, active: true }, select: { id: true } });
  if (!scoringRow || !pipelineRow) throw fixtureError('codecraft-web has no active scoring or pipeline version');
  const scoring = { id: scoringRow.id, version: scoringRow.version, config: parseScoringConfig(scoringRow.weights) };

  const conversationByPlace = new Map(CONVERSATION_FIXTURES.map((c) => [c.place, c]));
  const optInByPlace = new Map(OPT_IN_FIXTURES.map((o) => [o.place, o]));
  const phoneOf = new Map<string, string>();

  for (const [i, place] of imported.entries()) {
    const record = records[i]!;
    const normalized = normalizeLeadFields(record.fields);
    if (!normalized.ok) throw fixtureError(`place ${place.key} does not normalize (${normalized.reasonCode})`);
    const lead = normalized.lead;
    if (lead.phoneE164 === null) throw fixtureError(`imported place ${place.key} has no phone`);
    phoneOf.set(place.key, lead.phoneE164);
    const id = leadIdOf(place);
    const optIn = optInByPlace.get(place.key);
    const conversation = conversationByPlace.get(place.key);
    const handedOver = HANDOFF_FIXTURE.place === place.key;

    // Stage history as the app moves it: a first outbound send contacts, an inbound reply, a handoff converts.
    let salesStage: 'NEW' | 'CONTACTED' | 'REPLIED' | 'CONVERTED' = 'NEW';
    let stageVersion = 0;
    const firstMessage = conversation?.messages[0];
    if (firstMessage?.direction === 'OUT') {
      salesStage = 'CONTACTED';
      stageVersion += 1;
    }
    if (conversation?.messages.some((m) => m.direction === 'IN')) {
      salesStage = 'REPLIED';
      stageVersion += 1;
    }
    if (handedOver) {
      salesStage = 'CONVERTED';
      stageVersion += 1;
    }

    const optInRecordedAt = optIn ? plus(at(optIn.collectedMinutesAgo), 2 * MINUTE) : null;
    const firstInbound = conversation?.messages.find((m) => m.direction === 'IN');
    const confirmed = optInRecordedAt
      ? { contactConfirmedAt: optInRecordedAt, contactConfirmedVia: 'RECORDED_OPT_IN' }
      : firstInbound
        ? { contactConfirmedAt: at(firstInbound.minutesAgo), contactConfirmedVia: 'INBOUND_WHATSAPP' }
        : { contactConfirmedAt: null, contactConfirmedVia: null };
    const activity = [importedAt, optInRecordedAt, ...(conversation?.messages ?? []).map((m) => at(m.minutesAgo)), handedOver ? at(HANDOFF_FIXTURE.minutesAgo) : null];
    const updatedAt = new Date(Math.max(...activity.filter((d): d is Date => d !== null).map((d) => d.getTime())));

    const score = scoreLead({ ...lead, firstSource: 'GOOGLE_PLACES' }, scoring);
    await tx.lead.create({
      data: {
        id,
        workspaceId: wsId,
        displayName: lead.displayName,
        nameNormalized: lead.nameNormalized,
        category: lead.category,
        phoneE164: lead.phoneE164,
        phoneRaw: lead.phoneRaw,
        alternatePhones: lead.alternatePhones,
        emailNormalized: lead.emailNormalized,
        website: lead.website,
        websiteStatus: lead.websiteStatus,
        address: lead.address,
        city: lead.city,
        pincode: lead.pincode,
        rating: lead.rating,
        reviewCount: lead.reviewCount,
        salesStage,
        stageVersion,
        score: score.score,
        scoreReasons: json(score.reasons),
        unknownInputs: json(score.unknownInputs),
        scoreConfigVersionId: score.configVersionId,
        pipelineConfigVersionId: pipelineRow.id,
        firstSource: 'GOOGLE_PLACES',
        simulated: true,
        placeId: place.placeId,
        placesContentExpiresAt: plus(importedAt, PLACES_LEAD_TTL_DAYS * DAY),
        ...confirmed,
        handedOverAt: handedOver ? at(HANDOFF_FIXTURE.minutesAgo) : null,
        createdAt: importedAt,
        updatedAt,
      },
    });
    const keys = contactKeysFor(lead, 'GOOGLE_PLACES', place.placeId);
    await tx.leadContactKey.createMany({
      data: keys.map((k) => ({ id: key('lead-contact-key', `${place.key}:${k.kind}:${k.value}`), workspaceId: wsId, leadId: id, kind: k.kind, value: k.value })),
    });
    await tx.leadSourceRecord.create({
      data: {
        id: key('lead-source-record', place.key),
        workspaceId: wsId,
        leadId: id,
        importBatchId: batchId,
        source: 'GOOGLE_PLACES',
        externalId: record.externalId,
        status: 'ACCEPTED',
        reasonCode: null,
        rawPayloadRedacted: json(redact({ providerId: record.providerId, fields: record.fields, answers: {} })),
        mappingVersion: null,
        attribution: record.attribution,
        extractedAt: cellDoneAt(place.cellIndex),
        receivedAt: importedAt,
      },
    });
  }

  const placeByKey = new Map(places.map((p) => [p.key, p]));
  const placeOf = (k: string) => {
    const place = placeByKey.get(k);
    if (!place || !place.imported) throw fixtureError(`${k} is not an imported place`);
    return place;
  };

  // ---- Recorded WhatsApp opt-ins (ADR-125) ---------------------------------------------------------
  const noticeTextHash = sha256(PRESENTATION_OPT_IN_NOTICE);
  for (const o of OPT_IN_FIXTURES) {
    const place = placeOf(o.place);
    const leadId = leadIdOf(place);
    const consentId = key('consent', `${o.place}:opt-in`);
    const collectedAt = at(o.collectedMinutesAgo);
    const recordedAt = plus(collectedAt, 2 * MINUTE);
    await tx.consentRecord.create({
      data: {
        id: consentId,
        workspaceId: wsId,
        leadId,
        contactKey: keyFor(phoneOf.get(o.place)!),
        channel: 'WHATSAPP',
        purpose: 'MARKETING',
        basis: 'OPT_IN',
        source: 'MANUAL_EVIDENCE',
        // As grantManualConsent stores it (slice F5): the method, the note and the notice verbatim, with its hash.
        evidence: { note: o.note, method: o.method, noticeText: PRESENTATION_OPT_IN_NOTICE },
        noticeTextHash,
        noticeVersion: null,
        collectedAt,
        recordedAt,
        recordedBy: operatorId,
      },
    });
    await tx.auditEvent.create({
      data: {
        id: seedId('audit', `consent.grant:${PRESENTATION_SLUG}:${o.place}`),
        workspaceId: wsId,
        actorUserId: operatorId,
        actorKind: 'EMPLOYEE',
        action: 'consent.grant',
        targetType: 'ConsentRecord',
        targetId: consentId,
        result: 'SUCCESS',
        summary: { leadId, channel: 'WHATSAPP', purpose: 'MARKETING', basis: 'OPT_IN', source: 'MANUAL_EVIDENCE', method: o.method, fields: ['evidence.note', 'evidence.method', 'noticeText'] },
        crossWorkspace: false,
        correlationId: 'seed',
        simulated: true,
        createdAt: recordedAt,
      },
    });
  }

  // ---- Chats (ADR-121, ADR-122) ------------------------------------------------------------------------
  const workspaceFacts = { name: PRESENTATION_BUSINESS };
  const insertConversation = async (tx2: Tx, c: ConversationFixture): Promise<void> => {
    const place = placeOf(c.place);
    const leadId = leadIdOf(place);
    const conversationId = key('conversation', c.key);
    const messageId = (m: Pick<MessageFixture, 'key'>) => key('message', `${c.key}:${m.key}`);
    const inbound = c.messages.filter((m) => m.direction === 'IN');
    const lastInbound = inbound.at(-1) ?? null;
    const lastInboundIndex = lastInbound ? c.messages.indexOf(lastInbound) : -1;
    const escalatedBy = c.escalatedBy ? c.messages.find((m) => m.key === c.escalatedBy) : undefined;
    if (c.escalatedBy && !escalatedBy) throw fixtureError(`conversation ${c.key} escalates on unknown message ${c.escalatedBy}`);
    await tx2.conversation.create({
      data: {
        id: conversationId,
        workspaceId: wsId,
        leadId,
        channel: 'WHATSAPP',
        contactKey: keyFor(phoneOf.get(c.place)!),
        aiMode: c.aiMode,
        humanTakeover: c.humanTakeover,
        modeVersion: c.modeVersion,
        lastInboundProviderAt: lastInbound ? at(lastInbound.minutesAgo) : null,
        lastInboundMessageId: lastInbound ? messageId(lastInbound) : null,
        unansweredOutboundCount: c.messages.slice(lastInboundIndex + 1).filter((m) => m.direction === 'OUT').length,
        emailThreadToken: null,
        closedAt: null,
        escalatedAt: escalatedBy ? at(escalatedBy.minutesAgo) : null,
        createdAt: at(c.messages[0]!.minutesAgo),
      },
    });
    for (const m of c.messages) {
      const createdAt = at(m.minutesAgo);
      const id = messageId(m);
      if (m.direction === 'IN') {
        await tx2.message.create({
          data: {
            id,
            workspaceId: wsId,
            conversationId,
            direction: 'IN',
            channel: 'WHATSAPP',
            kind: 'TEXT',
            body: m.body ?? null,
            status: 'DELIVERED',
            statusRank: STATUS_RANK.DELIVERED,
            providerMessageId: `wamid.demo.seed.${PRESENTATION_SLUG}.${c.key}.${m.key}`,
            providerTs: createdAt,
            simulated: true,
            createdAt,
          },
        });
        // The inbound path records a service-window consent for every inbound message (P13).
        await tx2.consentRecord.create({
          data: {
            id: key('consent', `${c.key}:${m.key}`),
            workspaceId: wsId,
            leadId,
            contactKey: keyFor(phoneOf.get(c.place)!),
            channel: 'WHATSAPP',
            purpose: 'SERVICE_CONVERSATION',
            basis: 'INBOUND_MESSAGE',
            source: 'INBOUND_MESSAGE',
            evidence: { messageId: id },
            collectedAt: createdAt,
            recordedAt: createdAt,
            recordedBy: null,
          },
        });
        continue;
      }
      const automated = m.sendIntent === 'AUTOMATED';
      let template: { id: string; variables: Record<string, string> } | null = null;
      if (m.template !== undefined) {
        const mapping = templateMappings.get(m.template);
        const fixture = TEMPLATE_FIXTURES.find((t) => t.name === m.template);
        if (!mapping || fixture?.status !== 'APPROVED') throw fixtureError(`message ${c.key}:${m.key} uses ${m.template}, which is not an approved seeded template`);
        const resolved = resolveLeadTemplateVariables(
          { positions: templateShape(fixture.components).bodyVariables, sources: mapping.body },
          { displayName: place.name, city: place.city, category: place.category },
          workspaceFacts,
        );
        if (!resolved.ok) throw fixtureError(`message ${c.key}:${m.key} leaves template variables empty`);
        template = { id: templateIds.get(m.template)!, variables: resolved.values };
      }
      await tx2.message.create({
        data: {
          id,
          workspaceId: wsId,
          conversationId,
          direction: 'OUT',
          channel: 'WHATSAPP',
          kind: template ? 'TEMPLATE' : 'TEXT',
          body: template ? null : (m.body ?? null),
          templateId: template?.id ?? null,
          variables: template ? template.variables : undefined,
          status: m.status,
          statusRank: STATUS_RANK[m.status],
          providerMessageId: `demo.wamid.seed.${PRESENTATION_SLUG}.${c.key}.${m.key}`,
          providerTs: plus(createdAt, MINUTE),
          generatorLabel: m.generatorLabel ?? 'human',
          simulated: true,
          replyToInboundId: m.replyTo ? messageId({ key: m.replyTo }) : null,
          modeVersionAtCreate: automated ? c.modeVersion : null,
          sendIntent: m.sendIntent ?? 'MANUAL_SINGLE',
          initiatedBy: automated ? REPLY_INITIATOR : operatorId,
          createdBy: automated ? null : operatorId,
          createdAt,
        },
      });
    }
  };
  for (const c of CONVERSATION_FIXTURES) await insertConversation(tx, c);

  // ---- The handoff to the client (ADR-124) -------------------------------------------------------------
  const handedOver = placeOf(HANDOFF_FIXTURE.place);
  const handedOverLeadId = leadIdOf(handedOver);
  const handedOverAt = at(HANDOFF_FIXTURE.minutesAgo);
  const handedOverConversationIds = CONVERSATION_FIXTURES.filter((c) => c.place === HANDOFF_FIXTURE.place).map((c) => key('conversation', c.key));
  const handedOverStageVersion = (await tx.lead.findUniqueOrThrow({ where: { id: handedOverLeadId }, select: { stageVersion: true } })).stageVersion;
  await tx.leadHandoff.create({
    data: {
      id: key('lead-handoff', HANDOFF_FIXTURE.place),
      workspaceId: wsId,
      leadId: handedOverLeadId,
      fromUserId: operatorId,
      note: HANDOFF_FIXTURE.note,
      summary: JSON.stringify(HANDOFF_FIXTURE.summary),
      summaryGeneratorLabel: HANDOFF_FIXTURE.summaryGeneratorLabel,
      summaryStatus: 'READY',
      status: 'HANDED_OVER',
      acknowledgedBy: null,
      acknowledgedAt: null,
      createdAt: handedOverAt,
    },
  });
  await tx.auditEvent.create({
    data: {
      id: seedId('audit', `lead.handoff:${PRESENTATION_SLUG}:${HANDOFF_FIXTURE.place}`),
      workspaceId: wsId,
      actorUserId: operatorId,
      actorKind: 'EMPLOYEE',
      action: 'lead.handoff',
      targetType: 'Lead',
      targetId: handedOverLeadId,
      result: 'SUCCESS',
      // The shape handOverLead audits (slice F5): ids, stages and counts, never the note.
      summary: {
        handoffId: key('lead-handoff', HANDOFF_FIXTURE.place),
        from: 'REPLIED',
        to: 'CONVERTED',
        stageVersion: handedOverStageVersion,
        conversationIds: handedOverConversationIds,
        conversations: handedOverConversationIds.length,
        invalidatedApprovals: 0,
        cancelledSends: 0,
        pipelineHalted: null,
        summaryStatus: 'PENDING',
        summaryJobId: null,
        hasNote: true,
        requestKey: HANDOFF_FIXTURE.requestKey,
      },
      crossWorkspace: false,
      correlationId: 'seed',
      simulated: true,
      createdAt: handedOverAt,
    },
  });
  await tx.auditEvent.create({
    data: {
      id: seedId('audit', `lead.handoff.summary:${PRESENTATION_SLUG}:${HANDOFF_FIXTURE.place}`),
      workspaceId: wsId,
      actorUserId: null,
      actorKind: 'WORKER',
      action: 'lead.handoff.summary',
      targetType: 'Lead',
      targetId: handedOverLeadId,
      result: 'SUCCESS',
      summary: {
        handoffId: key('lead-handoff', HANDOFF_FIXTURE.place),
        status: 'READY',
        generatorLabel: HANDOFF_FIXTURE.summaryGeneratorLabel,
        modelId: 'local-deterministic-v1',
        errorCode: null,
        violationRules: [],
        fields: ['summary'],
      },
      crossWorkspace: false,
      correlationId: 'seed',
      simulated: true,
      createdAt: plus(handedOverAt, 30_000),
    },
  });
}
