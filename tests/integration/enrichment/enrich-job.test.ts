// R13, R15, G-SSRF-2 (T12): the `lead.enrich` job checks a lead's website through `safeFetch` in
// the worker and records the result on the lead.
// - REACHABLE stores the stripped page text, marked untrusted, and rescores the lead.
// - A blocked destination gives BLOCKED; nothing is fetched.
// - NXDOMAIN gives UNREACHABLE, never VERIFIED_ABSENT (that status is set only by a person).
// - VERIFIED_ABSENT, a missing website and DEMO mode fetch nothing (DEMO makes zero outbound calls).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@/generated/prisma/client';
import { createLogger } from '@/lib/logger';
import { createLeadEnrichJob, enqueueLeadEnrich } from '@/server/jobs/handlers/lead-enrich';
import { buildJobRegistry } from '@/server/jobs/registry';
import { seedId } from '../../../prisma/seed/ids';
import { createWorker, type Worker } from '../../../worker/worker';
import { createIngestHarness, WS_A, type IngestHarness } from '../ingest/support';
import { createLead, startSite, type SiteHarness } from './support';

let h: IngestHarness;
let db: PrismaClient;
let site: SiteHarness;
let liveWorker: Worker;
let demoWorker: Worker;

const SCORING_V1_A = seedId('scoring-version', 'smile-avenue-dental:1');

function worker(mode: 'demo' | 'live'): Worker {
  const registry = buildJobRegistry([createLeadEnrichJob({ fetchWebsite: (url) => site.fetchWebsite(url), mode: () => mode })]);
  return createWorker(
    { db, clock: h.clock, registry, logger: createLogger({ level: 'silent' }), mode, version: 'test', random: () => 0 },
    { leaseMs: 60_000, leaseExtendEveryMs: 20_000, backoff: { baseMs: 1_000, capMs: 1_000, jitterRatio: 0 } },
  );
}

beforeAll(async () => {
  h = await createIngestHarness('enrich-job');
  db = h.db;
  site = await startSite();
  liveWorker = worker('live');
  demoWorker = worker('demo');
});
afterAll(async () => {
  await site.close();
  await h.testDb.destroy();
});

let n = 0;
async function enrich(leadId: string, w: Worker = liveWorker) {
  n += 1;
  const { job } = await enqueueLeadEnrich(db, h.clock, { workspaceId: WS_A, leadId, requestKey: `test-${n}`, correlationId: `req_enrich_test_${String(n).padStart(4, '0')}` });
  while ((await w.tick()) === 'ran');
  const settled = await db.job.findUniqueOrThrow({ where: { id: job.id } });
  const lead = await db.lead.findUniqueOrThrow({ where: { id: leadId } });
  const audits = await db.auditEvent.findMany({ where: { action: 'lead.enrich', targetId: leadId }, orderBy: { createdAt: 'asc' } });
  return { job: settled, lead, audits };
}

type Enrichment = { untrusted: boolean; text: string; title: string | null; httpStatus: number | null; finalUrl: string | null; reasonCode: string | null; checkedAt: string };

