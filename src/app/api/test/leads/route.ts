/**
 * POST /api/test/leads (T26 E2E support, A40): ingests hand-entered (MANUAL) leads into a DEMO
 * workspace through the real `ingestBatch` service (normalization, dedupe, audit, pipeline), so
 * the Leads E2E spec can set up the 50/51 page boundary and a Devanagari-named lead, which no
 * source simulator produces. Exists only in DEMO with AURALEAD_TEST_CONTROL=1 and the right
 * x-test-control-token; otherwise a plain 404, like the other test-control routes. Refuses a
 * workspace that is not in DEMO mode (404).
 *   Body: { workspaceSlug, batchId, records: [{ name, phone?, email?, city?, category? }] (1-100) }
 */
import { z } from 'zod';
import { NotFoundError } from '@/lib/errors';
import { getJobContext } from '@/server/auth/context';
import { ingestBatch } from '@/server/services/leads/ingest';
import { withRoute } from '../../_lib/with-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const text = (max: number) => z.string().trim().min(1).max(max);
const Body = z
  .object({
    workspaceSlug: text(100),
    batchId: z.string().regex(/^[A-Za-z0-9._:-]{1,64}$/),
    records: z
      .array(z.object({ name: text(200), phone: text(40).optional(), email: text(200).optional(), city: text(100).optional(), category: text(100).optional() }).strict())
      .min(1)
      .max(100),
  })
  .strict();

export const POST = withRoute({ auth: 'none', testControl: true, origin: false, body: Body }, async ({ body, ctx, runtime: rt }) => {
  const workspace = await rt.prisma.workspace.findUnique({ where: { slug: body.workspaceSlug }, select: { id: true, mode: true } });
  if (!workspace || workspace.mode !== 'DEMO') throw new NotFoundError();
  const jobCtx = getJobContext({ id: `test-control:${body.batchId}`, workspaceId: workspace.id, correlationId: ctx.correlationId }, { prisma: rt.prisma, mode: rt.config.mode, clock: ctx.clock });
  const result = await ingestBatch(
    jobCtx,
    {
      source: 'MANUAL',
      externalBatchId: `test:${body.batchId}`,
      simulated: true,
      records: body.records.map((r, i) => ({ externalId: `${body.batchId}:${i + 1}`, fields: { name: r.name, phone: r.phone, email: r.email, city: r.city, category: r.category } })),
    },
    { contactKeyPepper: rt.config.secrets.suppressionPepper ?? '' },
  );
  return { batchId: body.batchId, counts: result.counts, records: result.records.map((r) => ({ status: r.status, leadId: r.leadId })) };
});
