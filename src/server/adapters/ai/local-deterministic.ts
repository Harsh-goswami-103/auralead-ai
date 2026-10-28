/**
 * The labelled local deterministic generator (R16, C13, ADR-18). It implements AiPort with no
 * network access and dispatches on the `task` field of the JSON user message (`{ task, data }`,
 * built by `taskUserMessage` in services/ai/run-task.ts) to one module per task under ./local/.
 * Same input, same output: each task module keys every choice that the input does not fully
 * determine by the seed, the first four bytes of the sha256 of the user message. DEMO uses it by
 * default; in LIVE it runs only through an explicit local action, and its output is always
 * labelled `local-deterministic` ("Local template" in the UI, never AI).
 *
 * LOCAL_TASKS holds one line per task. The lead-gen slices each add their task's line at their own
 * anchor (plan section 6). An unknown task, a message without a task, or a message that is not
 * JSON is a programming error and throws.
 */
import { createHash } from 'node:crypto';
import { generateLocalDraft } from './local/draft';
import { generateLocalHandoffSummary } from './local/handoff-summary';
import { generateLocalTemplateCopy } from './local/template-copy';
import type { AiPort, AiRequest, AiResponse } from './port';
// lead-gen F3: conversation_reply (ADR-122)
import { generateLocalConversationReply } from './local/conversation-reply';

export const LOCAL_GENERATOR_LABEL = 'local-deterministic' as const;
export const LOCAL_GENERATOR_MODEL = 'local-deterministic-v1';

/** What a local task module receives: the parsed user message and the input-derived seed. */
export type LocalTaskInput = { message: unknown; seed: number };
/** A local task module: returns the output object (serialized as the response text). */
export type LocalTaskGenerator = (input: LocalTaskInput) => unknown;

export const LOCAL_TASKS: Readonly<Record<string, LocalTaskGenerator>> = Object.freeze({
  lead_draft: generateLocalDraft,
  // ---- lead-gen F3 conversation_reply ----
  conversation_reply: generateLocalConversationReply,
  // ---- lead-gen F4 template_copy ----
  template_copy: generateLocalTemplateCopy,
  // ---- lead-gen F5 handoff_summary ----
  handoff_summary: generateLocalHandoffSummary,
});

const TASK_NAME_MAX = 64;

function taskOf(message: unknown): string | null {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return null;
  const task = (message as { task?: unknown }).task;
  return typeof task === 'string' ? task : null;
}

export function createLocalDeterministicAdapter(): AiPort {
  return {
    label: LOCAL_GENERATOR_LABEL,
    modelId: LOCAL_GENERATOR_MODEL,
    async generate(req: AiRequest): Promise<AiResponse> {
      const seed = createHash('sha256').update(req.user, 'utf8').digest().readUInt32BE(0);
      let message: unknown;
      try {
        message = JSON.parse(req.user);
      } catch {
        throw new TypeError('local-deterministic generator: the user message is not JSON');
      }
      const task = taskOf(message);
      if (task === null) throw new TypeError('local-deterministic generator: the user message has no "task" field');
      if (!Object.hasOwn(LOCAL_TASKS, task)) {
        const known = Object.keys(LOCAL_TASKS).join(', ');
        throw new TypeError(`local-deterministic generator: no local generator for task ${JSON.stringify(task.slice(0, TASK_NAME_MAX))} (known: ${known})`);
      }
      const output = LOCAL_TASKS[task]!({ message, seed });
      return { text: JSON.stringify(output), modelId: LOCAL_GENERATOR_MODEL, providerRequestId: null, usage: null };
    },
  };
}
