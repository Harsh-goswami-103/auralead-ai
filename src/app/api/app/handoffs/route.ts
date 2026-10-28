/**
 * GET /api/app/handoffs (ADR-124, lead-gen F5): the client's handed-over leads, newest first, with
 * the operator's note, the summary and whether someone acknowledged it. `?status=open` keeps the
 * ones nobody acknowledged yet. Role USER (the session's workspace), `leads.read`.
 */
import { z } from 'zod';
import { ValidationError } from '@/lib/errors';
import { listClientHandoffs } from '@/server/services/leads/handoff';
import { withRoute } from '../../_lib/with-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Query = z.object({ status: z.enum(['open', 'all']).optional() });

export const GET = withRoute({ auth: 'session', roles: ['USER'] }, async ({ req, ctx }) => {
  const parsed = Query.safeParse({ status: new URL(req.url).searchParams.get('status') ?? undefined });
  if (!parsed.success) throw new ValidationError({ code: 'QUERY_INVALID', message: 'status must be open or all' });
  return { handoffs: await listClientHandoffs(ctx, { status: parsed.data.status ?? 'all' }) };
});
