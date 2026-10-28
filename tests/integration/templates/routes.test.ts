// ADR-123 (slice F4): the template studio routes over HTTP (withRoute: session, CSRF, Zod, the
// workspace by slug as a `[ws]` segment, ADR-58). DEMO happy path: save a draft, save changes,
// generate copy (local template), submit (simulated review), delete; a foreign workspace slug is
// 404, a missing capability 403, an invalid draft 422 with its issues, a malformed body 400, a
// non-id template segment 404, no CSRF 403, and the per-workspace submission limit
// (`templateSubmit`, 20 an hour) answers 429. P1: the PDF upload route stores a brochure and caps
// the JSON body at the base64 size of 5 MB (413). The tenant matrix covers the remaining actors.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST as deleteRoute } from '@/app/api/app/templates/[templateId]/delete/route';
import { POST as saveRoute } from '@/app/api/app/templates/[templateId]/route';
import { POST as submitRoute } from '@/app/api/app/templates/[templateId]/submit/route';
import { POST as generateRoute } from '@/app/api/app/templates/generate/route';
import { POST as createRoute } from '@/app/api/app/templates/route';
import { POST as mediaRoute } from '@/app/api/app/media/route';
import { MEDIA_UPLOAD_MAX_BODY_BYTES } from '@/lib/schemas/templates';
import { csrfTokenForSession } from '@/server/auth/issue';
import { createSession, sessionCookieName } from '@/server/auth/session';
import { createRateLimiters } from '@/server/security/rate-limit';
import { seedId } from '../../../prisma/seed/ids';
import { makeRequest, testConfig, uninstallRuntime, useRuntime, type TestRuntime } from '../auth/support';
import { createStudioHarness, WS_A_SLUG, type StudioHarness } from './support';

let h: StudioHarness;
let runtime: TestRuntime;
let auth: { cookie: string; csrf: string };

async function signIn(userKey: string) {
  const user = await h.db.user.findUniqueOrThrow({ where: { id: seedId('user', userKey) } });
  const { token, session } = await createSession(h.db, { userId: user.id, globalRole: user.globalRole, mode: 'DEMO', activeWorkspaceId: null, ipHash: 'routes', userAgent: 'vitest', now: h.clock.now() });
  return { cookie: `${sessionCookieName(runtime.config)}=${token}`, csrf: csrfTokenForSession(runtime.config, session.id) };
}

type Handler = typeof createRoute;
const call = (handler: Handler, path: string, params: Record<string, string>, body: unknown, who = auth) => handler(makeRequest(path, { body, cookie: who.cookie, csrf: who.csrf }), { params: Promise.resolve(params) });

const DRAFT = {
  category: 'MARKETING',
  language: 'en',
  name: 'route_intro',
  header: { format: 'NONE' },
  body: 'Hello {{1}}, we build websites for local businesses. Reply to know more.',
  variables: [{ position: '1', source: 'lead.firstName', example: 'Ravi' }],
  buttons: [{ type: 'QUICK_REPLY', text: 'Stop', intent: 'STOP' }],
};

beforeAll(async () => {
  h = await createStudioHarness('f4-template-routes');
  runtime = useRuntime(h.db, testConfig('demo'), h.clock);
  auth = await signIn('employee');
}, 120_000);

afterAll(async () => {
  uninstallRuntime();
  await h?.destroy();
});

