/**
 * Helpers for the T21 conversation tests (AI mode, takeover, automated replies) on top of the T20
 * inbound harness, whose in-process worker runs `webhook.process`, `reply.auto`, the dispatch jobs
 * and `status.apply` with the production handlers (scripted transports stand in for the provider).
 */
import { createLogger } from '@/lib/logger';
import type { AppCtx } from '@/server/auth/context';
import { buildJobRegistry } from '@/server/jobs/registry';
import { setConversationAiMode, setWorkspaceAutoSend } from '@/server/services/messaging/conversations';
import { createWorker, type Worker } from '../../../worker/worker';
import { createLead } from '../dispatch/support';
import { inbound, WS_A, type InboundHarness } from './inbound-support';

export { WS_A };

/** A lead with a WhatsApp number whose first inbound message opened a conversation (aiMode DRAFT by default). */
export async function leadWithConversation(h: InboundHarness, opening = 'Hello') {
  const lead = await createLead(h.db);
  const first = await inbound(lead, { text: opening }, h.clock.now());
  if (first.res.status !== 200) throw new Error(`inbound webhook answered ${first.res.status}`);
  await h.drain();
  const conversation = await h.db.conversation.findFirstOrThrow({ where: { workspaceId: WS_A, leadId: lead.id, channel: 'WHATSAPP' } });
  return { lead, conversation };
}

/** Workspace auto-send on and the conversation switched to AUTO by the owner. */
export async function autoConversation(h: InboundHarness, opening = 'Hello') {
  const owner = await h.owner();
  await setWorkspaceAutoSend(owner, { enabled: true });
  const { lead, conversation } = await leadWithConversation(h, opening);
  const mode = await setConversationAiMode(owner, { conversationId: conversation.id, aiMode: 'AUTO' });
  return { lead, conversationId: conversation.id, owner, modeVersion: mode.modeVersion };
}

/** One customer message after `stepMs`, posted through the signed webhook route (not processed yet). */
export async function customerSays(h: InboundHarness, lead: { phoneE164: string | null }, text: string, stepMs = 1_000) {
  h.clock.advance(stepMs);
  const sent = await inbound(lead, { text }, h.clock.now());
  if (sent.res.status !== 200) throw new Error(`inbound webhook answered ${sent.res.status}`);
  return sent.id;
}

export async function inboundMessage(h: InboundHarness, providerMessageId: string) {
  return h.db.message.findFirstOrThrow({ where: { workspaceId: WS_A, channel: 'WHATSAPP', providerMessageId } });
}

/** Outbound replies the guard produced for one inbound message. */
export async function repliesTo(h: InboundHarness, inboundMessageId: string) {
  return h.db.message.findMany({ where: { workspaceId: WS_A, direction: 'OUT', replyToInboundId: inboundMessageId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
}

export async function attemptsFor(h: InboundHarness, messageId: string) {
  return h.db.dispatchAttempt.findMany({ where: { messageId }, orderBy: { attemptNo: 'asc' } });
}

export async function auditsOf(h: InboundHarness, action: string, targetId?: string) {
  return h.db.auditEvent.findMany({ where: { workspaceId: WS_A, action, ...(targetId ? { targetId } : {}) }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
}

/** A second in-process worker on the same DB and production handlers (runs jobs while the first is held at a pause point). */
export function secondWorker(h: InboundHarness): Worker {
  return createWorker(
    { db: h.db, clock: h.clock, registry: buildJobRegistry(h.defs), logger: createLogger({ level: 'silent' }), mode: 'demo', version: 'test-2', random: () => 0, workerId: 'second-worker' },
    { leaseMs: 60_000, leaseExtendEveryMs: 20_000, backoff: { baseMs: 1_000, capMs: 1_000, jitterRatio: 0 } },
  );
}

export type Ctx = AppCtx;
