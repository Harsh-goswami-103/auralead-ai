/**
 * Google Sheets route helpers (T34): the workspace an action is about (`workspaceSlug`, resolved like
 * a `[ws]` segment, ADR-58: a foreign slug is 404, a missing capability 403) and the live Sheets
 * dependencies from the request runtime's validated config (the key ring; no test seam in routes).
 */
import type { Runtime } from '@/server/boot';
import type { SheetsDeps } from '@/server/services/sheets/access';

export { consoleContext as sheetsContext } from '../../leads/_lib/console-context';
export { credentialRateRule as secretRateRule } from '../../integrations/_lib/deps';

export function sheetsDeps(runtime: Runtime): SheetsDeps {
  return { keyRing: runtime.config.secrets.credentials };
}
