// P15 (T22): "Copy link" / "Mark as sent manually" moves an APPROVED quote to SENT with
// sentVia MANUAL_LINK through the state machine (plan §6.1): DRAFT, EXPIRED and a stale version are
// 409; a repeat is a no-op without a second audit; the version's sentAt and the lead's sales stage
// (forward only, QUOTE_SENT) move with it; the share panel reads view evidence (opens, never
// "read"). The route is USER only with `dispatch.send`; another workspace's quote is 404.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { csrfTokenForSession } from '@/server/auth/issue';
import { createSession, sessionCookieName } from '@/server/auth/session';
import { approveQuote, createQuote } from '@/server/services/quotes/versioning';
import { createQuoteShare } from '@/server/services/quotes/share';
import { loadQuoteShareEvidence, markQuoteSentManually } from '@/server/services/quotes/manual-send';
import { POST as markSentRoute } from '@/app/api/app/quotes/[quoteId]/mark-sent/route';
import { seedId } from '../../../prisma/seed/ids';
import { makeRequest, testConfig, uninstallRuntime, useRuntime } from '../auth/support';
import { createLead, createQuoteHarness, DAY, ownerCtx, SERVICE, type QuoteHarness } from './support';
import { removeDir } from '../../support/db';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from '@/lib/config';

let h: QuoteHarness;
let config: AppConfig;
let dataDir: string;

beforeAll(async () => {
  h = await createQuoteHarness('manual-send');
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'auralead-manual-send-'));
  config = testConfig('demo', { AURALEAD_DATA_DIR: dataDir });
  useRuntime(h.db, config, h.clock);
}, 120_000);

afterAll(async () => {
  uninstallRuntime();
  await h?.testDb.destroy();
  await removeDir(dataDir);
});

async function draftQuote() {
  const owner = await ownerCtx(h);
  const lead = await createLead(h.db);
  const { quote } = await createQuote(owner, { leadId: lead.id, items: [{ serviceId: Object.values(SERVICE)[0]!, qty: 1 }], discount: { kind: 'NONE', value: 0n }, scopeText: 'Scope', timelineText: 'One week' });
  return { owner, lead, quote };
}

describe('mark sent manually (P15)', () => {
  it('APPROVED -> SENT with MANUAL_LINK, version sentAt, lead QUOTE_SENT, one audit; repeat is a no-op', async () => {
    const { owner, lead, quote } = await draftQuote();
    await expect(markQuoteSentManually(owner, quote.id, { expectedVersion: 1, via: 'COPY_LINK' })).rejects.toMatchObject({ status: 409, code: 'INVALID_TRANSITION' });
    await approveQuote(owner, quote.id, { expectedVersion: 1 });
    await expect(markQuoteSentManually(owner, quote.id, { expectedVersion: 2, via: 'COPY_LINK' })).rejects.toMatchObject({ status: 409 });

    const done = await markQuoteSentManually(owner, quote.id, { expectedVersion: 1, via: 'COPY_LINK' });
    expect(done).toMatchObject({ changed: true, quote: { status: 'SENT', sentVia: 'MANUAL_LINK' } });
    const version = await h.db.quoteVersion.findFirstOrThrow({ where: { quoteId: quote.id, versionNo: 1 } });
    expect(version.sentAt?.toISOString()).toBe(h.clock.now().toISOString());
    expect(await h.db.lead.findFirstOrThrow({ where: { id: lead.id } })).toMatchObject({ salesStage: 'QUOTE_SENT' });
    const audits = await h.db.auditEvent.findMany({ where: { action: 'quote.send', targetId: quote.id } });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.summary).toMatchObject({ via: 'MANUAL_LINK', trigger: 'COPY_LINK', versionNo: 1 });

    const again = await markQuoteSentManually(owner, quote.id, { expectedVersion: 1, via: 'MARK_SENT' });
    expect(again.changed).toBe(false);
    expect(await h.db.auditEvent.count({ where: { action: 'quote.send', targetId: quote.id } })).toBe(1);
  });

  it('an approved quote past its validity is EXPIRED and cannot be marked sent', async () => {
    const { owner, quote } = await draftQuote();
    await approveQuote(owner, quote.id, { expectedVersion: 1 });
    const saved = h.clock.now();
    h.clock.set(new Date(saved.getTime() + 40 * DAY));
    try {
      await expect(markQuoteSentManually(await ownerCtx(h), quote.id, { expectedVersion: 1, via: 'MARK_SENT' })).rejects.toMatchObject({ status: 409 });
    } finally {
      h.clock.set(saved);
    }
  });

  it('view evidence counts browser opens only and flags an opened-but-unsent link', async () => {
    const { owner, quote } = await draftQuote();
    await approveQuote(owner, quote.id, { expectedVersion: 1 });
    const { share } = await createQuoteShare(owner, quote.id, {});
    const base = { workspaceId: quote.workspaceId, quoteShareId: share.id, quoteVersionId: share.quoteVersionId, ipHash: 'x' };
    await h.db.quoteViewEvent.createMany({
      data: [
        { ...base, kind: 'BEACON', uaClass: 'BROWSER', createdAt: new Date('2026-10-16T06:10:00.000Z') },
        { ...base, kind: 'BEACON', uaClass: 'BOT', createdAt: new Date('2026-10-16T06:11:00.000Z') },
        { ...base, kind: 'FETCH', uaClass: 'LINK_PREVIEW', createdAt: new Date('2026-10-16T06:12:00.000Z') },
      ],
    });
    await h.db.auditEvent.create({ data: { workspaceId: quote.workspaceId, actorKind: 'PUBLIC', action: 'quote.view.unsent', targetType: 'Quote', targetId: quote.id, result: 'SUCCESS', summary: {}, correlationId: 'req_test', createdAt: h.clock.now() } });
    const evidence = await loadQuoteShareEvidence(owner, quote.id);
    expect(evidence).toMatchObject({ opens: 1, fetches: 1, openedWhileUnsent: true });
    expect(evidence.lastOpenAt?.toISOString()).toBe('2026-10-16T06:10:00.000Z');
  });

  it('route: owner 200; another workspace owner 404', async () => {
    const { owner, quote } = await draftQuote();
    await approveQuote(owner, quote.id, { expectedVersion: 1 });
    const auth = async (key: string) => {
      const user = await h.db.user.findUniqueOrThrow({ where: { id: seedId('user', key) } });
      const { token, session } = await createSession(h.db, { userId: user.id, globalRole: user.globalRole, mode: 'DEMO', activeWorkspaceId: null, ipHash: 'm', userAgent: 'vitest', now: h.clock.now() });
      return { cookie: `${sessionCookieName(config)}=${token}`, csrf: csrfTokenForSession(config, session.id) };
    };
    const post = async (key: string) => {
      const a = await auth(key);
      return markSentRoute(makeRequest(`/api/app/quotes/${quote.id}/mark-sent`, { body: { expectedVersion: 1, via: 'MARK_SENT' }, cookie: a.cookie, csrf: a.csrf }), { params: Promise.resolve({ quoteId: quote.id }) });
    };
    expect((await post('rohan')).status).toBe(404);
    const res = await post('owner');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ changed: true, quote: { status: 'SENT', sentVia: 'MANUAL_LINK' } });
  });
});
