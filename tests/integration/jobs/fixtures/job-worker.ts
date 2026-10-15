/**
 * A real worker process for the T07 multi-process tests. It boots through the production
 * `worker/boot.ts` (env loader, config, client factory, pending-migration refusal, DbOffsetClock in
 * DEMO + test control, heartbeat, reaper, claim loop) and registers generic test handlers.
 *
 * stdout protocol: `READY` once booted; `START <jobId> <worker>` when a handler starts;
 * `RAN <jobId> <worker>` when a handler body finishes (before its settle tx);
 * `OVERLAP <jobId> <count>` if another job with the same serialKey is RUNNING;
 * `EVENT <json>` for every runtime event. stdin: `GO` starts the loop (WAIT_FOR_GO=1),
 * `STOP` stops gracefully and exits 0.
 */
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { startWorkerProcess } from '../../../../worker/boot';
import { JobRegistry } from '@/server/jobs/registry';
import type { JobHandlerContext, TxClient } from '@/server/jobs/types';

const name = process.env.WORKER_NAME ?? `w${process.pid}`;
const tuning = JSON.parse(process.env.WORKER_TUNING ?? '{}') as Record<string, unknown>;

function sleepMsOf(ctx: JobHandlerContext): number {
  const payload = ctx.job.payload as { sleepMs?: number } | null;
  return typeof payload?.sleepMs === 'number' ? payload.sleepMs : 0;
}

async function audit(tx: TxClient, ctx: JobHandlerContext, action: string): Promise<void> {
  await tx.auditEvent.create({
    data: {
      workspaceId: ctx.job.workspaceId,
      actorKind: 'WORKER',
      action,
      targetType: 'Job',
      targetId: ctx.job.id,
      result: 'SUCCESS',
      summary: { worker: name, attempt: ctx.job.attempts },
      correlationId: ctx.job.correlationId,
      createdAt: ctx.clock.now(),
    },
  });
}

const registry = new JobRegistry();

// Domain write happens atomically with the SUCCEEDED settle.
registry.register({
  type: 'test.record',
  kind: 'default',
  payloadVersions: [1],
  async handler(ctx) {
    console.log(`START ${ctx.job.id} ${name}`);
    const ms = sleepMsOf(ctx);
    if (ms > 0) await sleep(ms);
    console.log(`RAN ${ctx.job.id} ${name}`);
    return { outcome: 'succeeded', finalTx: (tx) => audit(tx, ctx, 'test.record') };
  },
});

// Checks per-serialKey exclusivity from inside the handler, at start and end.
registry.register({
  type: 'test.serial',
  kind: 'default',
  payloadVersions: [1],
  async handler(ctx) {
    console.log(`START ${ctx.job.id} ${name}`);
    const check = async () => {
      if (ctx.job.serialKey === null) return;
      const running = await ctx.db.job.count({ where: { serialKey: ctx.job.serialKey, status: 'RUNNING' } });
      if (running > 1) console.log(`OVERLAP ${ctx.job.id} ${running}`);
    };
    await check();
    await sleep(sleepMsOf(ctx));
    await check();
    console.log(`RAN ${ctx.job.id} ${name}`);
    return { outcome: 'succeeded', finalTx: (tx) => audit(tx, ctx, 'test.serial') };
  },
});

// A domain write in its own fenced transaction before the settle (E5).
registry.register({
  type: 'test.fenced',
  kind: 'default',
  payloadVersions: [1],
  async handler(ctx) {
    console.log(`START ${ctx.job.id} ${name}`);
    await ctx.fencedTx((tx) => audit(tx, ctx, 'test.fenced'));
    console.log(`FENCED_WRITE_OK ${ctx.job.id} ${name}`);
    console.log(`RAN ${ctx.job.id} ${name}`);
    return { outcome: 'succeeded' };
  },
});

let releaseGate: () => void = () => undefined;
const startGate =
  process.env.WAIT_FOR_GO === '1'
    ? new Promise<void>((resolve) => {
        releaseGate = resolve;
      })
    : undefined;

const proc = await startWorkerProcess({
  registry,
  tuning,
  startGate,
  onEvent: (event) => console.log(`EVENT ${JSON.stringify(event)}`),
});

createInterface({ input: process.stdin }).on('line', (line) => {
  const cmd = line.trim();
  if (cmd === 'GO') releaseGate();
  if (cmd === 'STOP') {
    releaseGate();
    void proc.shutdown('stdin STOP');
  }
});

console.log('READY');
await proc.done;
process.exit(0);
