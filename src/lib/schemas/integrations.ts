/**
 * Request bodies of the Integration center routes (T28), shared by the routes and the buttons.
 * `workspaceSlug` names one of the caller's own workspaces and is resolved server-side exactly like
 * a `[ws]` segment (ADR-58); without it the session's active workspace applies. The integration
 * kind is the `[kind]` URL segment (catalog slug), never a body field.
 */
import { z } from 'zod';

const workspaceSlug = z.string().trim().min(1).max(100).optional();

/** POST /api/app/integrations/[kind]/test */
export const IntegrationTestBody = z.object({ workspaceSlug });
export type IntegrationTestBody = z.infer<typeof IntegrationTestBody>;

/** POST /api/app/integrations/[kind]/templates/sync */
export const TemplateSyncBody = z.object({ workspaceSlug });
export type TemplateSyncBody = z.infer<typeof TemplateSyncBody>;
