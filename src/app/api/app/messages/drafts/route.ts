/**
 * POST /api/app/messages/drafts (T22): the composer's "Save for review". The text becomes a DRAFT
 * message with a PENDING approval in the queue; nothing is sent. USER panel, `leads.write`; another
 * workspace's conversation is 404.
 */
import { ComposerDraftBody } from '@/lib/schemas/inbox';
import { inboxDepsFromConfig, saveComposerDraft } from '@/server/services/messaging/inbox';
import { withRoute } from '../../../_lib/with-route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const POST = withRoute({ auth: 'session', roles: ['USER'], body: ComposerDraftBody, capability: 'leads.write' }, async ({ ctx, body, runtime }) => {
  return saveComposerDraft(ctx, body, inboxDepsFromConfig(runtime.config));
});
