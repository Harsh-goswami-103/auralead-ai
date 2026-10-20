/**
 * The live adapter registry of the Integration center (T28 seam, filled by T32-T36). Routes pass
 * these to the services; tests pass their own. Append-only: each live adapter task adds its
 * connection tester under its IntegrationKind (and T32 the WhatsApp template sync). A kind with no
 * tester answers "Verification required" in LIVE and never reports success (PRD truthfulness);
 * DEMO never reads this registry (zero outbound).
 */
import type { LiveTemplateSync, LiveTesters } from './types';

export const LIVE_CONNECTION_TESTERS: LiveTesters = {};

export const LIVE_TEMPLATE_SYNC: LiveTemplateSync | null = null;
