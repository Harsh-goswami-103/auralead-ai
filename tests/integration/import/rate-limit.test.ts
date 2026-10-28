// Adversarial review: the `leadImport` limit (ADR-120: bodies up to about 7 MB) is declared on the
// upload and the confirm routes. It is keyed on the person, not on what the browser sends, so a
// padded or re-spelled workspaceSlug cannot open a fresh bucket; with the bucket empty both routes
// answer 429 and store nothing.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST as confirmRoute } from '@/app/api/app/leads/imports/[importId]/confirm/route';
import { POST as uploadRoute } from '@/app/api/app/leads/imports/route';
import { RATE_LIMIT_POLICIES } from '@/server/security/rate-limit';
import { seedId } from '../../../prisma/seed/ids';
import { makeRequest } from '../auth/support';
import { authAs, createImportHarness, csvUpload, type ImportHarness } from './support';

let h: ImportHarness;
beforeAll(async () => {
  h = await createImportHarness('rate-limit');
}, 120_000);
afterAll(async () => h?.cleanup());

const post = (owner: { cookie: string; csrf: string }, body: Record<string, unknown>) =>
  uploadRoute(makeRequest('/api/app/leads/imports', { body, cookie: owner.cookie, csrf: owner.csrf }), { params: Promise.resolve({}) });

describe('leadImport rate limit', () => {
  it('429 on upload once the person has used the bucket, whatever slug spelling is sent, and nothing is stored', async () => {
    const owner = await authAs(h, 'owner');
    const limiter = h.runtime.limiters.leadImport;
    const userId = seedId('user', 'owner');
    for (let i = 0; i < RATE_LIMIT_POLICIES.leadImport.limit; i += 1) limiter.take(`lead-import:${userId}`);
    const before = await h.db.leadImport.count();
    const slug = 'smile-avenue-dental';
    for (const [n, workspaceSlug] of [undefined, slug, ` ${slug}`, `${slug}  `, `\u00a0${slug}`].entries()) {
      const res = await post(owner, { ...csvUpload([['Name', 'Phone'], ['Rate Cafe', '98260 77777']], `rate-key-${n}`), ...(workspaceSlug === undefined ? {} : { workspaceSlug }) });
      expect(res.status).toBe(429);
      expect(await res.json()).toMatchObject({ code: 'RATE_LIMITED' });
    }
    expect(await h.db.leadImport.count()).toBe(before);
  });

  it('429 on confirm too', async () => {
    const owner = await authAs(h, 'owner');
    h.clock.advance(RATE_LIMIT_POLICIES.leadImport.windowMs);
    const res = await post(owner, csvUpload([['Name', 'Phone'], ['Rate Cafe Two', '98260 77778']], 'rate-key-confirm-0'));
    expect(res.status).toBe(200);
    const importId = ((await res.json()) as { import: { id: string } }).import.id;
    const limiter = h.runtime.limiters.leadImport;
    const userId = seedId('user', 'owner');
    for (let i = 0; i < RATE_LIMIT_POLICIES.leadImport.limit; i += 1) limiter.take(`lead-import:${userId}`);
    const limited = await confirmRoute(makeRequest(`/api/app/leads/imports/${importId}/confirm`, { body: { workspaceSlug: ' smile-avenue-dental ', mapping: { name: 0, phone: 1 } }, cookie: owner.cookie, csrf: owner.csrf }), { params: Promise.resolve({ importId }) });
    expect(limited.status).toBe(429);
    expect((await h.db.leadImport.findUniqueOrThrow({ where: { id: importId } })).status).toBe('PREVIEW');
  });
});
