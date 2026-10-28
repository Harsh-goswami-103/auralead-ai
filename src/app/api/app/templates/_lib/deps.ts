/**
 * Template studio route helpers (ADR-123, slice F4): the workspace an action is about
 * (`workspaceSlug`, resolved like a `[ws]` segment through the lead console's `consoleContext`,
 * ADR-58: a foreign slug is 404, a missing capability in it 403 from the service), the template id
 * from the URL (anything that is not an id is 404), and the studio's dependencies from the
 * validated boot config.
 */
import { NotFoundError } from '@/lib/errors';
import type { Runtime } from '@/server/boot';
import type { TemplateStudioDeps } from '@/server/services/integrations/template-authoring';

export { consoleContext as studioContext } from '../../leads/_lib/console-context';

export function templateIdParam(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new NotFoundError();
  return value;
}

export function studioDeps(runtime: Runtime): TemplateStudioDeps {
  return { keyRing: runtime.config.secrets.credentials, graphVersion: runtime.config.meta.graphVersion, storageDir: runtime.config.paths.storageDir };
}
