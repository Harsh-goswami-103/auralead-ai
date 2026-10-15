/**
 * POST /api/app/leads/[leadId]/quotes (T17): "Create quote from proposal". Creates DRAFT v1 for
 * the lead from one of its AI drafts: the proposal's catalog services and quantities, priced by
 * the server (never by the draft), with the draft's scope and timeline. Needs `quotes.edit`.
 * A draft of another lead is 404; a proposal without services or text is 422 with a code.
 */
import { LeadQuoteFromProposalBody } from '@/lib/schemas/lead-console';
import { createQuoteFromProposal } from '@/server/services/leads/console';
import { serializeQuote, serializeVersion } from '@/server/services/quotes/versioning';
import { withRoute } from '../../../../_lib/with-route';
import { consoleContext } from '../../_lib/console-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'], body: LeadQuoteFromProposalBody }, async ({ ctx, session, runtime, body, params }) => {
  const target = await consoleContext({ ctx, session, runtime }, body.workspaceSlug);
  const result = await createQuoteFromProposal(target, { leadId: String(params.leadId), draftId: body.draftId });
  return { quote: serializeQuote(result.quote, target.clock.now()), version: serializeVersion(result.version) };
});
