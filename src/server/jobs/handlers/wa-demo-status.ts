/**
 * `wa.demoStatus` (ADR-121, slice F3; DEMO only): simulated "delivered" and "read" statuses for the
 * workspace's own WhatsApp sends, so the DEMO thread shows WhatsApp's ticks. LIVE statuses come only
 * from Meta's webhooks; this job refuses to run in a LIVE process or for a LIVE workspace.
 *
 *  - `queueDemoStatus` is the one-line hook after a DEMO WhatsApp send settles (dispatch-run.ts): in
 *    the settle transaction it queues "delivered" DEMO_DELIVERED_AFTER_MS later.
 *  - The job builds the status webhook Meta would send (`statuses: [{ id, status, timestamp,
 *    recipient_id }]`) and hands it to the production receive path (`receiveWhatsAppWebhook`,
 *    routed to the workspace, flagged simulated): one WebhookEvent per status, then `status.apply`
 *    moves the message by the rank merge exactly as for a real status. After "delivered" it queues
 *    "read" DEMO_READ_AFTER_MS later, in its settle transaction.
 *  - A message that failed, was never sent or already has the status is left alone; a replay is a
 *    DUPLICATE at the receive path (`wa:<id>:<status>`), so nothing is applied twice.
 * Payload v1 `{ messageId, providerMessageId, status: delivered | read }`, workspace job, kind
 * default, idempotency key `wa.demoStatus:<messageId>:<status>`.
 */
import { z } from 'zod';
import { getConfig } from '@/lib/config';
import { LEAD_GEN_JOB_TYPES } from '@/lib/domain/lead-gen';
import { idempotencyKey } from '@/lib/ids';
import type { Clock } from '@/lib/clock';
import type { WaWebhook } from '@/lib/schemas/webhooks/whatsapp';
import { enqueueJob, type JobStore } from '@/server/jobs/queue';
import { requireKeyRing } from '@/server/security/secrets';
import { STATUS_RANK } from '@/server/services/messaging/delivery-state';
import { receiveWhatsAppWebhook, type ReceiveDeps } from '@/server/services/messaging/inbound';
import type { JobDefinition, JobHandlerContext, TxClient } from '../types';
import { deadResult, parseWorkspacePayload } from './lead-job-support';

export const DEMO_STATUS_JOB = LEAD_GEN_JOB_TYPES.demoStatus;
export const DEMO_STATUS_PAYLOAD_VERSION = 1;
/** How long after the simulated send the customer's phone "receives" it, then "reads" it. */
export const DEMO_DELIVERED_AFTER_MS = 2_000;
export const DEMO_READ_AFTER_MS = 4_000;

type DemoStatus = 'delivered' | 'read';
const payloadSchema = z.object({ messageId: z.string().min(1).max(64), providerMessageId: z.string().min(1).max(256), status: z.enum(['delivered', 'read']) });

function enqueue(tx: TxClient, clock: Clock, input: { workspaceId: string; messageId: string; providerMessageId: string; status: DemoStatus; afterMs: number; correlationId: string }) {
  return enqueueJob(tx as unknown as JobStore, clock, {
    type: DEMO_STATUS_JOB,
    payload: { messageId: input.messageId, providerMessageId: input.providerMessageId, status: input.status },
    payloadVersion: DEMO_STATUS_PAYLOAD_VERSION,
    workspaceId: input.workspaceId,
    idempotencyKey: idempotencyKey(DEMO_STATUS_JOB, input.messageId, input.status),
    correlationId: input.correlationId,
    runAt: new Date(clock.now().getTime() + input.afterMs),
    kind: 'default',
  });
}

/**
 * The DEMO settle hook (one line in dispatch-run.ts, after `settleSent`): a simulated WhatsApp send
 * in a DEMO process queues its "delivered" status. Anything else (LIVE, email, a real send) adds
 * nothing.
 */
export async function queueDemoStatus(
  tx: TxClient,
  ctx: { mode: 'demo' | 'live'; clock: Clock; correlationId: string },
  plan: { workspaceId: string; messageId: string; channel: string },
  sent: { providerMessageId: string; simulated: boolean },
): Promise<void> {
  if (ctx.mode !== 'demo' || plan.channel !== 'WHATSAPP' || !sent.simulated) return;
  await enqueue(tx, ctx.clock, { workspaceId: plan.workspaceId, messageId: plan.messageId, providerMessageId: sent.providerMessageId, status: 'delivered', afterMs: DEMO_DELIVERED_AFTER_MS, correlationId: ctx.correlationId });
}

