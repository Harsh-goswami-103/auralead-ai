/**
 * Consent route dependencies from the boot config: the suppression pepper (consent and suppression
 * rows share the contact HMAC, C17) and the SuppressionJournal directory (E8). Boot refuses to
 * start without the pepper, so a missing one here is a configuration fault, not a user error.
 */
import type { Runtime } from '@/server/boot';
import type { SuppressionDeps } from '@/server/services/messaging/suppression';

export function suppressionDeps(runtime: Runtime): SuppressionDeps {
  const pepper = runtime.config.secrets.suppressionPepper;
  if (!pepper) throw new Error('SUPPRESSION_PEPPER is not configured (run `npm run setup`).');
  return { contactKeyPepper: pepper, journalDir: runtime.config.paths.journalDir };
}
