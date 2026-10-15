/**
 * /api/app/quotes (T15): GET lists the workspace's quotes (newest first, optional `status`);
 * POST creates DRAFT v1 for a lead, from an AI proposal (`draftId`) or typed lines. Lines are
 * catalog service ids and quantities only; prices, tax and totals come from the server price list
 * (C12). A lead or service of another workspace is 404; domain limits are 422 with a code.
 */
import { NotFoundError } from '@/lib/errors';
import { parsePaise } from '@/lib/money';
import { QUOTE_LIST_STATUSES, QuoteCreateBody } from '@/lib/schemas/quotes';
import { createQuote, listQuotes, serializeListRow, serializeQuote, serializeVersion } from '@/server/services/quotes/versioning';
import { withRoute } from '../../_lib/with-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = withRoute({ auth: 'session', roles: ['USER'] }, async ({ ctx, req }) => {
  const status = new URL(req.url).searchParams.get('status');
  if (status !== null && !(QUOTE_LIST_STATUSES as readonly string[]).includes(status)) throw new NotFoundError({ message: `unknown status filter ${status}` });
  const rows = await listQuotes(ctx, status ? { status: status as (typeof QUOTE_LIST_STATUSES)[number] } : {});
  return { quotes: rows.map(serializeListRow) };
});

export const POST = withRoute({ auth: 'session', roles: ['USER'], body: QuoteCreateBody, capability: 'quotes.edit' }, async ({ ctx, body }) => {
  const { discount, ...rest } = body;
  const result = await createQuote(ctx, { ...rest, discount: { kind: discount.kind, value: parsePaise(discount.value) } });
  return { quote: serializeQuote(result.quote, ctx.clock.now()), version: serializeVersion(result.version) };
});
