/**
 * The lead-gen suite's shared constants (lead-gen plan §4 B3, ADR-118 .. ADR-126): one spelling
 * of every job type, AI task, status string and route-manifest owner the six slices share.
 */
import { describe, expect, it } from 'vitest';
import {
  CONTACT_CONFIRMED_VIA,
  CONTACT_CONFIRMED_VIA_LABELS,
  FINDER_EMAIL_KINDS,
  FINDER_EMAIL_STATUS_LABELS,
  FINDER_EMAIL_STATUSES,
  HANDOFF_SUMMARY_STATUS_LABELS,
  HANDOFF_SUMMARY_STATUSES,
  isLocalTemplateStatus,
  LEAD_GEN_AI_TASKS,
  LEAD_GEN_JOB_OWNERS,
  LEAD_GEN_JOB_TYPES,
  LEAD_GEN_MANIFEST_OWNERS,
  LEAD_GEN_SLICE_NAMES,
  LEAD_GEN_SLICES,
  leadGenAnchor,
  LOCAL_TEMPLATE_STATUSES,
  TEMPLATE_DRAFT_STATUS,
  TEMPLATE_SUBMITTING_STATUS,
} from '@/lib/domain/lead-gen';
import { buildJobRegistry, JobRegistry } from '@/server/jobs/registry';

const noop = async () => ({ outcome: 'succeeded' as const });

describe('slices and route-manifest owners', () => {
  it('name the six slices F1..F6 and their manifest owners T40..T45 (plan §5)', () => {
    expect([...LEAD_GEN_SLICES]).toEqual(['F1', 'F2', 'F3', 'F4', 'F5', 'F6']);
    expect(LEAD_GEN_MANIFEST_OWNERS).toEqual({ F1: 'T40', F2: 'T41', F3: 'T42', F4: 'T43', F5: 'T44', F6: 'T45' });
    for (const owner of Object.values(LEAD_GEN_MANIFEST_OWNERS)) expect(owner).toMatch(/^T\d{2}$/);
    expect(LEAD_GEN_SLICE_NAMES).toEqual({ F1: 'finder', F2: 'import', F3: 'chat', F4: 'templates', F5: 'handoff', F6: 'presentation' });
  });

  it('spell the anchor comments the shared files carry', () => {
    expect(leadGenAnchor('F1')).toEqual({ begin: '---- lead-gen F1 finder ----', end: '---- end F1 ----' });
    expect(leadGenAnchor('F6')).toEqual({ begin: '---- lead-gen F6 presentation ----', end: '---- end F6 ----' });
  });
});

describe('job types', () => {
  it('are exactly the ten the plan lists', () => {
    expect(Object.values(LEAD_GEN_JOB_TYPES).sort()).toEqual(
      [
        'leadFinder.search',
        'leadFinder.emails',
        'leadFinder.purge',
        'leads.placesExpire',
        'leads.import',
        'leads.importPurge',
        'wa.templateSubmit',
        'wa.templateReview',
        'wa.demoStatus',
        'handoff.summary',
      ].sort(),
    );
  });

  it('each has one owning slice', () => {
    expect(Object.keys(LEAD_GEN_JOB_OWNERS).sort()).toEqual(Object.values(LEAD_GEN_JOB_TYPES).sort());
    expect(LEAD_GEN_JOB_OWNERS).toMatchObject({
      'leadFinder.search': 'F1',
      'leadFinder.emails': 'F1',
      'leadFinder.purge': 'F1',
      'leads.placesExpire': 'F1',
      'leads.import': 'F2',
      'leads.importPurge': 'F2',
      'wa.demoStatus': 'F3',
      'wa.templateSubmit': 'F4',
      'wa.templateReview': 'F4',
      'handoff.summary': 'F5',
    });
  });

  it('are valid registry names', () => {
    const fresh = new JobRegistry();
    for (const type of Object.values(LEAD_GEN_JOB_TYPES)) expect(() => fresh.register({ type, kind: 'default', payloadVersions: [1], handler: noop }), type).not.toThrow();
    expect(fresh.types()).toHaveLength(10);
  });

  it('collide with no job type registered before the suite', () => {
    // The production registry at Foundation-A (61b4352); every one of these is still registered.
    const preSuite = [
      'ai.draft', 'bulk.run', 'campaign.action', 'campaign.metricsSync', 'campaign.readback', 'dispatch.email', 'dispatch.whatsapp',
      'ingest.process', 'integration.health', 'lead.enrich', 'lead.rescore', 'lead.score', 'leads.export', 'leads.exportPurge',
      'meta.lead.backfill', 'meta.lead.fetch', 'pipeline.advance', 'quote.expireSweep', 'quote.renderPdf', 'reply.auto', 'sheets.sync',
      'status.apply', 'suppression.journalReconcile', 'wa.qualityCheck', 'wa.templateSync', 'webhook.process', 'webhook.purge',
    ];
    const production = buildJobRegistry();
    for (const type of preSuite) expect(production.get(type), type).toBeDefined();
    for (const type of Object.values(LEAD_GEN_JOB_TYPES)) expect(preSuite, type).not.toContain(type);
  });
});

