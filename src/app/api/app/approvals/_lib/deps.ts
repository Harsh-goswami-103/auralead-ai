/**
 * Approval route helpers (T22): the workspace the decision is about (`workspaceSlug`, resolved like
 * a `[ws]` segment through the lead console's `consoleContext`, ADR-58: a foreign slug is 404, a
 * missing capability in it 403) and the eligibility dependencies from the boot config.
 */
export { consoleContext as approvalContext } from '../../leads/_lib/console-context';
export { inboxDepsFromConfig as approvalDeps } from '@/server/services/messaging/inbox';
