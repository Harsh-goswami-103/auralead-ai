/**
 * The `leadImport` rate limit (ADR-120: bodies up to about 7 MB) for uploads and confirmations, per
 * person. The key never includes anything the browser sends (the workspace slug is validated and
 * trimmed later, so differently spelled slugs would each open a fresh bucket).
 */
import type { RateRule } from '../../../../_lib/with-route';

export const leadImportRateRule: RateRule = {
  policy: 'leadImport',
  key: ({ ctx }) => (ctx.actor ? `lead-import:${ctx.actor.userId}` : null),
};
