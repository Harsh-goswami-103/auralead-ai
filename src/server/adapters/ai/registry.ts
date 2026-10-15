/**
 * AI generator selection: the one mode switch for AI (plan §3 "registry is the only mode switch",
 * §4.2, C13, ADR-18). Pure: the caller passes the boot mode (ctx.mode), the workspace's own mode
 * and its AI integrations with already-decrypted keys.
 *
 * - The explicit "Generate with local template" action gets the local generator in either mode.
 * - DEMO always uses the local generator: zero outbound calls, whatever integrations exist.
 * - LIVE uses the first usable integration (Anthropic, then OpenAI). With none, the result is
 *   AI_NOT_CONFIGURED: never a silent switch to the local generator.
 * - A workspace whose stored mode differs from the process mode is refused (defense in depth).
 */
import { createAnthropicAdapter } from './anthropic';
import { createLocalDeterministicAdapter } from './local-deterministic';
import { createOpenAiAdapter } from './openai';
import type { AiPort, AiTransport } from './port';

export type AiIntegrationKind = 'AI_ANTHROPIC' | 'AI_OPENAI';

export type AiIntegrationInput = {
  kind: AiIntegrationKind;
  status: string;
  modelId: string | null;
  apiKey: string | null;
};

export type AiSelection =
  | { ok: true; port: AiPort }
  | { ok: false; code: 'AI_NOT_CONFIGURED' | 'MODE_MISMATCH'; label: 'anthropic' | 'openai' | 'none'; modelId: string | null };

/** Integration states whose stored credentials may be used for generation. */
export const USABLE_AI_STATUSES: ReadonlySet<string> = new Set(['CONNECTED', 'CONFIGURED_UNVERIFIED', 'VERIFYING', 'DEGRADED']);

const PREFERENCE: readonly AiIntegrationKind[] = ['AI_ANTHROPIC', 'AI_OPENAI'];

export function selectAiPort(input: {
  mode: 'demo' | 'live';
  workspaceMode: 'DEMO' | 'LIVE';
  forceLocal: boolean;
  integrations: readonly AiIntegrationInput[];
  transport?: AiTransport;
}): AiSelection {
  if (input.workspaceMode !== (input.mode === 'demo' ? 'DEMO' : 'LIVE')) return { ok: false, code: 'MODE_MISMATCH', label: 'none', modelId: null };
  if (input.forceLocal || input.mode === 'demo') return { ok: true, port: createLocalDeterministicAdapter() };

  for (const kind of PREFERENCE) {
    const integration = input.integrations.find((i) => i.kind === kind);
    if (!integration || !USABLE_AI_STATUSES.has(integration.status) || !integration.apiKey) continue;
    if (kind === 'AI_ANTHROPIC') {
      return { ok: true, port: createAnthropicAdapter({ apiKey: integration.apiKey, modelId: integration.modelId, ...input.transport }) };
    }
    if (integration.modelId && integration.modelId.trim() !== '') {
      return { ok: true, port: createOpenAiAdapter({ apiKey: integration.apiKey, modelId: integration.modelId, ...input.transport }) };
    }
  }
  return { ok: false, code: 'AI_NOT_CONFIGURED', label: 'none', modelId: null };
}