describe('template studio routes (DEMO)', () => {
  it('save, change, generate, submit and delete for the workspace named by slug', async () => {
    const created = await call(createRoute, '/api/app/templates', {}, { workspaceSlug: WS_A_SLUG, ...DRAFT });
    expect(created.status).toBe(200);
    const body = (await created.json()) as { template: { id: string; status: string; simulated: boolean }; warnings: unknown[] };
    expect(body).toMatchObject({ template: { status: 'DRAFT', simulated: true }, warnings: [] });
    const id = body.template.id;

    const saved = await call(saveRoute, `/api/app/templates/${id}`, { templateId: id }, { workspaceSlug: WS_A_SLUG, ...DRAFT, footer: 'Tap Stop to opt out', copyGeneratorLabel: 'local-deterministic' });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ template: { copyGeneratorLabel: 'local-deterministic', draft: { footer: 'Tap Stop to opt out' } } });

    const generated = await call(generateRoute, '/api/app/templates/generate', {}, { workspaceSlug: WS_A_SLUG, category: 'UTILITY', utilityTrigger: 'QUOTE_ISSUED', local: true });
    expect(generated.status).toBe(200);
    expect(await generated.json()).toMatchObject({ generatorLabel: 'local-deterministic', draft: { category: 'UTILITY', utilityTrigger: 'QUOTE_ISSUED' } });

    const submitted = await call(submitRoute, `/api/app/templates/${id}/submit`, { templateId: id }, { workspaceSlug: WS_A_SLUG });
    expect(submitted.status).toBe(200);
    expect(await submitted.json()).toMatchObject({ simulated: true, template: { status: 'PENDING' } });

    const second = await call(createRoute, '/api/app/templates', {}, { workspaceSlug: WS_A_SLUG, ...DRAFT, name: 'route_throwaway' });
    const secondId = ((await second.json()) as { template: { id: string } }).template.id;
    const deleted = await call(deleteRoute, `/api/app/templates/${secondId}/delete`, { templateId: secondId }, { workspaceSlug: WS_A_SLUG });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ deleted: true, templateId: secondId });
  });

  it('refusals: 422 with issues, 400 malformed, 404 foreign slug or non-id, 403 capability, 403 without CSRF', async () => {
    const invalid = await call(createRoute, '/api/app/templates', {}, { workspaceSlug: WS_A_SLUG, ...DRAFT, name: 'Route Intro', body: 'Hi {{2}} there' });
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toMatchObject({ code: 'TEMPLATE_INVALID' });
    expect((await call(createRoute, '/api/app/templates', {}, { workspaceSlug: WS_A_SLUG, ...DRAFT, category: 'AUTHENTICATION' })).status).toBe(400);
    expect((await call(createRoute, '/api/app/templates', {}, { workspaceSlug: 'ironpulse-fitness', ...DRAFT })).status).toBe(404);
    expect((await call(createRoute, '/api/app/templates', {}, { workspaceSlug: 'kesari-crafts', ...DRAFT })).status).toBe(403);
    expect((await call(submitRoute, '/api/app/templates/x.y/submit', { templateId: 'x.y' }, { workspaceSlug: WS_A_SLUG })).status).toBe(404);
    const noCsrf = await createRoute(makeRequest('/api/app/templates', { body: { workspaceSlug: WS_A_SLUG, ...DRAFT }, cookie: auth.cookie }), { params: Promise.resolve({}) });
    expect(noCsrf.status).toBe(403);
  });

  it('submissions are limited per workspace (templateSubmit: 20 an hour, 429)', async () => {
    runtime.limiters = createRateLimiters(runtime.clock);
    for (let i = 0; i < 20; i += 1) runtime.limiters.templateSubmit.take(`workspace:${seedId('workspace', WS_A_SLUG)}`);
    const res = await call(submitRoute, '/api/app/templates/templatematrixprobe0000000/submit', { templateId: 'templatematrixprobe0000000' }, { workspaceSlug: WS_A_SLUG });
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).not.toBeNull();
  });

  it('a person without templates.manage cannot use up the workspace budget: 403 before the limiter is touched (submit and generate)', async () => {
    runtime.limiters = createRateLimiters(runtime.clock);
    const kesari = seedId('workspace', 'kesari-crafts');
    for (let i = 0; i < 25; i += 1) {
      expect((await call(submitRoute, '/api/app/templates/templatematrixprobe0000000/submit', { templateId: 'templatematrixprobe0000000' }, { workspaceSlug: 'kesari-crafts' })).status).toBe(403);
    }
    for (let i = 0; i < 35; i += 1) expect((await call(generateRoute, '/api/app/templates/generate', {}, { workspaceSlug: 'kesari-crafts', category: 'MARKETING', local: true })).status).toBe(403);
    expect(runtime.limiters.templateSubmit.take(`workspace:${kesari}`).allowed).toBe(true);
    expect(runtime.limiters.aiDraft.take(`workspace:${kesari}`).allowed).toBe(true);
  });

  it('P1: uploads a PDF brochure; a body over the cap is 413 before anything is parsed', async () => {
    const pdf = Buffer.from('%PDF-1.4 route brochure', 'latin1').toString('base64');
    const ok = await call(mediaRoute, '/api/app/media', {}, { workspaceSlug: WS_A_SLUG, fileName: 'route.pdf', contentType: 'application/pdf', dataBase64: pdf });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ asset: { fileName: 'route.pdf' } });
    const huge = 'A'.repeat(MEDIA_UPLOAD_MAX_BODY_BYTES);
    expect((await call(mediaRoute, '/api/app/media', {}, { workspaceSlug: WS_A_SLUG, fileName: 'big.pdf', contentType: 'application/pdf', dataBase64: huge })).status).toBe(413);
    expect((await call(mediaRoute, '/api/app/media', {}, { workspaceSlug: 'kesari-crafts', fileName: 'route.pdf', contentType: 'application/pdf', dataBase64: pdf })).status).toBe(403);
  });

  it('media uploads: a file already stored is reused, 10 a minute per person (429), and the library has a ceiling', async () => {
    runtime.limiters = createRateLimiters(runtime.clock);
    const pdf = (tag: string) => Buffer.from(`%PDF-1.4 media-guard ${tag}`, 'latin1').toString('base64');
    const upload = (tag: string, slug = WS_A_SLUG) => call(mediaRoute, '/api/app/media', {}, { workspaceSlug: slug, fileName: `${tag}.pdf`, contentType: 'application/pdf', dataBase64: pdf(tag) });
    const first = (await (await upload('same')).json()) as { asset: { id: string } };
    const again = (await (await upload('same')).json()) as { asset: { id: string } };
    expect(again.asset.id).toBe(first.asset.id);
    expect(await h.db.mediaAsset.count({ where: { workspaceId: seedId('workspace', WS_A_SLUG), sha256: (await h.db.mediaAsset.findUniqueOrThrow({ where: { id: first.asset.id } })).sha256 } })).toBe(1);

    // The library ceiling: 50 files.
    const ws = seedId('workspace', WS_A_SLUG);
    const held = await h.db.mediaAsset.count({ where: { workspaceId: ws, kind: 'DOCUMENT' } });
    const filler = Array.from({ length: 50 - held }, (_, i) => ({ id: `medfiller${String(i).padStart(4, '0')}`, workspaceId: ws, kind: 'DOCUMENT' as const, fileName: `f${i}.pdf`, mimeType: 'application/pdf', byteSize: 10, sha256: `filler-${i}`, storagePath: `media/${ws}/medfiller${i}.pdf`, uploadedBy: 'test', createdAt: h.clock.now() }));
    await h.db.mediaAsset.createMany({ data: filler });
    const full = await upload('one-too-many');
    expect(full.status).toBe(422);
    expect(await full.json()).toMatchObject({ code: 'MEDIA_QUOTA_REACHED' });
    await h.db.mediaAsset.deleteMany({ where: { id: { startsWith: 'medfiller' } } });

    // The rate limit is per person: the 11th upload within a minute is refused before anything is parsed.
    runtime.limiters = createRateLimiters(runtime.clock);
    for (let i = 0; i < 10; i += 1) runtime.limiters.mediaUpload.take(`media-upload:${seedId('user', 'employee')}`);
    const limited = await upload('limited');
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).not.toBeNull();
  });
});
