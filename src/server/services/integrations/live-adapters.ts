/**
 * The live adapter registry of the Integration center (T28 seam, filled by T32-T36). Routes and
 * jobs build it from the validated boot config with `liveAdapters(liveAdapterDepsFromConfig())`;
 * tests pass their own deps (a scripted Graph transport, an injected fetch). Append-only: each live
 * adapter task adds its connection tester under its IntegrationKind in `liveConnectionTesters`
 * (live-testers.ts; T35 adds META_ADS). A kind with no tester answers "Verification required" in LIVE and never
 * reports success (PRD truthfulness); DEMO never reads this registry (zero outbound).
 *
 * T32 registers: testers for WHATSAPP_CLOUD, AI_ANTHROPIC and AI_OPENAI, and the WhatsApp template
 * sync (`LIVE_TEMPLATE_SYNC`).
 */
import { getConfig, type AppConfig } from '@/lib/config';
import { liveConnectionTesters, type LiveAdapterDeps } from './live-testers';
import { liveTemplateSync } from './template-sync';
import type { LiveTemplateSync, LiveTesters } from './types';

export type { LiveAdapterDeps };

export type LiveAdapters = { testers: LiveTesters; templateSync: LiveTemplateSync };

export function liveAdapters(deps: LiveAdapterDeps): LiveAdapters {
  return { testers: liveConnectionTesters(deps), templateSync: liveTemplateSync(deps) };
}

/** Production deps: the credentials key ring, META_GRAPH_VERSION and META_MARKETING_VERSION from the validated config (never raw env). */
export function liveAdapterDepsFrom(config: Pick<AppConfig, 'secrets' | 'meta'>): LiveAdapterDeps {
  return { keyRing: config.secrets.credentials, graphVersion: config.meta.graphVersion, marketingVersion: config.meta.marketingVersion };
}

/** For jobs, which read the boot config lazily (routes use the request runtime's config). */
export function liveAdapterDepsFromConfig(): LiveAdapterDeps {
  return liveAdapterDepsFrom(getConfig());
}
