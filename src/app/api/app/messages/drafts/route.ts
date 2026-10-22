/**
 * POST /api/app/messages/drafts (T22; ADR-121): the composer's "Save for review", in both panels.
 * The text becomes a DRAFT message with a PENDING approval in the queue; nothing is sent. Needs
 * `leads.write` in the target workspace (the session's for USER, `workspaceSlug` for EMPLOYEE);
 * another workspace's conversation is 404; an operator gets 409 HANDED_OVER for a handed-over lead.
 */
import { ComposerDraftBody } from '@/lib/schemas/inbox';
import { inboxDepsFromConfig, saveComposerDraft } from '@/server/services/messaging/inbox';
import { withRoute } from '../../../_lib/with-route';
import { consoleContext } from '../../leads/_lib/console-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER', 'EMPLOYEE'], body: ComposerDraftBody }, async ({ ctx, session, body, runtime }) => {
  const { workspaceSlug, ...input } = body;
  const target = await consoleContext({ ctx, session, runtime }, workspaceSlug);
  return saveComposerDraft(target, input, inboxDepsFromConfig(runtime.config));
});