export type DemoStatusDeps = ReceiveDeps;

export function demoStatusDepsFromConfig(): DemoStatusDeps {
  const config = getConfig();
  const pepper = config.secrets.suppressionPepper;
  if (!pepper) throw new Error('SUPPRESSION_PEPPER is not configured (run `npm run setup`).');
  return { keyRing: requireKeyRing(config), contactKeyPepper: pepper, mode: config.mode, journalDir: config.paths.journalDir };
}

const STATUS_RANK_OF: Readonly<Record<DemoStatus, number>> = { delivered: STATUS_RANK.DELIVERED, read: STATUS_RANK.READ };

export function createWaDemoStatusJob(options: { mode?: () => 'demo' | 'live'; deps?: () => DemoStatusDeps } = {}): JobDefinition {
  const mode = options.mode ?? (() => getConfig().mode);
  const deps = options.deps ?? demoStatusDepsFromConfig;
  return {
    type: DEMO_STATUS_JOB,
    kind: 'default',
    payloadVersions: [DEMO_STATUS_PAYLOAD_VERSION],
    async handler(job: JobHandlerContext) {
      const parsed = parseWorkspacePayload(job, payloadSchema);
      if (!parsed.ok) return parsed.result;
      const { workspaceId, payload } = parsed;
      if (mode() !== 'demo') return deadResult('DEMO_ONLY', 'wa.demoStatus never runs in a LIVE process: statuses come from Meta.');
      const workspace = await job.db.workspace.findUnique({ where: { id: workspaceId }, select: { mode: true } });
      if (workspace?.mode !== 'DEMO') return deadResult('DEMO_ONLY', 'wa.demoStatus never touches a LIVE workspace.');

      const message = await job.db.message.findFirst({
        where: { id: payload.messageId, workspaceId, direction: 'OUT', channel: 'WHATSAPP' },
        select: { providerMessageId: true, status: true, statusRank: true, simulated: true, conversation: { select: { lead: { select: { phoneE164: true } } } } },
      });
      // Gone, never sent, failed, not simulated, or already at (or past) this status: nothing to simulate.
      if (!message || !message.simulated || message.providerMessageId !== payload.providerMessageId) return { outcome: 'succeeded' };
      if (message.status === 'FAILED' || message.status === 'NOT_SENT' || message.status === 'UNKNOWN' || message.statusRank >= STATUS_RANK_OF[payload.status]) return { outcome: 'succeeded' };

      // Lease check before the receive path writes (E5); the receive is idempotent per (id, status).
      await job.fencedTx(async () => undefined);
      const integration = await job.db.integration.findFirst({ where: { workspaceId, kind: 'WHATSAPP_CLOUD' }, select: { id: true, config: true } });
      const phoneNumberId = String((integration?.config as { phoneNumberId?: unknown } | null)?.phoneNumberId ?? `demo-${workspaceId}`);
      const webhook: WaWebhook = {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'demo',
            changes: [
              {
                field: 'messages',
                value: {
                  metadata: { phone_number_id: phoneNumberId },
                  statuses: [
                    {
                      id: payload.providerMessageId,
                      status: payload.status,
                      timestamp: String(Math.floor(job.clock.now().getTime() / 1000)),
                      ...(message.conversation.lead.phoneE164 ? { recipient_id: message.conversation.lead.phoneE164.replace(/^\+/, '') } : {}),
                    },
                  ],
                },
              },
            ],
          },
        ],
      };
      await receiveWhatsAppWebhook({ db: job.db, clock: job.clock, correlationId: job.correlationId }, webhook, deps(), {
        simulated: true,
        mode: 'demo',
        route: { workspaceId, integrationId: integration?.id ?? null },
      });
      if (payload.status === 'read') return { outcome: 'succeeded' };
      return {
        outcome: 'succeeded',
        finalTx: async (tx) => {
          await enqueue(tx, job.clock, { workspaceId, messageId: payload.messageId, providerMessageId: payload.providerMessageId, status: 'read', afterMs: DEMO_READ_AFTER_MS, correlationId: job.correlationId });
        },
      };
    },
  };
}

export const waDemoStatusJob = createWaDemoStatusJob();
