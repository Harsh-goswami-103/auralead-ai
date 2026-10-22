/**
 * POST /api/app/templates/generate (ADR-123, slice F4): "Generate with AI" in the template studio.
 * The person's category (which the model cannot change), language, UTILITY trigger and purpose go
 * to the `template_copy` task; the answer is a draft for the form plus who wrote it. Nothing is
 * stored. DEMO runs the labelled local generator; LIVE the workspace's AI integration, or 422
 * AI_NOT_CONFIGURED. Limited to 30 requests a minute per workspace (`aiDraft`). Roles USER and
 * EMPLOYEE, `templates.manage` (in the service); CSRF.
 */
import { RateLimitedError } from '@/lib/errors';
import { TemplateCopyBody } from '@/lib/schemas/templates';
import { generateTemplateCopy } from '@/server/services/ai/template-copy';
import { withRoute } from '../../../_lib/with-route';
import { studioContext } from '../_lib/deps';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'], body: TemplateCopyBody }, async ({ ctx, session, runtime, body }) => {
  const target = await studioContext({ ctx, session, runtime }, body.workspaceSlug);
  const decision = runtime.limiters.aiDraft.take(`workspace:${target.workspaceId}`);
  if (!decision.allowed) throw new RateLimitedError({ retryAfterSeconds: decision.retryAfterSeconds });
  return generateTemplateCopy(
    target,
    { category: body.category, language: body.language, utilityTrigger: body.utilityTrigger, purpose: body.purpose, local: body.local },
    { keyRing: runtime.config.secrets.credentials },
  );
});
