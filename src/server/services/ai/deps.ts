/**
 * Production dependencies for draft generation: the credentials key ring from the validated boot
 * config (never raw env). Resolved lazily, so importing a stage or job handler never boots config.
 */
import { getConfig } from '@/lib/config';
import type { DraftDeps } from './drafts';

export function defaultDraftDeps(): DraftDeps {
  return { keyRing: getConfig().secrets.credentials };
}