describe('AI tasks', () => {
  it('are the three snake_case task names of ADR-122, ADR-123 and ADR-124', () => {
    expect(LEAD_GEN_AI_TASKS).toEqual({ conversationReply: 'conversation_reply', templateCopy: 'template_copy', handoffSummary: 'handoff_summary' });
    for (const task of Object.values(LEAD_GEN_AI_TASKS)) expect(task).toMatch(/^[a-z]+(_[a-z]+)+$/);
  });
});

describe('status strings', () => {
  it('handoff summary: READY, PENDING, NOT_CONFIGURED, FAILED with a label each', () => {
    expect([...HANDOFF_SUMMARY_STATUSES]).toEqual(['READY', 'PENDING', 'NOT_CONFIGURED', 'FAILED']);
    expect(Object.keys(HANDOFF_SUMMARY_STATUS_LABELS).sort()).toEqual([...HANDOFF_SUMMARY_STATUSES].sort());
  });

  it('finder email extraction: every status has a distinct label; addresses carry one of three kinds', () => {
    expect([...FINDER_EMAIL_STATUSES]).toEqual(['NOT_REQUESTED', 'PENDING', 'FOUND', 'NONE_FOUND', 'NO_WEBSITE', 'BLOCKED', 'FAILED']);
    expect(Object.keys(FINDER_EMAIL_STATUS_LABELS).sort()).toEqual([...FINDER_EMAIL_STATUSES].sort());
    const labels = Object.values(FINDER_EMAIL_STATUS_LABELS);
    expect(new Set(labels).size).toBe(labels.length);
    expect([...FINDER_EMAIL_KINDS]).toEqual(['ROLE', 'PERSONAL', 'FREEMAIL']);
  });

  it('contact confirmation: the four first-party routes of ADR-118 (d), each labelled', () => {
    expect([...CONTACT_CONFIRMED_VIA]).toEqual(['INBOUND_WHATSAPP', 'RECORDED_OPT_IN', 'WEBSITE_EMAIL', 'OPERATOR']);
    expect(Object.keys(CONTACT_CONFIRMED_VIA_LABELS).sort()).toEqual([...CONTACT_CONFIRMED_VIA].sort());
  });

  it('template studio: DRAFT and SUBMITTING are local statuses, never a provider status a send accepts', () => {
    expect([TEMPLATE_DRAFT_STATUS, TEMPLATE_SUBMITTING_STATUS]).toEqual(['DRAFT', 'SUBMITTING']);
    expect([...LOCAL_TEMPLATE_STATUSES]).toEqual(['DRAFT', 'SUBMITTING']);
    for (const status of ['DRAFT', ' draft ', 'Submitting', 'SUBMITTING']) expect(isLocalTemplateStatus(status), status).toBe(true);
    for (const status of ['APPROVED', 'PENDING', 'REJECTED', 'PAUSED', 'DISABLED', '', null, undefined]) expect(isLocalTemplateStatus(status), String(status)).toBe(false);
  });
});
