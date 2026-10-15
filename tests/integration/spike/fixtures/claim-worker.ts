/**
 * Child process for two-process-claim.test.ts. Opens the DB through the production client,
 * prints READY, waits for GO on stdin, then claims jobs with the production claim statement until
 * none are claimable. Prints one RESULT line with JSON and exits 0. Any error other than a lost
 * race exits 1 with the error on stderr; SQLITE_BUSY is counted (the test requires zero).
 */
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { createPrismaClient } from '@/server/db/client';
import { claimNextJob } from '@/server/db/raw/claim-job';

const url = process.env.DATABASE_URL;
const workerId = process.env.WORKER_ID ?? `pid-${process.pid}`;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}

const prisma = createPrismaClient({ url });
await prisma.$queryRawUnsafe('SELECT 1');

const go = new Promise<void>((resolve) => {
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (line.trim() === 'GO') {
      rl.close();
      resolve();
    }
  });
});
console.log('READY');
await go;

const claimed: string[] = [];
let busyErrors = 0;
let lostRaces = 0;
const LEASE_MS = 60_000;

try {
  for (;;) {
    const now = new Date();
    let job;
    try {
      job = await claimNextJob(prisma, { now, leaseUntil: new Date(now.getTime() + LEASE_MS), claimToken: randomUUID() });
    } catch (error) {
      if (/SQLITE_BUSY|database is locked/i.test(String(error))) {
        busyErrors++;
        continue;
      }
      throw error;
    }
    if (job) {
      if (job.status !== 'RUNNING' || job.attempts !== 1) throw new Error(`claimed row in unexpected state: ${JSON.stringify(job)}`);
      claimed.push(job.id);
      continue;
    }
    const remaining = await prisma.job.count({ where: { status: 'QUEUED', runAt: { lte: now } } });
    if (remaining === 0) break;
    lostRaces++;
  }
  console.log(`RESULT ${JSON.stringify({ workerId, pid: process.pid, claimed, busyErrors, lostRaces })}`);
  await prisma.$disconnect();
  process.exit(0);
} catch (error) {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
}
