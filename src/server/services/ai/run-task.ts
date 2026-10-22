/**
 * The shared plumbing of every AI task (lead drafts today; conversation_reply, template_copy and
 * handoff_summary in the lead-gen slices; ADR-18, ADR-122..124). Two steps, both outside any
 * transaction (they may call a provider):
 *
 * `selectWorkspaceAi(ctx, deps, { forceLocal })` picks the generator for the caller's workspace:
 * - DEMO: the labelled local generator, always (zero outbound calls; integrations are not read).
 * - LIVE: the workspace's own AI integration with its key decrypted here (Anthropic first, then
 *   OpenAI with a model id). With none usable the result is a typed `AI_NOT_CONFIGURED` (errorCode
 *   `CREDENTIAL_DECRYPT_FAILED` when a stored key would not decrypt): never a silent switch to the
 *   local generator. Only an explicit local action (`forceLocal`) gets the local generator in LIVE.
 * - A workspace whose stored mode differs from the process mode is refused (`MODE_MISMATCH`).
 *
 * `runStructuredTask({ port, task, system, user, jsonSchema, zod | evaluate, maxTokens, finalAttempt })`
 * calls the port and validates its JSON output:
 * - Malformed, empty or truncated output gets exactly one repair call carrying the issues and the
 *   previous output (max tokens x1.5 after a truncation). A second invalid output is a failed
 *   result (`AI_MALFORMED_OUTPUT`), never a third call.
 * - A retryable provider failure (429, 5xx, timeout) is rethrown so the job retries, except on the
 *   job's final attempt (or a request-time call that passes `finalAttempt: true`), where it is a
 *   failed result. Auth failures, rejections and refusals are failed results at once.
 * - Validation is the task's zod schema on the parsed JSON, or a custom `evaluate` on the raw text
 *   (lead drafts keep their strip-and-flag evaluation, ./proposal.ts).
 * A failed result carries the AppError; the caller stores it as its own NEEDS_REVIEW, FAILED or
 * fixed-text outcome. Output policy checks on the parsed value stay with each task.
 */
import type { z } from 'zod';
import { getConfig } from '@/lib/config';
import { AiEmptyOutputError, AiMalformedOutputError, AiTruncatedOutputError, AppError } from '@/lib/errors';
import { redactText } from '@/lib/redact';
import { selectAiPort, type AiIntegrationInput, type AiIntegrationKind } from '@/server/adapters/ai/registry';
import type { AiPort, AiRequest, AiResponse, AiTransport } from '@/server/adapters/ai/port';
import type { AppCtx } from '@/server/auth/context';
import { requireWorkspace } from '@/server/auth/guards';
import { credentialAad, decryptSecretString, type KeyRing } from '@/server/security/secrets';

export type AiDeps = {
  /** The credentials key ring (config.secrets.credentials); null means no stored key is usable. */
  keyRing: KeyRing | null;
  transport?: AiTransport;
};

/** Production dependencies: the key ring from the validated boot config, resolved lazily. */
export function defaultAiDeps(): AiDeps {
  return { keyRing: getConfig().secrets.credentials };
}

// ---- selection ---------------------------------------------------------------------------------

const AI_KINDS: readonly AiIntegrationKind[] = ['AI_ANTHROPIC', 'AI_OPENAI'];

export type LoadedAiIntegrations = { integrations: AiIntegrationInput[]; decryptFailed: boolean };

/** The workspace's AI integrations (tenant-scoped read) with their API keys decrypted. */
export async function loadAiIntegrations(ctx: AppCtx, keyRing: KeyRing | null): Promise<LoadedAiIntegrations> {
  const rows = await ctx.db.integration.findMany({ where: { kind: { in: [...AI_KINDS] } } });
  let decryptFailed = false;
  const integrations = rows.map((row): AiIntegrationInput => {
    const config = (row.config ?? {}) as { modelId?: unknown };
    const envelope = (row.secrets as { apiKey?: unknown } | null)?.apiKey;
    let apiKey: string | null = null;
    if (keyRing && typeof envelope === 'string') {
      try {
        apiKey = decryptSecretString(keyRing, envelope, credentialAad({ workspaceId: row.workspaceId, integrationId: row.id, field: 'apiKey' }));
      } catch {
        decryptFailed = true;
      }
    }
    return { kind: row.kind as AiIntegrationKind, status: row.status, modelId: typeof config.modelId === 'string' ? config.modelId : null, apiKey };
  });
  return { integrations, decryptFailed };
}

export type WorkspaceAiSelection =
  | { ok: true; port: AiPort }
  | {
      ok: false;
      code: 'AI_NOT_CONFIGURED' | 'MODE_MISMATCH';
      /** `code`, or CREDENTIAL_DECRYPT_FAILED when AI_NOT_CONFIGURED came from a key that would not decrypt. */
      errorCode: 'AI_NOT_CONFIGURED' | 'MODE_MISMATCH' | 'CREDENTIAL_DECRYPT_FAILED';
      label: 'anthropic' | 'openai' | 'none';
      modelId: string | null;
    };

export async function selectWorkspaceAi(ctx: AppCtx, deps: AiDeps, opts: { forceLocal?: boolean } = {}): Promise<WorkspaceAiSelection> {
  const workspaceId = requireWorkspace(ctx);
  const forceLocal = opts.forceLocal ?? false;
  const workspace = await ctx.db.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { mode: true } });
  const loaded: LoadedAiIntegrations = ctx.mode === 'live' && !forceLocal ? await loadAiIntegrations(ctx, deps.keyRing) : { integrations: [], decryptFailed: false };
  const selection = selectAiPort({ mode: ctx.mode, workspaceMode: workspace.mode, forceLocal, integrations: loaded.integrations, transport: deps.transport });
  if (selection.ok) return selection;
  const errorCode = selection.code === 'AI_NOT_CONFIGURED' && loaded.decryptFailed ? 'CREDENTIAL_DECRYPT_FAILED' : selection.code;
  return { ok: false, code: selection.code, errorCode, label: selection.label, modelId: selection.modelId };
}

