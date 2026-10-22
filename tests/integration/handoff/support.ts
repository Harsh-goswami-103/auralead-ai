/**
 * Shared helpers for the lead-gen F5 handoff tests (ADR-124): the T20 inbound harness (seeded DEMO
 * DB, real user contexts, an in-process worker with the production webhook, reply and dispatch
 * handlers) plus the `handoff.summary` job, an operator context that holds `leads.handoff`, and a
 * snapshot of everything a handoff writes, to prove a refused one wrote nothing.
 */
import { createLogger } from '@/lib/logger';
import type { Capability } from '@/lib/domain/enums';
import type { AppCtx } from '@/server/auth/context';
import { createHandoffSummaryJob } from '@/server/jobs/handlers/handoff-summary';
import { buildJobRegistry } from '@/server/jobs/registry';
import type { AiDeps } from '@/server/services/ai/run-task';
import { seedId } from '../../../prisma/seed/ids';
import { createWorker, type Worker } from '../../../worker/worker';
import type { InboundHarness } from '../messaging/inbound-support';
import { userCtx } from '../quotes/support';

export const EMPLOYEE_ID = seedId('user', 'employee');
export const DEMO_AI: AiDeps = { keyRing: null };

/** The operator persona in smile-avenue-dental, with `leads.handoff` added to its assignment. */
export async function operatorWithHandoff(h: InboundHarness, workspaceSlug = 'smile-avenue-dental'): Promise<AppCtx> {
  const workspace = await h.db.workspace.findUniqueOrThrow({ where: { slug: workspaceSlug }, select: { id: true } });
  const assignment = await h.db.employeeAssignment.findUniqueOrThrow({ where: { employeeUserId_workspaceId: { employeeUserId: EMPLOYEE_ID, workspaceId: workspace.id } } });
  const caps = new Set(assignment.capabilities as Capability[]);
  caps.add('leads.handoff');
  await h.db.employeeAssignment.update({ where: { id: assignment.id }, data: { capabilities: [...caps] } });
  return userCtx(h.db, h.clock, 'employee', workspaceSlug);
}

/** A worker running the harness's production handlers plus `handoff.summary` (DEMO by default). */
export function handoffWorker(h: InboundHarness, opts: { mode?: 'demo' | 'live'; deps?: () => AiDeps } = {}): Worker {
  const mode = opts.mode ?? 'demo';
  return createWorker(
    {
      db: h.db,
      clock: h.clock,
      registry: buildJobRegistry([...h.defs, createHandoffSummaryJob({ mode: () => mode, deps: opts.deps ?? (() => DEMO_AI) })]),
      logger: createLogger({ level: 'silent' }),
      mode,
      version: 'test',
      random: () => 0,
    },
    { leaseMs: 60_000, leaseExtendEveryMs: 20_000, backoff: { baseMs: 1_000, capMs: 1_000, jitterRatio: 0 } },
  );
}

export async function drain(worker: Worker): Promise<number> {
  let ran = 0;
  while ((await worker.tick()) === 'ran') ran += 1;
  return ran;
}

let keySeq = 0;
export const requestKey = (prefix = 'handoff') => `${prefix}-key-${String((keySeq += 1)).padStart(6, '0')}`;

/** Everything a handoff of `leadId` could write, for before/after comparison. */
export async function handoffFootprint(h: InboundHarness, leadId: string) {
  const conversations = await h.db.conversation.findMany({ where: { leadId }, orderBy: { id: 'asc' }, select: { id: true, aiMode: true, humanTakeover: true, modeVersion: true } });
  const conversationIds = conversations.map((c) => c.id);
  return {
    lead: await h.db.lead.findUniqueOrThrow({ where: { id: leadId }, select: { salesStage: true, stageVersion: true, handedOverAt: true } }),
    handoffs: await h.db.leadHandoff.count({ where: { leadId } }),
    conversations,
    approvals: await h.db.approval.findMany({ where: { message: { conversationId: { in: conversationIds } } }, orderBy: { id: 'asc' }, select: { id: true, status: true } }),
    messages: await h.db.message.findMany({ where: { conversationId: { in: conversationIds } }, orderBy: { id: 'asc' }, select: { id: true, status: true } }),
    stageRuns: await h.db.pipelineStageRun.findMany({ where: { execution: { leadId } }, orderBy: { id: 'asc' }, select: { id: true, stage: true, status: true, reasonCode: true } }),
    audits: await h.db.auditEvent.count({ where: { OR: [{ targetId: leadId }, { targetId: { in: conversationIds } }] } }),
    jobs: await h.db.job.count({ where: { type: 'handoff.summary' } }),
  };
}