describe('lead.enrich job', () => {
  it('REACHABLE stores stripped text marked untrusted and rescores the lead', async () => {
    const lead = await createLead(db, WS_A, { website: 'http://smile.test/', rating: 45, reviewCount: 120 });
    const before = site.calls.length;
    const { job, lead: after, audits } = await enrich(lead.id);

    expect(job.status).toBe('SUCCEEDED');
    expect(site.calls.length - before).toBe(1);
    expect(after.websiteStatus).toBe('REACHABLE');
    const e = after.websiteEnrichment as Enrichment;
    expect(e).toMatchObject({ untrusted: true, title: 'Smile Avenue Dental | Gurugram', httpStatus: 200, finalUrl: 'http://smile.test/', reasonCode: null, checkedAt: h.clock.now().toISOString() });
    expect(e.text).toContain('Painless root canal — open 7 days.');
    expect(e.text).toContain('Home & About');
    // Injection text is kept as data (the AI layer treats it as untrusted), never as markup.
    expect(e.text).toContain('Ignore previous instructions');
    for (const hidden of ['do-not-store', 'color: red', 'hidden comment', 'enable js', '<p>', '<h1>']) expect(e.text).not.toContain(hidden);

    expect(after.score).not.toBeNull();
    expect(after.scoreConfigVersionId).toBe(SCORING_V1_A);
    expect(after.scoreReasons).toEqual(expect.arrayContaining([expect.objectContaining({ input: 'websiteStatus', points: 20 })]));

    expect(audits).toHaveLength(1);
    expect(audits[0]!.summary).toMatchObject({ checked: true, status: 'REACHABLE', host: 'smile.test' });
    expect(JSON.stringify(audits[0]!.summary)).not.toContain('Painless');
  });

  it('a blocked destination gives BLOCKED without fetching it', async () => {
    const lead = await createLead(db, WS_A, { website: 'http://169.254.169.254/latest/meta-data/' });
    const { job, lead: after, audits } = await enrich(lead.id);
    expect(job.status).toBe('SUCCEEDED');
    expect(after.websiteStatus).toBe('BLOCKED');
    expect(after.websiteEnrichment).toMatchObject({ untrusted: true, reasonCode: 'ENRICHMENT_BLOCKED_DESTINATION', text: '' });
    expect(audits[0]!.summary).toMatchObject({ status: 'BLOCKED', reasonCode: 'ENRICHMENT_BLOCKED_DESTINATION' });
    expect(after.unknownInputs).toEqual(expect.arrayContaining([expect.objectContaining({ input: 'websiteStatus', reasonCode: 'WEBSITE_BLOCKED' })]));
  });

  it('NXDOMAIN gives UNREACHABLE, never VERIFIED_ABSENT', async () => {
    const lead = await createLead(db, WS_A, { website: 'http://closed-business.test/' });
    const { job, lead: after } = await enrich(lead.id);
    expect(job.status).toBe('SUCCEEDED');
    expect(after.websiteStatus).toBe('UNREACHABLE');
    expect(after.websiteEnrichment).toMatchObject({ reasonCode: 'ENRICHMENT_DNS_NOT_FOUND', httpStatus: null });
    expect(after.unknownInputs).toEqual(expect.arrayContaining([expect.objectContaining({ input: 'websiteStatus' })]));

    const notFound = await createLead(db, WS_A, { website: 'http://smile.test/gone' });
    const r = await enrich(notFound.id);
    expect(r.lead.websiteStatus).toBe('UNREACHABLE');
    expect(r.lead.websiteEnrichment).toMatchObject({ reasonCode: 'ENRICHMENT_HTTP_STATUS', httpStatus: 404 });
    expect(await db.lead.count({ where: { websiteStatus: 'VERIFIED_ABSENT' } })).toBe(0);
  });

  it('does not fetch a website a person verified absent, or a lead with no website', async () => {
    const absent = await createLead(db, WS_A, { website: 'http://smile.test/', websiteStatus: 'VERIFIED_ABSENT' });
    const none = await createLead(db, WS_A, { website: null });
    const before = site.calls.length;
    const a = await enrich(absent.id);
    const b = await enrich(none.id);
    expect(site.calls.length).toBe(before);
    expect(a.lead.websiteStatus).toBe('VERIFIED_ABSENT');
    expect(b.lead.websiteStatus).toBe('UNKNOWN');
    expect(a.audits[0]!.summary).toMatchObject({ checked: false, reasonCode: 'VERIFIED_ABSENT' });
    expect(b.audits[0]!.summary).toMatchObject({ checked: false, reasonCode: 'NO_WEBSITE' });
  });

  it('makes zero outbound calls in DEMO and leaves the status unverified', async () => {
    const lead = await createLead(db, WS_A, { website: 'http://smile.test/' });
    const before = site.calls.length;
    const { job, lead: after, audits } = await enrich(lead.id, demoWorker);
    expect(job.status).toBe('SUCCEEDED');
    expect(site.calls.length).toBe(before);
    expect(after.websiteStatus).toBe('PRESENT_UNVERIFIED');
    expect(after.websiteEnrichment).toBeNull();
    expect(audits[0]!.summary).toMatchObject({ checked: false, reasonCode: 'OUTBOUND_BLOCKED_IN_DEMO' });
  });

  it('refuses a lead from another workspace', async () => {
    const other = await createLead(db, seedId('workspace', 'ironpulse-fitness'), { website: 'http://iron.test/' });
    const { job, lead } = await enrich(other.id);
    expect(job.status).toBe('DEAD');
    expect(job.lastErrorCode).toBe('LEAD_NOT_FOUND');
    expect(lead.websiteStatus).toBe('PRESENT_UNVERIFIED');
  });
});
