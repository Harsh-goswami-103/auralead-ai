/**
 * The `leadImport` rate limit (ADR-120: bodies up to about 7 MB) for uploads and confirmations,
 * per person and workspace slug. The parsed body is unvalidated here, so the slug is clipped.
 */
import type { RateRule } from '../../../../_lib/with-route';

export const leadImportRateRule: RateRule = {
  policy: 'leadImport',
  key: ({ body, ctx }) => {
    const raw = (body as { workspaceSlug?: unknown } | null)?.workspaceSlug;
    const slug = typeof raw === 'string' ? raw.slice(0, 100) : 'active';
    return ctx.actor ? `lead-import:${ctx.actor.userId}:${slug}` : null;
  },
};