// ---- one structured call with one repair ----------------------------------------------------------

/** The JSON user message every generator receives: `{ task, data }`, every untrusted value in `data`. */
export function taskUserMessage(task: string, data: unknown): string {
  return JSON.stringify({ task, data });
}

export const NOT_JSON_ISSUES = 'The output was not valid JSON. Return only the JSON object.';
export const EMPTY_OR_CUT_OFF_ISSUES = 'The previous output was empty or cut off. Return the complete JSON object, keeping every text short.';
const MAX_ISSUES_CHARS = 1500;

export type StructuredEvaluation<T> = { ok: true; value: T } | { ok: false; issues: string };

type TaskCall = {
  port: AiPort;
  /** The task named in `user` (`taskUserMessage(task, data)`); checked before any call. */
  task: string;
  system: string;
  user: string;
  jsonSchema: Record<string, unknown>;
  maxTokens: number;
  /** True on a job's last attempt, or for a request-time call that has no retry: retryable failures become a failed result. */
  finalAttempt: boolean;
  signal?: AbortSignal;
};

export type StructuredTaskInput<T> = TaskCall &
  (
    | { zod: z.ZodType<T>; evaluate?: undefined }
    | {
        /** Custom validation of the raw output text (instead of JSON.parse + zod). */
        evaluate: (raw: string) => StructuredEvaluation<T>;
        zod?: undefined;
      }
  );

export type StructuredTaskResult<T> =
  | { ok: true; value: T; response: AiResponse; repaired: boolean }
  | { ok: false; error: AppError };

const isOutputError = (e: unknown) => e instanceof AiMalformedOutputError || e instanceof AiEmptyOutputError || e instanceof AiTruncatedOutputError;

type CallResult = { response: AiResponse; error?: undefined } | { response?: undefined; error: AppError };

/** One port call: a retryable non-output failure is rethrown unless this is the final attempt. */
export async function callPort(port: AiPort, request: AiRequest, finalAttempt: boolean): Promise<CallResult> {
  try {
    return { response: await port.generate(request) };
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    if (error.retryable && !isOutputError(error) && !finalAttempt) throw error;
    return { error };
  }
}

function describeIssues(error: z.ZodError): string {
  const text = error.issues
    .slice(0, 12)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
  return redactText(text).slice(0, MAX_ISSUES_CHARS);
}

function zodEvaluator<T>(schema: z.ZodType<T>): (raw: string) => StructuredEvaluation<T> {
  return (raw) => {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return { ok: false, issues: NOT_JSON_ISSUES };
    }
    const parsed = schema.safeParse(json);
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, issues: describeIssues(parsed.error) };
  };
}

function assertTaskMatches(task: string, user: string): void {
  let named: unknown = null;
  try {
    const message: unknown = JSON.parse(user);
    if (message !== null && typeof message === 'object' && !Array.isArray(message)) named = (message as { task?: unknown }).task;
  } catch {
    named = null;
  }
  if (named !== task) {
    throw new TypeError(`runStructuredTask: task ${JSON.stringify(task)} does not match the user message (task ${JSON.stringify(named)}); build it with taskUserMessage(${JSON.stringify(task)}, data)`);
  }
}

export async function runStructuredTask<T>(input: StructuredTaskInput<T>): Promise<StructuredTaskResult<T>> {
  assertTaskMatches(input.task, input.user);
  const evaluate = input.evaluate ?? zodEvaluator(input.zod!);
  const firstRequest: AiRequest = { system: input.system, user: input.user, jsonSchema: input.jsonSchema, maxTokens: input.maxTokens };
  if (input.signal) firstRequest.signal = input.signal;

  const first = await callPort(input.port, firstRequest, input.finalAttempt);
  if (first.error && !isOutputError(first.error)) return { ok: false, error: first.error };

  if (first.response) {
    const evaluation = evaluate(first.response.text);
    if (evaluation.ok) return { ok: true, value: evaluation.value, response: first.response, repaired: false };
    return repair(input, firstRequest, evaluate, { previousOutput: first.response.text, issues: evaluation.issues, truncated: false });
  }
  return repair(input, firstRequest, evaluate, { previousOutput: null, issues: EMPTY_OR_CUT_OFF_ISSUES, truncated: first.error instanceof AiTruncatedOutputError });
}

async function repair<T>(
  input: StructuredTaskInput<T>,
  firstRequest: AiRequest,
  evaluate: (raw: string) => StructuredEvaluation<T>,
  previous: { previousOutput: string | null; issues: string; truncated: boolean },
): Promise<StructuredTaskResult<T>> {
  const second = await callPort(
    input.port,
    {
      ...firstRequest,
      maxTokens: previous.truncated ? Math.round(input.maxTokens * 1.5) : input.maxTokens,
      repair: { previousOutput: previous.previousOutput, issues: previous.issues },
    },
    input.finalAttempt,
  );
  if (second.error) return { ok: false, error: second.error };
  const evaluation = evaluate(second.response.text);
  if (evaluation.ok) return { ok: true, value: evaluation.value, response: second.response, repaired: true };
  return { ok: false, error: new AiMalformedOutputError({ message: `output failed validation after one repair: ${evaluation.issues}` }) };
}
